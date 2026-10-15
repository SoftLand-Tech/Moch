# Moch full desktop plan

Moch becomes a full desktop application. The real phone app runs in the Tauri 2 shell against a supervised local gateway, with every capability the phone has, real packaging, and a permanent verification gate. The operator gets a reviewable linear PR stack on branch `desktop-tauri`. The program enforces the architecture's hard rule. No business or protocol logic lands in the desktop tree. Behaviour goes into `app/src/lib`, and both platforms consume it. PRs in landing order are D1, D2, then D3 D4 D5 D6 D7 D8 D10 in parallel with D11, then D9, D12, D13.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `poteto-mode/playbooks/autopilot-stack.md`. Owners report STACK-READY, the root chains each PR onto its parent branch, and the operator lands bottom-up. Merge authority stays with the operator.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Environment adaptations for this machine, recorded once here and obeyed everywhere.

- Program trunk is branch `desktop-tauri` in the worktree `worktrees/desktop-tauri`. The docs to re-read at every tick are `desktop/ARCHITECTURE.md`, `desktop/PARITY-BACKLOG.md`, `desktop/P1-STATUS.md`, `desktop/DESKTOP-SHELL-SPEC.md`, and `desktop/ui/FROZEN.md`, read from the branch head.
- Owners are normally fresh `poteto-agent` subagents. On 2026-10-15 every subagent spawn in this environment failed with a provider 403 (no active subscription), observed on two separate spawn rounds. Until that heals, the executing chat takes the owner role box by box and logs each takeover in the decision trail. A healed provider means owners spawn again as normal.
- The audit tick has no `/loop` tool in this harness. The operator schedules the tick prompt below at any cadence, or the executing chat self-ticks between boxes.

Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from the branch head at program start. Re-read them at every tick. The upstream `git show origin/main:` reads do not exist for this program, because its trunk is the worktree branch, so the tick re-reads the files below at the branch head instead.
  - [ ] `poteto-mode/playbooks/autopilot-stack.md` and `poteto-mode/playbooks/autopilot-full.md` for the parts stack does not override
  - [ ] `poteto-mode/playbooks/shipping.md` for the patch-id rule and landing
  - [ ] `desktop/ARCHITECTURE.md`, `desktop/PARITY-BACKLOG.md`, `desktop/P1-STATUS.md`, `desktop/DESKTOP-SHELL-SPEC.md`, `desktop/ui/FROZEN.md`
  - [ ] `app/AGENTS.md` and `desktop/src-tauri` conventions
- [ ] On the operator's go, arm the audit tick as `/loop 1h` on any machine where a loop tool exists. In this harness the operator schedules the verbatim prompt below at any cadence, or the executing chat self-ticks between boxes. Never leave the cadence to memory.
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once, and post a short status message naming the stand-down in chat.

Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle of build, verify, stack-ready report, and verdict round.
- [ ] Follow this dependency graph. Start dependent work only after its parent reaches STACK-READY, or base it on the parent branch when stacking.
  - [ ] D1 is first and chains onto `desktop-tauri`.
  - [ ] D2 after D1.
  - [ ] D3, D4, D5, D6, D7, D8, and D10 after D2, mutually independent.
  - [ ] D11 after D1, in parallel with the D3 wave. D11 holds `desktop/src-tauri` exclusively inside that wave.
  - [ ] D9 after D11, because the notification slice touches the shell.
  - [ ] D12 after D11 and after the D3 wave, because it bundles the finished app and owns `desktop/src-tauri`.
  - [ ] D13 after D12.
- [ ] Hold the file boundaries. D3 through D10 and D13 touch `app/` and `desktop` presentation files only. D11 and D12 touch `desktop/src-tauri` and `desktop/runtime.py` only, plus their app-side seams listed in their sections.
- [ ] Hold the review gate. D1, D2, D11, and D12 change an interaction or ship an installer. They wait for the operator's review in chat with screenshots and a video before landing.

### PR mechanics, for every PR

- [ ] Resolve the forge once. `command -v origin` fails on this machine, so use `gh` for every PR operation. Recorded 2026-10-15 against `github.com/SoftLand-Tech/Moch`.
- [ ] Open the PR ready, never draft. `gh pr create --base <parent-branch>`. A stack child targets its parent branch, and the chain root targets `desktop-tauri`.
- [ ] Run the repo's typecheck once before the PR-facing push. Push with hooks on. App typecheck is `npm run typecheck` in `app/`; shell typecheck is `cargo build` in `desktop/src-tauri`.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `references/bugbot-triage.md`.
- [ ] Rebase onto the current parent tip before the stack-ready report and keep that merge base in fix rounds. Rebase again only at landing prep, on a `git merge-tree` conflict with the parent, or on a failure caused by a parent change.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. A rebase, a conflict resolution, or a minor fix gets a single verifier at the new head. Each swarm has one gates lane, the ten live lanes from the PR's verify block, the perf lane, and two audit lanes that read the diff and the receipts and distrust the PR body.
- [ ] Adaptation while the provider 403 stands. The swarm runs as direct checks by the executing chat, each lane with its own evidence file, and the cross-model audit lanes are skipped and recorded as skipped. A healed provider restores the real swarm.
- [ ] Clean only when every lane passes. Findings go back to the owner, including a defect a lane filed as a note.
- [ ] The owner reports STACK-READY with its verdict attached. The root appends the clean PR to the chain in dependency order with base set to its parent branch. The operator lands the stack bottom-up per `playbooks/shipping.md`, including the patch-id rule.

### Boot recipe, for every live lane

Each lane runs on this machine at the PR head. The single box replaces the cloud-VM fleet of the standard recipe.

