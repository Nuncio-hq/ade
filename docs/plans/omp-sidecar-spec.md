# OMP Bun sidecar — design spec

> Status: shipped (2026-07-28). Supersedes the in-process half of the
> 2026-07-28 "direct SDK" decision. Tracker: `docs/plans/omp-integration.html`
> (M4 phase 6). Branch: `app/omp-adapter`. Verified in the dev instance and in
> a packaged `NuncioADE.app`.

## 1. Why

`@oh-my-pi/pi-coding-agent@17.1.6` is **Bun-only by construction**, so the OMP
adapter built in M4 phases 1–5 cannot run inside the packaged app:

| Evidence                                                                                                  | Source                                                                                  |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Runtime entry is TypeScript source (`"import": "./src/index.ts"`; `dist/` holds only `cli.js` + `types/`) | package.json of the installed 17.1.6                                                    |
| Electron's Node v24 refuses it: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`                             | `ELECTRON_RUN_AS_NODE=1 NuncioADE -e "import(...)"`                                     |
| Bundling cannot fix it: 19 files import `bun:*`, 145 use `Bun.*` globals                                  | grep over the package source                                                            |
| The packaged backend is Node                                                                              | `apps/desktop/src/main.ts:3246` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` |

Measured on this machine (M5 Pro, omp 17.1.6, Bun 1.3.14), three sessions:

|                          | SDK in Node backend       | `omp --mode rpc`                                                                                      | **compiled Bun sidecar** |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| First session ready      | impossible (see above)    | 895 ms                                                                                                | **107 ms**               |
| RSS, 3 sessions          | 431 MiB (if it could run) | 1264 MiB                                                                                              | **397 MiB**              |
| Marginal RSS per session | ~10–45 MiB                | ~420 MiB                                                                                              | **~8–55 MiB**            |
| Rich `askDialog`         | yes                       | **no** — `modes/rpc/` has no `askDialog`, so the native `ask` tool degrades to single-choice `select` | yes                      |
| Upstream files touched   | packaging + persistence   | none                                                                                                  | `extraResources` only    |

`omp --mode rpc` is also one session per process (no `sessionId` on any command;
`new_session`/`switch_session` swap the process's single session), which is where
its memory profile comes from.

End-to-end proof of the sidecar, from a compiled binary in a directory holding
nothing but the binary and one `.node` file:

```json
{
  "execPath": "/private/tmp/sidecar-isolated/omp-turn",
  "model": "gpt-5.4-mini",
  "readyMs": 107,
  "turnMs": 7066,
  "toolsUsed": ["bash"],
  "sawBashOutput": true,
  "eventTypes": [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "notice",
    "turn_end",
    "agent_end"
  ]
}
```

Auth discovery, model resolution, the native brush shell, the full event stream
and teardown all work with zero `node_modules` on disk.

## 2. Shape

```
Electron main (Node)
└── Synara server (Node, inside app.asar)          ← unchanged
    └── OmpAdapter  ──stdio NDJSON──►  omp-sidecar (compiled Bun binary)
                                       └── @oh-my-pi/pi-coding-agent SDK
                                           ├── N AgentSessions (one per thread)
                                           ├── event mapping → ProviderRuntimeEvent
                                           ├── extension UI context (ask dialog)
                                           └── synara_* gateway tools
```

**One sidecar process hosts every OMP thread.** That is the whole memory
argument: a second session costs ~8–55 MiB, a second process costs ~420 MiB.
The trade is that one engine crash takes down all OMP threads at once —
acceptable because §7 restarts the sidecar and every thread resumes from its
session file (already implemented in phase 5).

The adapter spawns and supervises the sidecar exactly the way
`OpenCodeAdapter`, `KiloAdapter`, and `PiAdapter` already spawn child
processes. No change to `apps/desktop/src/main.ts`, no change to the asar
layout.

## 3. Module split

New workspace package `@nuncio/omp-sidecar` (`packages/omp-sidecar/`) — ours, so
`@nuncio` naming per AGENTS.md.

Moves **into** the sidecar, unchanged in substance:

| Today                                                                                      | Becomes                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `provider/Layers/OmpAdapter.ts` — session creation, event switch, watchdog, turn lifecycle | `packages/omp-sidecar/src/session-host.ts` + `event-mapping.ts` |
| `provider/ompExtensionUiContext.ts`                                                        | `packages/omp-sidecar/src/extension-ui-context.ts`              |
| `provider/ompGatewayTools.ts`                                                              | `packages/omp-sidecar/src/gateway-tools.ts`                     |
| `provider/ompTurnFailure.ts`, `provider/agentToolProjection.ts`                            | shared by both sides via `@synara/contracts`-adjacent imports   |

Stays in `apps/server` (Node):

- `provider/Layers/OmpAdapter.ts` shrinks to: Effect layer, process supervisor,
  NDJSON client, request/response correlation, and the `ProviderAdapterShape`
  surface. Its public behaviour — and therefore most of
  `OmpAdapter.turnLifecycle.test.ts` — is unchanged; the `loadSdk` seam is
  replaced by a `spawnSidecar` seam.

**The wire carries canonical `ProviderRuntimeEvent`s.** The sidecar imports
`@synara/contracts` (plain TypeScript, Bun compiles it) and does the mapping,
so the Node side is a thin decoder and the phase-3/4 mapping work survives the
move intact.

## 4. Protocol

NDJSON over stdio: one JSON object per line, UTF-8, `\n`-terminated. stdout is
the protocol channel and nothing else may write to it (the sidecar redirects
engine logging to stderr). stderr is captured into the provider log.

### Frames

```ts
// sidecar → server, first line after spawn
{ type: "hello", protocolVersion: 1, engineVersion: "17.1.6", pid: 1234 }

