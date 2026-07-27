# DELEGATION — subscriptions, models, and when to spawn which agent

> For agents working on NuncioADE inside Synara/ADE. You can spawn threads on
> other providers (`synara_create_threads`) or shell out to the Devin CLI.
> Use the user's subscriptions deliberately — right model for the job, not the
> cheapest or the nearest.

## Summary table

| Work | First choice | Alternative |
| --- | --- | --- |
| Backend implementation | Codex `gpt-5.6-sol` (fast priority OK) | Cursor API pool Opus |
| Code review | Codex `gpt-5.6-sol` | Claude Fable 5 (see safeguards caveat) |
| Dev + UI design | Claude Opus 5 (Claude Max) | Cursor API pool Opus/Fable |
| Ordinary/mechanical tasks | Cursor Auto pool: Grok 4.5 high + fast | Devin SWE-1.7 (free promo) |
| Review/planning (2nd opinion) | Claude Fable 5 | Opus 5 |
| Async end-to-end task with visual proof | Devin Cloud handoff (fusion) | — |

## 1) Claude Max (`claudeAgent` provider)

The Claude Code harness on the user's Claude Max subscription.

- **Opus 5** (`model: "opus"`, `options.effort`) — dev work and UI design.
- **Fable 5** (`model: "claude-fable-5[1m]"`) — reviews, planning, second opinions.
- **Fable safeguards caveat**: Fable 5 has strong safety guardrails and can
  refuse or derail on network/security-adjacent work (pentesting-flavored tasks,
  auth internals, proxies). For those reviews use Opus 5 or `gpt-5.6-sol` instead.
- Note: our own Pi threads also run Fable 5, but through pi's harness. Spawning
  `claudeAgent` is how you inherit the Claude Code harness (hooks, skills, plan mode).

## 2) Codex (`codex` provider)

- **`gpt-5.6-sol`** (`options.reasoningEffort`: low…ultra) — strongest for backend
  implementation and code review. Quota is plentiful: **fast/priority is fine**.
- Good default for bulk mechanical work with a clear spec.

## 3) Cursor (`cursor` provider, Ultra plan) — TWO quota pools

- **Auto pool** (cheap): only **`grok-4.5`** is worth using — `reasoningEffort:
  "high"` + fast mode. Use for ordinary tasks. Don't bother with other Auto-pool models.
- **API Usage pool** (expensive): use **`claude-fable-5`** and **`claude-opus-5`**
  only, and **never fast mode** there (fast burns API quota for no quality gain).
  Point of this pool: frontier models inside Cursor's harness — the user's #1 harness.
- Don't use the API pool for work the Auto pool or Codex can do.

## 4) Devin (Ultra plan) — CLI only, not a Synara provider

Spawn via Bash: `devin -p "<self-contained prompt>" --model <model>` (or
interactive/ACP). Weekly limit — spend on what Devin is uniquely good at.

- **`swe-1-7`** — free promo right now; fine for ordinary tasks at zero cost.
- **`swe-1-7-lightning`** — paid fast variant, no promo: **do not use**.
- Frontier models (`claude-opus-5-*`, `claude-5-fable-*`, `gpt-5-6-sol-*`)
  available; avoid `-fast`/`-priority` variants.
- **Devin Cloud handoff** — the unique capability: async end-to-end sessions with
  **Fusion** mode (official name, in Preview; "best balance of capability, speed,
  and cost" — Fable brainstorms/plans, a cheaper model executes) and
  **recordings/screenshots after implementation**. Use for tasks where visual
  proof of the result matters. (This record-and-screenshot idea is on our own
  roadmap for pi.)

## Checking quota before delegating

`openusage` CLI (installed at `/usr/local/bin/openusage`) reports live quota for
every subscription as JSON (5-min shared cache; `--force` to refresh; single
provider: `openusage claude`):

- `claude` — Max 20x: `session` (5h window), `weekly`, and `fable` (separate Fable weekly pool)
- `codex` — Pro 20x: `weekly`, `sparkWeekly`, rate-limit resets
- `cursor` — Ultra: `autoUsage` vs `apiUsage` — the two pools in section 3
- `devin` — `weekly` + extra-usage balance (USD)
- `grok` — free tier weekly

Use it when planning heavy delegation (parallel threads, long Devin sessions) or
when a provider starts erroring — check utilization/reset times and route to a
pool with headroom instead of hammering an exhausted one.

## Ground rules

- Prompts to spawned agents must be self-contained: goal, context, files in
  scope, constraints, expected deliverable, how to verify.
- Parallel implementation agents need isolated worktrees (Synara worktree threads).
- Judge output, not price: if a cheaper model's result doesn't meet the bar,
  redo with a stronger one instead of shipping mediocre work.
- Exact provider/model slugs and option keys: always confirm via
  `synara_capabilities` before creating threads; for Devin, `devin models list`.