- [ ] `git checkout <head SHA>` in the worktree. Stop any running Moch instance first; the flock must be free.
- [ ] Build the UI and the shell. Run `bash desktop/scripts/build-app-web.sh`, then `cargo build` in `desktop/src-tauri`.
- [ ] Start the surface. Served lanes run `bash desktop/scripts/serve-app-web.sh 8099` against a gateway started per `desktop/P1-STATUS.md`. Shell lanes launch `desktop/src-tauri/target/debug/moch-desktop` under `setsid --wait` with `GDK_BACKEND=x11 DISPLAY=:0`.
- [ ] Drive input through the surface. Keys and text go through `wtype` after focusing the window with `hyprctl dispatch 'hl.dsp.focus({ workspace = <n> })'`. Protocol-level turns run through `desktop/scripts/turn.mjs` against `runtime-home/.moch-gateway.json`. In-webview DOM control rides `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223` on the shell once D1 lands it.
- [ ] Save every screenshot to `desktop/.tmp/verify/<pr-id>/lane-<n>-<slug>.png` and list the paths in the lane report. Read rendered text with `tesseract` on the crop.

## Finish the P1 gate and repair the harness (D1)

**Depends on.** None. Chains onto `desktop-tauri`.

**Files.**

- [ ] Commit the existing uncommitted P1 code. That is `app/src/lib/desktopLocal.ts`, `app/app/_layout.tsx`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/tauri.conf.json`, `desktop/package.json`, `desktop/.gitignore`, `desktop/scripts/`, and the four program docs.
- [ ] Edit `desktop/scripts/shot.mjs` and `desktop/scripts/verify-desktop.sh` (two harness fixes already staged in the worktree, see Build).
- [ ] Edit `desktop/src-tauri/src/lib.rs` to pass `WEBKIT_INSPECTOR_SERVER` into the webview process.

**Build.**

- [ ] Commit the P1 bridge. `desktopLocal.ts` adopts the supervised loopback gateway from `GET /moch-config.json` as the remembered computer named "This computer", and `app/app/_layout.tsx` seeds it before the first dial.
- [ ] Keep the two harness fixes. `shot.mjs` launches Chromium with `--headless`, the only spelling Chromium 152 accepts, and `verify-desktop.sh` forwards `--chromium <path>` to `shot.mjs`.
- [ ] Add the inspector seam. The shell sets `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223` when `MOCH_DEV=1`, so lanes can read DOM text and drive the real composer without screenshot OCR.
- [ ] Measure cold start and peak RSS with the shell gate and record the numbers as the program baseline in `desktop/P1-STATUS.md`.

**You see.**

- [ ] `bash scripts/verify-desktop.sh --mode served` ends with `RESULT: PASS`, all twelve checks.
- [ ] `bash scripts/verify-desktop.sh --mode shell` ends with `RESULT: PASS` including cold-start and peak-RSS numbers.
- [ ] Four width screenshots of the chat surface exist under `desktop/.tmp/verify/d1/` at 1024, 1280, 1440, and 1920.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `cargo build` exits 0 in `desktop/src-tauri`. Run it.
- [ ] `npm run typecheck` exits 0 in `app/`. Run it.
- [ ] `bash -n` on both edited scripts. Run it.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression lane against the base. Run pairing-free boot to chat surface at base and at head. The base shows the pairing screen, the head shows the chat surface. Save `lane-1-regression.png`. Pass when head lands on chat and base does not.
- [ ] Lane 2. Served gate green. `verify-desktop.sh --mode served`. Save `lane-2-served.png`. Pass when `RESULT: PASS`.
- [ ] Lane 3. Shell gate green. `verify-desktop.sh --mode shell`. Save `lane-3-shell.png`. Pass when `RESULT: PASS` with cold-start and RSS numbers.
- [ ] Lane 4. Real streamed turn in the shell window. Type into the focused composer, wait for the reply, crop and read it. Save `lane-4-inui-turn.png`. Pass when the reply text appears in the transcript.
- [ ] Lane 5. Restart persistence. Quit the shell, relaunch, confirm the chat list and remembered computer survive. Save `lane-5-restart.png`. Pass when no pairing screen and history present.
- [ ] Lane 6. Gateway crash recovery. Kill the runtime child, confirm the shell surfaces an error and restarts it, then a turn completes. Save `lane-6-recovery.png`. Pass when a later turn completes.
- [ ] Lane 7. Four-width render. Screenshots at 1024, 1280, 1440, 1920 with no clipped composer. Save `lane-7-widths-<w>.png`. Pass when the composer is visible and inside the window at every width.
- [ ] Lane 8. DOM text via inspector. With `MOCH_DEV=1`, read the composer placeholder and one chip label over `127.0.0.1:9223`. Save `lane-8-dom.json`. Pass when both strings match the app's strings.
- [ ] Lane 9. Multi-turn conversation. Three prompts in one chat, replies in order. Save `lane-9-multiturn.png`. Pass when three user rows and three replies render in order.
- [ ] Lane 10. Long-session stability. Leave a stream running two minutes, then send a follow-up. Save `lane-10-stability.png`. Pass when the follow-up sends without reload.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cold start to interactive chat surface, peak RSS of the whole tree, and prompt-ack latency.
- [ ] Probe. Shell gate cold-start timer, `/proc/<pid>/status` VmHWM poll, and the turn driver's completion timestamp. Run at base and at head, interleaved.
- [ ] Baseline. Record the base numbers in `desktop/P1-STATUS.md` first. The base cannot run the real UI, so also record the head-only numbers as the program baseline.
- [ ] Rule. Absolute budgets, because the base cannot run the same scenario. Cold start at or under 20 s to chat, peak RSS at or under 1.2 GB, prompt-ack at or under 1.5 s on a warm gateway.

**Review gate.** The operator reviews before landing.

- [ ] Copy lane 1, 4, and 7 screenshots into `desktop/docs-shots/d1-review/`.
- [ ] Record a 30 to 60 second video of boot to streamed reply. Save it as `desktop/docs-shots/d1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. This PR is in the gated set (D1, D2, D11, D12), so it stops at stack-ready and waits for the operator's review.
- [ ] Stop at stack-ready. Wait for the operator.

