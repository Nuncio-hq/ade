# ADE Pi Harness

Our custom Pi harness, built as extensions on top of `@earendil-works/pi-coding-agent` — no fork of pi's source.

- `extensions/` — Pi extensions (auto-discovered when symlinked into `~/.pi/agent/extensions/` or a project's `.pi/extensions/`)

See `AGENTS.md` (Repo Layout & Boundaries) for how this fits into ADE.

## ade-proof (proof-of-work capture)

The `ade-proof` harness adds visual proof capture to an agent session:

- `harness/extensions/ade-proof/` — OMP extension that registers the `ade_proof_shot` tool, nudges after commits with UI files, and gates `session_stop` when UI files were changed without proof.
- `harness/skills/ade-proof/SKILL.md` — when/what/never-to-capture guidance.
- `packages/ade-proof/` — the `@nuncio/ade-proof` CLI, MCP server, and capture backends.

### Install

Symlink the extension into your agent directory:

```bash
ln -s "$(pwd)/harness/extensions/ade-proof" ~/.omp/agent/extensions/ade-proof
```

For the frozen `pi` provider use `~/.pi/agent/extensions/ade-proof` instead.

### What it does

- `ade_proof_shot` runs `bun packages/ade-proof/src/cli.ts shot --json` and returns a workspace-relative image path plus a base64 `ImageContent` block for the TUI.
- After a successful `git commit` with UI files (`*.tsx`, `*.jsx`, `*.css`, `*.vue`, `*.svelte`, `*.html`), the extension sends a visible nudge to capture proof.
- At `session_stop`, if the session edited or committed UI files and `ade_proof_shot` never ran, it requests a single continuation turn.

### Environment knobs

- `ADE_PROOF_LIVE=1` — enable live web/macos integration tests.
- `ADE_PROOF_HEADLESS=1` — force headless Chrome for web capture.
- `ADE_PROOF_CHROME` — override the Chrome/Chromium binary path.
