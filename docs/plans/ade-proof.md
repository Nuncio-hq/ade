# ade-proof — proof-of-work capture plugin (plan)

> Status: approved 2026-07-29, P0 core+tests complete; P1 core/CLI/backends in progress by sibling agents.
> (phases 1–4; phase 5 touches `apps/` and ships extension+bridge in one PR per
> AGENTS.md). Research session artifacts: OMP extension API scout + NuncioADE
> bridge scout (2026-07-29 chat thread).

## 1. Why

Devin Cloud and Cursor Cloud attach visual proof (screenshots, video, logs) to
every implemented feature so the human verifies work in seconds instead of
mentally simulating a diff. NuncioADE agents build UI blind today. The market
offers no adoptable turnkey: every OSS workflow layer is dead or pivoted
(proofshot dormant since 2026-04-14, solo author; web-eval-agent dormant since
2026-02; magnitude pivoted away), while the primitives layer is healthy and
corporate-backed (chrome-devtools-mcp 48k★ Google, agent-browser 39k★ Vercel,
playwright-mcp 36k★ Microsoft). Conclusion: own the thin workflow layer, stand
on unmodified primitives, never fork either.

## 2. Shape

One core, thin adapters. The **artifact contract is the product**; capture
backends and delivery adapters are plugins around it.

```
packages/ade-proof/            @nuncio/ade-proof (Bun/TS)
  src/core/                    session state, manifest writer, SUMMARY.md,
                               error-pattern scan (vendored from proofshot, MIT)
  src/capture/                 backends, one file each:
                               web.ts       puppeteer-core + system Chrome (CDP)
                               macos.ts     screencapture -l <windowid>
                               electron.ts  CDP attach (--remote-debugging-port)   [later]
                               ios-sim.ts   xcrun simctl io booted screenshot      [later]
                               android.ts   adb exec-out screencap                 [later]
  src/cli.ts                   ade-proof start|shot|record|stop|pr
  src/mcp.ts                   stdio MCP server (@modelcontextprotocol/sdk)
harness/extensions/ade-proof/  OMP extension: registers ade_proof_shot, nudges,
                               session_stop gate; shells out to the CLI
```

Naming (fixed): package `@nuncio/ade-proof`; MCP server key `ade-proof`; MCP
tools `proof_start` / `proof_shot` / `proof_record` / `proof_stop`; OMP
extension tool `ade_proof_shot`; slash command `/ade-proof`; artifacts in
`<workspace>/.ade/proof/` (gitignored).

## 3. Artifact contract (freeze in phase 1)

`.ade/proof/<yyyymmdd-hhmmss>-<slug>/`:

- `manifest.json` — `{ version: 1, description, startedAt, finishedAt, steps:
[{ ts, label, target, file, url? }], errors: [{ source: console|server,
pattern, line }], serverCmd?, video? }`
- `step-*.png`, `session.webm?`, `server.log?`, `SUMMARY.md`

Rules learned from the bridge scout (do not violate):

- **File paths, never inline base64** — sidecar ingress compacts provider
  runtime events > 512 KiB (`packages/omp-sidecar/src/event-ingress.ts`).
- Files live under the workspace so the existing web render path works with
  zero app changes: assistant markdown `![](.ade/proof/…png)` → `ChatMarkdown`
  → `GeneratedMarkdownImage` → `GET /api/local-image` (workspace-root
  allowlist in `apps/server/src/localImageFiles.ts`).
- Sidecar `tool-projection.ts` drops image content blocks; in NuncioADE the
  markdown path is the render channel. `ImageContent` blocks are TUI-only
  garnish.

## 4. Phases

**P0 — TDD: contract tests + edge-case catalog (before any implementation).**
Scaffold `packages/ade-proof` with Vitest wired into the workspace (`bun run
test`, never `bun test`). Write the tests that define the product, red first:

- **Manifest schema tests** — valid/invalid manifests, version field,
  forward-compat (unknown keys ignored), atomic write (tmp+rename; a killed
  writer never leaves a half manifest).
- **Session lifecycle state machine** (pure, no I/O) — every transition in
  §Edge-case catalog A has a test before the state machine exists.
- **Path/slug pure functions** — slug collisions get monotonic suffixes;
  output paths are workspace-relative, URL-safe (no spaces — `/api/local-image`
  markdown refs must survive), unicode workspace paths, cwd = subdir of
  workspace resolves to workspace root.
- **Error-pattern scan** — fixture logs per pattern; "0 errors"/"error-free"
  false-positive guards; multiline stack trace counted once; ANSI stripped.
- **Capture backend contract** — backends implement one interface
  (`capture(req) → {file, meta} | typed error`); a fake backend runs the full
  CLI/session pipeline in tests; real web/macos backends live behind
  `ADE_PROOF_LIVE=1` integration tests (headless Chrome not assumed in CI).

Deliverable: failing test suite + the catalog below encoded as cases (each
entry cites its test id). Accept: `bun run test` runs the suite; every
catalog-A/B/C case has a test or an explicit "deferred to Pn" note in code.

**P1 — core + CLI (backends: web, macos).**
`proof_start` (mkdir session, optional `--run` dev-server spawn with log tee),
`proof_shot` (web: goto→screenshot via puppeteer-core reusing system Chrome —
crib Chrome resolution from OMP `src/tools/browser/launch.ts`; macos:
`screencapture -l`), `proof_stop` (error-pattern scan over console/server
logs, write SUMMARY.md + manifest). Vendor `error-patterns.ts` + SUMMARY
format from proofshot (MIT, attribution comment). `.ade/` into workspace
`.gitignore` guidance. Accept: manual run in `playground/`, screenshot renders
in a NuncioADE chat message via markdown path.

