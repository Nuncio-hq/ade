# AGENTS.md

## Project Identity

**NuncioADE** (repo `Nuncio-hq/ade`, private) is a personal agentic development environment, forked from [Synara](https://github.com/Emanuele-web04/synara) (itself a fork of T3Code). It inherits Synara's full architecture and keeps every provider working, but its product direction is **Pi-first**: the Pi provider (`@earendil-works/pi-*` SDK) is the primary, deeply-integrated runtime and gets new investment first. Nothing from Synara is removed. UI/UX and general features are inherited from upstream; our own investment goes to the Pi harness, extension UI where needed, and mobile.

## Naming Convention (inherited vs ours)

Inherited Synara code keeps its Synara identity — do NOT rename. Renaming happens only if we ever decide to fully rebuild UI/UX (may be never):

- Keep: `@synara/*` package names, `SYNARA_*` env vars, app title/branding in `apps/` and `packages/`.
- Modifying files in Synara ground (e.g. the PiAdapter bridge) is still Synara world — no renames there.

Anything NEW and ours gets our namespace from the first commit — never `synara`:

- New workspace packages (e.g. mobile, harness-as-package): scope `@nuncio/*`.
- New env vars / config keys we introduce: prefix `NUNCIO_`.
- Pi extension tools/commands: prefix `ade_` tools, `/ade-*` commands.

This avoids a future refactor: our code never needs renaming, inherited code never causes merge conflicts.

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

Trunk-based. `main` is the only long-lived branch and must always be green (`bun fmt`, `bun lint`, `bun typecheck` pass). There is NO long-lived `dev`, `harness`, `app`, or `mobile` branch — do not create them.

All work happens on short-lived branches cut from `main`, merged back when green, deleted after merge. Name them by area prefix:

- `harness/<feature>` — Pi extensions and harness work (e.g. `harness/permission-gate`)
- `app/<feature>` — Synara-side work: server, web, desktop, bridge (e.g. `app/bridge-custom-widgets`)
- `mobile/<feature>` — mobile client work (e.g. `mobile/spike-expo-shell`)
- `sync/upstream-<version>` — upstream merges: merge the chosen upstream **release tag** here (never upstream HEAD; see Upstream Workflow), resolve conflicts (keep our `AGENTS.md`/`CLAUDE.md`; refresh `SYNARA-*.md` from upstream), verify, then merge to `main`

Rules:

- Cross-cutting changes (extension + bridge) stay in ONE branch — never split them by area.
- Aim for days, not weeks. If a branch lives long, merge `main` into it frequently.
- Releases are tags on `main` (`v0.x.y`) → `bun run build:desktop`. The gate before tagging is dogfooding via the dev instance, not a staging branch.
- Direct small commits to `main` are fine (solo project); use branches when work is multi-step or risky.

## Upstream Workflow

- `upstream` remote points to the original Synara repo. We selectively pull improvements; we do not track it as a hard dependency.
- **Merge released versions only, never upstream HEAD.** Sync targets are upstream release tags (check `gh api repos/Emanuele-web04/synara/releases`): `git fetch upstream --tags`, then merge the chosen `vX.Y.Z` tag via a `sync/upstream-<version>` branch. Why: HEAD commits are unstable/diluted; releases are the tested checkpoints.
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
│   └── harness/                  # ★ ours — Pi harness, does not exist upstream
│       ├── extensions/           #   Pi extensions (the core deliverable)
│       ├── skills/ prompts/      #   optional Pi resources
│       └── README.md             #   docs per extension
├── playground/               # disposable guinea-pig repo for agent testing (not in git)
└── claude-oauth-pi/          # reference only: pi tarballs + docs, oh-my-pi (OMP) source
```

Boundary rules:

- **`harness/`** is our own ground: change freely, never conflicts with upstream merges. Extensions are wired into Pi by symlinking into `~/.pi/agent/extensions/` (real use) or a project's `.pi/extensions/` (dev/testing).
- **`apps/` + `packages/`** are Synara ground: only touch them when a harness extension needs it — primarily extending the `ExtensionUIContext` bridge in `apps/server/src/provider/Layers/PiAdapter.ts` (Synara ignores TUI-only widgets and editor hooks) plus matching web UI. Keep each change small and note it in the commit message to ease upstream conflict resolution.
- An extension that depends on a bridge change must land in the same commit/PR as that bridge change.
- **`claude-oauth-pi/pkg-src`** holds reference material: `@earendil-works/pi-coding-agent` tarballs (with `docs/` and `examples/extensions|hooks`) and the OMP fork (`oh-my-pi`), a heavily upgraded pi worth studying. Port OMP ideas as extensions when possible; skip features that required forking pi's source.

## Dev Workflow (dev → product)

1. **Dev loop**: run an isolated ADE instance (see Local Dev Instance Isolation), edit extensions in `harness/extensions/`, hot-reload via the Pi reload command in-app, test against `playground/`.
2. **Bisect**: if an extension misbehaves in ADE, run the same extension in the `pi` TUI. TUI-works/ADE-fails ⇒ bridge gap in Synara code; both-fail ⇒ extension bug. Watch for version skew between the `pi` CLI and `@earendil-works/pi-*` pinned in `apps/server/package.json`.
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

## Pi Focus

- Pi is the only provider integrated via direct SDK (no CLI/ACP wrapper). Key files:
  - `apps/server/src/provider/Layers/PiAdapter.ts` — main adapter over `@earendil-works/pi-coding-agent` (`SessionManager`, `ModelRegistry`, `createAgentSessionRuntime`).
  - `apps/server/src/provider/Services/PiAdapter.ts` — service tag/contract.
  - `apps/server/src/provider/piTurnFailure.ts` — Pi turn failure classification.
- Pi is intentionally an unopinionated harness: do not add permission or plan-mode semantics on top of it.
- Pi has no static default model (`getDefaultModel("pi")` returns `null`); models come dynamically from Pi's `ModelRegistry`.
- When touching provider-generic code, verify Pi paths first; other providers second. All providers must keep working — Pi-first does not mean Pi-only.

## Package Roles

- `apps/server`: Bun/Node WebSocket server. Manages provider sessions, orchestration, SQLite persistence, serves the web app.
- `apps/web`: React/Vite UI. Session UX, conversation/event rendering, client-side state. Connects via WebSocket.
- `apps/desktop`: Electron wrapper.
- `packages/contracts`: Effect Schema contracts for provider events, WS protocol, model/session types. Schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities for server and web. Explicit subpath exports (e.g. `@synara/shared/git`) — no barrel index.

## Maintainability

If you add new functionality, first check whether shared logic can be extracted into a module. Duplicate logic across files is a code smell. Don't be afraid to change existing code; don't take shortcuts by adding local logic to solve a shared problem.

## Local Dev Instance Isolation

- Never start the default `bun run dev` while another instance (including the Synara desktop app) is running, unless shared ports/state are intended.
- Use an isolated home dir and non-default ports when running side by side, e.g. `env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 SYNARA_NO_BROWSER=1 bun run dev -- --home-dir ./.ade-dev --port 58090` (dry-run first with `--dry-run`).
- Check ports with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