// server → sidecar
{ id: "r1", type: "request", method: "session/start", params: { …ProviderStartSessionInput } }

// sidecar → server, correlated by id
{ id: "r1", type: "response", ok: true, result: { …ProviderSession } }
{ id: "r1", type: "response", ok: false, error: { method, detail, cause? } }

// sidecar → server, unsolicited
{ type: "event", threadId: "…", event: { …ProviderRuntimeEvent } }
```

### Methods

Mirror `OmpAdapterShape` one for one, so the adapter stays a pass-through:
`session/start`, `turn/send`, `turn/steer`, `turn/interrupt`, `task/stop`,
`user-input/respond`, `session/stop`, `session/list`, `session/has`,
`thread/read`, `thread/rollback`, `thread/compact`, `model/list`, `skill/list`,
`command/list`, `composer/capabilities`, `session/stop-all`.

### Rules

- **Max line 1 MiB.** Attachments and images are passed **by absolute path**,
  never inline base64 — the sidecar runs on the same machine and reads the file
  itself. This keeps every frame small and removes the need for the chunking
  layer OMP's own RPC mode had to build.
- **Version gate.** The server accepts `protocolVersion: 1` only. A mismatch
  marks OMP unavailable and emits `runtime.warning` with the reason, the same
  way a missing gateway does today — never a silent empty model list.
- **Backpressure.** The sidecar honours `stdout.write` drain before emitting the
  next frame; the server feeds decoded events through the existing
  `makeBoundedCallbackIngress`, so the bounded-queue behaviour of phases 2–3 is
  unchanged.
- **No request may block another.** Each request is handled independently; the
  sidecar never serialises turns across threads.

### Gateway credentials

`session/start` params carry `{ url, bearerToken }` for the thread-scoped
Synara MCP endpoint. The sidecar fetches the catalog over loopback HTTP exactly
as `ompGatewayTools.ts` does today, keeping `strict: false` and
`loadMode: "essential"`.

## 5. Packaging

|              | Dev                                                                           | Packaged                                       |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Sidecar      | `bun run packages/omp-sidecar/src/main.ts` — no compile step in the edit loop | compiled binary in `process.resourcesPath`     |
| Native addon | resolved from `node_modules` by the engine                                    | `pi_natives.<platform>.node` beside the binary |

- Build: `bun build --compile --target=bun-<platform>-<arch> --external omp-legacy-pi-modules --external "*.node"`. Both externals are required: the
  first is a runtime-only specifier OMP resolves lazily, the second keeps native
  addons out of the bundle.
- Ship via `extraResources` in `scripts/lib/desktop-platform-build-config.ts` —
  the one packaging file upstream has not touched since v0.6.0.
- `@oh-my-pi/*` leaves `apps/server`'s dependency graph, so the server bundle
  shrinks by roughly what the sidecar adds (~91 MiB binary).
- Override for local debugging: `NUNCIO_OMP_SIDECAR_PATH`.

## 6. Failure modes

| Failure                                 | Behaviour                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sidecar binary missing / wrong protocol | OMP provider reports unavailable; `runtime.warning` names the reason; other providers unaffected                                           |
| Sidecar crashes                         | Supervisor restarts it with bounded backoff; live threads emit `turn.completed{state:"failed"}` and are resumable from their session files |
| Sidecar hangs                           | The existing 10-minute turn watchdog (phase 3) stays inside the sidecar; the server additionally times out individual requests             |
| Server exits                            | Sidecar sees stdin EOF and disposes every session — `abort()` reaps the engine's brush-shell children (verified in the M4 spike)           |
| Orphan after SIGKILL                    | Sidecar registers no external state; session files are the only durable artefact and are safe to reopen                                    |

## 7. Phases

| Phase | Work                                                                                                          | Acceptance                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 6.1   | `packages/omp-sidecar` skeleton, protocol types, `hello` handshake, compile script                            | `bun run` and compiled binary both emit `hello`; CI builds the binary for darwin-arm64                               |
| 6.2   | Move session host, event mapping, UI context, gateway tools; adapter becomes client                           | Dev instance: OMP thread streams chat, ask dialog answers, `synara_context` runs — parity with today's dev behaviour |
| 6.3   | Packaging: extraResources, native placement, path resolver                                                    | Packaged app: OMP model list populated, a turn with a `bash` tool call succeeds                                      |
| 6.4   | Supervisor: restart with backoff, resume after restart, failure surfaced as `runtime.warning`, orphan reaping | Kill the sidecar mid-turn → thread reports failure, next turn resumes with history intact                            |

Phase 5's remaining item (dogfooding in the packaged app) reopens after 6.3.

## 8. What this does not fix

Dev runs the server under Bun, the packaged app runs it under Node. That skew
predates OMP — it is why `NodeSqliteClient`'s static `node:sqlite` import is
dead code in dev and live in production — and the sidecar does not address it.
Worth solving separately; not a reason to move the whole backend to Bun.