**Merge.**

- [ ] Operator lands D1 onto `desktop-tauri` after the clean verdict.

## Desktop shell presentation (D2)

**Depends on.** D1. Implements `desktop/DESKTOP-SHELL-SPEC.md` and ARCHITECTURE P2.

**Files.**

- [ ] Create `desktop/shell/` for the desktop presentation layer (nav rail, panes, palette, accelerators, menus).
- [ ] Edit `app/app/_layout.tsx` and `app/src/components/ScreenShell.tsx` for the desktop layout seams, behind a platform check.

**Build.**

- [ ] Nav rail on the left with the app's real screens; single-pane chat by default.
- [ ] Collapsible and resizable panes with persisted geometry.
- [ ] Ctrl+K command palette backed by `app/src/lib/slash.ts` catalogs.
- [ ] Accelerators cover Ctrl+1 through Ctrl+9 tabs, Ctrl+B rail, Ctrl+J transcript, Ctrl+Enter send, and Shift+Enter newline.
- [ ] Native menu bar via the Tauri menu API, wired to the same dispatch.
- [ ] Window state persistence across restarts.
- [ ] Focus rings, ARIA roles, and a density pass on tables.

**You see.**

- [ ] A 1280 window shows rail, chat pane, and no phone-only chrome. Ctrl+K opens the palette. Ctrl+2 switches screens. Restart restores pane geometry.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Node tests for the palette index built from the slash catalog. Run `npm run test` in `app/`.
- [ ] Typecheck both trees. Run them.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression lane against D1. Chat surface still boots to chat and streams. Save `lane-1-regression.png`. Pass when D1 behavior is unchanged.
- [ ] Lane 2. Rail navigation to every screen. Save `lane-2-rail.png`. Pass when each screen renders.
- [ ] Lane 3. Ctrl+K palette opens, filters, executes a command. Save `lane-3-palette.png`. Pass when the command runs.
- [ ] Lane 4. Ctrl+Enter sends, Shift+Enter newlines. Save `lane-4-keys.png`. Pass when both behave.
- [ ] Lane 5. Pane resize and collapse persists across restart. Save `lane-5-panes.png`. Pass when geometry matches after relaunch.
- [ ] Lane 6. Native menu triggers the same actions as the rail. Save `lane-6-menu.png`. Pass when menu items act.
- [ ] Lane 7. Keyboard-only pass reaches composer, send, and palette without a mouse. Save `lane-7-kbd.png`. Pass when all three work.
- [ ] Lane 8. ARIA smoke shows a focus ring on rail and palette items. Save `lane-8-aria.png`. Pass when rings render.
- [ ] Lane 9. Dense table check on sessions and automations. Save `lane-9-tables.png`. Pass when tables fit 1280 without clipping.
- [ ] Lane 10. Phone regression. The same screens still render phone-shaped in the Expo runtime. Save `lane-10-phone.png`. Pass when the phone layout is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Palette open latency and pane resize frame cost.
- [ ] Probe. Timestamp from keypress to palette paint via the inspector; resize while a stream runs.
- [ ] Baseline. Record at D1 head first.
- [ ] Rule. Palette opens at or under 100 ms. Resize during a stream drops no more than 2 frames per second of drag.

**Review gate.** The operator reviews before landing.

