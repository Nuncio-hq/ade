# STATE — current direction (keep under ~50 lines)

> Update this file whenever direction, milestones, or components change.
> Detail and rationale go to `DECISIONS.md`. Rules live in `AGENTS.md`.

## Direction

NuncioADE (repo `Nuncio-hq/ade`, public — release preflight requires it) =
Synara fork, **OMP-first** (since
2026-07-28; was Pi-first). Current scope: (1) OMP as first-class engine — new
`OmpAdapter` over the `@oh-my-pi/pi-coding-agent` SDK (M4, docs-only so far);
(2) harness via OMP extension points (`harness/extensions/`, skills/plugins),
no engine source fork; (3) UI for extensions when the bridge needs it;
(4) mobile (native, no PWA). Everything else — UI/UX, general features — is
inherited from Synara upstream. Pi provider frozen: works, gets no investment.
Synara-inherited code (`apps/`, `packages/`) is touched only to close bridge gaps.
All Synara-inherited providers are kept working.

## Milestones

- [x] **M0 Baseline** — clone, merge upstream, `bun install`, isolated dev instance
      runs (`.ade-dev/`, server :58090, web :8891), first extension (`ade_hello`)
      loads and is callable end-to-end (TUI + SDK path verified).
- [~] **M1 Harness v0** — real extensions in `harness/extensions/` (current).
  Shipped: AskUserQuestion (structured, notes + custom answers, E2E verified).
  Next: paused — revisit after M4 (OMP ships its own devin-agent).
- [~] **M2 Bridge gaps** — first bridge extension landed: `extension/ui/askUserQuestion`
  in PiAdapter + `allowNotes`/`allowCustomAnswer` on UserInputQuestion + notes UI.
- [~] **M3 Daily driver** — NuncioADE.app branded, built, installed; DB migrated
  from the old Synara install; user works in NuncioADE. **v0.0.3 released
  2026-07-29** (current latest): fixes the boot crash-loop when a build upgrade
  replays provider runtime events against receipts an older build recorded
  (stored receipts now win; see DECISIONS 2026-07-29). v0.0.2 (same day) was
  the first published GitHub release — signed + notarized mac arm64/x64
  dmg+zip, updater feed manifests (`latest-mac.yml`, `nuncioade-mac.yml`).
  Remaining: verify in-app auto-update end to end (v0.0.2 → v0.0.3 is the
  first chance).
- [x] **Rebrand** (2026-07-28, merged to `main`) — maximum rebrand
      Synara→NuncioADE across the whole tree via `scripts/rebrand-identity.ts`
      (deterministic, idempotent); supersedes the old no-rename law. Shipped:
      `nuncioade` CLI (+ `ade` alias), browser storage-key migration, managed
      codex-config marker normalization, external-MCP legacy prefix acceptance +
      frozen hash salt, DB migration 088 (audience constraint), `brand:check`
      guard extended + CI-enforced, `sync/rebranded-upstream` shadow branch for
      near-zero-conflict upstream syncs (rehearsed on v0.6.2: merged tree
      byte-identical). Left upstream: `trysynara.com` feedback/changelog endpoints.
