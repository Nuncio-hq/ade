# AGENTS.md

## Project Identity

ADE is a personal agentic development environment, forked from [Synara](https://github.com/Emanuele-web04/synara) (itself a fork of T3Code). It inherits Synara's full architecture and keeps every provider working, but its product direction is **Pi-first**: the Pi provider (`@earendil-works/pi-*` SDK) is the primary, deeply-integrated runtime and gets new investment first. Nothing from Synara is removed.

This is an early WIP. Sweeping changes that improve long-term maintainability are encouraged.

## Upstream Docs (read these too)

The original Synara agent docs are preserved verbatim in this repo and remain authoritative for everything not covered here (Codex app-server, UI conventions, transcript performance guardrails, dev instance isolation details):

- `SYNARA-AGENTS.md` — original upstream `AGENTS.md`
- `SYNARA-CLAUDE.md` — original upstream `CLAUDE.md`

Ignore the "Model Selection" section in those files: it reflects the upstream author's personal pricing deals and tooling, not this project's. Where the upstream docs and this file conflict, this file wins.

## Upstream Workflow

- `upstream` remote points to the original Synara repo. We selectively pull improvements; we do not track it as a hard dependency.
- To inspect upstream: `git fetch upstream && git log --oneline main..upstream/main`.
- Early on, prefer `git merge upstream/main`. Once diverged, prefer `git cherry-pick` of specific commits (especially anything touching `PiAdapter`, `piTurnFailure`, or `@earendil-works/pi-*` version bumps).
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