**P2 — MCP adapter.** `src/mcp.ts` exposes the four `proof_*` tools over
stdio. Register as external MCP in NuncioADE → every provider thread (codex,
claudeAgent, cursor, …) gets them. Division of labor: agents that need to
_drive_ a browser (login, multi-step nav) use chrome-devtools-mcp (registered
unmodified, zero code); `proof_shot` only captures final state + writes the
contract. Accept: a Codex thread calls `proof_shot` successfully.

**P3 — OMP extension.** `harness/extensions/ade-proof/`: `registerTool`
(`ade_proof_shot` → exec CLI; result = ImageContent for TUI + markdown path
for web), `tool_result` watcher (successful `git commit` → `sendMessage`
nudge), `session_stop` gate (UI files changed or commit made with no proof
this session → request continuation once). Events per OMP snapshot
`src/extensibility/extensions/types.ts` / `shared-events.ts`. Accept: E2E in
dev instance — agent changes playground UI, captures proof before finishing.

**P4 — skills/prompts.** OMP skill + generic AGENTS.md snippet: when to
capture (feature with visible surface), labeling, what never to capture
(secrets, credential screens). Skill teaches; tool does; extension enforces
(OMP only — non-OMP engines get prompt-level discipline, stated honestly).

**P5 — UI + video (touches apps/).** Proof panel in web UI reading
`manifest.json` per thread (gallery, timeline, video player); `proof_record`
via CDP screencast → webm; optional `ade-proof pr` (gh) posting SUMMARY +
images to the PR. Do only after P1–P3 are dogfooded; markdown render is the
daily-driver baseline.

## 5. Edge-case catalog (P0 input — each entry becomes a test)

**A. Session lifecycle**

- `shot`/`stop` with no active session → typed error with hint, never implicit
  start.
- `start` over a live session → error; `--force` reclaims only when the lock's
  pid is dead (crash recovery). Lock = `.ade/proof/.lock` with pid + session id.
- Double `stop` → idempotent no-op with warning, manifest not rewritten.
- **Concurrent sessions in one workspace** (NuncioADE runs parallel agent
  threads): sessions are keyed by id, `proof_shot {session?}` defaults to the
  caller's; two sessions never share a dir or lock each other out. This is a
  first-class case, not a corner.
- Crash mid-session: orphaned `--run` children (spawn in own process group,
  kill group on stop/reclaim); half-written manifest impossible by
  construction (atomic write); next `start` reports the abandoned session in
  its output.

**B. Capture — web**

- Dev server not listening: `start --run` waits for port with timeout; `shot`
  against a dead URL → typed error naming the port, plus server.log tail.
- Page 4xx/5xx: still capture (failure evidence is valid proof) but record
  `httpStatus` in the step and flag it in SUMMARY.
- Redirect (e.g. to login): capture, but record `finalUrl`; SUMMARY flags
  `requestedUrl ≠ finalUrl` so a wrong-page proof is self-incriminating.
- Page never settles (SSE/WebSocket apps — NuncioADE itself): wait strategy is
  `load` + fixed settle delay with a hard cap, never `networkidle`.
- Chrome not found / launch fails → doctor-style error listing probed paths.
- Determinism: fixed viewport + DPR 1, `prefers-reduced-motion`, caret hidden;
  retina hosts must not double artifact size.
- Element capture: selector not found → typed error, no silent full-page
  fallback. Full-page on huge pages: height cap with explicit `truncated` flag.
- Cookie/storage-state file invalid or expired → typed error before navigation.

**C. Artifacts & contract**

- Slug/label collisions within a second → monotonic counter suffix.
- Workspace paths with spaces/unicode; cwd deep inside the workspace; git
  worktrees (workspace root ≠ main repo root — resolve via git root of cwd).
- `.gitignore` missing the `.ade/` entry → warn in `stop` output and SUMMARY;
  never edit the user's files silently.
- Disk-full / EACCES on write → typed error; session stays recoverable.
- Markdown refs emitted by tools are always workspace-relative and URL-safe.
- Server log: ANSI stripped, size-capped with head+tail retention (never
  unbounded), encoding errors replaced not fatal.

**D. Adapters (tested in their phases, cataloged now)**

- MCP (P2): tool results carry paths + short text only (never image bytes);
  two parallel threads calling `proof_shot` concurrently; MCP process restart
  mid-session recovers from on-disk state.
- macOS backend (P1): window title with zero/multiple matches → error listing
  candidates; Screen Recording permission missing → detect (all-black/empty
  output) and name the fix; minimized/occluded windows.
- `--run` (P1): command exits immediately → surface exit code + stderr tail in
  the error; port already bound → name the occupying pid.
- OMP extension (P3): `session_stop` continuation fires **at most once per
  session** (loop guard is a test, not a hope); "UI files changed" heuristic
  false-positives documented with fixtures.

## 6. Non-goals

- No browser _driving_ primitives (click/fill/nav) in ade-proof — that layer
  belongs to chrome-devtools-mcp/OMP browser tool; every OSS project that
  bundled both died maintaining the wrong half.
- No forks: chrome-devtools-mcp, agent-browser, playwright-mcp are consumed
  as-is or not at all. proofshot is a snippet donor, never a dependency.
- No verification claims: proof is evidence for the human, not a green
  checkmark. A screenshot proves rendering, not correctness.
- Real iOS devices, Windows/Linux backends: out of scope until needed.

## 7. Risks

- Headless capture of auth'd apps → `proof_shot` accepts cookie/storage-state
  injection (P1 design, even if P1 ships localhost-only).
- macOS Screen Recording permission: one-time grant per host binary; document
  in the skill.
- Artifact bloat: videos never committed; `.ade/proof/` gitignored; PR upload
  is the sharing channel.
- Enforcement outside OMP is advisory forever; do not promise Devin-grade
  gating for non-OMP providers.
