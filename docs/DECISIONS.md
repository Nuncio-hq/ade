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

- **2026-07-28 — App Factory: new product direction (market research + app
  cloning), scope item (5).** A first-class sidebar section in ADE to find
  iOS apps worth cloning and study their UX/monetization. Sub-decisions:
  (1) Data = screensdesign API mirrored locally (catalog 2,621 apps; API
  probed live 2026-07-28: token works, free tier — Pro-gated filters bypassed
  by local mirror; screens blurred from paywall onward on free tier).
  GetAppNiche (5,000 API credits/mo, 1 credit = up to 100 search rows) is P2
  for estimates beyond the catalog; iTunes Lookup free enrichment later. No
  Sensor-Tower-class paid data. (2) Subscription strategy = sprint-based:
  P1 costs $0; later screensdesign Weekly $19 for clone sprints (no free
  trial exists), GetAppNiche 3-day trial → monthly. Cache-forever in SQLite
  with `fetched_at` provenance; snapshot mode keeps data browsable after
  lapse. (3) UX locked with user: table-first, dense, 4 tabs
  (Discover/Rising/Watchlist/Data), compare view (2-3 apps) in P1.
  (4) Clone execution deferred (P2+); when built, handoff = deterministic
  facts pack assembled by server code + `/ade-app-clone` skill in `harness/`
  — the OMP session itself does vision/spec synthesis; no server-side LLM
  calls, engine-agnostic via existing thread creation. (5) Secrets in
  `ServerSecretStore`, never env/localStorage. Plan:
  `plans/260728-1405-app-factory-p1/`.

- **2026-07-28 — App Factory P1 backend data layer landed (TDD).** Contracts
  (`packages/contracts/src/appFactory.ts`), migration 088 (`af_apps`,
  `af_app_revenue`, `af_videos`, `af_screens`, `af_watchlist`, `af_sync_runs`,
  `af_state`), `AppFactoryRepository`, `ScreensdesignClient` (typed errors,
  429 `Retry-After` backoff), `CatalogSync` (full/incremental/refreshApp,
  single-flight via in-memory ref, crash recovery + cursor resume; resumed
  full syncs skip removed-marking), `AppFactoryService` facade + 12 WS RPCs.
  Sub-decisions: (1) media (videos/screens) mirrored lazily on first detail
  view, then cache-forever — catalog sync stays cheap. (2) Sync token stored
  in `ServerSecretStore` as `screensdesign.api-token`; account email/isPro
  cached in `af_state`. (3) Sync runs in a detached fiber; progress readable
  via `appFactory.syncStatus`; 401 mid-sync finishes the run as
  `token_invalid` without touching local data. (4) Removed apps keep revenue
  history (`removed_at` flag, never deleted). 53 scoped tests green; full
  server suite 2996 green. Pre-existing at HEAD (not ours): 2 PiAdapter
  typecheck errors + 36 web test failures.

- **2026-07-28 — First `@nuncio/*` package: `@nuncio/contracts`.** App Factory
  domain schemas extracted from `@synara/contracts` into
  `packages/nuncio-contracts` (own `baseSchemas` atoms — no dependency on
  Synara code, one-way `@synara/contracts` → `@nuncio/contracts` import).
  `@synara/contracts` re-exports it from `index.ts`, so existing
  `from "@synara/contracts"` imports keep working unchanged. WS protocol
  registration (`WS_METHODS`, `WebSocketRequestBody`, RPC group) stays in
  Synara ground — it is the shared socket registry. Server implementation
  (`apps/server/src/appFactory/`) intentionally stays in `apps/server`:
  extracting it would make a package depend back on app internals (secret
  store, persistence infra) — wrong direction. Future Nuncio cross-app
  contracts (mobile, harness-as-package) live in `@nuncio/contracts`.
