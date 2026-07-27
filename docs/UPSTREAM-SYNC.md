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

## 1) Check for a new release

```sh
cd <repo root>
git fetch upstream --tags --quiet
gh api repos/Emanuele-web04/synara/releases --jq '.[0] | {tag: .tag_name, date: .published_at, notes: .body}'
git tag --merged main | grep '^v'          # releases already contained in main
```

New release = latest upstream tag not in `git tag --merged main`.
Read the release notes: they drive conflict expectations and the verify focus.

## 2) Create the sync branch and merge the tag

```sh
git switch -c sync/upstream-vX.Y.Z main
git merge vX.Y.Z --no-edit
```

## 3) Resolve conflicts — rules by file class

| File(s)                                                                                                          | Resolution                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`, `CLAUDE.md`                                                                                         | **Always keep ours** (`git checkout --ours`). Then refresh the upstream copies: `git show vX.Y.Z:AGENTS.md > SYNARA-AGENTS.md` and `git show vX.Y.Z:CLAUDE.md > SYNARA-CLAUDE.md`. |
| `harness/**`, `docs/STATE.md`, `docs/DECISIONS.md`, `docs/REFERENCES.md`, `docs/DELEGATION.md`, this file        | Ours only — upstream never has them. A conflict here means something is wrong; stop and investigate.                                                                               |
| `apps/**`, `packages/**` we never touched                                                                        | **Take theirs** (`git checkout --theirs`).                                                                                                                                         |
| `apps/**`, `packages/**` we modified (bridge changes — check `git log main --oneline -- <file>` for our commits) | Real merge: keep upstream's restructuring AND re-apply our bridge change. Read both sides; do not blind-pick. Our bridge changes are small and noted in their commit messages.     |
| `bun.lock`, `package.json` deps                                                                                  | Take theirs, then re-apply any of our own additions (grep for `@nuncio/` and packages upstream lacks), then `bun install` to regenerate the lock.                                  |
| `"version"` in the four release package.json files                                                               | **Always keep ours** (ADE's own 0.0.x line; the merged Synara tag is recorded in `UPSTREAM-BASE` instead).                                                                         |

After resolving: `git commit` (keep the merge commit; do not squash).

## 4) Verify (all must pass before merging to main)

```sh
bun install
bun run fmt && bun run lint && bun run typecheck
```

Then functional smoke — the parts upstream can silently break for us:

1. Start isolated dev instance (see AGENTS.md §Local Dev Instance Isolation).
2. Create a Pi thread; confirm models are discovered and a turn completes.
3. Confirm harness extensions load (extensions from `harness/extensions/` must
   appear in the session; check provider source shows `pi.sdk+extensions`).
4. If the release bumped `@earendil-works/pi-*`: check its changelog for
   extension-API changes and test one extension end-to-end.

## 5) Land it

```sh
git switch main
git merge sync/upstream-vX.Y.Z --no-edit
git push
git branch -d sync/upstream-vX.Y.Z
```

Update docs (this is part of the sync, per AGENTS.md Living Docs):

- `UPSTREAM-BASE`: set to the merged Synara tag (same commit as the merge).
- `docs/STATE.md`: bump "latest seen" upstream version.
- `docs/DECISIONS.md`: append an entry ONLY if the sync forced a real decision
  (e.g. dropped/adapted an upstream change); routine syncs don't need one.

## 6) When a sync goes wrong

- Conflicts too gnarly / upstream restructured something we depend on:
  abort (`git merge --abort`), keep main untouched, and file the problem —
  do NOT land a half-resolved merge. Cherry-picking the valuable commits from
  the release is the fallback (see AGENTS.md §Upstream Workflow).
- After landing, if the dev instance breaks in ways verify missed:
  `git revert -m 1 <merge-commit>` on main is safe and keeps history clean.

## Automation notes (future)

The intended automation: a scheduled run that executes steps 1–4 and stops.
It reports a ready-for-review sync branch (or "no new release" / "verify failed");
a human (or an explicitly instructed agent) does step 5. Landing to main stays
a deliberate act — the automation must never push to main on its own.
