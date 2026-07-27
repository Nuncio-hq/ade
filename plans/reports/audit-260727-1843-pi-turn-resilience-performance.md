# Pi Adapter Audit — Turn Resilience + Performance

Scope: `apps/server/src/provider/Layers/PiAdapter.ts` (2931 lines) and its ingress path.
SDK verified against the **installed** version `@earendil-works/pi-coding-agent@0.81.1` (bun.lock:409),
not the 0.82.1 reference tarball. Every SDK field cited below was confirmed present in 0.81.1 via
CHANGELOG version bisect.

Two questions answered: (A) why Pi agents die mid-turn, (B) performance.

---

## A. Why Pi agents die mid-turn

### A1 — CRITICAL: `agent_end` treated as terminal; `willRetry` ignored

`PiAdapter.ts:1972` handles `agent_end` by emitting `turn.completed` and clearing
`activeTurnId` / `activeAssistantItemId` / `activeToolItems`.

But in Pi, `agent_end` is **not** terminal. From `docs/rpc.md:841`:

> `agent_end` — One low-level agent run completes (**may still be followed by retry, compaction,
> or queued continuations**)
> `agent_settled` — Agent run is fully settled; no automatic retry, compaction retry, or queued
> continuation remains

The event carries the disambiguator: `agent_end { messages, willRetry: boolean }`
(`agent-session.d.ts:43-45`). Pi auto-retry is **on by default** — `retry.enabled=true`,
`maxRetries=3`, backoff 2s/4s/8s (`docs/settings.md:134-143`), triggered by 429/500/502/503/504
and overloaded errors.

Current failure sequence on any transient provider error:

1. Pi hits a 429/overloaded → fires `agent_end` with `willRetry: true`, `state.errorMessage` set.
2. Adapter reads `session.agent.state.errorMessage` (line 1977), classifies via
   `classifyPiTurnFailure` → `failed`, emits `runtime.error` + `turn.completed{state:"failed"}`,
   clears `activeTurnId`.
3. **The user sees the agent die.**
4. Pi waits 2s, fires `auto_retry_start`, retries, streams normally.
5. Post-retry deltas arrive with `activeTurnId === undefined` → `makePiRuntimeEventBase`
   (line 360) omits `turnId` → events are orphaned from the turn.
6. Pi fires `agent_end` again on success → a **second** `turn.completed` for a turn already
   reported failed.

Secondary consequence: the `sendTurn` guard `"A Pi turn is already active"` (line 2397) is
released at step 2, so a user re-prompt during the retry window is admitted while Pi is still
streaming the previous run.

`classifyPiTurnFailure` (`piTurnFailure.ts`) only distinguishes aborted-vs-error by string
matching; it has no notion of retryable. String matching is not the fix — `willRetry` is
authoritative and already on the event.

**In-repo precedent exists.** `CodexAdapter.ts:1615-1616` does exactly the right thing:

```ts
const willRetry = payload?.willRetry === true;
const treatAsWarning = willRetry || isNonFatalCodexErrorMessage(message);
```

Codex, a non-priority provider, is retry-aware. Pi, the first-class provider, is not.

**Fix:** treat `agent_end` as terminal only when `willRetry === false`. When `willRetry === true`,
emit `runtime.warning` (not `runtime.error`), keep `activeTurnId` and the active item ids intact,
and do not emit `turn.completed`. Move true turn finalization to `agent_settled`. Keep an
`agent_end` fallback for defensive termination if `agent_settled` never arrives.

### A2 — LOW: `compaction_end.willRetry` / `errorMessage` / `reason` ignored

**Correction.** An earlier revision of this report claimed the mismatched compaction item ids
(`pi-compaction-${crypto.randomUUID()}` minted separately at lines 1942 and 1957) leave a stuck
`inProgress` item. **That is wrong.** `providerRuntimeActivityProjection.ts:797-824` keys
compaction activity by `event.eventId`, not `itemId`, and emits two independent log lines
("Compacting conversation..." → "Context compacted"). Compaction never reaches the tool
lifecycle path (`isToolLifecycleItemType` at line 825 excludes it), so no `itemId` correlation
is required. The random ids are harmless.

