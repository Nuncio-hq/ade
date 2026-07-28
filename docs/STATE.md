# STATE — current direction (keep under ~50 lines)

> Update this file whenever direction, milestones, or components change.
> Detail and rationale go to `DECISIONS.md`. Rules live in `AGENTS.md`.

## Direction

NuncioADE (repo `Nuncio-hq/ade`, private) = Synara fork, **OMP-first** (since
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
- [~] **M3 Daily driver** — STARTED: NuncioADE.app branded, built, installed;
  DB migrated from the old Synara install (sqlite .backup snapshot); user works
  in NuncioADE. Remaining: signed builds + no-script auto-update via GitHub releases.
- [x] **Rebrand** (2026-07-28, branch `app/rebrand-nuncioade`) — maximum rebrand
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
      `docs/plans/omp-integration.html`. Adapter code not started.

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
- Versioning: ADE line = 0.0.x (currently 0.0.1), user-decided only, agents never
  bump/tag. Upstream base = `UPSTREAM-BASE` file (currently v0.6.2). See AGENTS.md
  §Versioning & Releases.
- Upstream = `Emanuele-web04/synara`, remote `upstream`; **sync on release tags only** (base: v0.6.2, synced), cherry-pick once diverged.
- Origin = `https://github.com/Nuncio-hq/ade` (private), `main` pushed and tracking.
- Extensions dev is project-local first, promote to global only when stable
  (pi: `.pi/extensions` → `~/.pi/agent/extensions/`; OMP: `.omp/extensions` →
  `~/.omp/agent/extensions/`). Symlinks point at `harness/extensions`.
- Bisect tool: `omp` CLI after M4 (pi TUI for the frozen pi provider); ADE
  stays the primary dev target.
- Engine watch: OMP releases fast (local tarball 17.1.3 vs npm 17.1.6 on
  2026-07-28); pin exact `@oh-my-pi/*` versions when OmpAdapter lands. Old pi
  skew (CLI 0.82.x vs ^0.81.1) is moot — pi frozen.

## Deprecated / do not revive

- Pi-first direction (2026-07-26→28) — superseded by OMP-first. The pi
  provider itself is NOT deprecated: frozen, must keep working.
- "Port OMP ideas as pi extensions" strategy — OMP is the engine now.

## Known issues

- 35 web tests fail on main (upstream-inherited; zustand persist vs missing
  localStorage in test env: splitViewStore, pinned\*Store, workflowRunUiStore).
  Not ours; recheck after next release sync. (Was 36 pre-rebrand — count drift
  from renamed test files, same root cause.)
- `@nuncio/cli` typecheck has 2 pre-existing upstream errors in `PiAdapter.ts`
  (`piCompactionTitle` undefined; `PiSessionContext` missing properties) —
  inherited from main, NOT rebrand-caused; recheck after next release sync.
- Installed NuncioADE.app lags main until rebuilt: harness extensions hot-load
  via /reload, but `apps/`/`packages/` changes need an app rebuild + reinstall.
- NEVER swap state.sqlite while the app runs (learned: disk I/O errors, app
  self-recovered). Quit app, `sqlite3 <src> ".backup <dst>"`, remove -shm/-wal.

## Reference material

- `../claude-oauth-pi/pkg-src/` — OMP tarball 17.1.3 (engine source, offline
  reading; npm canonical) + pi tarballs 0.82.1 (frozen provider reference).
- Old Synara snapshot at `~/Documents/Codex/2026-06-24/ba/work/synara` (v0.3.0, stale).
