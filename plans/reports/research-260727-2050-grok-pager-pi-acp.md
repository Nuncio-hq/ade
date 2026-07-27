# Research: Grok Build TUI × pi — pi-backend vs full fork

Date: 2026-07-27. Source: shallow clone at `/tmp/grok-build` (xai-org/grok-build, Apache-2.0, Rust, 78MB, ~60 crates). Pi docs: `../claude-oauth-pi/pkg-src/earendil-works-pi-coding-agent-0.82.1/docs/`.

## Facts (verified in source)

- TUI = `crates/codegen/xai-grok-pager` (+ `pager-render`, `pager-bin`, `pager-minimal`). Runtime = `xai-grok-shell` (+ `tools`, `workspace`, `agent`).
- Pager ↔ runtime seam = **standard open ACP**: workspace dep `agent-client-protocol = "0.10.4"` (same protocol as Zed/Gemini CLI), wrapped by `xai-acp-lib` with `ext_method` extensions (`xai-acp-lib/src/message.rs:107`).
- **Leader architecture**: persistent agent process on unix socket, default `~/.grok/leader.sock`; pager attaches/reconnects with ACP state replay (`pager-bin/src/main.rs:897`). Leader mgmt CLI exists (list/kill/info).
- **`--leader-socket <PATH>`** pager flag = pager can attach to custom socket (`xai-grok-pager/src/app/cli.rs:420` area).
- Leader handshake modest: `LeaderRegistration { client_id, leader_protocol_version: Option, leader_binary_version: Option, leader_capabilities: Option }` + keepalive pings (`xai-grok-shell/src/leader/client.rs:54`). Full leader protocol source readable in repo.
- Caveat: pager also links `xai-grok-shell/tools/workspace` directly (not a pure ACP client); some features may bypass ACP in in-process mode. Leader mode depth = spike question.
- pi side: `pi --mode rpc` = JSONL stdio embedding API (docs/rpc.md), incl. **extension UI channel** `extension_ui_request/response` (select/confirm/input/editor + notify/setStatus/setWidget). `ctx.ui.custom()` = undefined in RPC mode.

## Assessment

Direction A ("pi backend of grok build") is real: build `@nuncio` daemon = ACP-leader impersonator on one side, `pi --mode rpc` client on other. Official `grok` binary + `--leader-socket` → no fork.

Direction B ("turn grok build into pi", full fork) needs the SAME adapter + fork upkeep vs periodic monorepo syncs (generated root Cargo.toml). Everything B needs, A needs too → A first, nothing wasted.

Fallback (if handshake/ext-methods fight us): minimal fork patching ONLY pager (relax handshake, render 2–3 pi ext dialogs), rest untouched → cheap rebase. Full B only if leader mode turns out second-class/abandoned path.

Bonus: pi-ACP adapter is general asset — any ACP client (Zed etc.) could drive pi; only leader-handshake shim is grok-specific.

## Risks (A)

1. xAI ext_method dialect undocumented, may change per release → pin grok binary version, adapt on upgrade.
2. pi extension dialogs `input`/`editor` have no obvious standard-ACP mapping → AskUserQuestion notes/custom-answer fidelity may degrade without pager patch.
3. Pager may require xAI auth / model list from leader before usable — spike question.
4. Leader mode feature parity vs in-process unknown.

## Proposed spike (no commitment)

1. Read `xai-grok-shell/src/leader/mod.rs` registration server-side + enumerate ext_methods pager actually sends (grep `ext_method` call sites).
2. Minimal TS/Bun stub: unix socket + registration + ping + hardcoded ACP `session/update` reply → run `grok --leader-socket` against it, see how far pager gets (auth? models? renders?).
3. If pager renders: wire real `pi --mode rpc` behind it; test AskUserQuestion dialog round-trip.

## Unresolved questions

- Which ext_methods does pager require at startup (models/sessions/auth)?
- Does leader mode support full feature set (plan mode UI, diffs) or degraded?
- ACP mapping for pi `input`/`editor` dialogs — permission-request abuse vs pager patch?
- grok binary auth gate when leader is foreign?
