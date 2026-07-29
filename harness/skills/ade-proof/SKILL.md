# ade-proof capture skill

Proof-of-work capture for features with a visible surface.

## When to capture

Capture proof whenever a change has a user-visible surface. Run `ade-proof shot`
(or `ade_proof_shot`) before the final `stop`. Label the shot clearly, avoid
credential screens, and ensure `.ade/` is in `.gitignore`.

- After implementing a UI change (web page, component, dialog, error state).
- After a `git commit` that touched `.tsx`, `.jsx`, `.css`, `.vue`, `.svelte`, or `.html`.
- Before ending the session, as the last evidence artifact.

## Labels

Use short, snake-case labels that describe the state shown:

- `login-form-error`
- `dashboard-loaded`
- `settings-modal-dark-mode`

Avoid generic labels like `screenshot-1`.

## Storage state for auth'd apps

If the app requires a logged-in state, pass `--storage-state <path>` with a
JSON cookie/storage-state file. Never store real passwords in the state file
or commit it.

## macOS window capture

For `target=macos` the host must grant **Screen Recording** permission to the
binary running `screencapture` (usually your terminal/IDE the first time).

## What NOT to capture

- Login, 2FA, API-key, or payment forms.
- Anything containing secrets, tokens, or PII.
- Internal error stacks when the focus is UI behavior (capture the UI, not the
  terminal).

## Install into a project

```bash
mkdir -p .pi/extensions
ln -s ../../harness/extensions/ade-proof .pi/extensions/ade-proof
```

## .gitignore

Ensure this is present:

```gitignore
.ade/
```

## Env knobs

- `ADE_PROOF_HEADLESS=1` — force headless Chrome for web capture.
- `ADE_PROOF_CHROME` — override the Chrome/Chromium binary path.

---

## AGENTS.md snippet

Add this to the project's `AGENTS.md` to enable the proof capture workflow:

```markdown
## ade-proof (proof-of-work capture)

The `ade-proof` harness adds visual proof capture to an agent session. It lives
in `harness/extensions/ade-proof/` and is auto-discovered when symlinked into
`~/.omp/agent/extensions/` or a project's `.pi/extensions/`.

- Register the `ade_proof_shot` tool with target `web` or `macos`.
- After a successful `git commit` that touched UI files, the extension may nudge
  for a screenshot.
- If UI files were changed or committed and no shot was taken, the
  `session_stop` gate requests continuation once to capture proof.

Environment variables:

- `ADE_PROOF_HEADLESS=1` — force headless Chrome.
- `ADE_PROOF_CHROME` — Chromium binary path override.
```
