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
  home ~/.nuncioade, artifact NuncioADE-\*.dmg); identifier names keep SYNARA\_ per
  the no-rename decision. brand:check exempts lineage docs. Synara DB snapshotted
  into NuncioADE via sqlite .backup (attachments, signing key, keybindings, codex
  overlay copied; environment-id kept distinct). Lesson recorded: never replace
  the DB while the app is running.

- **2026-07-27 — First Pi bug fixed in Synara ground: trimmed tool detail.**
  Newline-terminated tool output violated TrimmedNonEmptyString at durable journal
  encode; events quarantined and durable tool records dropped. toolDetailText()
  trims + drops whitespace-only. Candidate to offer upstream.

- **2026-07-27 — ADE gets its own version line, human-gated.** Reset to 0.0.1;
  upstream Synara base tracked separately in `UPSTREAM-BASE` (v0.6.1). Agents
  never bump or tag — releases happen only on the user's explicit "release X.Y.Z"
  (z=fixes/syncs, y=nameable ADE feature, x=reserved for 1.0). Motivated by a
  prior project (nuncio) where automation inflated tags continuously. Upstream's
  CI finalize auto-bump stays disabled. Rationale for the split: we focus on Pi;
  the non-Pi platform is effectively outsourced to Synara upstream, and its
  version is an "engine version", not our product version.

- **2026-07-28 — OMP (oh-my-pi) adopted as first-class engine; Pi frozen.** After
  hands-on time with both, `@oh-my-pi/pi-coding-agent` (npm, 17.x) becomes the
  primary runtime and investment target. Supersedes the Pi-first framing
  (2026-07-26) and the "port OMP ideas as pi extensions" strategy (2026-07-27).
  Sub-decisions: (1) integration = new `OmpAdapter` via direct SDK
  (`createAgentSession`/`SessionManager`/`ModelRegistry`) — same first-class bar
  set for pi, no CLI/ACP wrapper; PiAdapter untouched, pi provider keeps working
  but gets no new investment; bisect moves `pi` TUI → `omp` CLI once OmpAdapter
  lands. (2) Consume OMP npm releases, never fork its source — custom behavior
  via OMP extension points (extensions/skills/plugins/hooks); reaffirms the
  no-source-fork principle. (3) Verified de-risking facts: OMP ships legacy
  `@earendil-works/*` shims (existing `harness/extensions/` run on it); SDK is
  public on npm; API diverged from pi 0.8x (`createAgentSessionRuntime` gone),
  so a new adapter, not a package swap; OMP uses its own dirs (`~/.omp/agent/`,
  project `.omp/`). Docs-only decision — no code yet.

- **2026-07-28 — Delegation: OMP-native model routing first; harness-bridge
  agents banned.** Sessions run on OMP, whose `modelRoles`
  (`~/.omp/agent/config.yml`) reach every subscription natively (Fable/Opus,
  `openai-codex/gpt-5.6-sol`, `devin/swe-1-7`, Cursor grok/composer) with
  usage-aware fallback and `subagent: inherit`. Never spawn `codex-rescue` or
  other Claude-Code-plugin bridge agents from OMP — lossy double-hop, zero
  gain. Route by context capability and performance: in-session
  subagents/completion tiers for work sharing current context; external
  engines (Synara provider threads, Devin CLI/Cloud) only where they win —
  isolated parallel worktrees, Claude Code harness inheritance, visual-proof
  async runs. Recorded as DELEGATION.md §0.

- **2026-07-28 — Maximum rebrand Synara→NuncioADE; supersedes the no-rename naming
  law.** The "inherited code keeps its Synara identity — do NOT rename" rule
  (2026-07-26) is reversed: the whole tree now carries the NuncioADE identity
  (`@nuncio/*`, `NUNCIO_*`, `nuncioade` CLI + `ade` alias, `NuncioADE` product,
  `com.nuncio.ade` bundle id kept as our pre-existing divergence). Why now:
  product is the daily driver (M3), and keeping two identities made every doc,
  CLI, and support conversation ambiguous. Why it stays maintainable: the rename
  is owned by ONE deterministic idempotent codemod (`scripts/rebrand-identity.ts`)
  applied to BOTH our tree and a new long-lived shadow branch
  `sync/rebranded-upstream` (= latest upstream tag + codemod). Upstream syncs now
  merge an already-rebranded tree, so identity renames never conflict — rehearsed
  on v0.6.2: the shadow merge into the rebrand branch produced a tree
  byte-identical to the pre-merge state. Sub-decisions: (1) retired `synara`
  tokens survive only in attribution/upstream references (`SYNARA-*.md`,
  `trysynara.com`, `Emanuele-web04/synara`), immutable history (DECISIONS.md,
  CHANGELOG.md, `persistence/Migrations/**`), and `// rebrand-exempt` compat
  shims; (2) compat shims keep pre-rebrand user data alive: browser storage
  keys migrated `synara.*`→`nuncioade.*` at bootstrap, managed codex-config
  markers normalized on read, external-MCP accepts legacy credential/pairing
  prefixes with the hash salt frozen at the legacy audience, DB migration 088
  rebuilds the audience CHECK constraint; (3) `bun run brand:check` extended to
  the full retired identity and wired into CI to prevent regressions;
  (4) `trysynara.com` feedback/changelog endpoints intentionally still point at
  upstream infra — revisit when we host our own.
