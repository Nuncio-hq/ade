# Disabled workflows

Community-management workflows inherited from Synara upstream, disabled for
NuncioADE (private, solo): pr-size, pr-vouch, issue-labels serve public repos
with external contributors and would only add noise (pr-vouch could even block
our own PRs).

Kept here instead of deleted so upstream sync merges surface their changes as
simple moves. Re-enable by moving a file back to `.github/workflows/`.

Active workflows: `ci.yml` (quality gate — also our upstream-sync verifier)
and `release.yml` (desktop builds; macOS signing possible via user's App Store
API keys, Azure/Windows signing unavailable).