**Do not "fix" this by switching `compaction_start` to `item.started`.** Line 800 explicitly
excludes `item.started` from the compaction branch, and line 825 then filters it out — the
"Compacting conversation..." line would disappear entirely.

What genuinely remains, and it is minor:

- `compaction_end` carries `willRetry: boolean` and `errorMessage?: string`
  (`agent-session.d.ts:65-70`); the adapter reads only `event.aborted`, so a compaction that
  failed but will retry renders as "Context compacted" (success), and a terminal failure shows
  no reason.
- `compaction_start.reason` (`"manual" | "threshold" | "overflow"`) is dropped — a manual
  `/compact` is indistinguishable from an emergency overflow compaction.

**Fix:** map `willRetry`/`errorMessage` into the emitted `status`/`detail`; surface `reason` in
the title. Item id handling stays as-is.

### A3 — HIGH: retry/queue lifecycle events are silently dropped

`handleSessionEvent`'s `switch` (line 1807) has `default: return`. Unhandled Pi events that
matter:

| Event | Cost of dropping |
|---|---|
| `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage}` | No "retrying 2/3 in 4s" feedback. 2–8s of silence = looks dead. |
| `auto_retry_end {success, attempt, finalError}` | Recovery invisible. |
| `agent_settled` | Real terminal event unused (root cause of A1). |
| `queue_update {steering, followUp}` | Queued messages invisible; user re-sends, compounding load. |
| `summarization_retry_scheduled/attempt_start/finished` | Compaction retries invisible. |
| `extension_error` | **Your own harness extension errors are swallowed.** |

`extension_error` deserves emphasis: `harness/extensions/` is the core deliverable of this repo,
and an extension that throws mid-turn produces no user-visible signal today.

**Fix:** map `auto_retry_start/end` and `summarization_retry_*` to `runtime.warning` +
`tool.progress`, `extension_error` to `runtime.error`, `queue_update` to progress.

### A4 — MEDIUM: no turn watchdog; a lost `agent_end` wedges the thread permanently

`sendTurn` fires the prompt without awaiting (line 2498):

```ts
void context.runtime.session.prompt(providerText, ...).catch((cause) => {
  completePromptRejection(context, turnId, cause);
});
```

`activeTurnId` is cleared only by `agent_end` or a `prompt()` rejection. If `prompt()` resolves
but `agent_end` never fires — extension deadlock, a swallowed SDK error, a hung
`ExtensionUIContext` promise — `activeTurnId` stays set forever. From then on every `sendTurn`
fails with `"A Pi turn is already active for this thread."` and the only recovery is restarting
the session. There is no timeout anywhere on the turn path.

Note `requestPiExtensionUserInput` (line 1382) only arms a timeout when the caller passes
`opts.timeout`; with no timeout and no abort signal, a pending user-input promise blocks the
turn indefinitely.

**Fix:** an inactivity watchdog per active turn (reset on any session event for that turn) that
emits a diagnosable `turn.completed{state:"failed"}` and clears state, rather than wedging.

### A5 — LOW: reaper depends on projection-visible `activeTurnId`

`ProviderSessionReaper.ts:55` skips threads with `session.activeTurnId != null`. A1 nulls that
mid-retry. Real trigger requires 30 min of inactivity (`DEFAULT_INACTIVITY_THRESHOLD_MS`) versus
a 2–8s backoff window, so this is not a practical cause of death today — noted only because A1
makes the guard unreliable in principle, and it becomes reachable if retry backoff ever grows.

### A6 — Config knobs ADE never sets (worth a decision, not a bug)

