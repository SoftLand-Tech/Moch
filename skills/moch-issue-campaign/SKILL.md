---
name: moch-issue-campaign
description: Use when asked to verify/fix/close a LARGE backlog of open GitHub issues (15+) — the campaign layer that orchestrates the per-issue pipeline (moch-issue-workflow) and merge loop (moch-merge-workflow) across an agent fleet: clustering, parallel read-only verification, parallel builders on worktrees, the Lead-as-review-gate ship phase, agent-fleet failure recovery, and shell/CI sharp edges. Learned closing 53 issues across two waves (16 + 37) in one session.
---

# Moch issue campaign (close the whole backlog)

`moch-issue-workflow` is the per-issue pipeline (verify → build → ship).
`moch-merge-workflow` is the merge mechanics. THIS skill is the campaign
layer: how to run that pipeline for an entire backlog at once with a fleet
of subagents, without losing work when agents die, without merge chaos, and
without the Lead becoming either a bottleneck or a rubber stamp.

Proven shape: 41 issues → 6 clusters → 6 verifiers → 6 builders → 8 PRs →
0 open issues, in one session, with two builder deaths and one silent
spawn-wall recovered mid-flight.

## 0. Intake — cluster BEFORE anything moves

1. `gh issue list --state open --limit 200 --json number,title,labels` — count
   by severity/label for the report you'll write at the end.
2. Map every issue to the files it lives in (the issue body cites them; trust
   but re-locate later). Group into **same-file clusters** — the unit of work
   is the cluster, not the issue. One PR per cluster (the issue-workflow's
   same-file exception, scaled up).
3. Write the **conflict plan** while clustering: which clusters share which
   files (`gateway_server.py`, `strings.ts`, `bugs.md`, `package.json` are the
   usual suspects) and therefore the **merge order**. Disjoint clusters can
   build in parallel safely; shared-file clusters get explicit file-ownership
   constraints (below) and a sequence.
