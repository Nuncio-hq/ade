# REFERENCES — projects we learn from

> Consult these when designing a similar feature. Extract patterns and ideas,
> not code (respect licenses). Entries curated by the user — propose additions,
> don't add silently.

## App design / taste (system-wide)

- **Synara** (`upstream` remote) — our fork base; design + orchestration reference by definition.
- **T3Code** (pingdotgg/t3code) — Synara's own origin; where the core design taste comes from.
- **Zed** (zed-industries/zed) — top-tier clean code and UI polish; authors of ACP (which Synara uses for some adapters). User backs this team.
- **Conductor** (closed, Mac) — parallel Claude Code workspaces; good workspace harness UX. Related: orca/superset (extensions in `~/.pi/agent/extensions/` come from this world).

## System architecture (NOT harness behavior)

- **OpenCode** (sst/opencode) — study the client/server split and large-codebase structure only. Do NOT copy its harness UX; user used it long-term and dislikes it as a harness.

## Harness (open source)

- **Codex CLI** (openai/codex) — OpenAI's harness; protocol/app-server design.
- **pi** (@earendil-works, tarballs in `../claude-oauth-pi/pkg-src/`) — our base harness; extension API is our platform.
- **OMP / oh-my-pi** (can1357/oh-my-pi) — heavily upgraded pi fork; user liked it in practice. Richest source of "what to build next" for our harness (port as extensions).
- **Grok Build** (xAI) — harness reference.
- **Kilo Code** (Kilo-Org/kilocode) — exemplary fork lineage: Cline → Roo Code → Kilo, building on top instead of rewriting; a model for how we treat Synara.
- **Cline** (cline/cline) — origin of that lineage; plan/act mode pattern at the source.
- **Aider** (Aider-AI/aider) — the OG harness; git-native workflow (auto-commit, undo) and benchmark methodology.
- **OpenHands** (All-Hands-AI/OpenHands) — open-source Devin; readable source for the async-agent ideas that inspired us. User used it briefly, positive.

## Closed source — learn from changelogs, blogs, research posts

- **Claude Code** (Anthropic) — harness behavior, hooks/skills model, release notes.
- **Cursor** (Anysphere) — user's #1 harness overall; UX bar to measure against.
- **Devin** (Cognition) — the inspiration for "your machine as cloud, agents"; study their task lifecycle writeups.
- **Factory Droid** — strong harness; its **mission** feature is something we want to build. Also a Synara provider, so observable in-app.
- **Amp** (Sourcegraph) — user's #2 after Cursor; unusually candid engineering blog + changelog (threads, oracle, sub-agents).

## Mobile / remote clients (for `apps/mobile`)

Open source:

- **Remodex** (Emanuele-web04) — same author as Synara; mobile remote for coding agents. Closest open reference to our mobile plan, from the codebase family we already know.
- **Orca mobile** — mobile version of orca (we already run its pi extensions); shows the extension-world take on remote control.

Closed source — study UX and feature scope:

- **Codex remote/cloud** (OpenAI) — phone-initiated async tasks, review-and-land flow.
- **Cursor mobile/web agents** (Anysphere) — remote agent UX from the #1 harness.
- **Devin PWA** (Cognition) — mobile surface for the original "cloud agents" product; note it's a PWA (we chose native — see DECISIONS.md) but its task-centric IA is the pattern to study.