- [ ] Copy lanes 2, 3, and 5 screenshots into `desktop/docs-shots/d2-review/`.
- [ ] Record a 30 to 60 second video of rail, palette, panes, and accelerators. Save it as `desktop/docs-shots/d2-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. This PR is in the gated set (D1, D2, D11, D12), so it stops at stack-ready and waits for the operator's review.
- [ ] Stop at stack-ready. Wait for the operator.

**Merge.**

- [ ] Operator lands D2 after the clean verdict.

## Terminal and PTY pane (D3)

**Depends on.** D2. Implements `desktop/PARITY-BACKLOG.md` row 1.

**Files.**

- [ ] Edit `app/src/lib/terminal.ts` for a local-PTY source seam alongside the phone guest.
- [ ] Create `desktop/shell/TerminalPane.tsx` mounting xterm.js over the same controller byte flow.
- [ ] Edit `desktop/runtime.py` if the gateway needs a local PTY channel.

**Build.**

- [ ] The pane runs the machine's login shell through the same controller the phone terminal uses.
- [ ] Resize reflows, copy and paste work, Ctrl+C sends the byte.

**You see.**

- [ ] A dockable terminal pane next to chat runs `python3 --version` and resize reflows the prompt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Byte-flow tests in `app` still pass. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat still boots and streams.
- [ ] Lane 2. Open pane, run `python3 --version`. Save `lane-2-version.png`. Pass when output renders.
- [ ] Lane 3. Resize reflows. Save `lane-3-resize.png`. Pass when the prompt reflows with no garble.
- [ ] Lane 4. Ctrl+C interrupts a sleep. Save `lane-4-interrupt.png`. Pass when the prompt returns.
- [ ] Lane 5. Copy and paste through the pane. Save `lane-5-clipboard.png`. Pass when text round-trips.
- [ ] Lane 6. Close and reopen replays scrollback. Save `lane-6-replay.png`. Pass when history returns.
- [ ] Lane 7. Colors and cursor addressing in an ncurses program. Save `lane-7-tui.png`. Pass when the program renders.
- [ ] Lane 8. Agent isolation. An agent exec leaves the pane's session untouched. Save `lane-8-isolation.png`. Pass when the pane is unchanged.
- [ ] Lane 9. Kill and restart the pane. Save `lane-9-restart.png`. Pass when a fresh shell starts.
- [ ] Lane 10. Phone regression. The phone terminal screen is unchanged. Save `lane-10-phone.png`. Pass when the phone build is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Keystroke to photon latency in the pane.
- [ ] Probe. Timestamp a key event and the xterm paint via the inspector, 20 samples.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. Median at or under 60 ms, p95 at or under 120 ms.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D3 in stack order.

## Connectors, MCP, and OAuth (D4)

**Depends on.** D2. Implements backlog row 2.

**Files.**

- [ ] Create `desktop/shell/ConnectorsTable.tsx` over `app/src/lib/mcpState.ts`.

**Build.**

- [ ] Dense table of servers with status, tools, auth kind, and enabled state.
- [ ] Install from catalog, add a custom stdio server, test, remove.
- [ ] OAuth completes in the real browser via the gateway's loopback callback.

**You see.**

- [ ] A catalog server installs, tests connected, and reports a tool count.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `mcpState` tests still pass. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Install a catalog server. Save `lane-2-install.png`. Pass when status becomes connected.
- [ ] Lane 3. Add a custom stdio server. Save `lane-3-custom.png`. Pass when it appears and tests.
- [ ] Lane 4. Complete an OAuth login. Save `lane-4-oauth.png`. Pass when the server reports authenticated.
- [ ] Lane 5. Remove a server. Save `lane-5-remove.png`. Pass when it disappears and stays gone after restart.
- [ ] Lane 6. Tool count surfaces in the table. Save `lane-6-tools.png`. Pass when the count matches the gateway.
- [ ] Lane 7. A failing server shows an honest error. Save `lane-7-error.png`. Pass when the error renders.
- [ ] Lane 8. stdio servers run on this machine with no desktop-only badge. Save `lane-8-local.png`. Pass when the badge is absent.
- [ ] Lane 9. Restart persistence of enabled state. Save `lane-9-persist.png`. Pass when state survives.
- [ ] Lane 10. Phone regression on the connectors screen. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Table render with 40 servers.
- [ ] Probe. Seed 40 servers through the gateway, open the screen, timestamp to interactive.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. Interactive at or under 400 ms.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D4 in stack order.

## Media send, view, and drag-drop attach (D5)

**Depends on.** D2. Implements backlog row 3.

**Files.**

- [ ] Edit `app/src/lib/mediaSend.ts` and `app/src/lib/mediaCache.ts` for fetch and blob seams on web.
- [ ] Create `desktop/shell/DropTarget.tsx` for drag-drop attach in the chat pane.

**Build.**

- [ ] Drag an image onto the chat to attach. Upload via fetch with the auth header.
- [ ] Inline images render in the transcript; the viewer opens in a pane or modal.

**You see.**

- [ ] A dragged image attaches, sends, and the reply quote renders inline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Upload seam tests with a fake fetch. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Drag-drop an image attaches a chip. Save `lane-2-drop.png`. Pass when the chip appears.
- [ ] Lane 3. Send the attachment; the gateway receives it. Save `lane-3-send.png`. Pass when the agent confirms the image.
- [ ] Lane 4. An image reply renders inline. Save `lane-4-inline.png`. Pass when the image shows in the transcript.
- [ ] Lane 5. The viewer opens and zooms. Save `lane-5-viewer.png`. Pass when zoom works.
- [ ] Lane 6. A large image uploads with a progress state. Save `lane-6-progress.png`. Pass when progress shows and completes.
- [ ] Lane 7. A failed upload shows a retry affordance. Save `lane-7-retry.png`. Pass when retry succeeds.
- [ ] Lane 8. Non-image file attach and send. Save `lane-8-file.png`. Pass when the agent receives the file.
- [ ] Lane 9. Media cache scoping across computer switch. Save `lane-9-scope.png`. Pass when no cross-machine render.
- [ ] Lane 10. Phone regression on media send. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. A 5 MB image upload time on loopback.
- [ ] Probe. Time the upload seam end to end, 5 samples.
- [ ] Baseline. Record at D2 head first, phone path excluded.
- [ ] Rule. At or under 2 s on loopback.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D5 in stack order.

## Sessions, settings, computer switcher, and live events (D6)

**Depends on.** D2. Implements backlog rows 5, 6, 10, and 13.

**Files.**

- [ ] Create `desktop/shell/SessionsPane.tsx`, `desktop/shell/SettingsPane.tsx`, and a rail computer switcher over `app/src/lib/gateway.ts` and `app/src/lib/sessionList.ts`.

**Build.**

- [ ] Sessions pane gives a dense table with context-menu delete using the close-then-delete flow, and content search through the palette.
- [ ] Settings pane carries theme cards, language, diagnostics to clipboard and file, and transcript export through a native save dialog.
- [ ] Computer switcher in the rail with "This computer" plus paired machines, and a paste field for a `hermes://connect` link.
- [ ] Live events surface title renames, usage chips, and todo updates without refresh.

**You see.**

- [ ] Deleting a running chat from the pane works, and a rename in another surface updates the title live.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Session list and marks tests. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Delete a running session. Save `lane-2-delete.png`. Pass when the row and server session are gone.
- [ ] Lane 3. Content search finds a phrase in an old chat. Save `lane-3-search.png`. Pass when the hit opens the chat.
- [ ] Lane 4. Theme switch persists across restart. Save `lane-4-theme.png`. Pass when the theme survives.
- [ ] Lane 5. Arabic flips the layout to RTL and persists. Save `lane-5-rtl.png`. Pass when the rail mirrors.
- [ ] Lane 6. Diagnostics copy and file export. Save `lane-6-diag.png`. Pass when both produce output.
- [ ] Lane 7. Transcript export writes a file via the save dialog. Save `lane-7-export.png`. Pass when the file exists.
- [ ] Lane 8. Pair a second computer entry and switch between the two. Save `lane-8-switch.png`. Pass when both connect.
- [ ] Lane 9. Live title and usage updates without refresh. Save `lane-9-live.png`. Pass when a rename appears in the row within one turn.
- [ ] Lane 10. Phone regression on sessions and settings. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sessions pane render with 300 rows.
- [ ] Probe. Seed 300 sessions on the gateway, open the pane, timestamp to interactive.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. Interactive at or under 500 ms with virtualized rows.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D6 in stack order.

