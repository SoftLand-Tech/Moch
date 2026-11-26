---
name: moch-issue-workflow
description: Use when fixing, verifying, or shipping bug fixes and features in the Moch app (or any repo with this pipeline) — the verify → build → PR workflow with adversarial subagents, shared-checkout git coordination, and a bug tracker.
---

# Moch issue workflow (verify → build → ship)

The established pipeline for turning user-reported issues into reviewed PRs.
Everything here was learned by doing it 40+ times across the Moch audit and
fix campaigns.

## 0. Intake — write it down first

- Keep a tracker file (`bugs.md`) at the repo root: one checkbox line per
  issue — `- [ ] **BUG-NNN [URGENT|HIGH|MEDIUM|LOW] Title** — file:line — what's wrong — impact — fix hint`.
- Every fixed issue gets checked off with the PR number. Partials say
  *(partially — what landed / what remains)*. Never delete a line.

## 1. Verify BEFORE building (adversarial, read-only)

- **First diff the working tree.** A prior session may have left an
  UNCOMMITTED fix attempt; the user's report may describe the SHIPPED
  state (HEAD), not the tree. Verify claims against HEAD, then judge the
  attempt (fixes it? fragile? new bugs?). This session: all four reported
  symptoms matched HEAD exactly, and the uncommitted attempt was
  PARTIAL on every one of them.
- Launch verification subagents on a stronger model. They are **READ-ONLY**.
- One agent per issue area, disjoint file scopes. Self-contained prompts:
  repo layout, the claim verbatim, "CONFIRM / PARTIAL / NOT REAL with
  file:line evidence", current-behavior description, and a minimal fix
  outline.
- Tell them to hunt for what the user's report *understates* — the best
  finds are adjacent to the claim ("worse than reported" beats "confirmed").
- Require them to check the claim against the SERVER contract when one
  exists (vendored backend source counts) — client-only reads miss
  protocol truths.
- **On-device UX bugs (IME, keyboard, touch, layout) get verified against
  the NATIVE sources, not JS reasoning** — read the RN/RNKC/library code
  in `node_modules` (`ReactEditText`, `ReactEditTextInputConnectionWrapper`,
  `KeyboardAvoidingView`). JS-level folk wisdom is often false: the
  "focus() early-returns when already focused" comment was wrong at RN
  0.86 (the real mechanism was IMMS dropping showSoftInput); a KAV prop
  looked exact on paper and still self-sank via an edges swap.
- **When the user compares against a native reference app (Termux, a
  polished competitor), the symptom list is the ceiling of the current
  architecture, not four bugs.** Check whether the repo already documents
  the planned next architecture (FEATURE-TERMINAL.md's xterm.js swap) and
  execute it instead of patching round four — patches had hit their
  ceiling by round three.
- Never fix from the verification pass. If a claim is NOT REAL, say so.

## 2. Build (one agent per issue, disjoint files)

- Builders implement from the verification evidence, on their own branch
  from `origin/main`.
- **Shared-checkout coordination** (multiple agents, one working tree):
  - Prefer sequential agents; if parallel, give each a dedicated
    `git worktree` + a symlinked `node_modules`, or accept that the last
    `git add`/commit sweeps everyone's staged files.
  - `git add <explicit-paths>` — never `-A`.
  - Branch switches carry uncommitted changes across branches; check
    `git status` before committing and before trusting a diff.
  - A stray commit on the wrong branch: rewrite via plumbing
    (`git show <branch>:<file> | git hash-object -w --stdin` → temp index
    via `GIT_INDEX_FILE` → `read-tree`/`update-index`/`write-tree` →
    `commit-tree` → `update-ref --force-with-lease`-style CAS) or a temp
    worktree — never reset a branch another live agent is standing on.
- Fix scope: implement the verified fix + the directly adjacent defects
  the verifier proved. Defer anything needing protocol/product decisions —
  document the deferral in the tracker and the PR.
- **Prefer the codebase's proven pattern over a cleverer new one.** When
  one screen already solves the same problem on-device (e.g. chat's
  reanimated keyboard pad), port it instead of inventing coordinate math —
  the boring variant is already device-verified.
- Extract fix logic into the pure layer when it's pure (e.g. the
  keystroke diff → `src/lib/terminal.ts` + `test:terminal` cases). Device-
  untestable logic still gets regression tests.

## 3. Verify the build

- `npm run typecheck` (all tsconfigs) + the project's own test suites.
- No device builds/emulators unless asked — the user verifies on-device.
- Add regression cases to the existing suites when the fix is pure logic.

## 4. Ship

- One PR per issue: evidence-backed body (mechanism → fix → verification),
  merge-order notes when PRs interact.
- **Exception: one PR for a same-file cluster.** When several verified
  issues live in the same ~100 lines, separate PRs conflict on every
  hunk — ship one PR, one commit, with a per-bug section each, and say
  why in the body.
- Tracker entries check off with the PR number **and the verification
  status**: `*(fixed in PR #NN — on-device check pending user's next dev
  build)*` when the proof so far is source-level. JS-only fixes still
  need an APK/metro rebuild before the user can confirm.
- After merging: fast-forward local main, and reconcile the tracker.

## 5. Report back

- Per issue: verdict, what shipped, PR link, what was deferred and why.
- Partial fixes are honest fixes — mark them, list what remains.

## 6. Ops notes

- If subagents die instantly with a provider 429 (usage limit), retry the
  spawn once with `model: "@default"` (the parent's live model) before
  falling back to doing the verification pass inline yourself — same
  rigor, no adversarial second opinion.
