---
name: moch-merge-workflow
description: Use when merging PRs (GitHub or local branches) into main in the Moch repo — the review → verify → merge → reconcile loop that has run 100+ PRs, including stack branches, squash-merge ancestor traps, API-built branches during push outages, and parallel-session coordination.
---

# Moch merge workflow (review → verify → merge → reconcile)

The established loop for landing other agents'/sessions' work safely.
Everything here was learned executing ~120 PRs and local merges in this repo.

## 0. Orient before touching anything

```bash
git fetch origin --prune          # FULL fetch — `git fetch origin main` leaves every
                                   # other remote ref STALE and you will mis-merge stacks
gh pr list --state open ...       # number, head, BASE, mergeable
git worktree list                 # who else is working where
git status --porcelain            # uncommitted work in the shared checkout
```

- **Check the PR's base branch.** Waves of PRs target a stack branch (`m9/integration`),
  not `main`. Merging via `gh pr merge` lands them on the BASE — if you think it's
  main and it's the stack, "MERGED" quietly landed somewhere else. After the stack's
  PRs merge, open a stack PR (`stack → main`) and merge that too — the wave isn't
  done until main has it.
- **A branch with no PR can hold the newest work.** `git for-each-ref` + content-diff
  against origin/main; ask/confirm before assuming it's stale.

## 1. Review (read-only, adversarial)

- Read the PR body, then the full diff. The body's claim must match the hunk.
- Hunt for what the body *understates*: gating that never engages (BUG-109: a flag
  nothing sets), cleanup that reads a value already null (OAuth cancel on sheet
  close), mount-scoped intervals on never-unmounting tabs (BUG-055 class), and
  renderer-contract violations (segments replacing `m.text` — the PR #4 catch).
- Cross-check RPC names/shapes against the screen that already calls them, and
  Python return shapes against the Kotlin bridge that parses them.
- **Segment-contract trap:** in this repo a non-empty `segments` array REPLACES
  `m.text` at render time. Any producer that sets segments must include a
  `{kind:'text'}` segment or the answer vanishes. Check every new segment producer.
- Small, surgical review fixes ON TOP of the author's branch are welcome (precedent:
  mVCP on the inverted list, focus-gated polling, module-isolated test scripts) —
  commit them with `REVIEW FIX` comments explaining why, then merge the whole thing.

## 2. Verify BEFORE merging (the battery)