## Composer power with slash palette, steer, queue, retry, and model picker (D7)

**Depends on.** D2. Implements backlog rows 8, 9, and 14.

**Files.**

- [ ] Edit `desktop/shell` composer components over `app/src/lib/slash.ts` and `app/src/lib/sendQueue.ts`.
- [ ] Edit the composer model badge to open `ModelPickerSheet` scopes.

**Build.**

- [ ] Inline slash autocomplete plus palette execution.
- [ ] Composer stays live mid-turn with queue and steer choices; failed rows retry.
- [ ] Model badge becomes a real picker with this chat, everywhere, and next reply scopes.

**You see.**

- [ ] Sending while busy queues, the queue flushes at turn end, and steering redirects a running agent.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Slash routing and queue tests. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Type a slash prefix, pick from autocomplete. Save `lane-2-slash.png`. Pass when the command inserts.
- [ ] Lane 3. Queue a send while busy; it flushes at turn end. Save `lane-3-queue.png`. Pass when the queued prompt runs.
- [ ] Lane 4. Steer a running agent. Save `lane-4-steer.png`. Pass when the agent changes course.
- [ ] Lane 5. Kill the gateway mid-send; the failed row retries successfully. Save `lane-5-retry.png`. Pass when retry delivers.
- [ ] Lane 6. Model pick scoped to this chat affects one turn. Save `lane-6-model.png`. Pass when usage reflects one turn.
- [ ] Lane 7. Model pick scoped everywhere changes the default. Save `lane-7-global.png`. Pass when the chip and config update.
- [ ] Lane 8. Failed slash text stays in the composer on failure. Save `lane-8-keep.png`. Pass when text survives.
- [ ] Lane 9. Offline send lands in the outbox and flushes on reconnect. Save `lane-9-offline.png`. Pass when the message delivers after reconnect.
- [ ] Lane 10. Phone regression on the composer. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Autocomplete filter latency on the 120-command catalog.
- [ ] Probe. Timestamp keystroke to filtered list paint, 20 samples.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. At or under 50 ms per keystroke.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D7 in stack order.

## Voice and bot SOUL editor (D8)

**Depends on.** D2. Implements backlog rows 4 and 7.

**Files.**

- [ ] Edit `app/src/lib/voice.ts` for a MediaRecorder seam on web.
- [ ] Create `desktop/shell/SoulEditor.tsx` over `app/app/bot.tsx` flows.

**Build.**

- [ ] Push-to-talk records through the webview MediaRecorder to the same transcribe endpoint; replies play through HTML audio.
- [ ] Wide SOUL editor with description beside it, and provider mirror with a result toast.

**You see.**

- [ ] Hold mic, speak, release lands a transcript in the composer, and editing an existing bot's SOUL saves.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Voice level math and SOUL save payload tests. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Record and transcribe through the gateway endpoint. Save `lane-2-stt.png`. Pass when the transcript lands in the composer. This lane needs a human to speak or a fixture audio device, and records that fact if unavailable.
- [ ] Lane 3. TTS playback of a reply. Save `lane-3-tts.png`. Pass when audio plays. Same human-or-fixture note applies.
- [ ] Lane 4. Push-to-talk key binding works. Save `lane-4-ptt.png`. Pass when the hold key records.
- [ ] Lane 5. Edit an existing bot's SOUL and save. Save `lane-5-soul.png`. Pass when the gateway stores the text.
- [ ] Lane 6. Provider mirror copies keys and reports what was copied. Save `lane-6-mirror.png`. Pass when the toast names the providers.
- [ ] Lane 7. Diff or preview before SOUL save. Save `lane-7-preview.png`. Pass when the preview renders.
- [ ] Lane 8. Create a bot from a template in the wide editor. Save `lane-8-create.png`. Pass when the bot exists.
- [ ] Lane 9. Recording strip shows levels. Save `lane-9-levels.png`. Pass when the meter moves.
- [ ] Lane 10. Phone regression on voice and bot screens. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Transcribe round trip on a 5 s clip.
- [ ] Probe. Time release to transcript, 3 samples, fixture or human audio.
- [ ] Baseline. Record at D2 head first, phone path excluded.
- [ ] Rule. At or under 4 s on loopback.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D8 in stack order.

## Native depth with tray, hotkey, multi-window, drag-drop, and updater (D11)

**Depends on.** D1. Holds `desktop/src-tauri` exclusively in its wave. ARCHITECTURE P4.

**Files.**

- [ ] Edit `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/tauri.conf.json`, and `desktop/shell` for tray and window events.

**Build.**

- [ ] Tray icon with close-to-tray and a show-or-quit menu.
- [ ] Global quick-ask hotkey opens a small ask window.
- [ ] Multi-window means a second chat window shares the same gateway client state.
- [ ] Native drag-drop-to-chat handoff at the shell boundary feeding the D5 seam.
- [ ] Tauri updater channel behind a flag.

**You see.**

