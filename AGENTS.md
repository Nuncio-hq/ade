# AGENTS.md

## Project Identity

**NuncioADE** (repo `Nuncio-hq/ade`, private) is a personal agentic development environment, forked from [Synara](https://github.com/Emanuele-web04/synara) (itself a fork of T3Code). It inherits Synara's full architecture and keeps every provider working, but its product direction is **OMP-first**: OMP (oh-my-pi, `@oh-my-pi/*` npm SDK) is the first-class engine and gets new investment first — consumed as npm releases, customized through its extension points, integrated via direct SDK (see §Engine Focus). The original Pi provider (`@earendil-works/pi-*`) stays working but is frozen. Nothing from Synara is removed. UI/UX and general features are inherited from upstream; our own investment goes to the OMP harness, extension UI where needed, and mobile.

## Naming & Identity (post-rebrand)

Since 2026-07-28 the WHOLE tree carries the NuncioADE identity — the old "inherited code keeps its Synara identity" rule is reversed (see DECISIONS.md). First-party identity, everywhere including inherited files:

- Packages: `@nuncio/*`. Env vars / config keys: `NUNCIO_*`. CLI: `nuncioade` (+ `ade` alias). Product: `NuncioADE`. Bundle id: `com.nuncio.ade`.
- Harness extension tools/commands (OMP or pi): prefix `ade_` tools, `/ade-*` commands.

The retired identity (`@synara/*`, `SYNARA_*`, `Synara`, bare `synara`) survives ONLY in:

- **Attribution & upstream references**: the `SYNARA-*.md` snapshots, "forked from Synara" prose, `Emanuele-web04/synara` repo links, `trysynara.com` endpoints (upstream-hosted; protected in the codemod).
- **Immutable history**: `docs/DECISIONS.md`, `CHANGELOG.md`, and `apps/server/src/persistence/Migrations/**` (applied SQL must never change).
- **Legacy-compat shims** that keep pre-rebrand user data working (browser storage-key migration, managed codex-config markers, external-MCP credential prefixes and hash salt) — each marked `// rebrand-exempt` and covered by tests.

Mechanism (single source of truth = `scripts/rebrand-identity.ts`): a deterministic, idempotent codemod owns all token mappings, protections, and exemptions. `bun run brand:check` (CI-enforced) flags any reintroduction of the retired identity outside exemptions. Upstream syncs stay clean because BOTH sides are rebranded by the same codemod — see §Upstream Workflow and `docs/UPSTREAM-SYNC.md`.

This is an early WIP. Sweeping changes that improve long-term maintainability are encouraged.

## Living Docs (read first, keep true)

This file is the LAW layer: how we work, boundaries, conventions. It changes rarely. Current state and history live elsewhere:

- `docs/STATE.md` — **current direction**: active milestone, what is done/in progress, decisions currently in force, what is deprecated. Read this at the start of every session before doing direction-related work. Keep it under ~50 lines; push detail to DECISIONS.md.
- `docs/DECISIONS.md` — **append-only log**: one entry per decision (date + decision + why). Never edit or delete old entries. If a decision is reversed, append a new entry that supersedes it.
- `docs/REFERENCES.md` — **curated reference projects** (design taste, harnesses, mobile). Consult when designing a similar feature; note the per-entry caveats (e.g. OpenCode: architecture yes, harness UX no). Propose additions to the user — don't add silently.
- `docs/DELEGATION.md` — **which subscription/model/agent to spawn for which work** (Claude Max, Codex, Cursor pools, Devin CLI). Read before delegating work to other agents or creating provider threads. Supersedes the "Model Selection" section in `SYNARA-AGENTS.md`.

Update triggers — when any of these happen, updating the docs is PART OF THE TASK, not optional:

- Product direction changes or a milestone starts/completes → update `docs/STATE.md` + append to `docs/DECISIONS.md`.
- A component, provider, dependency, or workflow is added, removed, or deprecated → update `docs/STATE.md` (and the relevant section here if it states otherwise).
- An architectural or tooling decision is made (even verbally with the user) → append to `docs/DECISIONS.md`.
- Anything in this file or STATE.md becomes factually wrong because of your change → fix it in the same task.

Deprecated things must be listed in `docs/STATE.md` under "Deprecated / do not revive" — this prevents future agents from accidentally resurrecting dead code or abandoned directions.

## Upstream Docs (read these too)

The original Synara agent docs are preserved verbatim in this repo and remain authoritative for everything not covered here (Codex app-server, UI conventions, transcript performance guardrails, dev instance isolation details):

- `SYNARA-AGENTS.md` — original upstream `AGENTS.md`
- `SYNARA-CLAUDE.md` — original upstream `CLAUDE.md`

Ignore the "Model Selection" section in those files: it reflects the upstream author's personal pricing deals and tooling, not this project's. Where the upstream docs and this file conflict, this file wins.

## Branching

Trunk-based. `main` must always be green (`bun fmt`, `bun lint`, `bun typecheck` pass). There is NO long-lived `dev`, `harness`, `app`, or `mobile` branch — do not create them. The ONE long-lived exception besides `main` is `sync/rebranded-upstream`: a mechanical shadow (`latest synced upstream tag + rebrand codemod`) that keeps release syncs conflict-free. It is never hand-edited and never merged from directly — only via `docs/UPSTREAM-SYNC.md`.

All work happens on short-lived branches cut from `main`, merged back when green, deleted after merge. Name them by area prefix:

- `harness/<feature>` — OMP harness work: extensions/skills/plugins (e.g. `harness/permission-gate`)
- `app/<feature>` — app-side work: server, web, desktop, bridge (e.g. `app/bridge-custom-widgets`)
- `mobile/<feature>` — mobile client work (e.g. `mobile/spike-expo-shell`)
- `sync/upstream-<version>` — upstream syncs: advance the `sync/rebranded-upstream` shadow to the chosen upstream **release tag** first (never upstream HEAD), then merge the SHADOW here, resolve conflicts (keep our `AGENTS.md`/`CLAUDE.md`; refresh `SYNARA-*.md` from the raw tag), verify, then merge to `main`. Full steps: `docs/UPSTREAM-SYNC.md`

Rules:

- Cross-cutting changes (extension + bridge) stay in ONE branch — never split them by area.
- Aim for days, not weeks. If a branch lives long, merge `main` into it frequently.
- Releases are tags on `main` (`v0.x.y`) → `bun run build:desktop`. The gate before tagging is dogfooding via the dev instance, not a staging branch.
- Direct small commits to `main` are fine (solo project); use branches when work is multi-step or risky.

## Versioning & Releases

ADE has its OWN version line (currently 0.0.x), independent of Synara's. The
Synara release our main is based on lives in the `UPSTREAM-BASE` file at the repo
root — our "engine version". Think of it as: ADE version = our product; upstream
base = the outsourced platform underneath (we focus on the OMP harness; everything else is
effectively outsourced to Synara upstream).

Hard rules:

- **Agents NEVER bump versions or push tags on their own.** A release happens
  only when the user explicitly says "release X.Y.Z". No auto-bump, no nightly,
  no CI-driven version increments (upstream's finalize job stays disabled — do
  not set the `NUNCIO_FINALIZE_RELEASE` repo var).
- Version meaning (user decides, these are the defaults): **z** = fixes/polish/
  upstream syncs with no new ADE feature; **y** = a nameable ADE feature ships
  (e.g. AskUserQuestion, Devin provider); **x** = reserved until the user
  declares 1.0. Every release must be justifiable in one meaningful changelog line.
- Release procedure: set the version in the four release package.json files via
  `scripts/update-release-package-versions.ts`, commit `release: vX.Y.Z`, then
  `git tag vX.Y.Z && git push --tags` — CI does the rest.
- After an upstream sync lands, update `UPSTREAM-BASE` to the merged Synara tag
  in the same commit. Keeping the base fresh IS part of maintaining ADE: the
  non-harness surface improves only through these syncs.

## Upstream Workflow

- `upstream` remote points to the original Synara repo. We selectively pull improvements; we do not track it as a hard dependency.
- **Merge released versions only, never upstream HEAD.** Sync targets are upstream release tags (check `gh api repos/Emanuele-web04/synara/releases`): `git fetch upstream --tags`, advance the `sync/rebranded-upstream` shadow to the chosen `vX.Y.Z` tag (re-running the rebrand codemod), then merge the shadow via a `sync/upstream-<version>` branch. Why: HEAD commits are unstable/diluted; releases are the tested checkpoints; the shadow makes identity renames non-conflicting.
- **Full sync runbook: `docs/UPSTREAM-SYNC.md`** — follow it step by step (conflict resolution rules per file class, verification, landing). Read it before any sync work.
- To inspect what a release brings: `git log --oneline main..vX.Y.Z`.
- Once diverged, prefer `git cherry-pick` of specific commits from a release (especially anything touching `PiAdapter`, `piTurnFailure`, or `@earendil-works/pi-*` version bumps).
- Never push to `upstream`.

## Repo Layout & Boundaries

```
Nuncio/
├── ade/                      # this repo = the product (Synara fork)
│   ├── apps/{server,web,desktop} # inherited from Synara — modify minimally
│   ├── packages/                 # inherited from Synara — modify minimally
│   │   └── omp-sidecar/          #   ★ ours (@nuncio/omp-sidecar) — Bun host for the OMP SDK
│   └── harness/                  # ★ ours — OMP harness, does not exist upstream
│       ├── extensions/           #   extensions (core deliverable; pi-API compatible, run on OMP via its legacy shims)
│       ├── skills/ prompts/      #   optional engine resources
│       └── README.md             #   docs per extension
├── playground/               # disposable guinea-pig repo for agent testing (not in git)
└── claude-oauth-pi/          # engine source snapshots: OMP + pi tarballs (docs/examples), for offline reading
```

Boundary rules:

- **`harness/`** is our own ground: change freely, never conflicts with upstream merges. Extensions are wired in by symlinking into the engine's agent dir — OMP: `~/.omp/agent/extensions/` (real use) or a project's `.omp/extensions/` (dev/testing); the frozen pi provider still reads `~/.pi/agent/extensions/` / `.pi/extensions/`.
- **`apps/` + `packages/`** are Synara ground: only touch them when a harness extension needs it — primarily extending the `ExtensionUIContext` bridge in `apps/server/src/provider/Layers/PiAdapter.ts` (and `OmpAdapter` once it lands; Synara ignores TUI-only widgets and editor hooks) plus matching web UI. Keep each change small and note it in the commit message to ease upstream conflict resolution.
- An extension that depends on a bridge change must land in the same commit/PR as that bridge change.
- **`claude-oauth-pi/pkg-src`** holds engine source snapshots: the OMP tarball (`@oh-my-pi/pi-coding-agent` — read here for SDK/extension APIs; npm is canonical) and `@earendil-works/pi-coding-agent` tarballs (frozen provider reference, with `docs/` and `examples/extensions|hooks`).

## Dev Workflow (dev → product)

1. **Dev loop**: run an isolated ADE instance (see Local Dev Instance Isolation), edit extensions in `harness/extensions/`, hot-reload via the engine's reload command in-app, test against `playground/`.
2. **Bisect**: if an extension misbehaves in ADE, run the same extension in the engine CLI (`omp`; `pi` TUI for the frozen pi provider). CLI-works/ADE-fails ⇒ bridge gap in Synara-inherited code; both-fail ⇒ extension bug. Watch for version skew between the `omp` CLI and `@oh-my-pi/*` pinned in `apps/server/package.json` (once OmpAdapter lands).
3. **Ship**: `bun run build:desktop` → install and use ADE as the daily driver; feedback loops back into `harness/`.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Treat them as heavyweight workspace checks: bundle into one final verification pass per task; avoid rerunning the full set during iteration.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- Before finishing any task, ask: _did this change make `docs/STATE.md` or `AGENTS.md` stale?_ If yes, updating them is part of the task (see Living Docs). A task that changes direction, components, or workflow without updating the docs is NOT done.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Engine Focus (OMP-first)

- **OMP (oh-my-pi) is the primary engine**, integrated via its **direct SDK** (no CLI/ACP wrapper) — but the SDK is **Bun-only** (its runtime entry is TypeScript source and it uses `bun:*` / `Bun.*` throughout), and the packaged backend is Node, so the SDK is hosted in a compiled **Bun sidecar we own** (`@nuncio/omp-sidecar`) that `OmpAdapter` spawns and supervises like the other child-process adapters. Synara's server stays Node, inside asar. Design: `docs/plans/omp-sidecar-spec.md`; status/milestone: `docs/STATE.md`.
- **Consume OMP from npm, never fork its source.** Custom behavior goes through OMP's extension points (extensions, skills, plugins, hooks). OMP ships legacy `@earendil-works/*` shims, so pi-written extensions in `harness/extensions/` run on OMP.
- **The pi provider is frozen**: keeps working through upstream syncs, gets no new investment. Key files: `apps/server/src/provider/Layers/PiAdapter.ts`, `apps/server/src/provider/Services/PiAdapter.ts`, `apps/server/src/provider/piTurnFailure.ts`. Do not retarget PiAdapter to `@oh-my-pi/*` — the APIs diverged (`createAgentSessionRuntime` does not exist in OMP); OMP integration is a separate adapter.
- Both engines are intentionally unopinionated harnesses: do not add permission or plan-mode semantics on top of them. Pi has no static default model (`getDefaultModel("pi")` returns `null`); models come dynamically from the engine's `ModelRegistry` — same policy for OmpAdapter.
- When touching provider-generic code, verify the engine adapter paths first (`OmpAdapter` once it lands; `PiAdapter` today — it exercises the same extension bridge), other providers second. All providers must keep working — OMP-first does not mean OMP-only.

## Package Roles

- `apps/server`: Bun/Node WebSocket server. Manages provider sessions, orchestration, SQLite persistence, serves the web app.
- `apps/web`: React/Vite UI. Session UX, conversation/event rendering, client-side state. Connects via WebSocket.
- `apps/desktop`: Electron wrapper.
- `packages/contracts`: Effect Schema contracts for provider events, WS protocol, model/session types. Schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities for server and web. Explicit subpath exports (e.g. `@nuncio/shared/git`) — no barrel index.

## Maintainability

If you add new functionality, first check whether shared logic can be extracted into a module. Duplicate logic across files is a code smell. Don't be afraid to change existing code; don't take shortcuts by adding local logic to solve a shared problem.

## Local Dev Instance Isolation

- Never start the default `bun run dev` while another instance (including an installed NuncioADE.app) is running, unless shared ports/state are intended.
- Use an isolated home dir and non-default ports when running side by side, e.g. `env -u NUNCIO_AUTH_TOKEN NUNCIO_PORT_OFFSET=3158 NUNCIO_NO_BROWSER=1 bun run dev -- --home-dir ./.ade-dev --port 58090` (dry-run first with `--dry-run`).
- Check ports with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
