# STATE — current direction (keep under ~50 lines)

> Update this file whenever direction, milestones, or components change.
> Detail and rationale go to `DECISIONS.md`. Rules live in `AGENTS.md`.

## Direction

ADE = Synara fork, Pi-first. The custom Pi harness is built **via extensions only**
(`harness/extensions/`), no fork of pi's source. Synara code (`apps/`, `packages/`)
is touched only to close `ExtensionUIContext` bridge gaps that extensions need.
All Synara providers are kept working.

## Milestones

- [x] **M0 Baseline** — clone, merge upstream, `bun install`, isolated dev instance
      runs (`.ade-dev/`, server :58090, web :8891), first extension (`ade_hello`)
      loads and is callable end-to-end (TUI + SDK path verified).
- [ ] **M1 Harness v0** — real extensions in `harness/extensions/` (current)
- [ ] **M2 Bridge gaps** — extend PiAdapter UI bridge as extensions demand
- [ ] **M3 Daily driver** — `bun run build:desktop`, use ADE daily; branding last

## In force

- Branching: trunk-based on `main`; short-lived branches `harness/*`, `app/*`,
  `mobile/*`, `sync/upstream-<date>`. No long-lived dev branch; release = tag on main,
  gated by dogfooding the dev instance. See AGENTS.md §Branching.
- Mobile: end goal is "your machine as cloud, agents" — phone is a remote
  client to the Mac-hosted server, never a Pi runtime. Near-term: use REMOTE.md
  (Tailscale + auth token) to reach the web UI from the phone. Native-vs-PWA path
  undecided.
- Upstream = `Emanuele-web04/synara`, remote `upstream`; merge early, cherry-pick later.
- Origin remote: **not set yet** (user will add private repo).
- Extensions dev is project-local first (`.pi/extensions` symlink → `harness/extensions`);
  promote to `~/.pi/agent/extensions/` (global) only when stable.
- Pi TUI is the bisect tool, not the primary dev target; ADE is the primary target.
- Version skew watch: `pi` CLI 0.82.x vs `@earendil-works/pi-*` ^0.81.1 in
  `apps/server/package.json` — bump when convenient.

## Deprecated / do not revive

- (none yet)

## Reference material

- `../claude-oauth-pi/pkg-src/` — pi tarballs 0.82.1 (docs + examples), OMP fork
  (oh-my-pi 17.1.3): port ideas as extensions; skip source-fork-only features.
- Old Synara snapshot at `~/Documents/Codex/2026-06-24/ba/work/synara` (v0.3.0, stale).