- [ ] Closing the window hides to tray, the hotkey summons quick-ask from anywhere, and a reply is visible in a second window.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `cargo build` exits 0. Run it.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Close to tray, reopen from tray. Save `lane-2-tray.png`. Pass when the state survives.
- [ ] Lane 3. Quick-ask hotkey from another application. Save `lane-3-hotkey.png`. Pass when the ask window appears.
- [ ] Lane 4. A quick-ask turn completes. Save `lane-4-askturn.png`. Pass when the reply renders.
- [ ] Lane 5. Second window streams the same session. Save `lane-5-window2.png`. Pass when both show the reply.
- [ ] Lane 6. Drag a file from a file manager onto chat. Save `lane-6-dnd.png`. Pass when the chip attaches.
- [ ] Lane 7. Tray menu quit terminates the whole tree, gateway included. Save `lane-7-quit.png`. Pass when no runtime or browser survives.
- [ ] Lane 8. Updater flag off by default and the app starts without it. Save `lane-8-updater.png`. Pass when startup is clean.
- [ ] Lane 9. Single-instance still holds with tray enabled. Save `lane-9-single.png`. Pass when a second launch exits.
- [ ] Lane 10. Cold start unchanged with the tray active. Save `lane-10-cold.png`. Pass when within the D1 budget.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Quick-ask window latency from hotkey.
- [ ] Probe. Timestamp hotkey to window paint, 10 samples.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. At or under 300 ms.

**Review gate.** The operator reviews before landing.

- [ ] Copy lanes 2, 3, and 5 screenshots into `desktop/docs-shots/d11-review/`.
- [ ] Record a 30 to 60 second video of tray, hotkey, and second window. Save it as `desktop/docs-shots/d11-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. This PR is in the gated set (D1, D2, D11, D12), so it stops at stack-ready and waits for the operator's review.
- [ ] Stop at stack-ready. Wait for the operator.

**Merge.**

- [ ] Operator lands D11 after the clean verdict.

## OS notifications and i18n RTL (D9)

**Depends on.** D11, because emission goes through the shell's notification plugin. Implements backlog rows 11 and 12.

**Files.**

- [ ] Edit `app/src/lib/push.ts` for the when-to-knock decision shared by both platforms.
- [ ] Edit `desktop/src-tauri` to emit desktop notifications.
- [ ] Wire `app/src/lib/strings.ts` atoms into the desktop chrome.

**Build.**

- [ ] Approval knocks raise a desktop notification when unfocused; clicking focuses the pending card.
- [ ] Arabic flips the rail, palette, and panes, and persists.

**You see.**

- [ ] An approval arriving while unfocused raises a notification, and clicking it opens the pending card.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Knock-decision tests and locale persistence tests. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D11 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Approval knock while unfocused fires a notification. Save `lane-2-knock.png`. Pass when the notification appears.
- [ ] Lane 3. Click focuses the pending card. Save `lane-3-focus.png`. Pass when the card is visible.
- [ ] Lane 4. No notification while focused. Save `lane-4-quiet.png`. Pass when nothing fires.
- [ ] Lane 5. Reply knocks honor the user setting. Save `lane-5-replies.png`. Pass when the toggle is respected.
- [ ] Lane 6. Arabic renders rail and palette RTL. Save `lane-6-rtl.png`. Pass when mirrored.
- [ ] Lane 7. Arabic persists across restart. Save `lane-7-persist.png`. Pass when still RTL.
- [ ] Lane 8. Fleet screens render the Arabic catalog. Save `lane-8-fleet.png`. Pass when translated.
- [ ] Lane 9. English fallback for missing strings. Save `lane-9-fallback.png`. Pass when no raw keys show.
- [ ] Lane 10. Phone regression on notifications and locale. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Notification latency from gateway request.
- [ ] Probe. Timestamp the gateway request to the desktop notification, 5 samples.
- [ ] Baseline. Record at D11 head first.
- [ ] Rule. At or under 1 s.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D9 in stack order.

## Browser live pane and skills execution (D10)

**Depends on.** D2. Implements backlog rows 15 and 16.

**Files.**

- [ ] Create `desktop/shell/BrowserPane.tsx` over `app/src/lib/browserRelay.ts` with a CDP screencast or attach.
- [ ] Edit `desktop/shell` skills table to run through `app/src/lib/slash.ts`.

**Build.**

- [ ] The agent's Chromium docks as a live pane with a tab strip driven by the same atoms, plus open-in-default-browser handoff.
- [ ] Skills run from the table or palette and land in the composer exactly like the phone.

**You see.**

- [ ] The pane shows the page the agent is driving, and running a skill from the table fills the composer.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Browser relay atom tests. Run `npm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D2 head. Save `lane-1-regression.png`. Pass when chat is unchanged.
- [ ] Lane 2. Browser pane attaches and shows the live tab. Save `lane-2-attach.png`. Pass when the page renders.
- [ ] Lane 3. Agent navigation is visible in the pane within 2 s. Save `lane-3-nav.png`. Pass when the URL updates.
- [ ] Lane 4. Tab create and switch from the pane. Save `lane-4-tabs.png`. Pass when the strip matches the gateway.
- [ ] Lane 5. Open in default browser hands off. Save `lane-5-handoff.png`. Pass when the URL opens outside.
- [ ] Lane 6. Skills table run fills the composer. Save `lane-6-skill.png`. Pass when the draft appears.
- [ ] Lane 7. Palette runs a skill. Save `lane-7-palette.png`. Pass when the draft appears.
- [ ] Lane 8. Recent skills appear first. Save `lane-8-recent.png`. Pass when ordering holds.
- [ ] Lane 9. Browser relay down shows an honest error. Save `lane-9-down.png`. Pass when the error names the fix.
- [ ] Lane 10. Phone regression on browser and skills screens. Save `lane-10-phone.png`. Pass when unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Pane frame latency behind the agent's own navigation.
- [ ] Probe. Navigate from the agent, timestamp URL change to pane paint, 10 samples.
- [ ] Baseline. Record at D2 head first.
- [ ] Rule. At or under 500 ms.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D10 in stack order.

