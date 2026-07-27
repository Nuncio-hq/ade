# DECISIONS — append-only log

> One entry per decision: date, decision, why. Never edit or delete old entries.
> To reverse a decision, append a new entry that supersedes it.

- **2026-07-26 — Detached fork, not GitHub fork.** Cloned Synara into `ade/` with
  remote `upstream`; private origin to be added. Why: GitHub forks of public repos
  can't be private, and we diverge fast; fetch/merge/cherry-pick keeps the update path.

- **2026-07-26 — Keep everything from Synara.** No providers or features removed;
  Pi-first means Pi gets new investment first, not Pi-only. Why: inherit maximum
  value, minimize merge conflicts.

- **2026-07-26 — Preserve upstream agent docs verbatim.** Original `AGENTS.md`/
  `CLAUDE.md` kept as `SYNARA-AGENTS.md`/`SYNARA-CLAUDE.md`; our `AGENTS.md` is
  authoritative on conflict. Why: agents keep access to upstream knowledge without
  it masquerading as our direction.

- **2026-07-27 — Custom Pi harness via extensions, no pi source fork.** Harness
  lives in `harness/extensions/`, loaded through pi's extension auto-discovery.
  Why: pi's extension API covers our needs (tools, hooks, commands, UI); OMP shows
  deep forks are possible but costly; Synara already bridges extensions into its UI.

- **2026-07-27 — ADE (Synara) is the primary dev target; pi TUI is for bisecting.**
  Why: the product runs inside Synara's UI bridge; developing TUI-first hides
  bridge constraints until too late. Hot-reload works inside ADE, so the loop is fast.

- **2026-07-27 — Monorepo layout: harness inside `ade/`, playground outside.**
  `harness/` doesn't exist upstream (zero merge conflicts); bridge changes and the
  extensions that need them land in the same commit. `playground/` is a disposable
  guinea-pig repo outside git.

- **2026-07-27 — Three-layer living docs.** `AGENTS.md` (law) + `docs/STATE.md`
  (current state) + `docs/DECISIONS.md` (append-only log), with update triggers
  wired into task completion. Why: a prior project (Nuncio) failed because agents
  never updated docs on direction changes; cheap append + small STATE file makes
  updates actually happen.

- **2026-07-27 — Trunk-based branching, no component branches.** Rejected long-lived
  harness/mobile/app/dev branches in favor of short-lived area-prefixed branches
  (`harness/*`, `app/*`, `mobile/*`, `sync/upstream-*`) off `main`, release by tag.
  Why: directory layout already isolates areas; component branches would split
  extension+bridge changes that must land together; each long-lived branch multiplies
  upstream-merge sync points; solo dev + dogfooding needs no staging branch.

- **2026-07-27 — Mobile philosophy: your machine as cloud, agents.** The phone is a
  remote client to the Mac-hosted ADE server (WebSocket contract in
  `packages/contracts`); agents and the Pi runtime never run on the phone.
  Delivery path (PWA vs straight-to-native) not yet decided.

- **2026-07-27 — Mobile goes straight to native (Expo/RN); PWA skipped.** Why: push
  notifications are the #1 mobile feature and iOS PWA push is second-class; user
  doesn't want to maintain an intermediate layer; frontend contracts already exist
  in `packages/contracts`. Web-via-Tailscale (REMOTE.md) remains the zero-code
  stopgap and requirements-gathering tool.

- **2026-07-27 — Project named NuncioADE; repo `Nuncio-hq/ade` (private) is origin.**
  Created and pushed 2026-07-27. Branding lives at repo/docs level only.

- **2026-07-27 — No rename of inherited Synara identifiers.** `@synara/*` packages,
  `SYNARA_*` env vars, app branding stay as-is unless we ever fully rebuild UI/UX
  (may be never). New-and-ours code uses `@nuncio/*` scope, `NUNCIO_` env prefix,
  `ade_`/`/ade-*` extension tools/commands from the first commit. Why: narrow delta
  keeps upstream merges cheap; namespacing new code from day one avoids a future
  refactor.

- **2026-07-27 — Current scope frozen: Pi harness, extension UI when needed, mobile.**
  All other UI/UX and features are inherited from Synara upstream rather than built.

- **2026-07-27 — Upstream sync targets releases, not HEAD.** We merge Synara
  release tags (e.g. v0.6.2) via `sync/upstream-<version>` branches; never track
  upstream HEAD commits. Why: HEAD is unstable and dilutes history; releases are
  upstream's own tested checkpoints. (Supersedes the earlier "merge upstream/main
  early" habit from the bootstrap phase.)

- **2026-07-27 — AgentKit adopted as engineering-kit reference.** User's paid kit
  (agentkit.best; `ak-*` skills in Claude Code config). Study its skills/hooks/
  subagents design for our harness; engineering parts only — marketing parts
  deferred. Install key stored at `~/.nuncio/agentkit.key` (never in git).