- [ ] **M4 OMP engine** — `OmpAdapter` in `apps/server` (direct SDK:
      `createAgentSession`/`SessionManager`/`ModelRegistry` from
      `@oh-my-pi/pi-coding-agent` 17.x), models from OMP's registry,
      `harness/extensions/` verified under OMP (legacy `@earendil-works/*`
      shims), bisect tool switches `pi` TUI → `omp` CLI. Spike PASSED
      2026-07-28 (`playground/omp-spike`, SDK 17.1.6 under Bun: session 132ms;
      `abort()` reaps bash children natively — no process supervisor needed;
      `agent_settled` gone → `agent_end.isTerminal`; async jobs inject
      self-initiated follow-up turns). Plan + tracker + coverage gộp một doc:
      `docs/plans/omp-integration.html`. Phases 1–4 DONE 2026-07-28 on
      `app/omp-adapter`: "omp" ProviderKind + contracts/settings mirrors, the
      walking skeleton (`Services/OmpAdapter.ts` + `Layers/OmpAdapter.ts`, SDK
      pinned 17.1.6), event mapping v1 — tool items, reasoning, token
      usage, compaction/retry/notice status, todo → task list, `ompTurnFailure.ts` —
      then the bridge: `hasUI:true` + `setToolUIContext` route OMP's native `ask`
      and extension select/confirm/input onto Synara's user-input flow
      (`ompExtensionUiContext.ts`), `synara_*` gateway tools ride in as
      `customTools` (`ompGatewayTools.ts`; a supplied `mcpManager` would NOT
      register them — the engine only registers MCP tools on its own discovery
      path; they need `strict: false` or models over-fill optional args, and
      `"omp"` must sit in `PROVIDERS_WITH_THREAD_SCOPED_SYNARA_MCP` or the
      harness policy denies control the tools actually have), plus
      stopTask/compactThread/listSkills/listCommands. Both lifecycle
      risks closed: an async-result follow-up keeps the same turn id (engine
      probe + tests in `OmpAdapter.turnLifecycle.test.ts`), and a turn the engine
      abandons is freed by a watchdog that re-arms while `asyncJobManager` still
      reports work. Phase 5 found the blocker: **the OMP SDK is Bun-only**
      (entry is `./src/index.ts`; 19 files import `bun:*`, 145 use `Bun.*`), and
      the packaged backend is Node (`main.ts:3246`), so a real NuncioADE.app
      build shows an empty OMP model list. Direction: host the SDK in a
      compiled Bun sidecar — `docs/plans/omp-sidecar-spec.md`, tracker phase 6.
      Measured 3 sessions: sidecar 107ms/397MiB vs `omp --mode rpc`
      895ms/1264MiB, and RPC has no `askDialog` (native `ask` degrades to a
      single-choice select). Phase 5 shipped dev-side: session resume mints its
      own session file (`SessionManager.create` stamps an unsuppressable
      terminal breadcrumb that hijacks the user's own `omp` CLI), engine feature
      flags reviewed with a reason each (`enableLsp` now ON — `lsp.lazy`
      defaults true so startup is discovery only), and OMP appears in Settings →
      Installed CLIs. Phase 6 DONE 2026-07-28: the engine moved into
      `packages/omp-sidecar` (`@nuncio/omp-sidecar`, our first `@nuncio/*`
      package) — a compiled Bun binary speaking NDJSON over stdio, with
      `OmpAdapter` as its supervisor client. Verified end to end in the dev
      instance (OMP thread, bash tool, reply) and in a real `NuncioADE.app`
      (binary + `pi_natives` in `Contents/Resources/omp-sidecar/`, 334 models,
      `turn.completed` with a `command_execution` item). M4 remaining: run OMP
      as the daily driver.
- [ ] **M5 ade-proof** — proof-of-work capture plugin (approved 2026-07-29,
      not started): P0 TDD contract tests + edge-case catalog → `@nuncio/ade-proof` core+CLI (artifact contract
      `.ade/proof/`, backends web/macos first) → stdio MCP for all providers →
      OMP extension (`ade_proof_shot`, `session_stop` gate) → skills → web UI
      panel + video last. chrome-devtools-mcp consumed unmodified for browser
      driving; no proofshot dependency. Plan: `docs/plans/ade-proof.md`.

## In force

- Branching: trunk-based on `main`; short-lived branches `harness/*`, `app/*`,
  `mobile/*`, `sync/upstream-<version>`. No long-lived dev branch; ONE exception:
  `sync/rebranded-upstream` (mechanical shadow: latest upstream tag + codemod,
  see `docs/UPSTREAM-SYNC.md`). Release = tag on main, gated by dogfooding the
  dev instance. See AGENTS.md §Branching.
- Mobile: end goal is "your machine as cloud, agents" — phone is a remote
  client to the Mac-hosted server, never a Pi runtime. **Native app (Expo/RN),
  PWA skipped.** Near-term: use REMOTE.md (Tailscale + auth token) to reach the
  web UI from the phone and collect real mobile requirements.
- Naming: post-rebrand the whole tree is `@nuncio/*` / `NUNCIO_*` / `nuncioade` /
  `ade_` tools. Retired `synara` tokens survive only in attribution, exempt
  history, and `// rebrand-exempt` compat shims — enforced by `bun run
brand:check` in CI. See AGENTS.md §Naming & Identity.
- Versioning: ADE line = 0.0.x (currently 0.0.3, released 2026-07-29;
  v0.0.1 was tagged but never published — its release runs all failed),
  user-decided only, agents never bump/tag. Upstream base = `UPSTREAM-BASE`
  file. See AGENTS.md §Versioning & Releases. Toolchain note: Bun pinned
  1.3.14 — 1.3.12 has a compiled-binary codesign regression (oven-sh/bun
  #29361) that breaks signing the OMP sidecar.
- Upstream = `Emanuele-web04/synara`, remote `upstream`; **sync on release tags only** (base: v0.6.3, synced 2026-07-28 via the shadow flow), cherry-pick once diverged.
- Origin = `https://github.com/Nuncio-hq/ade` (public), `main` pushed and tracking.
- Extensions dev is project-local first, promote to global only when stable
  (pi: `.pi/extensions` → `~/.pi/agent/extensions/`; OMP: `.omp/extensions` →
  `~/.omp/agent/extensions/`). Symlinks point at `harness/extensions`.
- Bisect tool: `omp` CLI after M4 (pi TUI for the frozen pi provider); ADE
  stays the primary dev target.
- Runtime split: Synara's server stays **Node** (packaged, inside asar); the OMP
  SDK runs in a compiled **Bun** sidecar we own. Moving the whole backend to Bun
  was rejected — `bun build --compile` of the server dies on
  `NodeSqliteClient.ts`'s static `node:sqlite` import, so it would force
  unpacking the server from asar and diverging in packaging/signing, upstream's
  active patch area. Pre-existing skew stays: dev server runs Bun, packaged runs
  Node.
- Engine watch: OMP releases fast (17.1.6 pinned, 17.1.7 already out on
  2026-07-28); pin exact `@oh-my-pi/*` versions and bump deliberately. Old pi
  skew (CLI 0.82.x vs ^0.81.1) is moot — pi frozen.
- Rich fence content (mermaid today): the markdown fence IS the cross-engine
  contract; render via the web fence-renderer registry
  (`apps/web/src/lib/fenceRenderers.ts`), never via provider events. New
  renderable languages = new registry entry. See DECISIONS 2026-07-29.

## Deprecated / do not revive

- Pi-first direction (2026-07-26→28) — superseded by OMP-first. The pi
  provider itself is NOT deprecated: frozen, must keep working.
- "Port OMP ideas as pi extensions" strategy — OMP is the engine now.

## Known issues

- (RESOLVED 2026-07-29, via `fe53e80f` "CI repairs") the 35 web test failures
  and the 2 `@nuncio/cli` PiAdapter typecheck errors are gone: full `bun run
test` (10/10 tasks) and `bun run typecheck` (8/8) verified green locally on
  `app/mermaid-fence-renderer` (contains main).
- Installed NuncioADE.app lags main until rebuilt: harness extensions hot-load
  via /reload, but `apps/`/`packages/` changes need an app rebuild + reinstall.
- NEVER swap state.sqlite while the app runs (learned: disk I/O errors, app
  self-recovered). Quit app, `sqlite3 <src> ".backup <dst>"`, remove -shm/-wal.

## Reference material

- `../claude-oauth-pi/pkg-src/` — OMP tarball 17.1.3 (engine source, offline
  reading; npm canonical) + pi tarballs 0.82.1 (frozen provider reference).
- Old Synara snapshot at `~/Documents/Codex/2026-06-24/ba/work/synara` (v0.3.0, stale).