In a dedicated worktree (never the user's checkout):

```bash
git worktree add --detach worktrees/pr-review origin/main
ln -sfn <repo>/app/node_modules worktrees/pr-review/app/node_modules   # no reinstall
git checkout --detach origin/<pr-branch>
git merge origin/<pr-base>              # integrate FIRST; resolve conflicts (§3)
```

Then, from `worktrees/pr-review/app`:

- `npm run -s typecheck` (both tsconfigs — catches broken imports AND the
  script-scope TS2451 trap when a new test declares top-level `pass/fail/check`)
- All 14 suites: test, test:imports, test:order, test:chatlist, test:attention,
  test:queue, test:slash, test:interactive, test:command-output, test:media,
  test:sharein, test:terminal, test:browser-relay, test:voice
- Python suites with the **embedded venv** (`app/.venv-embedcheck/bin/python`) —
  bare py3.11 lacks deps and fails mock.patch spuriously (environment artifact,
  not a code bug). Suites live in `app/python-runtime/tests/`.
- `python3 -m py_compile` on every touched `.py` (vendored hermes included).

A green battery is necessary, not sufficient — the PR #4 rendering bug passed every
suite. The review IS the gate; the battery is the regression net.

## 3. Conflict resolution rules

- **Import blocks**: keep both sides' additions.
- **Tracker (`bugs.md`)**: both sections survive, in wave order; fill
  `PR_NUMBER_PLACEHOLDER` with the real PR number.
- **Same-file fix vs older base** (squash noise, §5): take the side that IS the
  fix (the PR's), not main's stale copy.
- **Two features claiming the same slot** (e.g. `_layout` child 0): compose BOTH
  in the order the surrounding structure already uses.
- **A branch iterating on already-merged work** (rounds on the same file): the
  branch's side is usually the strict superset — verify symbols it references
  exist, take its side, py_compile.
- `git rerere` is on in this repo — previous resolutions replay automatically
  ("Staged ... using previous resolution"). Let it.
- Path depth trap: from the worktree root it's `app/app/(tabs)/file.tsx` (TWO
  `app/` levels). Quote parens; use `git add -- 'path'`.

## 4. Merge mechanics

- Default: `gh pr merge <n> --squash` (repo convention — linear history, the PR
  title becomes the commit).
- Stack PRs (stack → main): `--merge` (merge commit) so the stack's history stays
  inspectable.
- Push the integrated branch first (`git push origin HEAD:refs/heads/<branch>`),
  wait ~15s for GitHub to recompute mergeability, then merge.
- **Branch protection is ON for main** — direct pushes are rejected; everything
  goes through PRs, including version bumps (precedent: release PR).
- **Push stalls happen** (GitHub receive hangs; packs land but never ACK). Diagnose
  with a throwaway-ref probe push. If the receive path is down, **build the branch
  through the git-data API**: `POST /git/trees` (base_tree + entries with content)
  → `POST /git/commits` → `POST /git/refs` → PR normally. The resulting tree SHA
  must equal the local branch's tree SHA (cryptographic content proof).

## 5. Squash-merge ancestor traps (the biggest footgun)

Squash-merges NEVER leave ancestor links, so `git branch --merged` and
`merge-base --is-ancestor` lie. Consequences:

- "Unmerged branches" lists are noise: verify CONTENT (`git diff origin/main...<b>`)
  or the PR state, never ancestry alone. Old fix/* labels showing full diffs are
  usually squash noise.
- **A diff-based API-branch build can silently revert main.** If you overlay the
  BRANCH's changed files onto main via the trees API, any file the branch holds at
  a PRE-merge state (it forked before later PRs touched the same file) reverts
  those PRs. After any content-constructing merge, diff the trees
  (`git rev-parse main^{tree}` vs `origin/main^{tree}`) and reconcile stragglers
  with a fix PR (precedent: #52 restoring #48–#50).
- After EVERY merge session: `git fetch origin && git diff origin/main main --stat`
  — empty means truly synced.

## 6. Parallel-session coordination (shared checkout)

Another agent session works this repo concurrently. Rules that prevent disasters:

- **Never move the branch the main checkout stands on.** Do your work in
  `worktrees/pr-review`; build releases in `worktrees/release`.
- If local `main` diverged with unique commits, check whether their CONTENT is
  already upstream before judging: a doc commit landed separately can be
  content-identical to a PR's file. Reset local main only when content-identical
  (`git diff origin/main main` empty after align).
- Uncommitted changes in the main checkout belong to the other session — leave
  them (typical: a versionCode bump for a device build). Note them in the report.
- Untracked files blocking a merge are often byte-identical leftovers of the same
  work: diff each against the incoming version (`git show <rev>:<path> | diff - <path>`);
  remove only if identical.

## 7. Reconcile after merging (every time)

1. `git fetch origin && git worktree remove worktrees/pr-review`
2. Update local main: fast-forward if possible; if it holds unique commits whose
   content is already upstream, `git branch -f main origin/main` (checkout NOT on
   main) or reset after proving tree identity.
3. Leave the user's checkout ON main, clean, tree-identical to origin.
4. Confirm `gh pr list --state open` = 0 (or account for what remains open and why).

## 8. Report back

Per PR: verdict (merged as-is / merged + review fixes), the fixes you added and
why, verification run, and anything deferred. State the final main SHA, that
local == origin (tree SHAs), and what needs a new APK (rule of thumb: Kotlin or
Python changes ⇒ rebuild; JS-only ⇒ Metro reload can suffice).