Pi exposes `retry.maxRetries` (3), `retry.baseDelayMs` (2000), `retry.provider.timeoutMs`,
`httpIdleTimeoutMs` (300000), `websocketConnectTimeoutMs` (15000). ADE sets none of them; Pi
defaults apply. `docs/settings.md:147` explicitly warns to keep `retry.provider.maxRetries` at
`0` — SDK-level retries can mask out-of-usage-limit errors and block the agent until quota
resets. Since Pi-first resilience is the goal, these should become an explicit, documented ADE
choice rather than an inherited default.

---

## B. Performance

### B1 — CRITICAL: O(n²) serialization per streaming turn

Every `message_update` delta attaches the **entire** Pi event as `raw.payload`
(`PiAdapter.ts:1775`, `1802`):

```ts
raw: { source: "pi.sdk.event", messageType: event.type, payload: event },
```

`MessageUpdateEvent` is `{ type, message: AgentMessage, assistantMessageEvent }`
(`extensions/types.d.ts:561-565`) — `message` is the **full accumulated assistant message**, not
the delta. So each token's event embeds the whole response so far.

That payload is then JSON-serialized **twice** per event:

1. `offerRuntimeEvent` → `compactProviderRuntimeEventForIngress(event)` →
   `providerRuntimeEventBytes(event)` → `JSON.stringify` (`providerRuntimeEventIngress.ts:13`)
2. `runtimeEventIngress.offer(compacted)` → `options.sizeOf(item)` → `providerRuntimeEventBytes`
   again (`boundedCallbackIngress.ts:122`)

Cost per delta is O(response-so-far), so total cost per turn is **O(n²)** in response length.
A 50 KB response streamed over ~5k deltas serializes on the order of hundreds of MB of JSON —
on the server's event hot path, per turn.

This is a Pi-specific outlier. `ClaudeAdapter.ts:2645-2649` attaches the *stream event*
(`content_block_delta`), which is O(delta) and bounded. Pi is the only adapter whose per-delta
raw payload grows with the message.

**Second-order effect that ties back to Part A:** the ingress byte budget is 32 MB
(`PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES`) across capacity 2048
(`PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY`). Inflated delta events consume that budget
far faster than necessary, and `boundedCallbackIngress.offer` **silently drops** non-terminal
events on overflow (`dropped += 1`, line 144-146). Dropped deltas = missing assistant text in
the UI = another "agent broke" symptom, arising purely from payload bloat.

Note `compactProviderRuntimeEventForIngress` truncates only *after* stringifying, at a 512 KB
threshold — so the expensive serialization happens on every delta regardless.

**Fix:** for delta events emit `payload: { assistantMessageEvent }` (or just the delta) instead
of the whole event; and thread the byte count computed in `compact...` into `offer` so the
second `JSON.stringify` disappears. The `sizeOf` de-duplication benefits **all** providers, not
just Pi.

### B2 — HIGH: unbounded per-delta item accumulation

`recordItem` (line 1693) is called on **every** text and thinking delta (lines 1765, 1792):

```ts
const recordItem = (context, item) => {
  const turn = context.activeTurnId
    ? context.turns.find((c) => c.id === context.activeTurnId)   // linear scan per delta
    : context.turns.at(-1);
  turn?.items.push(item);                                        // one object per token
};
```

Two problems, both per-token:

- `context.turns.find(...)` is a linear scan over all turns in the session — on a 200-turn
  thread that is 200 comparisons per token.
- `turn.items` gains one `{type, delta}` object per token and is **never trimmed**.
  `context.turns` lives for the whole session, so this is unbounded memory growth for the
  lifetime of the thread.

`snapshotThread` (line 2629) then does `[...activeTurn.items]`, copying the entire array.

Server memory pressure is itself a cause of mid-turn death, so B2 feeds Part A.

**Fix:** cache the active turn object on `PiSessionContext` (invalidate on turn change), and
coalesce deltas by appending into the current item's text instead of pushing one item per token.

