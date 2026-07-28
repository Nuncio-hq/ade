# UPSTREAM-SYNC — pulling Synara releases into NuncioADE

> Runbook for syncing from upstream Synara. Written to be executable by an agent
> with no chat context. Policy summary lives in AGENTS.md §Upstream Workflow;
> this file is the how.

## Policy (do not violate)

- Sync **release tags only** (`vX.Y.Z`). NEVER merge `upstream/main` HEAD.
- One release per sync branch: `sync/upstream-vX.Y.Z`.
- If multiple releases accumulated, merge the **latest** tag only (it contains
  the earlier ones); don't do one branch per skipped release.
- Never push to `upstream`.
- The shadow branch `sync/rebranded-upstream` is the ONE sanctioned long-lived
  branch besides `main` (see AGENTS.md §Branching). It is a mechanical artifact:
  `latest synced upstream tag + rebrand codemod`. Never hand-edit it; it is only
  ever updated by this runbook.

## Why the shadow branch

ADR: both `main` and upstream releases are rebranded by the SAME deterministic
codemod (`scripts/rebrand-identity.ts`). Merging a rebranded tree into a
rebranded tree makes every identity rename a non-conflict — proven in the
v0.6.2 rehearsal (2026-07-28): 1296 files rebranded on the shadow, merge into
the rebrand branch produced a tree byte-identical to the pre-merge state
(`git diff HEAD` empty after resolution). Conflicts can then only appear where
ADE _deliberately_ diverges from upstream, which is exactly where human
attention belongs.

## 1) Check for a new release

```sh
cd <repo root>
git fetch upstream --tags --quiet
gh api repos/Emanuele-web04/synara/releases --jq '.[0] | {tag: .tag_name, date: .published_at, notes: .body}'
git tag --merged main | grep '^v'          # releases already contained in main
```

New release = latest upstream tag not in `git tag --merged main`.
Read the release notes: they drive conflict expectations and the verify focus.

## 2) Advance the shadow branch to the new tag

```sh
git switch sync/rebranded-upstream
git merge vX.Y.Z --no-edit        # conflicts here are rare; see below
git show main:scripts/rebrand-identity.ts > /tmp/rebrand-identity.ts
bun /tmp/rebrand-identity.ts      # normalize whatever the release brought
git add -A
git commit -m "chore: rebrand upstream vX.Y.Z to NuncioADE identity"
```

Notes:

- The shadow tree has no copy of the codemod (it only contains upstream files),
  so extract the CURRENT codemod from `main` each time. Always use the latest
  codemod — rule fixes (protections, exemptions) apply retroactively.
- Merge conflicts inside the shadow (upstream moved a line the codemod also
  rewrites) resolve toward UPSTREAM's structure, then let the codemod run
  normalize identity. Never resolve toward old shadow content.
- **List ALL conflicts before resolving — never truncate merge output**
  (`| tail` cost us a broken shadow once). Resolve every file in
  `git diff --name-only --diff-filter=U`, and before committing verify BOTH:
  zero unmerged paths AND zero conflict markers:
  `rg -l '^<{7} |^>{7} ' --glob '!node_modules'` must print nothing.
  `git add -A` happily stages unresolved markers and the commit then succeeds —
  this is the one way the shadow can silently go bad.
- The shadow's `.gitignore` is upstream's: it does NOT ignore ADE-local paths
  like `.ade-dev/`. Before working on the shadow, add `.ade-dev/` to
  `$(git rev-parse --git-dir)/info/exclude` (per-worktree, survives branch
  switches) so `git add -A` can't pollute the shadow with dev-instance state.
- Re-running the codemod is idempotent; an unchanged release produces "nothing
  to change" and you may skip the commit.

## 3) Merge the shadow into a sync branch

```sh
git switch -c sync/upstream-vX.Y.Z main
git merge sync/rebranded-upstream --no-edit
```

## 4) Resolve conflicts — rules by file class

Identity renames never conflict anymore (both sides share them). A conflict
here always means "ADE diverges on purpose" or "upstream restructured code we
modified". Resolve by class:

