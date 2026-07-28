# Phase 03 — States, settings panel, verification, docs

## Context Links

- Overview: [plan.md](plan.md); phases [01](phase-01-data-layer.md), [02](phase-02-web-ui.md)
- Settings patterns: `settingsNavigation.ts` (`integrations` section),
  `ProviderCredentials` (`providerCredentials.ts`), `ServerSettings` redaction
  pattern (`*Configured` booleans)

## Overview

- Priority: third — ship-readiness
- Status: pending
- Token management UX, all lifecycle states, verification pass, living-docs
  updates

## Key Insights

- Token must be configurable entirely from UI (no env restart): Settings →
  Integrations → ScreensDesign → paste, test, save into ServerSecretStore.
- Every data surface shows provenance: `Source: screensdesign · fetched Nd
ago`; >30d = `stale` badge. Snapshot mode is a feature, not an error.
- Failures are states, not crashes: no token, syncing, token expired (401),
  rate limited, offline — each with a next action.

## Requirements

- Functional: settings integrations panel (token set/test/clear, account
  email + Pro/free shown from `/v1/me/`); sync states (idle/running/failed);
  401 banner app-wide in App Factory with update-token CTA; empty states per
  tab; stale badges; cancel/resume sync controls.
- Non-functional: `bun fmt`, `bun lint`, `bun typecheck` green; `bun run test`
  for new logic (sync resume, schema mapping, preset predicates); dogfood on
  isolated dev instance.

## Test Plan (write BEFORE implementation)

- **Token redaction**: after `setToken`, assert the token string appears in
  no RPC payload, no settings response, no sync-run error text (grep-style
  unit test over serialized outputs).
- **Banner state machine**: idle → syncing → idle / failed(token_invalid);
  401 during sync → banner + data still readable (repo layer untouched).
- **Stale badge**: boundary at exactly 30d; missing `fetched_at` → no badge
  crash.

## Implementation Steps

0. Write the failing tests above first.
1. Settings → Integrations: ScreensDesign card (set/test/clear + status).
2. Global App Factory state banner (401 / sync failed / sync running).
3. Empty states: no token (connect CTA), pre-sync (sync CTA), empty watchlist
   (hint to pin), empty Rising (loosen preset hint).
4. Stale-badge component wired to `fetched_at`.
5. Tests: redaction, banner state machine, stale boundary (written in step 0)
   plus any regressions found during dogfooding.
6. Verification pass: fmt/lint/typecheck + `bun run test` (never `bun test`);
   confirm no NEW failures vs the 36 known upstream ones.
7. Docs: STATE.md milestone M5 → shipped; commit notes list wiring-point
   diffs for future upstream merges.

## Todo List

- [ ] token set/test/clear from UI; account info displayed
- [ ] 401 banner keeps data browsable, CTA works
- [ ] all 4 empty states render
- [ ] stale badge at >30d
- [ ] redaction + banner state machine + stale boundary tests (Red first)
- [ ] fmt/lint/typecheck/test green
- [ ] STATE.md updated; wiring diffs noted in commit message

## Success Criteria

- Fresh profile on dev instance, no env vars: complete flow connect → sync →
  research works; disconnect network mid-sync → resume; expire token → 401
  banner + snapshot still browsable.

## Risk Assessment

- Settings surface leaks token → reuse redaction pattern; only `configured:
bool` + account email leave the server.
- First-sync duration UX → progress + cancel; resume validated by test.

## Security Considerations

- Same as phase 01 (secret isolation) + no token in URL/query/state dumps.

## Next Steps

- Ship P1 → tag decision with user → P2 scope: GetAppNiche integration
  (AF-14, credits UI), media download for shortlist, then clone handoff
  (facts pack + `/ade-app-clone` skill).