### B3 — MEDIUM: duplicate `sizeOf` stringify affects every provider

Independent of Pi: the `compactProviderRuntimeEventForIngress` → `offer(sizeOf)` pair always
stringifies twice. Returning `{event, bytes}` from compaction and accepting a precomputed size
in `offer` removes one full serialization from every runtime event in the system.

### B4 — LOW

- `buildPromptPayload` reads image attachments with `{ concurrency: 1 }` (line 2386) — turn-start
  only, not hot.
- `mapMessageHistory` is O(all messages) but only reached via `readThread`, which for Pi is the
  import path, not the streaming path.
- `crypto.randomUUID()` once per event in `makePiRuntimeEventBase` — measurable at high delta
  rates, but minor next to B1/B2.

---

## Recommended order

Sequenced by impact-per-unit-risk. 1–2 are the ones that make agents stop dying.

| # | Change | Fixes | Risk |
|---|---|---|---|
| 1 | Honor `agent_end.willRetry`; finalize on `agent_settled` | A1 | Medium — core lifecycle |
| 2 | Slim delta `raw.payload` to the delta | B1, and the drop path | Low |
| 3 | Handle `auto_retry_*`, `extension_error`, `queue_update`, `summarization_retry_*` | A3 | Low — additive |
| 4 | Coalesce `recordItem` deltas + cache active turn | B2 | Low |
| 5 | Single `sizeOf` stringify in the ingress pair | B3, all providers | Low |
| 6 | Turn inactivity watchdog | A4 | Medium — needs a threshold decision |
| 7 | Honor `compaction_end.willRetry`/`errorMessage`, surface `reason` | A2 | Low — cosmetic |
| 8 | Decide + document explicit `retry` / timeout settings | A6 | Low, needs user call |

Items 1, 3, 7 are all inside `handleSessionEvent` and share one test fixture — worth landing as
one branch (`app/pi-turn-resilience`) rather than three.

## Blast radius: backend only

All items land in `apps/server/`. Verified no downstream change is required:

- **`packages/contracts`** — untouched. Every event type the fixes emit already exists:
  `runtime.warning` (`providerRuntime.ts:203`), `context_compaction` (`:136`), `tool.progress`,
  `turn.completed`. No schema change, so no contract/version coordination.
- **`apps/web`** — untouched. `runtime.warning` already flows through `apps/web/src/workLog.ts`;
  compaction already renders via `providerRuntimeActivityProjection.ts:797-824`. The fixes change
  *when* and *how correctly* events are emitted, not their shape, so the UI improves without
  edits.
- **`harness/extensions`** — untouched, but A3 is what finally makes extension errors visible
  there.

## Test coverage gap

`PiAdapter.test.ts` (491 lines) contains **no** `agent_end`, `agent_start`, or `turn.completed`
test. The entire turn lifecycle — the thing failing here — is untested. Any fix to item 1 should
land with a fixture driving `agent_end{willRetry:true}` → deltas → `agent_end{willRetry:false}`
→ `agent_settled`, asserting exactly one `turn.completed`.

## Boundary note

All of this is in `apps/server/` = Synara ground per AGENTS.md. These are Pi-specific correctness
fixes in the file AGENTS.md already designates as the main Pi bridge (`Layers/PiAdapter.ts`), so
they fit the "touch Synara ground only for Pi" rule. B3 is the one genuinely provider-generic
change — small and isolated, but flag it in the commit message for upstream conflict resolution.

## Unresolved questions

1. Turn watchdog threshold (A4) — what inactivity window counts as wedged? Must exceed the
   longest legitimate silent stretch (xhigh reasoning on Fable, long `bash`).
2. A6 — keep Pi retry defaults, or raise `maxRetries` for a Pi-first daily driver?
3. Should `willRetry` retries be visible in the transcript (warning items) or silent until final
   failure? Affects A1/A3 UX.