| File(s)                                                                                                          | Resolution                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`, `CLAUDE.md`                                                                                         | **Always keep ours** (`git checkout --ours`). Then refresh the upstream copies: `git show vX.Y.Z:AGENTS.md > SYNARA-AGENTS.md` and `git show vX.Y.Z:CLAUDE.md > SYNARA-CLAUDE.md` (raw tag, NOT shadow — the snapshots keep upstream's own identity). |
| `harness/**`, `docs/STATE.md`, `docs/DECISIONS.md`, `docs/REFERENCES.md`, `docs/DELEGATION.md`, this file        | Ours only — upstream never has them. A conflict here means something is wrong; stop and investigate.                                                                                                                                                  |
| Identity VALUES we deliberately changed (bundle IDs, `com.nuncio.ade`, update channels, endpoints)               | **Keep ours.** The shadow carries upstream's values rebranded; ours are product decisions (see `packages/shared/src/desktopIdentity.ts`).                                                                                                             |
| `apps/**`, `packages/**` we never touched                                                                        | **Take theirs** (`git checkout --theirs`).                                                                                                                                                                                                            |
| `apps/**`, `packages/**` we modified (bridge changes — check `git log main --oneline -- <file>` for our commits) | Real merge: keep upstream's restructuring AND re-apply our bridge change. Read both sides; do not blind-pick. Our bridge changes are small and noted in their commit messages.                                                                        |
| `bun.lock`, `package.json` deps                                                                                  | Take theirs, then re-apply any of our own additions (grep for `@nuncio/` and packages upstream lacks), then `bun install` to regenerate the lock.                                                                                                     |
| `"version"` in the four release package.json files                                                               | **Always keep ours** (ADE's own 0.0.x line; the merged Synara tag is recorded in `UPSTREAM-BASE` instead).                                                                                                                                            |
| `scripts/rebrand-identity.ts`, `scripts/check-brand-identity*`                                                   | Keep ours. The shadow never contains these files; a conflict means upstream added a same-named file — investigate.                                                                                                                                    |

Shortcut that is usually correct: if `git log main --oneline -- <file>` shows
no ADE commit since the last sync, take theirs; if it shows only rebrand/manual
identity commits, take ours. When in doubt, read both sides.

After resolving: `git commit` (keep the merge commit; do not squash).

## 5) Verify (all must pass before merging to main)

```sh
bun install
bun run brand:check     # identity guard: no retired tokens outside exemptions
bun run fmt && bun run lint && bun run typecheck
bun run test
```

Then functional smoke — the parts upstream can silently break for us:

1. Start isolated dev instance (see AGENTS.md §Local Dev Instance Isolation).
2. Create a Pi thread; confirm models are discovered and a turn completes.
3. Confirm harness extensions load (extensions from `harness/extensions/` must
   appear in the session; check provider source shows `pi.sdk+extensions`).
4. If the release bumped `@earendil-works/pi-*`: check its changelog for
   extension-API changes and test one extension end-to-end.

## 6) Land it

```sh
git switch main
git merge sync/upstream-vX.Y.Z --no-edit
git push
git branch -d sync/upstream-vX.Y.Z    # the SHADOW branch stays alive
```

Update docs (this is part of the sync, per AGENTS.md Living Docs):

- `UPSTREAM-BASE`: set to the merged Synara tag (same commit as the merge).
- `docs/STATE.md`: bump "latest seen" upstream version.
- `docs/DECISIONS.md`: append an entry ONLY if the sync forced a real decision
  (e.g. dropped/adapted an upstream change); routine syncs don't need one.

## 7) When a sync goes wrong

- Conflicts too gnarly / upstream restructured something we depend on:
  abort (`git merge --abort`), keep main untouched, and file the problem —
  do NOT land a half-resolved merge. Cherry-picking the valuable commits from
  the release is the fallback (see AGENTS.md §Upstream Workflow) — apply the
  codemod to the cherry-picked files afterwards.
- If the SHADOW merge (step 2) goes wrong: reset the shadow to its previous tip
  (`git reset --hard sync/rebranded-upstream@{1}`), sync the old way for this
  release, and fix the codemod before the next one.
- After landing, if the dev instance breaks in ways verify missed:
  `git revert -m 1 <merge-commit>` on main is safe and keeps history clean.

## Automation notes (future)

The intended automation: a scheduled run that executes steps 1–5 and stops.
It reports a ready-for-review sync branch (or "no new release" / "verify
failed"); a human (or an explicitly instructed agent) does step 6. Landing to
main stays a deliberate act — the automation must never push to main on its
own.