## Packaging and installer (D12)

**Depends on.** D11 and the D3 wave. Holds `desktop/src-tauri`. ARCHITECTURE P5.

**Files.**

- [ ] Edit `desktop/src-tauri/tauri.conf.json` and `desktop/src-tauri/src/lib.rs` for resources, sidecar, and port handling.
- [ ] Edit `desktop/runtime.py` for XDG paths and the readiness answer.

**Build.**

- [ ] Bundle `runtime.py`, `app/python-runtime`, and the hermes fork as Tauri resources.
- [ ] Ship or bootstrap a pinned Python instead of the hardcoded venv path.
- [ ] Move HERMES home, logs, and profiles to XDG directories.
- [ ] Dynamic port with an authenticated readiness probe replacing the bare TCP connect.
- [ ] Rebuild deb and AppImage and smoke-test on a clean machine or container.

**You see.**

- [ ] The AppImage boots on a clean container, installs or finds Python, boots the gateway, and reaches chat.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `cargo build` exits 0 with the resource manifest. Run it.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Regression against D11 head in the dev tree. Save `lane-1-regression.png`. Pass when dev mode is unchanged.
- [ ] Lane 2. Build the deb. Save `lane-2-deb.log`. Pass when the build succeeds.
- [ ] Lane 3. Build the AppImage. Save `lane-3-appimage.log`. Pass when the build succeeds.
- [ ] Lane 4. Clean-container boot from the AppImage to chat. Save `lane-4-clean.png`. Pass when chat renders.
- [ ] Lane 5. No machine-baked absolute paths in the shipped binary. Save `lane-5-paths.txt`. Pass when a strings scan finds none.
- [ ] Lane 6. State lands in XDG dirs on first run. Save `lane-6-xdg.png`. Pass when no dotfiles land in `$HOME` root.
- [ ] Lane 7. Dynamic port pick when 9118 is occupied. Save `lane-7-port.png`. Pass when the shell serves and connects.
- [ ] Lane 8. Readiness probe refuses unauthenticated probes. Save `lane-8-auth.png`. Pass when a bare TCP probe no longer reports ready.
- [ ] Lane 9. Upgrade from a previous install preserves the agent home. Save `lane-9-upgrade.png`. Pass when history and credentials survive.
- [ ] Lane 10. Uninstall removes units and leaves the agent home. Save `lane-10-uninstall.png`. Pass when the tree is clean.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Installed size and clean-boot time from the AppImage.
- [ ] Probe. Measure the artifact and time cold start on the clean container.
- [ ] Baseline. Record the current dev-tree numbers first.
- [ ] Rule. Boot within the D1 budget on the clean container. Installed size at or under 600 MB with Python bundled.

**Review gate.** The operator reviews before landing.

