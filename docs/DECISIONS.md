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

- **2026-07-28 — OMP SDK runs in a Bun sidecar; Synara's server stays Node.**
  Supersedes the "direct SDK, in-process" sub-decision of the 2026-07-28
  OMP-adoption entry — the SDK choice stands, its _hosting_ changes. Why: the
  published `@oh-my-pi/pi-coding-agent` is Bun-only (runtime entry is
  `./src/index.ts`; 19 files import `bun:*`, 145 use `Bun.*`), and the packaged
  backend is Node (`apps/desktop/src/main.ts:3246`), so a real NuncioADE.app
  build starts with an empty OMP model list — M4 phases 1–4 only ever worked
  because the dev server runs under Bun. Three options were measured on
  hardware, 3 sessions each: in-process SDK 137ms/431MiB (unshippable),
  `omp --mode rpc` 895ms/1264MiB (one session per process, and `modes/rpc/`
  exposes no `askDialog` so the native `ask` tool degrades to single-choice
  select), compiled Bun sidecar **107ms/397MiB with the rich dialog intact** —
  proven end to end from a binary with zero `node_modules` (auth, model, native
  brush shell, full event stream). Moving the _whole_ backend to Bun was
  rejected: `bun build --compile` dies on `NodeSqliteClient.ts`'s static
  `node:sqlite` import, so it would force the server out of asar and diverge in
  packaging/signing — upstream's active patch area (`main.ts` took 5 of 41
  commits since v0.6.0, 7 hunks in the band around the spawn site). The sidecar
  touches one packaging file upstream has not changed since v0.6.0. Trade
  accepted: +~91MiB app size, a stdio protocol we own, and one engine crash
  taking down all OMP threads at once (they resume from session files). Spec:
  `docs/plans/omp-sidecar-spec.md`; tracker phase 6.

- **2026-07-28 — Provider discovery reads get their own WebSocket admission
  class (Synara ground).** `apps/server/src/wsRequestAdmission.ts` classified
  `provider.listModels`/`listAgents`/`listSkills`/`listCommands`/`listPlugins`
  as `expensive-read`, capped at 2 concurrent per client. The model picker opens
  one query per installed provider — 10 at once — so two slow CLI probes held
  both slots and every later provider was rejected with
  `RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED` before reaching its adapter. Both
  pi-lineage providers rendered an empty picker (OMP and Pi were last in the
  fan-out); the OMP sidecar was innocent — it answered 334 models in 420ms once
  admitted. Fix: a `provider-discovery` class limited to 12, leaving
  `expensive-read` at 2 for git diffs, snapshots and thread compaction. This is
  upstream code we diverge in; re-check it on every sync.

- **2026-07-28 — A dead per-thread stream must self-heal (Synara ground).** The
  client subscribes one WebSocket stream per open thread. When that stream dies
  with the transport's bounded retries spent, `__root.tsx` only cleared the
  cursor and called `markThreadDetailSyncFailed` — and that marker is a no-op
  for a thread already flagged `synced`, because rendering stale data beats
  blanking a conversation. Nothing resubscribed. The thread froze on whatever
  the client last applied: an in-flight turn spins "Thinking" forever while the
  server completes it, writes the reply, and generates the title (observed in
  `~/.nuncioade` — turn `beb9b24e` completed 11:31:39Z with the UI still
  spinning). Provider-agnostic by construction. Fix: a self-chaining resubscribe
  backoff (1s widening to 30s, 12 attempts) that runs for as long as the client
  holds the lease and stops on the first stream frame. `THREAD_SNAPSHOT_NOT_FOUND`
  is excluded — an unpromoted draft is expected to 404 and the shell stream
  already restarts it via `requestThreadSnapshot`; adding a second owner would
  just churn subscribes for every idle draft. Measured: a new thread burns 8–11
  of the transport's 12 bootstrap retries before its `thread.create` projection
  lands, so this margin is thinner than it looks.

- **2026-07-29 — Diagram rendering via fence-renderer contract, not provider
  events (Synara ground, engine-generic).** OMP's system prompt actively tells
  models to emit ` ```mermaid ` fences (`renderMermaid` defaults true; the
  sidecar doesn't override), so ADE transcripts show raw mermaid source. The
  wire contract for rich renderable content is the markdown fence itself —
  every engine already speaks it, so there is no new provider event, no
  `packages/contracts` change, and no adapter work; an engine that ever emits
  diagrams through another channel normalizes to a fence in its own adapter.
  Web side: a fence-renderer registry (`apps/web/src/lib/fenceRenderers.ts`)
  maps fence language → renderer, hooked at the single `pre` override in
  `ChatMarkdown` (covers timeline, plans, PR views, file preview for free).
  Mermaid is the first renderer: lazy-loaded (~2MB, never static), rendered
  with `securityLevel: "strict"` (model output stays inert; never "loose"),
  SVG memoized per (source, theme) with failures cached too, diagram-by-default
  with a source toggle and an expand dialog, silent fallback to the plain code
  block on invalid source, and streaming messages stay on the plain code path
  until settled. Rejected: server/sidecar-side rendering (wrong layer, needs
  headless rendering, theme is client state) and extension-UI widgets (OMP-only,
  diagrams are static content, not interactive UI). `mermaid` is pinned exact
  (11.16.0) like `@oh-my-pi/*` — OMP's own ASCII renderer is a hand-written
  parser in `@oh-my-pi/pi-utils`, so there is no engine version to align with.

- **2026-07-29 — Stored command receipts win over replay-derived content in
  provider runtime ingestion (Synara ground).** Provider-derived command IDs are
  deterministic per persisted runtime event, but the command *content* is derived
  by the running build — so after an app upgrade, journal/open-turn replays can
  recompute content whose fingerprint no longer matches the receipt an older
  build recorded. `ProviderRuntimeIngestion` now routes every dispatch through a
  wrapper that treats `OrchestrationCommandIdentityCollisionError` (and recorded
  rejections) as "already decided: keep the recorded outcome" instead of failing,
  and the startup open-turn rebuild skips per-event failures instead of dying.
  Why: v0.0.2 install over a hand-built binary crash-looped on boot (collision in
  `rebuildAcceptedOpenTurnState`, which ran raw under `Effect.orDie`), and the
  same collision in the journal drain would silently wedge the consumer cursor
  forever. The engine itself stays strict — client-originated command IDs still
  hard-fail on fingerprint mismatch; only the ingestion layer, replaying its own
  deterministic IDs, is tolerant.