4. Pre-create every build worktree NOW from `origin/main`:
   `git worktree add -b fix/<cluster> worktrees/fix-<cluster> origin/main` +
   `ln -sfn <repo>/app/node_modules worktrees/fix-<c>/app/node_modules`
   (no reinstall; the merge skill's symlink trick). Never build in the main
   checkout — it may be another session's.

## 1. Verify fleet — read-only agents, one per cluster

Spawn all verifiers in ONE message (independent, background). Each prompt is
SELF-CONTAINED (they share nothing with you):

- Repo map (paths + what lives where + which trees are vendored-but-editable).
- The claims VERBATIM (paste the issue text; do not paraphrase).
- The verdict vocabulary: CONFIRM / PARTIAL / NOT REAL, each with file:line
  evidence **at HEAD**, a current-behavior walk, an understatement hunt
  ("worse than reported" beats "confirmed"), and a minimal fix outline that
  follows the codebase's own patterns.
- The instruction to check the SERVER contract when one exists (vendored
  backend source counts) and to RUN things when cheap (lint, suites, `curl -I`
  a URL — a "corrected" URL inside a comment was ALSO dead; a live probe
  caught it, a code read did not).
- Test targets for the eventual fix.

**Verify at the right tree.** The main checkout may be dirty or on another
session's diverged branch — three separate verifiers reported "your brief's
HEAD is wrong" before I told them to verify against `origin/main` blobs (`git
show origin/main:<file>`) or a clean worktree. Bake that into the prompt.

Never fix from the verification pass. NOT REAL verdicts close immediately
with the evidence as the issue comment — that's real progress, take it.

## 2. Baseline battery — before any fix exists

Run the full battery on a clean worktree of `origin/main` (typecheck + every
npm suite + every python test file) and WRITE DOWN the green counts AND the
normal skips. Every later failure is then attributable to a fix, not the
environment. (Known-benign tails: `test_terminal`'s "reader exited (shell
dead)" log line; piped `npm run -s` sometimes swallows the summary line —
check exit codes via PIPESTATUS or a redirect, never `cmd | tail; echo $?`.)

## 3. Build fleet — one agent per cluster, on the pre-made worktrees

Builder prompts embed the verifier's report (the evidence IS the spec) plus:

- **Hard file-ownership constraints** where clusters could collide: "do NOT
  touch X (a parallel PR owns it); extend existing suites, don't add npm
  scripts" etc. This keeps conflicts to the mechanical files.
- Strings/tracker discipline: append-only own keys (EN+AR), tracker entries as
  checked-off lines with `PR #PR_NUMBER_PLACEHOLDER` (filled at reconcile),
  never delete a line.
- Explicit permission to deviate with a written justification — the best
  builder deviations caught things the verifier missed (an expo-constants
  typing trap, a contract enum that HAD to gain an action).
- The battery to run + "commit with explicit `git add` paths, print
  `git show --stat`, report deviations and understatement finds."

The Lead pre-reviews diffs WHILE builders work (read-only peeks at the
worktrees) — front-loads the gate and catches drift early.

## 4. Ship gate — per cluster, in the planned merge order

For each finished cluster, the Lead does — in this order:

1. **Review the diff yourself** (the merge skill's "review IS the gate").
   Read the core hunks, not just the stat. Verify the builder's battery
   claims by re-running key suites in ITS worktree.
2. **Integrate first**: review worktree → `git merge origin/main` → resolve →
   commit → THEN push and PR. You WILL race your own previous merges (GitHub
   says CONFLICTING because main moved after your last fetch). The fix is
   always: fetch, re-merge, resolve, push, merge in one shot.
   Conflict recipes: **import blocks keep both sides' additions**;
   **strings.ts / package.json keep both key sets** (append-append conflicts);
   **bugs.md tracker waves survive in merge order** (older waves first);
   **same-file fix vs stale base takes the PR's side**.
3. **Battery the integrated branch** (typecheck + the suites the cluster
   touches + one or two canaries).
4. **PR with an evidence body**: per-issue mechanism → fix → verification
   (real numbers) → compat/on-device checklist → honest deferrals.
5. **Squash-merge, then close each issue** with a short verification record
   (verdict + what shipped + PR link). `Closes #N` auto-closes; still post
   the record comment for the NOT REALs and partials.
6. A cluster that can't fully fix something ships the honest partial and the
   tracker says exactly what remains and why.

## 5. Agent-fleet ops — the failure modes and the recovery

Learned the hard way, in order of frequency:

- **Spawns can fail silently or at the tool boundary.** If a spawned agent
  produces nothing: probe with a one-step canary (`reply with one word`),
  then a multi-step canary (create a file, run bash, delete it) to test the
  ROUTE, not just spawning. Child routes need `provider` AND `model`
  TOGETHER (the error literally says so; `model: "@default"` is not valid
  here). Use `list_subagent_models` to find a working route.
- **You cannot steer a running subagent.** `send_message` to one returns
  "active teammate not found" — which is unaddressability, NOT proof of
  death (I misread it once and nearly respawned five live agents). If you
  have corrections mid-run: write them into YOUR review checklist and
  enforce them at the gate.
- **Builders die mid-run; their work survives in the worktree.** Survey
  `git status` + stash list + reflog, finish the missing pieces INLINE at
  the same rigor (the skill's ops note sanctions this), run the battery,
  commit, ship. Two of six builders died in wave 2; both clusters shipped
  from their recovered work.
- **Worktrees are your coordination substrate**: dirty-count and recent-file
  mtime are the only liveness signals you get. But don't poll every round —
  harnesses detect and punish identical repeated calls. Space the checks,
  vary the arguments, or just yield and let completion notifications drive
  you (they will).
- **Goal rounds fire faster than agents work.** A round can arrive seconds
  after you yield; builders need tens of minutes. Yield with no tool call
  when there is genuinely nothing to decide.

## 6. Shell & environment sharp edges (each one cost real minutes)

- `cmd | tail; echo $?` prints TAIL's exit. Use `echo ${PIPESTATUS[0]}` or
  redirect to a file first.
- `/tmp` and `$HOME` may not persist or be writable between shell calls —
  scratch dirs live INSIDE the workspace.
- Gradle in a sandbox: `~/.gradle` can be read-only. Redirect
  `GRADLE_USER_HOME` into the worktree. To test a build-logic change in
  isolation, extract the gate into a scratch project and exercise it with
  the real gradle dist — that legitimately unit-tests configuration logic.
- `gh pr merge --squash` without a number guesses wrong; always pass it.
- jq string interpolation in `gh --jq` breaks with spaces — use `jq 'length'`
  via pipe for counts.
- Kotlin has NO test infra in this repo: "compile against compileSdk 36" via
  the gradle redirect is the strongest offline verification; say "on-device
  pending" honestly in the PR and tracker.

## 7. Reconcile & report — every time, end of campaign especially

1. One final docs PR fills ALL `PR_NUMBER_PLACEHOLDER` tokens (map by
   section header → PR number; the builders can't know their PR numbers).
2. Remove YOUR worktrees (idle + clean + merged = safe; verify all three).
   NEVER touch another session's worktrees or PRs — leave them and say so.
3. Confirm: 0 open issues (yours), 0 open PRs (yours), `origin/main` green.
4. Report per issue: verdict, mechanism shipped, PR, deferred-and-why, and
   the APK-vs-Metro-reload line (Kotlin/Python ⇒ rebuild; JS-only ⇒ reload).

## 8. The one-paragraph version

Cluster by shared files; verify everything read-only in parallel at the
RIGHT commit; baseline the battery; build one agent per cluster on pre-made
worktrees with file-ownership fences; the Lead reviews every diff and re-runs
the battery claims; integrate-before-PR with keep-both conflict recipes;
squash-merge in conflict-plan order; close every issue with its verification
record; reconcile the tracker at the end. When agents die — canary the route,
recover the worktree, finish inline. When you misread HEAD, the fix is
`git show origin/main:<file>`, not assumptions.