- [ ] Copy lane 4 screenshot into `desktop/docs-shots/d12-review/`.
- [ ] Record a 30 to 60 second video of the clean-container boot. Save it as `desktop/docs-shots/d12-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. This PR is in the gated set (D1, D2, D11, D12), so it stops at stack-ready and waits for the operator's review.
- [ ] Stop at stack-ready. Wait for the operator.

**Merge.**

- [ ] Operator lands D12 after the clean verdict.

## Verification as a gate (D13)

**Depends on.** D12. ARCHITECTURE P6.

**Files.**

- [ ] Edit `desktop/scripts/verify-desktop.sh` into the permanent gate with the lane matrix, budgets, inspector DOM checks, OCR fallback, and a `--report json` output.
- [ ] Create `desktop/scripts/desktop-smoke.sh` running the full lane matrix in one command.

**Build.**

- [ ] The gate runs unit, live, and perf blocks for any PR head with one command and writes a machine-readable report.
- [ ] The program done-rule lives in the gate. No done claim without a green `desktop-smoke.sh` run at the final head.

**You see.**

- [ ] One command on a clean tree prints a per-lane pass table and exits nonzero on any failure.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `bash -n` and a dry-run mode on both scripts. Run them.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, driven on this machine per the boot recipe.

- [ ] Lane 1. Smoke suite on the D12 head, all previous lanes re-run by the suite itself. Save `lane-1-suite.json`. Pass when the suite reproduces their verdicts.
- [ ] Lane 2. Suite detects a seeded regression. Save `lane-2-seed.png`. Pass when the suite fails on purpose.
- [ ] Lane 3. Suite on a clean container. Save `lane-3-clean.json`. Pass when green.
- [ ] Lane 4. Report is valid JSON and consumable. Save `lane-4-report.json`. Pass when a jq read works.
- [ ] Lane 5. Budget failures fail the run. Save `lane-5-budget.png`. Pass when a breach exits nonzero.
- [ ] Lane 6. Flaky-lane retry policy of one retry, then honest failure. Save `lane-6-retry.png`. Pass when documented behavior holds.
- [ ] Lane 7. Suite leaves no processes behind. Save `lane-7-clean.png`. Pass when no gateway or browser survives.
- [ ] Lane 8. Suite is idempotent back to back. Save `lane-8-idem.png`. Pass when two runs agree.
- [ ] Lane 9. Suite runtime at or under 15 minutes. Save `lane-9-time.txt`. Pass when within budget.
- [ ] Lane 10. The final program head passes the full suite. Save `lane-10-final.json`. Pass when green.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Suite wall time and flake rate over three runs.
- [ ] Probe. Run `desktop-smoke.sh` three times on the same head.
- [ ] Baseline. Record on the first run.
- [ ] Rule. Three consecutive green runs with zero flakes.

**Review gate.** The operator reviews before landing.

- [ ] Post the lane screenshots and a short video in chat for the operator. This PR is not in the gated set (D1, D2, D11, D12), so the review happens during the stack audit rather than as a stop.

**Merge.**

- [ ] Operator lands D13. The program is done when D13's lane 10 is green at the final head.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] The decision trail `.audit/desktop-full.tsv` is audited against the run per the show-me-your-work skill, with a cross-model review when the provider heals.
- [ ] Reply to the operator with the stack list, each PR's verdict, and the final D13 report.

## Appendix A. Prototype evidence

Prototypes ran on 2026-10-15 in `worktrees/desktop-tauri` at head `42dc3ce` plus the uncommitted P1 changes. The decision trail is `.audit/desktop-full.tsv`.

- Compile risk, settled. `cargo build` on the uncommitted shell code finishes green in 2 m 33 s and produces `target/debug/moch-desktop`. The P1-STATUS compile unknown is closed.
- Boot risk, settled. The shell cold-boots its own gateway. The service log shows `moch: runtime spawned`, `moch: handshake received`, and `moch: static server on 43117 (embedded UI)`. Handshake to serving takes seconds, not the 150 s worst case.
- UI risk, settled for fidelity. The real app UI renders in the shell's webview and lands on the chat surface, not pairing. Evidence is `desktop/.tmp/verify/shots/shell-1.png`, `shell-1b.png`, and `shell-4-inui-reply.png`, read by OCR and showing "New chat", the "AskMochi..." composer, and the zai/glm model chip.
- Protocol risk, settled. One real turn against the local gateway completed in 3233 ms end to end through `desktop/scripts/turn.mjs` on session `5b11524b`, covering `session.create`, `prompt.submit`, and the completion notification.
- Unproven, carried into D1. In-window typing through the real composer needs an input click first. This harness has no click injector (`xdotool` and `ydotool` absent, `wtype` lands keys but the DOM input was never focused). D1's inspector seam or a manual click closes this.
- Unproven, carried into D1. Multi-width screenshots through `shot.mjs`. Chromium under this harness dies at spawn with SIGTRAP on 10 of 11 boots, including through the `setsid` wrapper and both `--headless` spellings; it worked from a user terminal earlier the same day per ARCHITECTURE section 2.6. The two harness fixes in D1 are staged in the worktree; the remaining SIGTRAP is an environment issue to diagnose outside the harness sandbox.
- Cold start and RSS numbers, unmeasured. D1 records the baseline.

## Appendix B. Alternatives rejected

- The frozen hand-written fork `desktop/ui/` as the desktop UI. Two audits found it shares two modules with the phone, speaks half the protocol, and has no desktop shape. Frozen by ARCHITECTURE, migrated screen by screen, then deleted.
- Electron or a second native UI. Rejected in the superseded step-1 doc, which cites no maintained Linux RN target and a duplicate bridge per platform.
- A phone-sized web export in linked mode through the relay. Superseded by ARCHITECTURE; the desktop now runs the real screens against the local runtime.
- Driving the in-window turn by injecting keystrokes with `wtype` alone. Delivered keys to the app but not to the unfocused DOM input, so the D1 inspector seam replaces it as the lane instrument.
- Fixing the relay and moch-link CORS gaps so remote linked mode gets media on desktop. Server-side work independent of this program and unnecessary in local mode; parked unless the operator asks for remote linked media.

## Appendix C. Risks

- Subagent provider 403 blocks owners, swarms, and cross-model review. Observed twice on 2026-10-15. Mitigation is that the executing chat owns boxes directly and logs it, and a healed provider restores the standard playbooks. Lands in every PR's mechanics.
- Chromium SIGTRAP under the harness sandbox blocks `shot.mjs` lanes. Evidence is `.tmp/verify/raw/shot.log` with exit code 133 on 10 of 11 boots. Mitigation is that D1 lands the setsid wrapper, the Chromium 152 flag fix, and the inspector seam so lanes do not depend on OCR alone, and the residual SIGTRAP gets diagnosed outside the harness. Lands in D1.
- WebKitGTK performance with react-native-web is unmeasured at width. The bundle renders correctly; streaming feel at 1920 is unknown. Mitigation is D1 lane 7 and the D1 perf budgets. If WebKitGTK streams poorly, the P2 shell adds a renderer seam, decided on D1 evidence.
- The 8 GB box is tight with gateway, agent Chromium, builds, and the desktop shell together. Mitigation is that lanes start and stop their own surfaces, and the suite kills its tree. Lands in D13.
- tmpfs at 80 percent with a user quota. Chromium profiles pile up in /tmp. Mitigation is that the suite cleans `moch-shot-profile-*` and `.org.chromium.*` before and after. Lands in D13.
- Packaging embeds machine paths today, including the hardcoded venv Python. Mitigation is that D12 lane 5 fails the PR if a strings scan finds one. Lands in D12.
- The loopback gateway serves its session token on `GET /moch-config.json`, and the readiness probe is unauthenticated. Acceptable on a single-user desktop, tightened in D12 lanes 7 and 8. Tracked upstream as the phone-side BUG-120 class.

## Appendix D. Links and reading list

- `desktop/ARCHITECTURE.md` is the decision record. Read before any box.
- `desktop/PARITY-BACKLOG.md` is the per-capability debt with phone owners and acceptance checks. D3 through D10 implement its rows in order.
- `desktop/DESKTOP-SHELL-SPEC.md` is the P2 shell spec. Read before D2.
- `desktop/P1-STATUS.md` is the gate resume point. D1 finishes it.
- `desktop/ui/FROZEN.md` is the fork notice. Nothing new goes there.
- `app/README.md` carries the gateway protocol v7 notes, stored versus live ids, and the wire contract location.
- D2 gets the interrogate skill on its pane and palette design. D3 and D10 get the how skill, because the terminal byte flow and the CDP pane are architecture questions.
- The decision trail for the whole program lives at `.audit/desktop-full.tsv` in the worktree, per the show-me-your-work skill. It is a local artifact and stays uncommitted.
