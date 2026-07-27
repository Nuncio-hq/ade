# STATE — current direction (keep under ~50 lines)

> Update this file whenever direction, milestones, or components change.
> Detail and rationale go to `DECISIONS.md`. Rules live in `AGENTS.md`.

## Direction

NuncioADE (repo `Nuncio-hq/ade`, private) = Synara fork, Pi-first. Current scope:
(1) Pi harness **via extensions only** (`harness/extensions/`), no fork of pi's source;
(2) UI for Pi extensions when the bridge needs it; (3) mobile (native, no PWA).
Everything else — UI/UX, general features — is inherited from Synara upstream.
Synara code (`apps/`, `packages/`) is touched only to close `ExtensionUIContext`
bridge gaps. All Synara providers are kept working.

## Milestones

- [x] **M0 Baseline** — clone, merge upstream, `bun install`, isolated dev instance
      runs (`.ade-dev/`, server :58090, web :8891), first extension (`ade_hello`)
      loads and is callable end-to-end (TUI + SDK path verified).
- [~] **M1 Harness v0** — real extensions in `harness/extensions/` (current).
  Shipped: AskUserQuestion (structured, notes + custom answers, E2E verified).
  Next: Devin provider extension (research OMP's devin-agent impl first).
- [~] **M2 Bridge gaps** — first bridge extension landed: `extension/ui/askUserQuestion`
  in PiAdapter + `allowNotes`/`allowCustomAnswer` on UserInputQuestion + notes UI.
- [~] **M3 Daily driver** — STARTED: NuncioADE.app branded, built, installed;
      DB migrated from Synara (sqlite .backup snapshot); user works in NuncioADE.
      Remaining: signed builds + no-script auto-update via GitHub releases.

## In force

- Branching: trunk-based on `main`; short-lived branches `harness/*`, `app/*`,
  `mobile/*`, `sync/upstream-<date>`. No long-lived dev branch; release = tag on main,
  gated by dogfooding the dev instance. See AGENTS.md §Branching.
- Mobile: end goal is "your machine as cloud, agents" — phone is a remote
  client to the Mac-hosted server, never a Pi runtime. **Native app (Expo/RN),
  PWA skipped.** Near-term: use REMOTE.md (Tailscale + auth token) to reach the
  web UI from the phone and collect real mobile requirements.
- Naming: inherited code stays `@synara/*` / `SYNARA_*`; new code is `@nuncio/*` /
  `NUNCIO_` / `ade_` tools. See AGENTS.md §Naming Convention.
- Versioning: ADE line = 0.0.x (currently 0.0.1), user-decided only, agents never
  bump/tag. Upstream base = `UPSTREAM-BASE` file (currently v0.6.1). See AGENTS.md
  §Versioning & Releases.
- Upstream = `Emanuele-web04/synara`, remote `upstream`; **sync on release tags only** (latest seen: v0.6.2 — pending sync), cherry-pick once diverged.
- Origin = `https://github.com/Nuncio-hq/ade` (private), `main` pushed and tracking.
- Extensions dev is project-local first (`.pi/extensions` symlink → `harness/extensions`);
  promote to `~/.pi/agent/extensions/` (global) only when stable.
- Pi TUI is the bisect tool, not the primary dev target; ADE is the primary target.
- Version skew watch: `pi` CLI 0.82.x vs `@earendil-works/pi-*` ^0.81.1 in
  `apps/server/package.json` — bump when convenient.

## Deprecated / do not revive

- (none yet)

## Known issues

- 36 web tests fail on main (upstream-inherited; zustand persist vs missing
  localStorage in test env: splitViewStore, pinned\*Store, workflowRunUiStore,
  chatHotPath.compiler). Not ours; recheck after next release sync.
- Installed NuncioADE.app lags main until rebuilt: harness extensions hot-load
  via /reload, but `apps/`/`packages/` changes need an app rebuild + reinstall.
- NEVER swap state.sqlite while the app runs (learned: disk I/O errors, app
  self-recovered). Quit app, `sqlite3 <src> ".backup <dst>"`, remove -shm/-wal.

## Reference material

- `../claude-oauth-pi/pkg-src/` — pi tarballs 0.82.1 (docs + examples), OMP fork
  (oh-my-pi 17.1.3): port ideas as extensions; skip source-fork-only features.
- Old Synara snapshot at `~/Documents/Codex/2026-06-24/ba/work/synara` (v0.3.0, stale).
