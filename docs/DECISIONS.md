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

- **2026-07-27 — Community CI disabled; core CI kept.** pr-size, pr-vouch,
  issue-labels moved to `.github/workflows-disabled/` (they serve public repos;
  pr-vouch could block our own PRs). `ci.yml` (quality gate + migration lineage —
  our upstream-sync verifier) and `release.yml` stay. macOS signing is possible
  later via the user's App Store API keys (`~/Desktop/Oscar/appstoreapi/`:
  Developer ID p12 + App Store Connect API key); Azure Trusted Signing (Windows)
  is not available — Windows builds stay unsigned or skipped.

- **2026-07-27 — openusage CLI is the quota source of truth.** Agents check
  subscription quotas (`openusage`, JSON output: claude/codex/cursor/devin/grok)
  before heavy delegation. Documented in DELEGATION.md.

- **2026-07-27 — AskUserQuestion ships as the first harness+bridge feature.**
  Tool name stays `AskUserQuestion` (matches Claude Code / Synara's provider-native
  layer; Synara canonical language used everywhere else: UserInputQuestion,
  user-input.requested, respondToUserInput). Extension copied from my-pi-harness
  into `harness/extensions/` as the single source of truth. Bridge adds
  `extension/ui/askUserQuestion` (feature-detected via `ctx.ui.askUserQuestions`);
  contract gains optional `allowCustomAnswer`/`allowNotes` and a structured
  `{selected, choiceNotes}` answer form — notes UI renders only for questions
  that opt in, so Claude/Grok behavior is unchanged.

- **2026-07-27 — Shared ~/.pi/agent; extensions promoted by symlink.** No separate
  ADE agent dir: auth.json token rotation makes copies diverge dangerously, and
  Synara settings already expose `providers.pi.agentDir` as the escape hatch if a
  global extension ever misbehaves. `harness/install.sh` symlinks graduated
  extensions into `~/.pi/agent/extensions/`; dev stays project-local.

- **2026-07-27 — Two-instance model: stable app + dev instance.** Daily driver is
  the built NuncioADE.app (no hot reload under your feet); `.ade-dev` (ports
  58090/8891) is the test bench. They share only the git repo and ~/.pi/agent —
  app state dirs are separate.

- **2026-07-27 — NuncioADE branding shipped; migrated off Synara.app.** User-facing
  values only (display name NuncioADE, bundle com.nuncio.ade, scheme nuncioade://,
  home ~/.nuncioade, artifact NuncioADE-*.dmg); identifier names keep SYNARA_ per
  the no-rename decision. brand:check exempts lineage docs. Synara DB snapshotted
  into NuncioADE via sqlite .backup (attachments, signing key, keybindings, codex
  overlay copied; environment-id kept distinct). Lesson recorded: never replace
  the DB while the app is running.

- **2026-07-27 — First Pi bug fixed in Synara ground: trimmed tool detail.**
  Newline-terminated tool output violated TrimmedNonEmptyString at durable journal
  encode; events quarantined and durable tool records dropped. toolDetailText()
  trims + drops whitespace-only. Candidate to offer upstream.
