# Moch — bugs.md

Every confirmed issue in the chat session system, sorted **urgent → low**, ready to fix one by one.
Check off `- [ ]` as you fix. All findings were adversarially verified against source (63 confirmed, 14 corrected-mechanics, 0 rejected). Line numbers are current as of 2026-10-07. Paths are relative to `app/` (e.g. `app/src/lib/chat.ts` from the repo root).

**99 issues: 7 URGENT · 25 HIGH · 43 MEDIUM · 24 LOW.** *(+BUG-105, wave 8: 100 issues / 26 HIGH. +Waves 9: 122 issues / 34 HIGH / 50 MEDIUM / 27 LOW — see the Wave 9 section at the end of this file.)*
**Wave 2 (BUG-082–089):** user-reported symptoms, adversarially verified 2026-10-07 — approval overflow (URGENT), thinking vanish, busy-looks-dead-on-return, flaky status indicators — placed in severity order.
**Wave 3 (BUG-090–093):** user-reported terminal ( drawer → Terminal ) input UX, on-device 1.0.6, verified 2026-10-08. The working tree carried an UNCOMMITTED, UNVERIFIED fix attempt for all four — wave-3 entries describe HEAD (shipped) behavior; the build step must judge the attempt, not assume it works. *(Shipped in PR #46 / 1.0.7 build; on-device video confirms caret, lift, tap-focus and typing all work.)*
**Wave 4 (BUG-094–096):** same terminal, on-device 1.0.7 video (debug.mp4, 2026-10-08) — caret/lift/tap fixed, but flicker+lag, backspace, and helper-key feedback remain. Video-verified against frames 9–18s. *(094/095 shipped in PR #46 commit 2 / 1.0.8.)*
**Wave 5 (BUG-097–099):** on-device 1.0.8 vs Termux comparison videos (termux.mp4, moch-terminal.mp4, 2026-10-08). 1.0.8's sentinel backspace reaches the shell but the display cannot show erasures — the v1 append-only renderer has hit its ceiling; the documented xterm.js WebView swap is now the fix.
**Wave 6 (BUG-100):** user report on-device 1.0.9 RC3 (2026-10-09): cannot type at all. Root cause found in RN core sources, not guessed: pointerEvents is enforced only on ReactViewGroup containers, so the RC3 WebView renderer's `pointerEvents="none"` was a silent no-op and the WebView became the touch target.
**Wave 7 (BUG-104):** on-device 1.0.11-browser (2026-10-10): with the Browser screen open and tools advertised, EVERY agent browser tool returns "No browser page…" — the per-page (WebView) attach auto-detect could never engage. Root-caused in source and adversarially verified with a live relay + Chromium reproduction.
**Wave 8 (BUG-105):** user report (2026-10-11, on the post-BUG-104 source): "the agent sees the tools but cannot access the browser — it says something like the browser is dead." Same verbatim tool error as BUG-104, different cause: the BOOT gate arms from a relay.json that outlives the process.
**Wave 9 (BUG-106–122):** first full-surface on-device pass on 1.0.15-browser (versionCode 18), 2026-10-11 — browser, terminal, bots/fleet, crew, automations, connectors, share-in, settings, search. Every entry carries device evidence; the run matrix, pass/fail per documented runbook step and the two root causes proven on the device (IPv6-only relay bind; fleet flag never armed) are in `TEST-REPORT-1.0.15-device.md`. Standing result: **the browser cannot drive a page, and the M9 fleet runtime is not active, on the shipped APK.**

**Fix-order warnings baked in below:**
- BUG-001 (reconnect) must ship together with BUG-007 (stale timer) — fixing one alone exposes the other.
- BUG-005 (offline UX) is one coupled redesign, not three one-liners.

---

## 🔴 URGENT — data loss / core flows broken

- [x] **BUG-001 [URGENT] Auto-reconnect is dead code** — `src/lib/gateway.ts:53,426,445`
  `lastConfig` is only assigned in `retryNow()` (and cleared in `clearConfig()`); `dial()` (479-578) and `connect()` never set it. After any socket drop, `scheduleReconnect()` bails at :426 (`!lastConfig`) — no retry is ever armed. The app sits on the "Connection failed" veil (its "auto-retrying…" gates on `attempt > 0`, never true) until a manual Retry or background→foreground cycle. Queues/outbox never flush.
  *Fix:* set `lastConfig = v` in `dial()` after `validateConfig`; clear only in `disconnect()`. **Ship with BUG-007.**

- [x] **BUG-002 [URGENT] flushOutbox permanently drops every queued message after the first failure** — `src/lib/chat.ts:781-794`
  `outbox.set([])` + `persistOutbox()` write the EMPTIED queue to storage *before* the loop (loss survives restart); the catch re-enqueues only the failing text (:790) and throws. Items after the first failure are gone. Sole caller `app/(tabs)/chat.tsx:248` swallows (`.catch(() => {})`).
  *Fix:* dequeue one at a time; remove each item only after success; re-enqueue the unsent remainder before rethrowing.

- [x] **BUG-003 [URGENT] Send during an in-flight ack silently vanishes** — `src/lib/chat.ts:1545-1548`
  When `sendingSessions.has(lockKey)`, the text goes to the global outbox and `sendPrompt` returns normally — but the composer was already cleared (`chat.tsx:648`). No bubble, no queue strip (the outbox count renders only inside the offline banner, `chat.tsx:844`), no toast. The outbox flushes only on the offline→online edge (`chat.tsx:248`) — possibly never.
  *Fix:* route lock-conflict sends to the per-chat busy queue (`enqueueSend`), not the outbox.

- [x] **BUG-004 [URGENT] Deleting from the Chats tab fails for ~6h after opening a chat, and leaks state** — `app/(tabs)/sessions.tsx:119-139` vs `src/components/ScreenShell.tsx:301-332`
  Three defects: (1) no detach + no `session.close` → gateway refuses live sessions with 4023 "cannot delete an active session" (`hermes-src/tui_gateway/methods_session.py:982-983`); live handles persist **6 hours** (`_SESSION_TTL_S = 6*3600`, attached exempt). (2) `forgetSession(s.id)` gets a STORED id but is keyed by LIVE id (`src/lib/chat.ts:1371-1411`) → cleanup skipped: stuck "N questions waiting" banner, leaked drafts/queue/attention/marks, `LAST_SESSION_KEY` still resumes the deleted chat. (3) deleting an already-deleted chat alerts "Delete failed: session not found" and keeps the dead row (no `isSessionNotFound` tolerance — `chat.ts:1513-1515`; the drawer handles it at `ScreenShell.tsx:315-323`).
  *Fix:* reuse the drawer's flow (detach if active → `session.close` live → delete → `forgetSession(liveId)` + `forgetChatMarks(storedId)`), treat not-found as success.

- [x] **BUG-005 [URGENT] Offline UX is three contradicting layers; the banner is inverted** — `app/_layout.tsx:251,338` + `app/(tabs)/chat.tsx:129,843`
  (1) A full-screen `rgba(0,0,0,0.94)` veil covers the whole app the instant state leaves 'open' — the chat screen's grace banner, queue strip, and cached history are unreachable exactly when designed to show. (2) The banner condition `reconnects < 2` is inverted vs its own comment ("3rd+ attempt") — and its `Connecting…` branch is unreachable behind `connState !== 'connecting'`. (3) Even with BUG-001 fixed, backoff waits sit in `'closed'` and the first retry (1s) lands inside the 2.5s grace — the banner would still essentially never show.
  *Fix:* one coupled redesign — veil only for boot/no-config; mid-session outages show the in-chat banner + queue strip (condition: `!online && pastGrace`, drop the attempt clause).

- [x] **BUG-006 [URGENT] (found during verification) Drawer RENAME is entirely broken** — `src/components/ScreenShell.tsx:289-299`
  `session.title` is a live-session-only method server-side (`hermes-src/tui_gateway/contracts/common.py:194-197`; resolved via the runtime-sid `_sessions` map → 4001 otherwise, `server.py:1133-1149`), but the drawer passes the row's STORED id (`Sidebar.tsx:450` → `ScreenShell.tsx:293`). Every manual rename fails "session not found"; the title is never written. Even on success the path is broken: `patchRowTitle` patches `sessionRows` while the header reads `activeTitle` from `sessionsById` (`chat.ts:194`), manual renames emit no `session.title` echo (auto-titler only, `prompt_turn.py:673`), the `session.info` echo is dropped at the live-key gate (`chat.ts:2063-2066`), and the 60s poll refreshes the wrong store.
  *Fix:* resolve the live id before the RPC (like delete does); on success also `patchSession(liveId, { title })`.

- [x] **BUG-082 [URGENT] Long approval/clarify/sudo prompts push the Approve/Deny buttons off-screen — turn deadlocks** — `app/(tabs)/chat.tsx:1090-1130,1132-1203,1205-1240` (+ styles `:1566-1580`)
  The pending-request cards are inline children of the chat column with **no maxHeight, no ScrollView, flexShrink 0** (`s.sheet :1566`): long content (command+description up to 800+800 chars, `chat.ts:1875-1876`; clarify-batch has UNBOUNDED question count, `chat.ts:1903-1910`) collapses the transcript to 0 height and pushes the choice row AND composer below the fold — untappable, approve *and* deny gone, turn blocked until server timeout. Keyboard amplifier: `adjustResize` + `kbPad` (`chat.tsx:163-164`) steals ~40% more height, so on sudo/secret the Send/Deny row slides off exactly when you focus the field to answer. Only escape: the drawer.
  *Fix:* maxHeight-bound the sheet (~60-70% window), ScrollView the body only, pin the choices row outside the scroll, collapse command/description behind "show more".

---

## 🟠 HIGH — broken/misleading behavior users hit often

- [x] **BUG-007 [HIGH] Stale reconnect timer flips the phone back to the previous computer** — `src/lib/gateway.ts:409-411,412-415,432-436`
  A computer switch supersedes the socket → 'closed' blip → `scheduleReconnect` arms a timer for the OLD `lastConfig`; the `'open'` branch never calls `cancelReconnect()`. The timer then dials the old machine, supersedes the healthy socket, re-persists it active, and re-scopes caches. Reachable after the first `retryNow` of the session — **fixing BUG-001 without this bug's fix exposes it on every switch.**
  *Fix:* `cancelReconnect()` in the `'open'` branch (or stamp the timer with its config and drop mismatches).

- [x] **BUG-008 [HIGH] Outbox flushes to the WRONG chat; duplicates sends; stale "failed" rows** — `src/lib/chat.ts:183,781-794,1605,1697-1707`
  Outbox is an unpinned `string[]`; flush calls unpinned `sendPrompt(text)` → the ACTIVE chat at flush time (compose in A, switch to B, reconnect → B gets A's prompt). Failure double-enqueues (chat.ts:1605 + 790). `retryMessage` never clears the outbox copy → Retry + reconnect = 2–3 sends. No reconciliation: rows stay 'failed' after a successful flush.
  *Fix:* store `{storedId, text}`; pin the flush; enqueue in exactly one layer; clear/mark matching failed rows on flush; drop the outbox copy on successful Retry.

- [x] **BUG-009 [HIGH] Dead-socket probe can't rebuild; sends hang up to 120s** — `src/lib/gateway.ts:608-618` + `src/protocol/json-rpc-gateway.ts:174,334-337` + `json-rpc-channel.ts:135,241-249`
  Foreground probe failure calls `retryNow()` → same-URL idempotence guard returns (half-open socket reads OPEN) → re-declares 'open' on a corpse. Heartbeat starts only if `gateway.ready` advertises `heartbeat:true`. Request timeout is 120s and never touches the transport.
  *Fix:* `client.invalidate('probe failed')` before redial; start a conservative heartbeat unconditionally; shorter `prompt.submit` timeout with an "unknown outcome" retry affordance.

- [x] **BUG-010 [HIGH] Gateway errors render as normal assistant replies** — `src/lib/chat.ts:2330-2331` (+ `:2015`)
  The streaming branch finalizes with no `status:'failed'`/`error`: had text → error silently discarded, turn looks complete; empty → raw error string becomes the answer. The attention toast is suppressed when the user is WATCHING the chat (`:2015`) — exactly the mid-stream scenario.
  *Fix:* set `status:'failed', error: msg` in the streaming branch; don't suppress for in-chat errors (show inline).

- [x] **BUG-011 [HIGH] Uploads have no timeout — one stalled upload wedges the chat** — `src/lib/mediaSend.ts:113-119` + `src/lib/chat.ts:1692`
  `uploadAsync` has no deadline/abort; a hung upload holds `sendPrompt` open, the lock (released only in the `finally` at chat.ts:1692) is held forever, and all later sends to that chat silently vanish (BUG-003 behavior) until restart.
  *Fix:* race the upload against `uploadTimeoutMs(size, ATTACH_RATE_KBPS)`; fail the chip.

- [x] **BUG-012 [HIGH] Chat lists sort by CREATION time; active old chats never rise; labels mislead** — `src/lib/sessionList.ts:48-50,66` + `src/components/Sidebar.tsx:391` + `app/(tabs)/sessions.tsx:215`
  Client re-sorts by `started_at` (immutable creation time — verified: hermes never UPDATEs it; activity lives in `last_activity_at`), destroying the server's `order_by_last_active=True` order. Drawer Today/Yesterday/Older buckets bucket by creation; "· 3d ago" reads as last-used.
  *Fix:* keep the server's ordering (drop `sortSessions`), or request `last_active` in the compact row and sort/group on it.

- [x] **BUG-013 [HIGH] Visiting the Models tab mints a real server session** — `app/(tabs)/agent.tsx:63-74` + `src/lib/chat.ts:1082-1091,943`
  Mount effect runs `ensureSession()` unconditionally (refires on online/sid change) → `session.create` + a saved "New chat" row with 0 messages — violating the documented local-only invariant (the chat screen deliberately avoids this, `chat.tsx:233-239`).
  *Fix:* resolve without forcing create (create lazily on the actual RPC), or gate on an explicit user action.

- [x] **BUG-014 [HIGH] Failed detached-reattach silently swaps to a fresh session** — `src/lib/chat.ts:1101-1106`
  When resume of the detached chat fails, the catch logs, creates a NEW session, and switches unconditionally (not even the guarded re-point the success path has) — the user's send lands in an empty new chat; can also yank the screen mid-switch.
  *Fix:* banner the failure, stay on the old chat; fall back to a new chat only explicitly.

- [x] **BUG-015 [HIGH] Steer/slash output grafts onto the wrong session (transcript corruption)** — `src/lib/chat.ts:1724-1748` + `app/(tabs)/chat.tsx:425-455`
  `sid` captured, RPC awaited, then `patchSession(sid, { messages: [...messages.get(), userRow] })` — the source is the ACTIVE chat's list at patch time. Switching mid-steer REPLACES the old chat's in-memory transcript with the other chat's messages; the steer bubble appears nowhere. runSlash output cards land in whichever chat is active when the RPC returns.
  *Fix:* snapshot the target session's message array before the await; file rows by stored id.

- [x] **BUG-016 [HIGH] First-run setup fails silently into an infinite spinner** — `app/setup.tsx:75,161-185`
  `linuxBootstrap(...).catch(() => {})` then unconditional `onNext()`; no busy state (double-tap restarts a minutes-long download); `InstallStep` polls forever with no error/retry; nothing downstream surfaces the failure.
  *Fix:* surface bootstrap failure on the Install step; disable the button while busy; add retry.

- [x] **BUG-017 [HIGH] Theme contract broken in shipped UI** — `app/(tabs)/settings.tsx:516,519` + `app/(tabs)/chat.tsx:1499` + `app/(tabs)/sessions.tsx:247` + `src/components/SessionToasts.tsx:23-27`
  Settings icon chips hard-code Mocheme's accent rgba (stay orange under Relay); a third red `rgba(239,68,68,0.12)` matches NO token in either palette; `'#241A08'` banner duplicated in two files (clashes with Relay's teal band); `KIND_META` snapshots `C.*` at module scope (theme.ts:10-15 forbids it).
  *Fix:* use `accentSoft`/`redSoft`/`amberSoft` tokens; resolve toast colors inside the component.

- [x] **BUG-018 [HIGH] Chats screen is unreachable in the default theme; delete is undiscoverable; tab is a drawer duplicate** — `app/(tabs)/chat.tsx:820` + `app/(tabs)/sessions.tsx:142,198-203` + `src/components/ScreenShell.tsx:188-195,336-381,400-409`
  The ONLY route to `/(tabs)/sessions` is the chat header's search icon, which renders in the Relay bar only — in default Mocheme the Chats screen is reachable via NOTHING; the drawer has no Chats entry. The tab's search icon merely clears the query; no rename/pin/archive (chatListState unused); archived chats shown unmarked; delete only via unhinted long-press (no ⋯ menu, haptic, or double-tap guard — the drawer has all three).
  *Fix:* add a "Chats" drawer entry; focus the search field from the header icon; add the row ⋯ menu mirroring the drawer.

- [x] **BUG-019 [HIGH] Old machine's outbox stays live after a backend switch** — `src/lib/chat.ts:769-779` + `src/lib/backendIdentity.ts:4,86-131`
  `loadOutbox` only sets the atom on success, and **no `resetOutbox` exists anywhere** — even a SUCCESSFUL switch leaves the previous machine's outbox in memory when the new machine has no shelved outbox (flush would deliver cross-machine; BUG-008 compounds).
  *Fix:* add `resetOutbox()` (clear atom), call it in the identity switch before reloading.

- [x] **BUG-083 [HIGH] Thinking (reasoning) disappears when you leave a chat and come back** — `src/lib/chat.ts:1465-1496`
  `applyHistory` maps only role/content/text/ts — it never reads the reasoning the server sends (verified: the gateway stores reasoning durably and forwards it on EVERY resume in both cold and live-reuse payloads — `hermes-src/tui_gateway/session_history.py:179-185`; `message.complete` also carries it, `contracts/events.py:178`, client ignores it) — then wholesale-replaces the messages AND overwrites the device cache (`schedulePersist :1494` → `persistSession :583-597`), making the loss permanent on-device. All four return paths lose it: in-memory switch (resume still runs), cold row + cache hydrate, reconnect resync, app restart.
  *Fix:* in `applyHistory`, map each assistant row's `reasoning`/`reasoning_content` into a leading `{kind:'thinking'}` segment (or merge segments instead of replacing); optionally backfill from `message.complete`'s `p.reasoning`.

- [x] **BUG-084 [HIGH] A running session looks STOPPED after cold re-entry until its next event ("feels offline")** — `src/lib/chat.ts:966,1005,1057-1072,1352-1359`
  The server's resume payload explicitly reports `running:true` / `status:"working"` (`methods_session.py:714-727`, `server.py:2803-2837`) — the client never reads it: `runResume`'s result type omits it, `busy:true` is set in exactly ONE place (the local send, `:1626`), and `seedPlaceholder`/`makeSession` default `busy:false`. On app restart / notification deep link / drawer cold row mid-turn: idle transcript, no stop button (`chat.tsx:1390`), collapsed tool footer, and the drawer busy dot drops too (`busyStoredIds` reads the same false flag). Text heals only on the next message/thinking delta; the busy chrome stays gone until the user sends again. `applyHistory` also flattens the streaming tail (history rows never carry `streaming`). The `status.update` handler's `p.busy === false` branch (`:2313-2321`) is dead code — server payloads are `{kind,text}` only.
  *Fix:* read `running`/`status`/`turn_started_at` in `runResume` and merge `{ busy: !!res.running }` into the `:1005` entry construction; preserve `streaming` on the in-flight tail row across `applyHistory`.

- [x] **BUG-085 [HIGH] Opening a chat clears its "needs approval" dot; leaving without answering leaves NO indicator (worst after relaunch: zero)** — `src/lib/chat.ts:960,1069,1309,1336,1355,1992-1994,247-256`
  Every open path clears attention synchronously at tap; `markAttention` only fires on NEW server events; there is NO re-mark path from `pendingBySession`. So: question arrives → amber dot → tap the chat (cleared) → leave without answering → dot gone while the question still blocks. The stated intent "leaving without answering should show yellow" (`:1992-1994`) is only implemented at arrival. After a relaunch (memory-only pending map, replay only on resume of that session) the indication is zero until you happen to reopen the chat. `pendingStoredIds` (`:247-256`) — built for exactly this — is dead code (see BUG-023).
  *Fix:* derive the row dot at render time by wiring `pendingStoredIds` into `rowStatus`, or re-mark `'input'` when leaving a chat whose `pendingBySession` entry is non-empty.

- [x] **BUG-086 [HIGH] Sessions started elsewhere (automation/CLI/another device) show NO running/done/error dot in any state — and their approval questions are unanswerable** *(fixed in PR #PR_NUMBER_PLACEHOLDER — untracked approvals surface as an aggregate answerable card, request.cancel clears foreign entries (badge no longer lies forever), attention toast fires; per-row dot for foreign sessions follows the indicator-contract work, bugs.md:290)* — `src/lib/chat.ts:2065-2066,239-244,282-289,2002-2003,1884,224-228` + `src/lib/sessionList.ts:22-31`
  Events for sessions not in `sessionsById` are dropped wholesale; `session.list` carries no running field; busy dots derive only from `sessionsById`. Foreign approval requests DO land in `pendingBySession` (`:1884`) so the footer count shows "waiting on you", but no row dot exists (`flagAttention` early-returns, `:2002-2003`) and `pendingRequest` (`:224-228`) requires that foreign session to be active — silently permanently blocked.
  *Fix:* server: add running/state to `session.list` (or status events). Client: resolve untracked pending entries to stored ids (`storedIdMap`/`sessionRows`) instead of early-returning, and make them openable/answerable.

- [x] **BH-000018 [HIGH] inflightCreate shared across provisional windows — send in a second new-chat window landed in the first window's session** — chat.ts:1261,1184,1247,1276 — *(fixed in PR #PR_NUMBER_PLACEHOLDER — inflightCreates Map keyed by provisional id; sweep drops dead windows' creates; pseudo-id outbox pinning fixed; on-device check pending)*
  One module-global `inflightCreate` was shared by every optimistic new-chat window: New → send (create in flight) → New again → send made window 2's `ensureSession`/`activeLiveId` await window 1's create, so the message landed in window 1's session while the screen stayed on the (now empty) window 2. The failure leg was worse: if window 1's create rejected, window 2's send was enqueued pinned to window 2's PSEUDO stored id (`new:…`), which `flushOutbox` can neither match to a live entry nor resume — silently dropped forever.
  *Fix:* `inflightCreates` Map keyed by the provisional temp id (same shape as `inflightResumes`); `newChat`'s sweep deletes a swept window's entry (an abandoned window's create is never adopted); `enqueueOffline` never pins to a pseudo id (falls back to the unpinned contract, and `loadOutbox` normalizes legacy pseudo pins).

- [ ] **BUG-103 [HIGH] Long chats open at the top and require repeated scrolling to reach the bottom** *(fixed in PR #50 — on-device check pending user's next dev build)* — `app/app/(tabs)/chat.tsx` (FlatList + `parkAtBottomRef`/`listRevealed`/`scrollListToEnd`)
  A non-inverted `FlatList` starts at `offset = 0` (the oldest message) and only mounts the first `initialNumToRender` (10) items; `VirtualizedList` (`@react-native/virtualized-lists/Lists/VirtualizedList.js:1010-1039`) clamps the tail spacer to `_highestMeasuredFrameIndex` when `getItemLayout` is absent. Three failures compound on open: (1) on cold/hydrating open, `msgs` is initially `[]` so `onContentSizeChange` fires with `h <= viewH` and immediately flips `parkAtBottomRef.current = false` before messages arrive; (2) on warm open, `scrollListToEnd` scrolls to `contentH - viewH` of only the first 10 items, `readScroll` sees `distance < 120` for that partial height and ends parking, and subsequent batches expanding `contentH` flip `stick = false`; (3) even tapping "Jump to latest" only reaches the end of the currently-measured batches.
  *Fix:* invert the transcript `FlatList` (`inverted`, `data={reversedMsgs}`, `initialNumToRender={20}`, `contentContainerStyle={{ paddingTop: 16, paddingBottom: 156, flexGrow: 1, justifyContent: 'flex-end' }}`). `offset = 0` is now the latest message on frame 1 with no `listRevealed` opacity veil or parking race; short/empty chats stay top-aligned under the 156px mascot reserve via `justifyContent: 'flex-end'`, and older history mounts lazily only when the user scrolls up.

- [x] **BUG-090 [MEDIUM] Terminal shows NO typing indicator — no caret, ever** *(fixed in PR #46 — on-device check pending user's next dev build)* — `app/(tabs)/terminal.tsx` (HEAD: echo Text at ~281, no caret node exists)
  The terminal renders the PTY echo as one `Text` node with zero caret of any kind; typed characters appear (120ms drain lag) with no cursor. The user cannot see where input lands or that keystrokes registered at all — their explicit top ask.
  *Fix:* render a `▍` block at the echo tail — steady while the session is alive, blinking (500ms) while the hidden input holds focus. Gate on `alive`, NOT only on focus (focus tracking is exactly what BUG-091 breaks).

- [x] **BUG-091 [HIGH] Tapping the terminal output does not raise the keyboard (must select text first)** *(fixed in PR #46 — blur+rAF refocus, gated on IME visibility; touch-cancel unwired to preserve selection)* — `app/(tabs)/terminal.tsx` (HEAD: `onTouchEnd={() => inputRef.current?.focus()}` at ~266)
  Android never blurs the hidden 1×1 input when the IME is dismissed — it silently keeps focus, and RN `focus()` early-returns on an already-focused view, so `showSoftInput` never re-fires. Tapping the output is dead; the only escape is long-press-selecting output text (which blurs the field for real), after which the next tap works.
  *Fix:* on tap, force a REAL focus transition (blur → verified-refocus with real temporal separation, or alternate between two hidden inputs) so RN re-calls showSoftInput every time.

- [x] **BUG-092 [HIGH] Soft-keyboard backspace does nothing after every Enter** *(fixed in PR #46 — empty-field onKeyPress DEL + diffKeystrokes() rebuild for non-prefix rewrites, 9 new tests)* — `app/(tabs)/terminal.tsx` (HEAD: no backspace handling; diff-based DEL only fires while the field still holds text)
  `submitLine` clears the hidden field after Enter, so — the common case — the field is empty when the user hits backspace: no text to diff-remove, no `onChangeText`, and HEAD has no `onKeyPress` fallback. DEL is silently swallowed exactly when users want to fix the command they just ran.
  *Fix:* add an empty-field `onKeyPress` DEL path AND stop leaving the field empty (sentinel char so every backspace flows through the diff) — don't depend on empty-field key events alone.

- [x] **BUG-093 [HIGH] Key row + composer stay behind the keyboard; unreachable while typing** *(fixed in PR #46 — KAV replaced with the chat reanimated-pad lift; static bottom edge)* — `app/app/(tabs)/terminal.tsx` (HEAD: `KeyboardAvoidingView behavior="padding"` at ~262)
  The KAV computes its padding from parent-relative coords and runs short by exactly ScreenShell's header height: the composer sinks first, the Tab/↑/↓/^C/Esc key row ends up behind the IME — untappable while typing. Chat solved this screen-shape identically with the reanimated keyboard animation + negative `paddingBottom` (BUG-037 fix, `chat.tsx:163-164,899`).
  *Fix:* replace the KAV with the proven chat pattern (`useReanimatedKeyboardAnimation` + animated negative pad), or prove the KAV prop actually compensates for the header offset on device.

- [x] **BUG-094 [HIGH] Terminal flickers and lags — every caret blink and drain tick re-renders the WHOLE scrollback** *(fixed in PR #46 — steady caret + 12k tail window + memo; on-device check pending RC2)* — `app/(tabs)/terminal.tsx` (PR #46 state: caret concat in echo Text ~291, blink interval ~166, scrollToEnd ~158)
  Video proof (debug.mp4): frames 17.4s vs 17.9s are byte-identical 40-line listing except the trailing `▍`. The echo Text value is `{snap.text}{caret?'▍':''}` — each 500ms blink AND each 120ms drain produce a NEW string → new Text child → full Android TextView re-layout of the entire buffer. With a 486-line completion listing the JS/UI thread saturates: visible flicker at 2Hz, echo lag, and key events (backspace, helper keys) dropped or seconds late — the direct driver of BUG-095/096 symptoms.
  *Fix:* steady caret (drop the blink timer — no re-renders between drain ticks), render only a tail window of the buffer (TERM_RENDER_WINDOW ~12k chars + head marker; controller keeps the 200k scrollback), memoize the window, and extract the windowing as a pure tested `renderTail()`.

- [x] **BUG-095 [HIGH] Backspace still dead after Enter on GBoard (1.0.7)** *(fixed in PR #46 — U+200B sentinel field + counting-based key/change pairing, 21 new tests; on-device check pending RC2)* — `app/(tabs)/terminal.tsx` (PR #46 state: empty-field `onKeyPress` DEL ~318)
  Video: `ls` sits unchanged 9s→12s; no deletion is ever visible; the line only disappears via ^C. After Enter the field is logically empty; GBoard's delete on an empty (sentinel-less) field doesn't reliably produce `onChangeText`, and the `onKeyPress` path — even where it fires — lands on a JS thread saturated by BUG-094, so DEL is swallowed.
  *Fix:* never-empty field: value = `\u200b` sentinel + logical text; deleting the sentinel maps to exactly one DEL (restored by the controlled value), mid-text deletes flow through the diff as today, and the `onKeyPress` fallback gets a ~120ms dedup stamp so key-event and change-event paths can never double-delete. Extract as pure `mapFieldChange()` + tests.

- [x] **BUG-096 [MEDIUM] Helper keys give no visible feedback (↑ with empty history; ←/→ invisible; caret lies about cursor position)** *(fixed in PR #46 — wave 5 xterm.js renderer draws the REAL PTY cursor: ←/→ visible, colors + erases correct)* — `app/(tabs)/terminal.tsx` (PR #46 state: tail-pinned caret + comment ~287)
  Video: Tab completion visibly works; ↑ on a prompt with no completed commands shows nothing (nothing to recall — correct but reads as dead); ←/→ move the real PTY cursor while `▍` stays pinned at the tail (it even intrudes on `more`'s `--More--` prompt at 17.4s). Partly BUG-094 starvation, partly the documented v1-renderer limitation (no cursor addressing).
  *Fix:* 094's un-starving restores ^C/Tab/↑ feedback. ←/→ cursor-addressing is only fixable by the planned xterm.js WebView renderer (FEATURE-TERMINAL.md v2, `vim` smoke) — deferred, not silently dropped.

- [x] **BUG-097 [HIGH] Backspace erases in the shell but the display never shows it — display and PTY diverge** *(fixed in PR #46 — xterm.js 5.5.0 WebView renderer, raw byte flow; on-device check pending RC3)* — `src/lib/terminal.ts:193` (`stripAnsi` drops `\x08`), `:333,373` (replay/tick bank stripped text)
  Video (moch-terminal.mp4 @40s): the prompt echo says `cd` while the executed command's output is an `ls` listing; earlier frame shows `lscd mamoun/lscd…` — stale letters jammed together. The PTY erases correctly (1.0.8's sentinel DELs work — the shell line is right), but the renderer is append-only: readline's erase echo (`\b \b`, `\r\x1b[K` redraws) is stripped (`[\x00-\x08…]` regex deletes backspace bytes outright) and the remaining text is APPENDED, so every erase leaves stale chars. User's words: "backspace does delete the letters but it is not showing in the interface."
  *Fix:* render through a real VT emulator — xterm.js in a local-asset WebView (react-native-webview 13.16.1 already a dep). Feed it RAW bytes (stop stripAnsi-ing the display path), replay the banked buffer into a fresh xterm on WebView reload. This is FEATURE-TERMINAL.md's designed v2 swap ("swaps only the renderer; the byte flow is already xterm-shaped"; `vim` smoke = acceptance).

- [x] **BUG-098 [HIGH] Keystroke-to-photon latency — feels laggy next to Termux** *(fixed in PR #46 — 50ms drain while the screen is mounted + incremental xterm painting; on-device check pending RC3)* — `src/lib/terminal.ts` (`TERM_DRAIN_MS = 120` poll) + render chain
  Termux: native emulator + continuous PTY read → <50ms. Moch v1: JS diff → bridge write → PTY echo → 120ms drain poll → JS render → TextView relayout ≈ 200-400ms per keystroke. The 120ms poll alone is most of the floor once the render is native (xterm paints decoded bytes in ms).
  *Fix:* drop the terminal drain poll to ~50ms while the screen is alive (cheap local JNI promise, xterm write is incremental); keep 120ms for the agent's exec path (unchanged).

- [x] **BUG-099 [MEDIUM] Extra-keys row below par vs Termux's two-row pad** *(fixed in PR #46 — two rows: Esc/Tab/Ctrl/↑/↓/^C/^D + Alt/←/→/Home/End/PgUp/PgDn, sticky Ctrl (CSI 1;5 forms) + Alt; on-device check pending RC3)* — `app/(tabs)/terminal.tsx` KeyRow
  Termux shows ESC/−/HOME/END/PGUP + TAB/CTRL/ALT/←/→/PGDN (two rows, Ctrl as modifier). Moch has one 8-key row (Tab ← → ↑ ↓ ^C ^D Esc); no Ctrl-as-modifier (can't type ^R/^L/^A/^E), no HOME/END, styling visibly plainer than Termux's.
  *Fix:* two-row pad like Termux's (ESC · TAB · CTRL · ALT · ↑ ↓ ← → · HOME END), CTRL/ALT as sticky modifiers composing the NEXT key from the keyboard or the pad; wire through xterm/PTY bytes. Style with the same token system as the rest of the screen.

- [x] **BUG-100 [HIGH] RC3: cannot type at all — the WebView eats every tap and the IME types into the web page** *(fixed uncommitted — box-only touch wrapper + term.onData→PTY safety net; on-device check pending RC4)* — `app/(tabs)/terminal.tsx` (RC3: `pointerEvents="none"` on the WebView) + `android/app/src/main/assets/term/index.html`
  Android enforces pointerEvents only on `ReactViewGroup` containers (`ReactViewGroup.onInterceptTouchEvent` + `TouchTargetHelper.findTouchTargetViewWithPointerEvents`, which defaults any view NOT implementing `ReactPointerEventsView` to AUTO); `RNCWebView` implements neither, so `pointerEvents="none"` on the WebView itself is a **no-op**. Every tap on the output lands inside the WebView: `outputWrap`'s `onTouchEnd` never fires (BUG-091's tap-to-focus is dead), and the WebView requests focus into xterm's internal textarea — the IME then types into the web page, where `term.onData` was never wired, so keystrokes vanish without ever reaching the PTY. The pad has no letter keys → zero ways to type. Keyboard may still LOOK up (webview textarea is focusable), which masks the cause.
  *Fix:* wrap the WebView in a `box-only` View that intercepts touches BEFORE the WebView (ReactViewGroup — actually enforced) and is itself the touch target for `focusInput`; the dead-session overlay stays a sibling so Retry remains tappable. Belt-and-braces: `term.onData → postMessage({type:'key'})` → `ctl.send` forwards web-focused keystrokes to the PTY — safe because Android has exactly one focused view, so this channel and the hidden sentinel input can never double-send.

- [ ] **BUG-101 [MEDIUM] Tray header: long conversation titles ellipsize under the right-side buttons** *(fixed in PR #48 — on-device check pending user's next dev build)* — `app/src/components/ScreenShell.tsx` (trayTitleAbs)
  The tray title's safe inset is a static `paddingHorizontal: 64` (the comment claims it is "inset by the measured controls width" — it never was), while the right control cluster (search + new chat + status = 3×38dp circles + 2×6 gap + card padding ≈ 136dp) overruns it — a long conversation title ellipsized its tail UNDER the search button (user screenshot). Only the tray branch (`S.trayHeader`, default theme); the Relay `topBar` is a flex row with a `flex: 1` title and is unaffected.
  *Fix:* measure the real cluster width — `onLayout` on `trayRight`, ref-latched setState so stable layout never re-fires — and inset the absolutely-positioned title by `max(clusterW + 18, 56)`; the 56 floor covers the menu side (38 circle + card padding + air) when the cluster is short.

- [ ] **BUG-102 [MEDIUM] Steer chip below the composer lifts the input off the screen bottom** *(fixed in PR #49 — on-device check pending user's next dev build)* — `app/(tabs)/chat.tsx` (steerChip placement + composerWrap)
  The Steer toggle renders AFTER the composer pill with `marginTop: 6`, so while the agent is busy its appearance (26dp chip + 6dp margin) pushes the pill UP, while `composerPad` keeps the `max(insets.bottom, 10)` safe-area padding under the CHIP — the input visibly floats high off the bottom with dead space beneath (user screenshot, steer-active). Steer only exists while `busy`, so normal/idle layout is untouched.
  *Fix:* move the chip ABOVE the pill inside `composerWrap` (between the attachment chips and the composer), flip its margin to `marginBottom: 6` so the gap hangs on the pill side; the pill stays pinned to the safe-area bottom in every state.

- [x] **BUG-104 [HIGH] Moch Browser: every agent browser tool fails "No browser page. Call browser_navigate first (and keep the Moch Browser screen open)" even with the screen open and a live tab** *(fixed in PR #53 — on-device check pending user's next dev build)* — `app/hermes-src/tools/browser_supervisor.py` (`_attach_initial_page`) + `browser_supervisor_frames.py` (`_enable_page_domains`) *(PR #56)*
  Three defects compound so the per-page (WebView) attach mode can NEVER engage through its automatic path: (1) the mode probe URLs are derived from the supervisor's ws:// cdp_url (`self.cdp_url.split("/devtools/",1)[0] + "/json/version"`) and fed to `requests`, which has no ws:// adapter → InvalidSchema every time → swallowed at debug level → `relay_browser_level` stays None (verified live: "No connection adapters were found for 'ws://…'"); (2) the stock browser-level branch then sends `Target.getTargets`/`createTarget` over the relay's page-tunneled socket, where a WebView has no browser-level surface → attach raises → swallowed by `_ensure_cdp_supervisor` ("non-fatal", debug-only) → webview tools return `_NO_SESSION` verbatim; (3) even in the per-page branch, `_enable_page_domains(None)` sent `Target.setAutoAttach` sessionless — another browser-level command a WebView page socket rejects. Masked in verification: `MOCH_BROWSER_FORCE_PER_PAGE` was a no-op for branch selection (the `if relay_browser_level is False:` gate never consulted it), and the PC proof passed via the stock branch because desktop Chromium tolerates Target.* over the tunneled page socket — the shipped per-page path was never exercised anywhere. An identical `_NO_SESSION` also fires when `BROWSER_CDP_URL` is unset (tools advertised via a stale relay.json while the relay is down) — same symptom, different cause; the per-page attach INFO log line now distinguishes them in logcat.
  *Fix:* derive probe URLs via `_http_probe_root()` (ws→http / wss→https, same authority + token) for BOTH the version and list fetches; a failed probe under `MOCH_BROWSER_RELAY=1` defaults to per-page (by probe time the ws dial already succeeded, and the relay only tunnels when a LIVE page exists — 503 otherwise); force flag actually forces (`relay_browser_level is False or force_per_page`); per-page branch enables only Page+Runtime sessionless (drops Target.setAutoAttach); probe-failure default logged at INFO; regression suite `app/python-runtime/tests/test_browser_attach.py` (8 cases, py3.11+py3.14 green) asserts per-page ENGAGEMENT — `_page_session_id is None`, zero `Target.*` commands, rewritten probe URLs, relay-default, force knob, stock default preserved without the env.

- [x] **BUG-105 [HIGH] Moch Browser: after ANY app restart the tools are advertised but every call fails "No browser page…" — the boot gate arms from a stale relay.json** *(the "the browser is dead" report; fixed in source — on-device check pending user's next dev build)* — `app/python-runtime/moch/hermes_boot.py` (`_prepare_home`) + `app/hermes-src/tools/browser_webview.py` *(PR #56)*
  `CdpRelay.stop()` never deletes `<hermesHome>/browser/relay.json` (deliberate — the token is stable per install), so after any app restart the file describes a relay in a DEAD process. `_prepare_home` read it and set `BROWSER_CDP_URL` + `MOCH_BROWSER_RELAY=1` unconditionally — without consulting the `pid` field `writeStateFile()` had been writing all along — so `check_browser_requirements()` (`browser_tool_install.py`) advertised the whole browser toolset against a dead endpoint. The relay only starts when the Browser screen opens (`BrowserRelayModule.ensureRunning`), so chat-first use after a restart (or any agent task while the screen is closed) dial-fails `127.0.0.1:9334`, `_ensure_cdp_supervisor` swallows it as debug "non-fatal", and every webview verb returns `_NO_SESSION` verbatim — which the model reports to the user as "the browser is dead". The "same symptom, different cause" twin BUG-104 flagged in passing; that PR only distinguished it in logcat.
  *Fix:* arm from the file ONLY when its `pid` equals `os.getpid()` — the relay is in-process (CdpRelay + Chaquopy share the app pid), so a matching pid is exactly "this process started the relay"; a stale/missing pid leaves the gate OFF so the tools stay hidden until the live flip (`moch.browser_gate.activate`, called by `ensureRunning`) arms them mid-session with no restart, in either open order; a preset `BROWSER_CDP_URL` (manual PC runs) is never clobbered either way. `webview_navigate` now distinguishes the residual dead-relay case with an actionable error — "open the Browser screen in Moch once (drawer → Browser); the tools activate the moment it opens" — via a 2s `/json/version` probe instead of the misleading `_NO_SESSION`. Regression suite `app/python-runtime/tests/test_browser_boot_gate.py` (9 cases): stale-pid no-arm (the bug), current-pid arm, missing-pid no-arm, malformed file inert, preset env survives, absent file unchanged; relay-down ⇒ instruction, relay-up ⇒ None, unconfigured ⇒ None. Full python-runtime battery green (106 tests, 4 skipped by design). E2E `research/browser-proof/run_bug105_proof.py` — ALL PROOFS PASSED: stale-file no-arm, dead-relay actionable error, full agent verb chain (navigate/refs/click/type/screenshot) through the mock relay to real Chromium on the armed path, stock browser-level regression; plus an A/B child run proving HEAD (old condition) arms the stale gate — `armed=True webview_mode=True` — while the fixed tree leaves it off. Build runbook: `TEST-1.0.15-browser.md` (vc18).

---

## 🟡 MEDIUM — noticeable glitches and friction

**Session list & screens**
- [x] **BUG-020 [MEDIUM] Silent 200-session cap** — `src/lib/sessionList.ts:66`. Client-chosen `limit: 200` (the server RPC honors any limit — fix is trivial); no pagination/"showing N of M"; older chats vanish.
  *Fix:* raise/remove the limit or paginate.
- [x] **BUG-021 [MEDIUM] No loading state on first open; error+empty shown together** — `app/(tabs)/sessions.tsx:175-185,221-232`. Blank void while loading (no skeleton); with an error, "tap to retry" AND "No conversations yet" render simultaneously.
- [x] **BUG-022 [MEDIUM] Dead offline retry + stacked double banners** — `app/(tabs)/sessions.tsx:80-86,175-185` + `ScreenShell.tsx:435`. `load` early-returns offline (dead retry button); the drawer's unguarded `loadSessions()` sets the shared error atom → two "Not connected" rows stacked.
- [x] **BUG-023 [MEDIUM] "N questions waiting" banner doesn't deep-link** — `app/(tabs)/sessions.tsx:164-173`. Navigates to the active chat; `pendingStoredIds` (`chat.ts:247-256`) has zero usages; `requestOpenSession` exists and isn't used.
- [x] **BUG-024 [MEDIUM] Stale `session.list` race on computer switch** — `src/lib/sessionList.ts:58-83`. No generation guard; machine A's in-flight response can repopulate rows on machine B (window ≈ one handshake; self-heals on next fetch).
- [x] **BUG-025 [MEDIUM] Drawer never reconciles chats deleted elsewhere** — `src/components/ScreenShell.tsx:211-223`. Merges all `sessionsById` locals; nothing prunes against `session.list` → ghost rows until restart/backend switch.
- [x] **BUG-026 [MEDIUM] Toast ergonomics** — `src/components/SessionToasts.tsx:56-83` + `src/lib/attention.ts:59-63`. Newest at BOTTOM; no swipe/close (only tap-to-navigate or 6.5-9s timer); same-chat replacement remounts with a flash.
- [x] **BUG-027 [MEDIUM] Two taps to open a search result** — `app/(tabs)/sessions.tsx:187-233`. FlatList lacks `keyboardShouldPersistTaps="handled"`; `returnKeyType="search"` has no `onSubmitEditing`.
- [x] **BUG-028 [MEDIUM] `loadSessions` inflight/force race** — `src/lib/sessionList.ts:52-83`. Force overwrites `inflight`; first finisher nulls it → 3 concurrent fetches, premature spinner clear, stale rows can overwrite fresher ones.

**Lifecycle & state**
- [x] **BUG-029 [MEDIUM] Deep link to a dead session strands a ghost "New chat"** — `app/_layout.tsx:199-205` + `src/lib/chat.ts:1275-1290,1312-1320,1361-1367`. Placeholder titled "New chat" + forever-failing retry (no `isSessionNotFound` handling in the switch path); taps older than 60s are dropped with zero feedback.
- [x] **BUG-030 [MEDIUM] Drawer delete detaches BEFORE deleting; no rollback** — `src/components/ScreenShell.tsx:301-332`. `newChat()` runs first; a failed close/delete strands the user in an empty chat with the old row still listed.
- [x] **BUG-031 [MEDIUM] Media caches ignore the backend fingerprint** — `src/lib/media.ts:446-460` + `src/lib/mediaCache.ts:34-43,169-187` + `src/lib/backendIdentity.ts:98-106`. Path-only `cacheKeyFor` overrides URL keying; relay-media existence IS the cache; purge list omits media → machine A's images/audio render for machine B's same-named paths.
- [x] **BUG-032 [MEDIUM] Backend-switch cache scoping leaks** — `src/lib/backendIdentity.ts:35-36,76-81,94-115`: `.orphan.<fp>` shelves accumulate forever (no cap/sweep); the `'legacy'` migration shelf can NEVER be restored (fingerprints are 16 hex); a transient AsyncStorage read error triggers a full purge (compounding `'legacy'`); concurrent dials can run `syncBackendIdentity` out of order (`gateway.ts:515-517` has no gen re-check; `syncedThisRun` set only at the end).
- [x] **BUG-033 [MEDIUM] `resetSessionCaches` leaves residue** — `src/lib/chat.ts:1424-1445`. Skips `chatBanner` (:326 — stale retry against a dead stored id), `streamBufs` (:404 — never `.delete`d anywhere), `queuedAttachments` (:806 — also skipped by `forgetSession`), `mochiMoment` (:304).
- [x] **BUG-034 [MEDIUM] "Forget this computer" never closes the socket** — `src/lib/gateway.ts:377-385` + `app/(tabs)/settings.tsx:283-295`. `clearConfig` has no `client.close()`/state write; Settings forgets without `disconnect()` (unlike `_layout.tsx:53-55`) → revoked machine stays connected, hero shows green "Connected".
- [x] **BUG-035 [MEDIUM] Debounced queue/draft writes lost on a quick kill** — `src/lib/sendQueue.ts:28,52-63` + `src/lib/drafts.ts:18,41-54` + `src/lib/chat.ts:534,547-559`. 400-500ms debounces; `flushSendQueue`/`flushDrafts` have ZERO production callers; no AppState 'background' flush (`_layout.tsx:150-160` handles only 'active'). Queue loss = message lost.
- [x] **BUG-036 [MEDIUM] 120s request timeout → 2-minute hangs + double-submitted prompts** *(partially — client half fixed in PR #PR_NUMBER_PLACEHOLDER: typed timeouts, no auto-resubmit after submit-phase timeout, unconfirmed row status; SERVER dedupe deferred: needs client_request_id in vendored contracts (extra=forbid) — protocol decision)* — `src/protocol/json-rpc-channel.ts:135,241-249` + `src/lib/chat.ts:1655`. Timeout only rejects; `prompt.submit` has no idempotency key so timed-out-but-delivered + retry double-submits. *(Client-side half; server dedupe is the real fix.)*

- [x] **BUG-089 [MEDIUM] Server requests can be misfiled onto the wrong chat or a dead key (unmarked + unanswerable)** *(fixed in PR #31: live ids rebind through storedIdFor before filing)*  — `src/lib/chat.ts:1867,2002-2003,1012`
  A request missing `session_id` is filed under WHATEVER chat is active (`:1867`) — the wrong row gets the amber dot + composer block while the origin shows nothing; a request emitted under the old live id during resume rotation lands under a dead key — `flagAttention` early-returns and `pendingRequest` can never match. Timing-narrow but silently permanent when hit.
  *Fix:* resolve request session ids through `liveIdFor`/`storedIdMap` before filing; file unknown ids under the stored key.

**Chat UI**
- [x] **BUG-037 [MEDIUM] Composer double-inset above the keyboard** — `app/(tabs)/chat.tsx:817,1243,163-164`. SafeAreaView bottom edge + `paddingBottom: Math.max(insets.bottom, 10)` stack (keyboard-controller applies no native lift in edge-to-edge) → the pill floats ~2× gesture inset above the keyboard.
- [x] **BUG-038 [MEDIUM] Composer attachments are not scoped to the chat** — `app/(tabs)/chat.tsx:177,202-220,652,634`. Plain state; the storedId effect resets drafts/scroll but not chips; Send delivers chips (and captions) to the NEWLY active chat (both direct and busy-queue paths).
- [x] **BUG-039 [MEDIUM] Reconnect resync / live-id rotation re-keys ALL messages on screen** *(partially — PR #4 preserves the live streaming tail across resync/rotation; fully stable ids need server message identity, tracked)*  — `src/lib/chat.ts:1485,1493,2056,1012` + `app/(tabs)/chat.tsx:894`. `id: nid()` on every applyHistory → every visible row remounts in place (aspect probe resets → layout snap). *(Switch remount is by-design via `key={storedId}` — the harmful paths are the on-screen ones.)*
- [x] **BUG-040 [MEDIUM] Streaming renders raw text; cursor on its own line** *(partially — inline cursor in PR #24; markdown-while-streaming is a documented perf trade)*  — `src/components/Chat.tsx:213-224`. Code/links untappable until segment end; the `▍` is a separate Text node below the paragraph.
- [x] **BUG-041 [MEDIUM] Failed slash command loses typed text** — `app/(tabs)/chat.tsx:608-611,458-460`. Composer cleared before `runSlash`; catch doesn't restore (plain-send does, :656). Concretely: `/reset` on a brand-new chat throws "New chat is not ready" and the text is gone.
- [x] **BUG-042 [MEDIUM] No escape for literal "/" messages** — `app/(tabs)/chat.tsx:608` + `src/lib/slash.ts:570-643`. Any leading-slash text (no attachments) becomes a command dispatch — `/usr/bin/env` produces an error card; the text is never sent as a chat turn.
- [x] **BUG-043 [MEDIUM] "Browse slash commands" starter is a dead end** — `app/(tabs)/chat.tsx:958-960,1042`. Inserts "/" but doesn't focus the composer (palette is focus-gated); a catalog sheet exists (`CommandCatalogSheet` :1452-1457) and isn't used.
- [x] **BUG-044 [MEDIUM] TTS state never resets on playback end; stale "stop" icons** — `src/lib/voice.ts:120-131` + `src/components/Chat.tsx:138-173,246,251`. expo-audio player with no status listener; `ttsPlaying` cleared only in `stopTts`; bubble A keeps the "stop" icon + "Stop playback" a11y label after B's tap kills its audio.
- [x] **BUG-045 [MEDIUM] No timestamps on user messages; no day separators** *(partially — user timestamps in PR #24; day separators need list-data restructuring, tracked)*  — `src/components/Chat.tsx:231-296` + `app/(tabs)/chat.tsx:785-793,893`. `ts` exists on every message; rendered only for assistant rows; no separator items anywhere.
- [x] **BUG-046 [MEDIUM] Header status chip looks tappable but does nothing (zero press feedback)** — `src/components/ScreenShell.tsx:368-378,411-421`. Pressable with no onPress AND no pressed style (neighbors have one); the chat banner next to it says "tap to retry".
- [x] **BUG-047 [MEDIUM] `stopRun` clears busy even when the interrupt RPC failed, then flushes the queue** — `src/lib/chat.ts:1709-1722,1721,1759-1767`. Catch only logs; `busy:false` unconditional; `maybeFlushQueue` submits the head into a possibly still-running turn (dead-socket is the only guard that saves it).
- [x] **BUG-048 [MEDIUM] Recording auto-stop fires inside a setState updater (impure; `finishRecording` non-idempotent)** — `app/(tabs)/chat.tsx:723-728,673-697`. No StrictMode today so no double-fire, but the second `recorder.stop()` would throw → "Recording failed" alert. *Move the limit check into the interval callback.*

- [x] **BUG-087 [MEDIUM] Approval/clarify button pills render broken with the default 4-choice set** — `app/(tabs)/chat.tsx:1572-1580` (row rendered `:1105-1128`)
  `s.sheetRow` has no `flexWrap`; `s.sheetBtn` has ZERO horizontal padding; `s.sheetBtnText` has no `textAlign`/`numberOfLines` → on a 360dp screen each pill gets ~71dp while "Always this chat" needs ~100dp: it wraps to 2-3 ragged LEFT-aligned lines inside a "centered" pill, and row-stretch equalizes heights — a band of misaligned multiline pills that reads as broken. Clarify option pills wrap up to 12 unbounded gateway strings the same way (`:1578-1580`).
  *Fix:* `numberOfLines={1}` (+ `adjustsFontSizeToFit` or shorter labels like "This chat"), `textAlign:'center'`, `paddingHorizontal: 8-10`, or a 2×2 grid when >2 choices.
- [x] **BUG-088 [MEDIUM] Turn endings without a terminal event leave NO done indication** — `src/lib/chat.ts:2313-2321,2100-2115,2151`
  `status.update busy=false` (aborted/empty/tool-only turns) clears the pulse with no `flagAttention`; `session.reclaimed` kills it silently; `message.start` erases an unread green done dot (e.g. an auto-flushed follow-up). Contrast: `message.complete`/`background.complete` DO mark done when not watching.
  *Fix:* call `flagAttention` (or at least `markAttention`) on every busy=false edge not immediately followed by `message.complete`.

**Cross-cutting**
- [x] **BUG-049 [MEDIUM] New-chat confirmation inconsistent across 4 entry points** — `app/(tabs)/settings.tsx:297-302` confirms; drawer (`Sidebar.tsx:767-777`), Chats tab (`sessions.tsx:112-117`), `/new` (`chat.tsx:395-400`) all switch immediately.
- [x] **BUG-050 [MEDIUM] Denying an approval plays a Success haptic** — `app/(tabs)/chat.tsx:1106-1119`. One handler for all `approvalChoices` incl. deny; AlertDialog correctly uses Warning for destructive (`AlertDialog.tsx:66-74`). *Fix: Warning for deny.*
- [x] **BUG-051 [MEDIUM] Sub-44dp touch targets on mid-stream controls** *(partially — steer chip + FAB hitSlops in PR #21; queue-row buttons/drawer menu/skills pills remain)* — steer chip 26-28dp no hitSlop (`chat.tsx:1646-1648,1431-1439`); queue buttons 30×30+6≈42 (`:1668,1309,1318`); jump FAB 40×40 (`:1530-1541`); drawer ⋯ 40dp (`Sidebar.tsx:1094-1099`); Skills pills 34 (`skills.tsx:165`); AttachmentChip remove/retry 26px (`src/components/media/AttachmentChip.tsx:66-73`).
- [x] **BUG-052 [MEDIUM] Key-storage copy contradicts itself (and the truth)** — `app/setup.tsx:94` "stored on this phone" vs `app/(tabs)/agent.tsx:305-308` "on your server". Wire truth: `model.save_key` RPC (`src/lib/modelState.ts:300-309`); ZERO local key persistence exists (SecureStore holds pairing tokens only). Setup copy is false.
- [x] **BUG-053 [MEDIUM] Dev jargon + a dead CLI in user-facing copy** — `agent.tsx:155` "Run `moch model`" (npm CLI deprecated); `settings.tsx:456`, `PairForm.tsx:128,226` expose "JSON-RPC"/`hermes-pair.sh`; raw `e.message` alerts across sessions/chat/settings; "Sudo requested"/"Secret requested" vs "Hermes needs you" register mix.
- [x] **BUG-054 [MEDIUM] Perf: admitted-skipped items still shipped** *(partially — palette virtualized in PR #28; voice chunking needs the upload-stream endpoint for voice, tracked)* — slash palette 120-row unvirtualized ScrollView + 120ms timer (`chat.tsx:88,366-376,1051-1085`; SPEED_REPORT A2-10/A2-12); voice base64-encodes whole recordings on the JS thread (`voice.ts:60`; A2-29).
- [x] **BUG-055 [MEDIUM] Every visited tab polls the gateway forever (~7 RPC/min steady-state)** — `src/components/ScreenShell.tsx:167-175` + `app/(tabs)/_layout.tsx:16-31`. 60s `setInterval` per mounted shell, no focus gate; plain `<Tabs>` keeps tabs mounted; inflight dedup only collapses simultaneous calls.
- [x] **BUG-056 [MEDIUM] Reduced-motion support is one-off** — `src/components/Chat.tsx:73-79` (one-shot read, no listener — all 4 AccessibilityInfo uses in the repo are one-shot); `Sidebar.tsx:884-894` and `SessionToasts.tsx:37-46` never check it.
- [x] **BUG-057 [MEDIUM] Setup notifications card is a no-op; doc comment points at a nonexistent entry** — `app/setup.tsx:140` (`setNotif(notif || true)` — always true, requests nothing; a user who denied can flip it to "allowed"), `:20-24` claims Settings → "Run setup" (doesn't exist; real path `PairForm.tsx:72`).

---

## 🟢 LOW — polish, dead code, hygiene

- [x] **BUG-058 [LOW] `fmtWhen` shows "just now" indefinitely for future timestamps; labels refresh only via the 60s poll** — `app/(tabs)/sessions.tsx:36-50`.
- [x] **BUG-059 [LOW] DST drift mis-buckets Yesterday / Previous 7 days by an hour** — `src/lib/chatListState.ts:142-167` (fixed 24h subtraction vs calendar days; concrete failing instant verified for US fall-back).
- [x] **BUG-060 [LOW] Stale "stuck streaming" tail can graft the next turn** — `src/lib/chat.ts:2158,422-480` (downgraded: hermes reliably emits terminal `message.complete` — prompt_turn.py:985 — but a hung thread + a following `message.start` grafts onto the stale bubble).
- [x] **BUG-061 [LOW] `message.complete` drops the final answer if no streaming row exists** — `src/lib/chat.ts:2181-2213` (downgraded: needs a missed `message.start` — boot/reconnect race on a remote backend only; no fallback append).
- [x] **BUG-062 [LOW] Dead code: write-only `sending` flag (7 writes, 0 reads) and exported-dead `resumeSession`** — `src/lib/chat.ts:1502,1550,1693,2214,2298,2317,2336,957-963`; stale citation at `src/lib/attention.ts:19`.
- [x] **BUG-063 [LOW] Dead/duplicated code batch** — unused `Ionicons` imports (chat.tsx:19, sessions.tsx:3, index.tsx:6, add-computer.tsx:5, setup.tsx:5, Chat.tsx:11); `interface Sess` duplicates `SessionRow` (sessions.tsx:24-31); dead `warn`/`note` styles (settings.tsx:532-533); duplicate `connectionState` subscriptions (chat.tsx:116,130); inline FlatList styles recreated per render (chat.tsx:892,897); unreachable `ready` tag (setup.tsx:100).
- [x] **BUG-064 [LOW] storedIdMap 200-cap evicts by insertion order, not recency; evictions strand legacy v1 transcript blobs** — `src/lib/chat.ts:737-748,621-624,705-711` (acknowledged in-code at :605-607 as bounded/best-effort).
- [x] **BUG-065 [LOW] Queue/draft eviction by insertion order, not recency** — `src/lib/sendQueue.ts:65-70` + `src/lib/drafts.ts:93-97`.
- [x] **BUG-066 [LOW] Transcripts of server-deleted chats persist forever (same-machine window)** — `src/lib/chat.ts:703-715` (only forgetSession/fingerprint-switch clean up; no session.list reconciliation; bounded 300 msgs/blob).
- [x] **BUG-067 [LOW] ''-keyed server requests become unanswerable (defensive path, currently unreachable)** — `src/lib/chat.ts:1867` + `pendingRequest:224-228`; the gateway stamps+validates `session_id` on every frame (`server_requests.py:62-63,135`).
- [x] **BUG-068 [LOW] Malformed WS frames dropped with zero telemetry** — `src/protocol/json-rpc-channel.ts:369-377`.
- [x] **BUG-069 [LOW] Probe-key shape never validated client-side (base64-of-16-bytes invariant)** — `src/lib/gateway.ts:134-141`; short tokens surface as opaque connect errors.
- [x] **BUG-070 [LOW] Reconnect backoff has no jitter** — `src/lib/gateway.ts:430`.
- [x] **BUG-071 [LOW] Per-server token silently falls back to plaintext AsyncStorage (no warn, unlike saveConfig)** — `src/lib/gateway.ts:201-208` vs :371.
- [x] **BUG-072 [LOW] `client.capabilities` re-advertised on every gateway.ready frame** — `src/protocol/json-rpc-channel.ts:414-415,427-429` ("once per generation" comment unenforced).
- [x] **BUG-073 [LOW] Queue flush into a session deleted mid-flush drops the head (and its attachments) silently** — `src/lib/chat.ts:1541-1543,1778-1780`.
- [ ] **BUG-074 [LOW] Raw server strings in UI** — `item.source` verbatim ("mobile · 2 msgs", sessions.tsx:213); "cannot delete an active session"/"session not found" alerts; optimistic row stuck at "0 msgs" (`sessionList.ts:120`).
- [x] **BUG-075 [LOW] Silent no-feedback sends** — retry early-returns (`chat.ts:1699/1701/1704` — the real silent path is BUG-003's lock); send with no storedId no-ops (`chat.tsx:631`); clarify empty mini-send wipes the field (`chat.tsx:1194` + `chat.ts:1829-1830`); steer with a full queue drops the item's attachments (`chat.tsx:1294-1307` — re-enqueue re-attaches only when the queue isn't full).
- [x] **BUG-076 [LOW] Enter inserts a newline despite `returnKeyType="send"`** *(documented platform limitation: RN multiline ignores the IME action; a real fix needs a native single-line+manual-newline composer — out of scope)*  — `app/(tabs)/chat.tsx:1381-1383` (multiline native; submit handler web-gated; no `blurOnSubmit`).
- [x] **BUG-077 [LOW] Truncations with no markers** — expanded thinking at 4000 chars (`Chat.tsx:368,381`); history rows 8000 vs 32000 streamed (`chat.ts:1481-1487`); transcript export 50k silent truncate ("Transcript copied" regardless, settings.tsx:279-280); todos capped at 4, index keys, no "+N" (`chat.tsx:1019-1023`).
- [x] **BUG-078 [LOW] One-frame top flash on chat switch** — `app/(tabs)/chat.tsx:202-220` (post-paint useEffect vs pre-render reset).
- [x] **BUG-079 [LOW] A11y roles missing on icon-only controls; internal qid leaked into a label** *(qid fixed in PR #28; queue-action roles + hitSlops in PR #34)*  — model chip/banners/FAB/copy-listen (labels but no `accessibilityRole`); `accessibilityLabel={'Answer ' + q.qid}` (`chat.tsx:1159`); tab rows/search/banners lack roles (`sessions.tsx:145-203`, `SessionToasts.tsx:56-60`).
- [x] **BUG-080 [LOW] Scattered hard-coded whites/inks bypassing tokens** — `chat.tsx:1410,1575`; `Sidebar.tsx:1044,1198`; `SessionToasts.tsx:62`; iOS-only `RefreshControl tintColor` on an Android-only app (`sessions.tsx:190`).
- [x] **BUG-081 [LOW] Docs drift** — SPEED_REPORT A2-28 says "not edited" but concurrent persist is implemented (`gateway.ts:518-532`); TODO.md's cold-launch-lands-on-pairing issue STILL TRUE (`app/index.tsx:24-29` — no auto-restore/"continue as <name>"); `setup.tsx:60` typo "rocksolid".

---

## Security (audit C-items)

- [x] **C-05 / BH-000038 [HIGH, security] Plaintext-by-default pairing + cleartext app-wide — crafted QR/deep-link silently dials ws:// with the token in the URL** — pairing.ts:37, gateway.ts:559, http.ts:5, AndroidManifest:23 — *(fixed in PR #130 — tls defaults ON for public hosts, explicit confirm before any plaintext public dial (QR + deep-link + manual), dial/http refusal without confirmation; networkSecurityConfig loopback-only deferred (breaks documented LAN plaintext pairing — product call); on-device check pending user's next dev build)*.

---

## Suggested fix order
1. **BUG-001 + BUG-007** (reconnect pair — one commit).
2. **BUG-002 + BUG-003 + BUG-008 + BUG-019** (outbox rework: pin `{storedId,text}`, dequeue-after-success, single enqueue layer, resetOutbox).
3. **BUG-082** (approval overflow — standalone, ship ASAP: it deadlocks the agent).
4. **BUG-004 + BUG-006** (delete + rename — shared "resolve live id first" helper).
5. **BUG-005** (veil/banner redesign, coupled).
6. **BUG-083 + BUG-084** (one commit — both live in `applyHistory`/`runResume`: restore reasoning segments + merge the server `running` flag + preserve the streaming tail).
7. **BUG-009 → BUG-011** (connection robustness).
8. **BUG-012 + BUG-018** (list correctness + navigation).
9. **BUG-085 + BUG-086 + BUG-023** (indicator contract: wire `pendingStoredIds`, re-mark on leave, server running-state bridging).
10. Everything else in numbered order.

---

## 📱 Wave 9 — full-surface on-device pass, 1.0.15-browser (versionCode 18), 2026-10-11

Device: Xiaomi M2101K7BG (Redmi Note 10), Android 13 / SDK 33. APK verified
byte-size-identical to `app/android/app/build/outputs/apk/release/app-release.apk`,
baked Python confirmed to carry the BUG-105 `_pid == os.getpid()` gate.
Method: real UI driven over adb (uiautomator + `input` + OCR of live frames), the
app's own gateway (127.0.0.1:9119) for authoritative state, `/proc/net/*` for
sockets, `ps` for guest processes. Full evidence and per-step results:
`TEST-REPORT-1.0.15-device.md` (+ raw log `.devtest/FINDINGS.md`).

- [x] **BUG-106 [HIGH] [FIXED + VERIFIED on device] The browser relay is IPv6-only while every client URL is IPv4 — the whole browser feature is dead on device** — `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt:86` vs `app/python-runtime/moch/hermes_boot.py:158` + `moch/browser_gate.py` (`activate`) *(PR #56)*
  `srv.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), preferPort))` binds `::1` on Android (measured: `::1:9334` LISTEN in `/proc/net/tcp6`, **nothing** on 127.0.0.1; `toybox nc 127.0.0.1 9334` → Connection refused), while both arming paths set `BROWSER_CDP_URL=http://127.0.0.1:<port>/<token>`. `requests`/`websockets` dial that literal as IPv4 → ECONNREFUSED → `browser_webview._relay_down_error()` fires and every tool call returns "The Moch browser relay is not running…". Proven end-to-end: installing a 127.0.0.1→[::1] forwarder **inside the app's own network namespace** made the very next `browser_navigate` succeed — "Worked — page title: 'Example Domain'." — and the visible tab really navigated (tab strip + URL bar + rendered page). PC proofs missed it because the mock relay binds 127.0.0.1.
  *Fix:* bind `InetAddress.getByName("127.0.0.1")` in `CdpRelay.start` (preferred; loopback-only, IPv4 is what the clients speak), or emit `localhost`/`[::1]` in the two arming paths — not both.

- [x] **BUG-107 (DUPLICATE ENTRY — same defect as the BUG-107 entry further down, which carries the root cause and the fix) [HIGH] (narrowed) Opening the Browser screen does not arm the tools "immediately" — the flip only lands after the 30 s check_fn TTL, and never in an existing chat** — `app/python-runtime/moch/browser_gate.py` (`_check_fn_cache.clear()`), `hermes-src/tools/registry.py:222` (`_CHECK_FN_TTL_SECONDS = 30`) *(PR #56)*
  Measured with `agent.log`: gate activated 15:01:02; a **new** chat at 15:01:30 had no browser tools ("No browser tool (browser_navigate) exists in my toolset"); a **new** chat at 15:02:30 listed `browser_back, browser_click, browser_console, browser_get_images, browser_navigate, …`. A chat that existed before the flip never gained them. TEST-1.0.15 step 1.4 ("tools are live immediately, no app restart needed") and step 3 (screen-first order) both fail.
  *Fix:* invalidate the resolved tool schema per turn (not just `_check_fn_cache`), or resolve the browser toolset per message; if that is not possible, arm the relay from a screen the user has open anyway (or start it at app boot).

- [x] **BUG-108 [HIGH] [FIXED + VERIFIED on device] Bot detail loads blank and Save is a silent no-op — `profiles.*` called with `profile` instead of `name`** — `app/app/bot.tsx:36,55` *(PR #57)*
  `profiles.describe`/`profiles.configure` resolve `params["name"]` (`hermes-src/tui_gateway/methods_profiles.py:71`) and answer `4063 name required` for `{profile: …}` (probed live over `/api/ws`). The screen shows the placeholder `What is this bot for?` and an empty SOUL for a bot whose description + generated SOUL.md both exist, swallows the load error (`catch {}`, bot.tsx:44-46) and reports nothing on save. `moch.*` methods do take `profile`; the `profiles.*` family does not.
  *Fix:* send `{name: bot}` in both calls, or accept `profile` as an alias in `_resolve_profile`.

- [x] **BUG-109 [HIGH] [FIXED + VERIFIED on device] The M9 fleet runtime is never armed, so Crew/freeze/DM/kanban are dead on device** — `app/python-runtime/moch/gateway_server.py:88-105`, `moch/fleet.py:40` *(PR #58)*
  `MOCH_FLEET`/`MOCH_EMBEDDED` are read by `fleet.py`, `fleet_worker.py`, `dm_bridge.py` and the gateway gate, but **set nowhere** in the app (grep over `python-runtime/`, `hermes-src/`, Kotlin, gradle: only docstrings/tests). Measured: `moch.fleet.status`, `moch.fleet.freeze`, `moch.kanban.tasks`, `moch.runs.timeline` all answer `-32601 unknown method`. User-visible: the Crew board pins a raw developer error (`unknown method: moch.kanban.tasks — the client and the Hermes backend are out of sync … run 'hermes update' and restart both`) over empty columns, and Freeze/unfreeze is a silent no-op (`fleet.tsx:70-78` has no `catch`).
  *Fix:* arm the flag in the embedded gateway boot (`os.environ.setdefault("MOCH_FLEET", "1")` next to `HERMES_DESKTOP`), or ship the surfaces flag-gated with an honest "not enabled in this build" state instead of a version-skew error.

- [x] **BUG-110 [HIGH] [FIXED + VERIFIED on device] Deleting a bot is impossible in the app** — `app/app/bot.tsx:87` → `moch/rpc_fleet.py:263` *(PR #57)*
  `moch.profiles.delete` is registered only by `rpc_fleet.install()` (BUG-109). Probed: `-32601 unknown method`. The delete wizard's `Tap again to confirm deletion` does nothing — no dialog, no error, profile and roster unchanged; there is no native `profiles.delete` RPC to fall back on, so a bot can only be removed by hand.
  *Fix:* ship a non-fleet delete path (plain `profiles.delete` RPC), and surface the failure when the runtime is absent.

- [x] **BUG-111 [HIGH] [FIXED + VERIFIED on device — scoping is now visible and reversible] The active bot silently captures every later chat, with no attribution in the UI** — `app/src/lib/chat.ts` (`createSession`, M9.2 bot binding) + chat header/Sidebar *(PR #57)*
  Repro: chat with a bot once (Fleet → Chat with <bot>), then New chat from the Chat screen — the header shows only the title (no `Bot ·` prefix) and the drawer row shows no bot identity, but the session lands in the bot's profile: `session.list {profile: research-assistant}` returns it while the default list does not. The user keeps talking to a profile with its own memory/skills/credentials/budgets while the UI reads as a normal chat. M9.2's "bot chips + attribution in chat and sidebar" is the missing half.
  *Fix:* show the active bot in the header/composer and the drawer row (localized), and make the binding visible/explicit with a way back to the default profile.

- [x] **BUG-112 [HIGH] [FIXED + VERIFIED on device] Bot conversations disappear from the drawer and All-chats after a restart** — `app/src/lib/sessionList.ts:178` (`session.list` with no profile) *(PR #57)*
  The list RPC is profile-scoped server-side; the client never passes a profile, so only the active (default) profile's sessions come back. While the app runs, a bot chat stays visible via the optimistic local row; after `am force-stop` + relaunch it is gone from both list surfaces although it is still on disk (verified with the profile-scoped call). Fleet → `Chat with <bot>` opens a NEW chat instead of resuming, orphaning the old one. Contradicts M9.2's "killing/reopening the app preserves everything".
  *Fix:* pass the active profile (or fan out across profiles and merge) in `loadSessions`; resume the bot's most recent session on hand-off.

- [x] **BUG-113 [HIGH] [FIXED + VERIFIED on device] Share-in loses the payload when the app is cold** — manifest `ACTION_SEND` filters + `app/src/lib/shareIn.ts` (`take()` pull) / `sharein/ShareInRelay.kt` *(PR #57)*
  Warm share (app running) works exactly as documented — app routes to the chat tab and the composer holds `https://example.com/shared-from-test`, nothing auto-sent. Cold share (`am force-stop`, then the same SEND intent) cold-boots to the chat tab with an **empty** composer: waited 20 s, backgrounded→foregrounded to force the `AppState-active` re-pull, retried with a second payload, and `…/cache/share-in/` stayed empty. FEATURE-SHARE-IN step 6 fails.
  *Fix:* capture in `onCreate` before the React tree mounts and hold the payload until `take()` drains it (or persist it in the relay until acknowledged); add an on-device trace for the capture path.

- [x] **BUG-114 [MEDIUM] [FIXED + VERIFIED on device — both halves] Session search cannot find message content** — `state.db` FTS5 + `hermes_cli/web_routers/sessions.py` (search_router) *(PR #58)*
  `errors.log`: `SQLite FTS5 unavailable for …/state.db; full-text session search disabled … (no such module: fts5)`. Measured: drawer/Chats search matches **titles** (`AGENT-ISOLATION`) but not a phrase that exists only in a message body (`reachable from my side` → `No matches`, phrase verified in the transcript); `GET /api/sessions/search?q=…` returns `{"results":[]}` even for a title term. No UI hint that search is title-only.
  *Fix:* ship an FTS5-capable SQLite/Python in the embedded runtime, or add a LIKE-based fallback for message search and label the degraded mode.

- [ ] **BUG-115 [MEDIUM] Terminal: Kill → Retry replays the dead session's scrollback into the fresh shell** — `app/python-runtime/moch/terminal.py:202-203` + `app/src/lib/terminal.ts:226-250`
  `start()` clears `_state.chunks` but not `_state.replay` (the WebView-refill bank), and the JS immediately re-banks `native.replay()` into the new xterm. Repro: echo a marker → Kill → Retry → the previous session's output (`uname -a`, `TICK-1..4`, marker) is on screen again from a bash that never ran it. Also makes the kill affordance look broken.
  *Fix:* clear `_state.replay`/`replay_bytes` in `start()` (or scope the replay bank to WebView reloads only).

- [x] **BUG-116 [MEDIUM] [FIXED + VERIFIED on device] The EN/AR i18n foundation cannot be reached — `setLocale()`/`loadLocale()` have zero callers** — `app/src/lib/strings.ts` *(PR #57)*
  Grep over the app finds only the definitions; Settings has no language row (whole screen scrolled). The atom is therefore always `'en'`, so the Arabic catalog and the RTL flag are dead code; forcing the app locale (`cmd locale set-app-locales … ar`) + relaunch leaves the UI English and LTR. M9.2's "RTL pass on the new screens" is untestable as shipped.
  *Fix:* call `loadLocale()` once at boot and add the language row (EN/العربية) that calls `setLocale()` + reloads the RN layout direction.

- [ ] **BUG-117 [MEDIUM] Model picker opened from Settings shows an internal error banner** — `app/(tabs)/settings.tsx` → model sheet
  `Couldn't refresh the model inventory (New chat is not ready). Showing the last known list.` The cached list still renders, but an internal precondition leaks into a Settings screen and the inventory can stay stale for anyone who never opens the picker from a chat.
  *Fix:* refresh the inventory without a live chat (gateway `models.*`), or phrase/scope the fallback so it never surfaces raw state.

- [x] **BUG-118 [MEDIUM] [PLUMBING FIXED + VERIFIED on device — shipping curated manifests stays a content decision] The MCP catalog is empty in the shipped APK** — `hermes-src/hermes_cli/mcp_catalog.py:126` (`optional-mcps/`) *(PR #56)*
  Connectors → Browse: `Catalog is empty`; `GET /api/mcp/catalog` → `{"entries":[],"diagnostics":[]}`; RPC `mcp.catalog` → `{"servers":[]}`; `…/AssetFinder/app/optional-mcps` does not exist. The screen invites browsing a catalog that never ships.
  *Fix:* bundle `optional-mcps/` in the Python sources, or replace the empty state with an honest "catalog not bundled in this build" + the manual add-server path.

- [ ] **BUG-119 [LOW] About shows `Moch v1.0`, not the installed build** — `app/(tabs)/settings.tsx`
  Installed APK is `1.0.15-browser` (versionCode 18) and the runtime reports `Mochi 0.21.3`; the About row says `Moch v1.0`, so neither the user nor support can read the build from the UI.
  *Fix:* render `Constants.expoConfig?.version` + the Android versionName/versionCode.

- [x] **BUG-120 [MEDIUM, security] The loopback gateway hands out its own session token without auth** *(fixed in PR #129 — embedded runtime no longer serves the token at /: idempotent route-surgery in gateway_server._run_server, hermes-src pristine; regression test tests/test_gateway_root_shim.py; on-device check pending user's next dev build)* — `moch/gateway_server.py` (hermes `web_server` root shim)
  `GET http://127.0.0.1:9119/` returns the dashboard HTML containing `window.__HERMES_SESSION_TOKEN__="…"` with no authentication, while every `/api/*` route requires exactly that token (`X-Hermes-Session-Token`). Loopback TCP is reachable by any app on the device, so any installed app can read the token and then drive the full hermes API — sessions, transcripts, file read/write/delete, cron, fleet. The browser relay was deliberately token-gated against this same threat model (`FEATURE-BROWSER.md` §Safety: "loopback TCP is reachable by other apps, unlike the unix socket"); the gateway is not.
  *Fix:* serve the token only to the app's own WebView (or drop the token from the shim response entirely and inject it through the RN bridge), and/or bind the gateway to a UID-restricted channel.

- [ ] **BUG-121 [MEDIUM] Browser gate failure mode: the agent improvises instead of saying the tools are unavailable** — `hermes-src/tools/tool_search.py` hint + `browser_webview._RELAY_DOWN_ERROR` path
  With the gate correctly off (BUG-105 verified fixed), TEST-1.0.15 step 1.3 expects the agent to say it has no browser tools. Instead it burned 5 `terminal` calls trying `/system/bin/am` inside the proot guest, then the run ended `Operation interrupted.` — no answer to the user. `tool_search`'s hint actively discourages concluding the capability is missing ("Retry tool_search … before concluding the capability is unavailable"), and nothing tells the model the Moch Browser exists but is not armed.
  *Fix:* when the platform supports the relay but it is down, inject a one-line capability note ("the Moch Browser exists; ask the user to open the Browser screen") into the system prompt/tool notes.

- [ ] **BUG-122 [LOW] SQLite WAL-reset vulnerability warning on every boot, with non-actionable advice** — `errors.log` (`hermes_state`)
  Once per process per DB: "linked SQLite 3.50.4 … vulnerable to the WAL-reset corruption bug … using journal_mode=DELETE instead of enabling WAL. … run `hermes update`". The mitigation is automatic, but every database now runs in the slower journal mode and the message tells a phone user to run a CLI they do not have.
  *Fix:* ship SQLite ≥ 3.51.3 in the embedded runtime and drop the developer-facing advice from the phone log.

- [x] **BUG-123 [URGENT] Reset Linux leaves an undeletable `rootfs/workspace` behind, the reinstall then silently skips the distribution, and the status reports a guest that does not exist — the Linux environment becomes unrecoverable from the app** — `app/python-runtime/moch/linux_env.py` (`reset()` :611-623, `bootstrap()` rootfs gate ~:517-529, `status()` :602-608) *(PR #58)*
  Found while running the terminal runbook's step 9 (Reset) on device. Chain, all measured:

  1. `Reset Linux environment` → confirm. The guest disappears, the Terminal correctly reports
     `Moch Linux isn't installed yet. Install it from Settings → Linux environment, then come back.`
  2. But `linux/rootfs/{data,workspace}` survive: `workspace` is a directory the **app's own uid cannot
     read or remove** — `GET /api/fs/list …/rootfs/workspace` → `{"entries":[],"error":"EACCES"}`, and
     `DELETE /api/files …/rootfs/workspace` → `500 [Errno 13] Permission denied`. It is the bind target
     for the app workspace and is not owned/permissioned for the app process, so
     `reset()`'s `shutil.rmtree(linux_dir, ignore_errors=False)` raises, leaves the tree half-deleted,
     and the UI shows no error.
  3. With `rootfs/` still present, `bootstrap()`'s guard `if not rootfs.exists():` is False, so
     **the Ubuntu base is never downloaded or extracted**. The proot/libtalloc/shmem steps do run, the
     stamp is written, `report["ok"] = True`, and `status()` reports
     **`Linux ready — None · 0 MB on disk`** while the Terminal still says not installed.
  4. `Update / reinstall environment` can never repair it: the stamp matches and `rootfs` exists, so
     every retry is a no-op. I retried it twice (80 s + 60 s of monitoring, `linux/tmp` never gets a
     partial download, no downloader process appears) and the tree stayed `rootfs/{data,etc,workspace}`.

  Net effect: one tap on a documented Settings action bricks Moch Linux — the Terminal screen, the
  agent's `terminal`/`exec_in_guest` path and every guest feature are dead — and the app both hides the
  failure and then claims the guest is ready. On this device it could not be recovered from the UI
  (see the recovery note in `TEST-REPORT-1.0.15-device.md`).
  *Fix:* (a) `reset()` → `ignore_errors=True` + explicit stamp removal + honest result (report leftover
  paths instead of raising); (b) gate the rootfs step on a **sentinel** (`rootfs/etc/os-release`), not
  bare `rootfs.exists()`; (c) `status()["bootstrapped"]` → require the same sentinel so the UI can never
  say "Linux ready" for a stub tree; (d) treat `rootfs/workspace` like the mount target it is — never
  descend into it during reset (skip it, or chmod/remove it from the Kotlin side that created it).

- [ ] **BUG-124 [LOW] A rejected pairing link gives no feedback at all** — `app/add-computer.tsx` (paste-pairing-link path)
  On device: Settings → Add computer → More pairing options → paste
  `hermes://connect?host=127.0.0.1:1&token=bogus` → `Use pairing link`. Nothing
  happens — no toast, no inline error, the screen does not move, and the pairing
  state stays empty (`/api/pairing` → `{"pending": [], "approved": []}`). A
  mistyped host or an expired QR is indistinguishable from a dead button. The
  happy paths (scan QR / this phone as host) and the manual `host:port` + TLS
  fields all render; only the failure is silent.
  *Fix:* surface the parse/connect error inline next to the field ("could not
  reach 127.0.0.1:1 — check the host and that the agent is running").

- [x] **BUG-125 [HIGH] [FIXED + VERIFIED on device] Refs from a FRESH snapshot are rejected as "stale ref" unless the `@` prefix is stripped — the agent's primary click/type path silently dead-ends** — `hermes-src/tools/browser_webview.py:200-207` (`_ref_js`), snapshot ref rendering
  On device, same page, same minute (session `20261011_162731_898f7c`):
  `browser_snapshot` → `[e1] text` / `[e2] submit "Search"`, then
  `browser_type({"ref":"@e1","text":"moch hermes agent"})` →
  `{"success": false, "error": "stale ref @e1 — re-snapshot"}` (twice, after two
  re-snapshots). Repeating the identical call with the bare ref
  `browser_type({"ref":"e1", …})` + `browser_click({"ref":"e2"})` → both succeed
  (the typed text landed in the visible DuckDuckGo field and the click submitted
  the form). `_ref_js` does a literal `[data-moch-ref="<ref>"]` lookup, so `@e1`
  simply never matches — the element is not stale at all, the *format* is.
  Impact: `@e1` is the convention every sibling tool (browser-use, Playwright MCP)
  trains models to emit, and the snapshot prints refs as `[e1]`, so the model's
  next guess is `@e1`. It burns turns, then abandons the ref API and does raw
  `document.querySelector(...).click()` through `browser_console` (exactly what
  the earlier successful run did).
  *Fix:* normalize the ref before lookup (`ref.strip().lstrip("@").strip("[]")`)
  in `_ref_js` and the click/type handlers, and reword the miss to
  `unknown ref <r> — snapshot refs are bare ids like e1`.

- [ ] **BUG-126 [MEDIUM] `browser_console` can answer "JavaScript evaluation is not supported by this browser backend. agent-browser CLI not found (cached)" in WebView mode** — `hermes-src/tools/browser_tool.py` (console backend check)
  Same app run, ~18 minutes apart: at 16:12 `browser_console` evaluated JS on
  google.com successfully several times (it read the result links); at 16:30 the
  identical tool on the on-device backend returned that CLI-flavoured error and
  the evaluation never ran. Nothing about the page differed (a plain https page in
  the visible tab). The message names `agent-browser`, a Node CLI that cannot
  exist on Android, so a user/agent reading it is pointed at the wrong fix.
  *Fix:* make the console path honour `MOCH_BROWSER_RELAY` unconditionally (no CLI
  probe/negative cache in WebView mode) and drop the CLI wording from this branch.

- [ ] **BUG-127 [MEDIUM] "No browser page" can appear while the relay is up and the tab is loaded — the attachment is lost across a CDP navigation and only a fresh navigate recovers it** — `hermes-src/tools/browser_supervisor.py` (per-page attach), `CdpRelay` /json/list filter
  Sequence on device: `browser_navigate` → DuckDuckGo Lite → success; type+click
  into the search form → success; minutes later `browser_snapshot` →
  `{"success": false, "error": "No browser page. Call browser_navigate first (and
  keep the Moch Browser screen open)"}` while the Browser screen was open, the tab
  was loaded and the relay answered `/json/list` normally. `browser_navigate` to
  the same URL restored the attachment immediately (next snapshot returned
  `URL: https://example.com/`).
  Caveat recorded honestly: earlier in the same run I had typed an invalid
  `http://127.0.0.1:9119/…` URL into the URL bar (a failed load), which may have
  left an extra WebView alive; the relay's documented single-target fallback can
  then pick a different target than the one the supervisor attached to. Either
  way the state is reachable and silent — exactly the "the browser is dead"
  family (BUG-104/105) this feature keeps producing.
  *Fix:* pin the supervisor's target by id for the life of the task and re-attach
  on target swap instead of depending on the relay's heuristic pick; make the
  error say which target the relay is currently offering.

- [ ] **BUG-128 [LOW] `data:` URLs are refused with the wrong reason** — `hermes-src/tools/browser_tool.py` (`_url_policy_error` → `_is_safe_url`)
  `browser_navigate("data:text/html,…")` → `{"success": false, "error": "Blocked:
  URL targets a private or internal address"}`. The guard is right to refuse the
  scheme; the message is wrong and sends the reader hunting for a DNS/SSRF
  problem. (The model handled it well — it refused to re-encode the URL to
  circumvent the guard and said so.)
  *Fix:* a scheme-specific message: "only http(s) URLs can be driven; data:,
  javascript:, file: and blobs are refused".

- [ ] **BUG-129 [MEDIUM] Settings → "Stop runtime" does nothing — the app keeps running and the gateway keeps serving, with the failure swallowed** — `app/app/(tabs)/settings.tsx:125-131` → `src/lib/mochiRuntime.ts:55-58` → `android/.../hermes/HermesBridgeModule.kt:58-65` (`HermesService.stop`)
  On device, with the runtime healthy: tapping the row (label: *"Ends the background service
  and exits the app"*) produced no dialog, no toast, no exit — same pid, app still
  foreground, `/` on `127.0.0.1:9119` still answering 200, ten seconds later.
  **Control test:** the neighbouring `Restart runtime`, tapped the same way from a
  fresh dump, exited the app immediately (pid gone, launcher focused), so the taps
  land and the exit path works — the Stop handler is the dead one. It cannot
  report anything either: `stopEmbeddedRuntime().then(...).catch(() => {})` swallows
  every rejection.
  *Fix:* make `HermesService.stop` actually tear the runtime down (and exit like
  Restart does), or relabel the row to what it really does; surface the rejection
  instead of `.catch(() => {})`.

- [x] **BUG-130 [MEDIUM, CORRECTED] The composer's accessibility subtree freezes while a turn runs — the Steer chip and the Stop button are rendered but invisible to a11y, and the EditText keeps reporting the last submitted text** — `app/(tabs)/chat.tsx:1414-1427` (Steer chip, `busy`-gated), `:1469-1478` (Stop button, `busy`-gated), composer `TextInput` a11y text
  **Correction first:** this entry was originally filed as "a running turn shows no busy state, the Stop control is unreachable". That was wrong, and the mistake is instructive: the instrument was `uiautomator`, not the screen. Re-checked with a screenshot of the composer band while a run was provably in flight (a `terminal` call to `sleep 600`; transcript timestamps 17:08:28 → 17:18:xx): the band reads **"Steer"**, and `chat.tsx:1414` renders that chip only when `busy` is true — so `busy` is tracked locally and the code path that swaps the voice slot for the **Stop** button (`chat.tsx:1469`) is live too. The UI is fine; the accessibility tree is not.

  What is actually broken, measured at those same instants:
  - `uiautomator` lists **no** `Steer mode` / `Steer mode on` node although the chip is on screen, and reports the composer slot as `Record voice` — not the `Stop` button that `busy` renders there.
  - The composer `EditText` node's `text` stays frozen at the last **submitted** prompt (`"Run exactly this with your terminal tool: sleep 600…"`) while the field itself holds later typing: a screenshot after typing shows `TESTFOCUS123 ZZTOP999` in the box, the node still shows the submitted prompt minutes later, mid-run and after.
  - The same tree updates elsewhere (transcript bubbles, `Thought · Ns`), so it is the composer subtree that goes stale.

  Impact: screen-reader users cannot reach the two busy-only controls (Stop, Steer), and any accessibility-driven automation — including the on-device harness used for this campaign — reads an "idle" composer with the wrong contents. My first BUG-130 report is exactly the false positive that produces.
  *Fix:* re-announce the composer subtree when `busy` flips (`accessibilityLiveRegion`, explicit `importantForAccessibility` on the chip, a keyed re-render or `accessibilityValue` for the input) so the new controls and the live text reach the tree.

- [ ] **BUG-131 [MEDIUM] Session list rows carry no running marker** — `hermes_cli/web_routers/sessions.py` (list rows), `app/src/lib/sessionList.ts`
  `/api/sessions` rows return `running: null` (also `active`/`busy`: null) for a session that is demonstrably mid-turn — its own detail endpoint says `last_activity_description: "receiving stream response"` at the same moment. The client can therefore never learn "this chat is working" from a list refresh (`chat.ts:1095` has a `res.running` branch no list payload can satisfy), which is the recovery path a reconnect, a chat switch or a second device needs.
  *Fix:* include the live running flag on `session.list` rows (the gateway already knows it).

  **[FIXED 2026-10-11, verified on device]** `CdpRelay.start` now binds
  `InetAddress.getByName("127.0.0.1")` (IPv4 loopback literal, both the preferred
  port and the ephemeral fallback) instead of `InetAddress.getLoopbackAddress()`.
  Rebuilt + `adb install -r` (data preserved). Device evidence after the fix, with
  no shim of any kind: `cat /proc/net/tcp6 | grep 2476` → `::ffff:127.0.0.1:9334
  LISTEN` (IPv4-mapped), `echo | toybox nc -w 2 127.0.0.1 9334` →
  **IPV4-REACHABLE**, and the agent's real calls returned
  `browser_navigate → {"success": true, "url": "https://lite.duckduckgo.com/lite/"}`
  `browser_snapshot → [e1] text / [e2] submit "Search"`
  `browser_click({"ref":"@e2"}) → {"success": true, "clicked": "e2"}`,
  with the **visible tab** following (tab strip `moch fixed at DuckDuckGo`, the
  search box holding the typed text and results rendered).

- [x] **BUG-107 [HIGH] [ROOT-CAUSED + fixed] Opening the Browser screen does not reach the tool catalog — the gate cleared only HALF the caches** The mid-session gate flip still does not reach the tool catalog — and session catalogs differ in a way that looks like tool-loading MODE, not just the browser gate** *(PR #56)*
  Post-fix rerun of TEST-1.0.15 steps 1.3/1.4:
  - **1.3 PASSES**: app restarted, Browser never opened, relay down
    (`/proc/net/tcp6` 0 sockets), fresh chat → catalog
    `["skill_view","skills_list","terminal","tool_search","tool_describe","tool_call"]` — no browser tools. BUG-105's arming fix holds.
  - **1.4 STILL FAILS**: Browser screen opened at 18:02:17 (`Moch browser gate active` in `agent.log`, 7th activation, relay socket present), fresh chat at 18:03:18 (60 s later) → catalog
    `["delegate_task","memory","skill_view","skills_list","terminal","tool_search","tool_describe","tool_call"]` — still no `browser_*`.
  - New data point: a session created at 17:51 — same app run that had just been reinstalled, gate activated at 17:49:50, **no restart in between** — carried **22** tools including all ten `browser_*` plus `delegate_task, memory, patch, read_file, …`. The three catalogs observed today (22 / 8 / 6) differ far beyond browser tools, and the small ones look like the *deferred* surface (`tool_search` / `tool_describe` / `tool_call`). So this is likely a tool-loading-mode difference per session, with the relay gate as one input — worth a focused look at how the embedded gateway picks the catalog per session (`model_tools.get_tool_definitions` + the deferred-tools path) rather than another browser-only probe.

  **ROOT CAUSE (found in source, then applied):** `moch/browser_gate.activate()` cleared only
  `tools.registry._check_fn_cache`. The tool list the model actually receives is memoized a layer
  above that in `model_tools._tool_defs_cache`, keyed by `(enabled_toolsets, disabled_toolsets,
  skip_tool_search_assembly)` — and the browser verdict is baked into the cached list. Nothing on
  the browser path ever cleared that memo (only `tools/mcp_tool_agent.py::reprobe_tool_availability()`
  does it, for the same class of problem when an MCP server appears mid-session). So any session
  whose definitions were assembled while the relay was down kept replaying the browser-less catalog
  for the rest of the process — exactly the 18:01/18:03 pair, and exactly why one app run produced a
  22-tool session and later runs produced 8- and 6-tool ones.
  *Fix applied:* `activate()` now calls `invalidate_check_fn_cache()` **and**
  `model_tools._clear_tool_defs_cache()`, both best-effort, mirroring the MCP helper. Rebuilt and
  re-verified on device (below). Note this also rules out the tool-search hypothesis: all 18
  `browser_*` names are in `toolsets._HERMES_CORE_TOOLS`, so Tool Search can never defer them.

  **Device re-verification after the fix (same APK install, same process, no restart):**
  - chat created *before* opening the Browser screen → catalog **6** tools, no `browser_*`;
  - open the Browser screen (`Moch browser gate active`, relay socket up);
  - **new chat** → catalog **21** tools, including all ten
    `browser_back, browser_click, browser_console, browser_get_images, browser_navigate,
    browser_press, browser_scroll, browser_snapshot, browser_type, browser_vision`;
  - asked that chat to *"open example.com in the visible tab"* → the agent used
    `browser_navigate` and answered **"Example Domain"**, and the Browser screen's tab strip
    reads `Example Domain` with the URL bar on `https://example.com/`.
  TEST-1.0.15 step 1.4 now passes as written: opening the Browser screen arms the tools for
  the next chat, mid-session, with no restart.

  **[FIXED 2026-10-11, verified on device]** `gateway_server._run_server` now calls
  `os.environ.setdefault("MOCH_FLEET", "1")` immediately before the flag-gated install block —
  the embedded gateway arm that `fleet.py`'s docstring had always claimed existed. (`setdefault`
  keeps an explicit operator override authoritative; the whole install remains try/except'd.)
  47/47 fleet tests green on the PC. On device, rebuilt + installed, one process, no restart:
  - `moch.fleet.status` → `{"fleetEnabled": true, "queue": {"slots": 2, "active": 0, …}}`
    (was `-32601 unknown method`);
  - `moch.kanban.tasks` → `{"tasks": []}`; `moch.runs.timeline` → real merged ledger
    (cron jobs + a delegation);
  - **Crew screen**: the raw `unknown method … run hermes update` banner is gone and the
    Run ledger lists `job 06aa786b01d6 · completed`, `delegation completed · @default`,
    `job 6d6867e4b948 · completed`;
  - **Freeze**: tap → `moch.fleet.status` flips `research-assistant: frozen False → True`, the
    button becomes `Unfreeze research-assistant`, and a chat with the frozen bot is refused with
    the alert **"bot is frozen (fleet kill switch)"**; unfreezing restores `frozen: False`;
  - **no chat regression**: an ordinary chat on the armed gate answered `GATE-OK` normally.

  **[FIXED 2026-10-11, verified on device]** Two independent causes; the second was found while
  testing the first fix on the phone.
  1. `moch.profiles.delete` only exists once the fleet runtime is installed (BUG-109) — fixed
     above; the RPC then worked when called directly (`{"deleted": "deal-watcher"}`).
  2. `app/app/bot.tsx`'s two-tap confirm could **never** fire: `doDelete()` opened with
     `if (confirmDelete < 2 || deleting) return`, but the second tap calls it from the render
     where `confirmDelete` is still `1` (React state updates are async), so the guard returned
     immediately — the button then sat on "deleting…" and nothing happened. Guard removed (the
     armed tap *is* the confirmation; only `deleting` gates now).
  Verified on the new build: Fleet → create bot → open it → `Delete this bot` → `Tap again to
  confirm deletion` → profile gone from `/api/profiles`, roster updated, app returned to Fleet.
  The user independently confirmed the delete now works on their device.

  **[FIXED 2026-10-11, verified on device]** `app/app/bot.tsx` now sends `{name: bot}` to
  `profiles.describe` and `profiles.configure` (was `{profile: bot}`), matching the contract
  `fleet.ts::profiles.create` already used. tsc clean; rebuilt + installed. Device evidence:
  - before: Job/description showed the placeholder `What is this bot for?` and the SOUL editor was
    empty for a bot whose description and generated SOUL.md both exist;
  - after: the editor loads `Research assistant: read my saved sources daily and brief me on what
    changed.` and the SOUL box shows `# research-assistant …`;
  - Save persists: edited to `Research assistant (device test edit)` → `profiles.describe {name}`
    returns exactly that, with **the SOUL still intact** (`startswith("# research-assistant")`)
    — note the pre-fix path was one tap away from writing an EMPTY soul over a real SOUL.md, so
    this was a data-loss-shaped bug, not just a broken editor;
  - original description restored through the same Save path and re-verified.

  **[FIXED 2026-10-11, verified on device]** The chat header now renders a bot chip
  (`app/(tabs)/chat.tsx`, next to the model chip) whenever `activeBotAtom` is set, i.e. whenever NEW
  chats are being scoped to a bot: accent-filled, labelled `Bot <name> is active — new chats use this
  bot. Tap to switch back to the default agent.`  Tapping it opens a plain-language explanation
  (*"New chats go to <bot> — this bot runs on its own profile: its own memory, skills and
  credentials…"*) with **Stay** / **Switch back**; `Switch back` calls `setActiveBot(null)`.

  Device evidence (fresh install, one process):
  - after `Fleet → Chat with research-assistant`, the chip is present in the header and **survives an
    app restart** (the active bot is persisted);
  - repro of the original defect, before the fix: New chat from the Chat tab →
    `research-assistant -> Exact reply CAPTURE-PROBE request` with a header that showed only the
    title — nothing said a bot was in the loop;
  - after `Switch back`: chip gone, and the next New chat →
    `default -> Reply with SWITCHED-BACK` (previously it would have landed in the bot profile).

  Deliberate remainder (design, not silence): the active bot still persists until the user switches
  back — M9.2 specifies a *persisted* active bot — but it can no longer capture chats unnoticed, and
  there is one obvious action to leave. BUG-112 (those chats then being absent from the default-profile
  drawer) is the remaining half of the visibility story.

  **[FIXED 2026-10-11, verified on device]** `src/lib/sessionList.ts::loadSessions` now merges the
  other profiles' conversations into the list (`withOtherProfiles`, bounded to 8 profiles, best-effort
  per profile, interleaved by recency so the default profile's own order is preserved) and tags every
  row with the profile it came from (`SessionRow.profile`). Because the roster is normally only primed
  by a Fleet visit, the helper primes it once via `refreshFleet()` when it is empty — without that, a
  cold start still had no other-profile names to ask for, which is precisely the restart case.
  The drawer's title mapping (`ScreenShell.tsx`) now prefixes a bot row with its profile
  (`research-assistant · <title>`) unless the title already contains the name (Fleet-created chats
  carry `Bot · <name>`).

  Device evidence (installed build, cold start, no Fleet visit):
  ```
  Open Reply with SWITCHED-BACK
  Open research-assistant · Exact reply CAPTURE-PROBE request
  Open Reply with ATTRIB-PROBE
  Open research-assistant · Reply with GATE-OK
  Open research-assistant · Reply exactly with POSTGATE-OK
  Open research-assistant · Reply exactly BASELINE-OK
  Open research-assistant · Reply exactly TOOLS-OK
  ```
  and the Chats screen lists the same merged set (`Exact reply CAPTURE-PROBE request`,
  `Reply with GATE-OK`, `Reply exactly with POSTGATE-OK`, … — present, though without the drawer's
  profile prefix; identity there still rides the title). M9.2's "its session shows in the sidebar
  under its identity" now holds across restarts. `tsc` clean.

  **[FIXED 2026-10-11, verified on device]** Root cause: on a cold share the inbox payload was
  consumed by the chat screen *before that screen owned a session*. The effect did
  `const cur = draftFor(storedId)` with `storedId === ''`, and `draftFor` returns `''` for a falsy
  key — so the shared text was written under the empty draft key, `ackShareIn()` cleared the inbox,
  and the moment the new session landed `setInput(draftFor(newStoredId))` re-read that session's own
  (empty) draft and wiped the composer. Warm shares never hit it because a session already existed
  and the draft keys matched.
  *Fix:* `app/(tabs)/chat.tsx`'s share effect now returns early while `storedId` is empty (holding the
  payload in the inbox rather than acking it) and lists `storedId` as a dependency, so the effect
  re-runs when the session exists and lands text + attachment chips in the right draft.

  Device evidence, same build:
  - cold (`am force-stop` → `ACTION_SEND text/plain "cold-share-fixed-19"`) → app boots to `New chat`
    and the composer holds **`cold-share-fixed-19`** (was: empty);
  - warm (second SEND while running) → merged into the draft alongside the first (`… cold-share-fixed-19
    warm-share-19`, confirmed by screenshot OCR — the a11y node was stale again per BUG-130).
  `tsc` clean.

  **[FIXED 2026-10-11, verified on device]** Two missing wires, both added:
  (1) `app/_layout.tsx` now calls `loadLocale()` at boot — nothing ever invoked it, so even a stored
  preference was ignored; (2) Settings → APPEARANCE has a **Language** row (`app/(tabs)/settings.tsx`)
  bound to `localeAtom`, offering English / العربية through the app's own confirm sheet, with the
  current choice in the subtitle. `tsc` clean.

  Device evidence (installed build):
  - row before the change: absent; the catalog had zero callers (`grep` found only the definitions);
  - pick العربية → the **Fleet screen switches immediately**: title `الأسطول`, button
    `تحديث الأسطول`, runtime line `وقت التشغيل · 0/2 مهام`, and the Settings row reads
    `العربية — fleet screens are right-to-left`;
  - **persists across a restart** (`force-stop` + relaunch → still `الأسطول`), i.e. the boot
    `loadLocale()` works;
  - pick English again → back to `Fleet` / `Refresh fleet` (the app is left in English, as found).
  Scope note kept honest: only the M9.2 fleet surfaces are catalogued (per `strings.ts`), which the
  sheet says out loud — the rest of the app is still English and retrofitting it remains a later pass.

  **[SERVER HALF FIXED 2026-10-11, verified on device]** `hermes_state_search.py::search_messages`
  returned `[]` for EVERY query when the interpreter has no `fts5` module (the Android embedded
  runtime: "no such module: fts5") — and it did so *before* reaching the LIKE fallback that sits
  immediately above for the stale-index case. Same fallback, same finalisation, now also on the
  no-FTS path. Rebuilt + installed; device probe (was `{"results":[]}` for everything):

  ```
  GET /api/sessions/search?q=reachable%20from%20my%20side → 1 result, real snippet
  q=relay → 1   q=GATE → 3   q=SWITCHED → 1
  ```

  Known nit in the same path: a hyphenated query misses (`q=GATE-OK` → 0) — the FTS5 query
  sanitizer treats `-` specially and the LIKE path inherits the mangled terms. Worth a follow-up.

  **Still open (client half):** nothing in the app calls session search at all — `grep` for
  `sessions/search`/`session.search` over `src/` and `app/` returns nothing; the drawer
  (`Sidebar.tsx:430`) and the Chats screen both filter the *already-loaded rows* client-side, so
  only titles can ever match. Making content search user-visible needs the search box wired to the
  (now working) server search — the HTTP surface is `/api/sessions/search?q=…&limit=…` and the
  gateway RPC equivalent (`search_router`) is what the RN client should call — with results rendered
  as a grouped section (title + snippet) that opens the session on tap.

  **[CLIENT HALF FIXED 2026-10-11, verified on device]** `app/(tabs)/sessions.tsx` now queries the
  server as you type (300 ms debounce, `apiFetch('/api/sessions/search?q=…&limit=12')`, best-effort)
  and merges the hits into the visible list — mapped through `session_id`/`title`/`started_at`/`profile`
  onto the existing `SessionRow` shape, deduped, after the title matches (a title hit is the stronger
  signal). The local title filter still runs, so nothing regresses when the search RPC is unreachable.

  Device evidence (installed build, Chats screen search box):
  - `reachable from my side` — a phrase that appears in **no title** — lists
    **`List available tools #2`** (was `No matches`);
  - `zzqqxx-no-such-thing` still shows `No matches` (no false positives);
  - `tsc` clean.

  Small polish left (not a defect): the matched row renders its usual meta line
  (`0 msgs · started 6h ago`) rather than the returned `snippet`, because the row only falls back to
  `preview` when the title is empty. Showing "why it matched" under the title is a follow-up.
  Also still open in this area: the hyphen nit above (`q=GATE-OK` → 0).

  **[FIXED 2026-10-11, verified on device]** Root cause: `mcp_catalog._catalog_root()` calls
  `get_optional_mcps_dir(<source-checkout>/optional-mcps)`, and `hermes_constants._packaged_dir`
  only falls back to `<HERMES_HOME>/optional-mcps` when NO default is passed — so the non-existent
  checkout path won, `list_catalog()` always answered `[]`, and Connectors → Browse showed
  "Catalog is empty" no matter what. Fix (no vendored change): `moch/hermes_boot._prepare_home` now
  creates `<HERMES_HOME>/optional-mcps` and sets the documented override
  `HERMES_OPTIONAL_MCPS` to it, so the catalog is resolved from the app's own home.

  Device proof of the whole chain (installed build): dropped a valid `manifest_version: 1` entry at
  `<home>/optional-mcps/filesystem/manifest.yaml` (`@modelcontextprotocol/server-filesystem`, stdio)
  and confirmed, in order:
  1. `GET /api/mcp/catalog` → `entries: 1`, name `filesystem`, `installed: false`, no diagnostics;
  2. **Connectors → Browse renders it** with an `Install filesystem` action.
  Fixture removed afterwards → the API returns `entries: []` again, i.e. the app is left as found.

  Two honest remainders, both recorded rather than glossed:
  - **No curated manifests ship** — that is a *content* decision (which third-party servers to
    endorse), not a code one; the plumbing now makes it a drop-in, and the empty state can honestly
    say so.
  - The client caches the catalog per app session: after deleting the fixture the Browse tab still
    listed `filesystem`, and a leave/return did **not** refresh it (a restart is needed). Worth a
    re-fetch on tab focus so the list cannot outlive the files behind it.

## Tree verification (round 24, phone in use — no device run)

Full `python-runtime` suite **109 tests OK** (4 skipped), app `tsc` clean, `eslint` 0 errors across
the seven touched app files (2 pre-existing `_layout.tsx` warnings on untouched lines). Diff review:
17 files, +901/−34, every hunk accounted for above; the only `build.gradle` change is the shipped
version bump `1.0.14-bots` → `1.0.15-browser` (code 18). Nothing unintended is staged for the
user's review, and the MCP-catalog fixture used in BUG-118 was removed from the device.

### BUG-114 now has a regression test (round 25, device-free)

`app/python-runtime/tests/test_search_no_fts.py` — 4 tests over a real `SessionDB` in a temp dir,
forcing `_fts_enabled = False` / `_fts_stale = False` to stand in for the Android interpreter (the
one with no `fts5` module) and asserting that body text is still found:

- `test_content_is_found_without_fts` — the BUG-114 case, a body-only phrase;
- `test_multiple_words_from_the_body_are_found` — a phrase from a second message;
- `test_a_real_miss_stays_empty` — no false positives;
- `test_indexed_path_agrees_when_fts5_is_available` — the normal indexed route (skips where the
  interpreter has no fts5).

**Proved to be a real guard, not a tautology:** with the fix reverted in place (branch reduced to
`return []`), the two content tests **FAIL** and the miss/indexed tests still pass — then restored
(+8/−1, same diff as recorded) and 4/4 pass again. A guarded `httpx` stub keeps the test runnable on
an interpreter that lacks that optional dep (the device bundles it); nothing is stubbed when the real
module is present.

Whole-suite state: **113 tests OK** (4 skipped) across `app/python-runtime/tests`.

Round 25 device smoke (installed build): chat → *"Run this in your terminal and reply with only the
output: echo SMOKE-R25"* → the agent ran it and answered `SMOKE-R25`. Terminal path healthy.

### BUG-130 re-diagnosed (round 26, device-verified single-dump evidence)

Earlier rounds argued about whether the composer's a11y subtree "freezes". It does not — the real
state is simpler and worse: **during an active turn the composer renders its IDLE state**, so Steer
and Stop are not merely missing from the accessibility tree, they are not rendered at all.

Evidence (installed build, one `uiautomator dump` 4 s after sending
*"Count slowly from 1 to 60 in your thinking, then reply only DONE-R26"*, 20:15:40):

```
transcript (busy, live)   Expand thinking / TextView "Thought · 3s"
composer (same dump)      EditText "Ask Mochi…"          ← the IDLE placeholder
                          Add attachment / Record voice / Send message
                          (no Steer chip, no Stop button — in the tree or on screen)
```

A screenshot of the same moment agrees with the tree (composer row = `+ Ask Mochi... ( )`), so this
is not an instrumentation artifact this time: both channels show the idle composer while the turn is
running. Consequence: **there is no way to stop or steer a running turn from the phone** — the
affordances the M6 "steer/stop" acceptance depends on are unreachable in this state. (An earlier
round did see a `Steer` chip and a working Stop, so this is either a regression or state-specific;
either way it is broken now.)

Next: find why `agentBusy` is not driving the composer during a run (`chat.ts` sets it on send and
derives it from `res.running`; the composer's busy gates are at `app/(tabs)/chat.tsx` ~1414-1478) —
and make Steer/Stop survive whatever path clears it. This supersedes the "a11y tree freezes" framing
recorded earlier in this entry.

### BUG-130 root-cause narrowing (round 27, source)

Both affordances are `{busy ? …}` gated — the **Steer chip** at `app/(tabs)/chat.tsx:1451` and the
**Stop button** at `:1500` (label `Stop`, action `stopRun()`), and the busy placeholder
("Reply — queued until it finishes") with them. So one state explains the whole symptom:
`agentBusy` is false during the run.

`agentBusy = computed(view, s => s.busy)` (`chat.ts:201`), `busy` lives in `SessionState`, and the
writers are:

| line | write | when |
|---|---|---|
| `chat.ts:1820` | `busy: true` | the send path — the ONLY place a run is marked live |
| `chat.ts:1095` | `busy: res.running ?? prev.busy` | resume payload (BUG-084) — on entry, not a suspect |
| `chat.ts:1877/1888` | `busy: false` | send FAILED |
| `chat.ts:1932` | `busy: false` | explicit stop |
| `chat.ts:2347` | `busy:false, detached:true` | event `session.reclaimed` |
| `chat.ts:2577` | `busy: false` | event `background.complete` |
| **`chat.ts:2592-2596`** | **`busy: false` on `status.update {busy:false}`** | any gateway heartbeat that says "not busy" |

**Prime suspect: `status.update`.** The handler clears busy purely on the event payload
(`if (p.busy === false) { … patchSession(eSid, { busy: false }) … }`), with no cross-check against a
turn the client knows it just started. Device evidence fits exactly: `busy` was already false 4 s
after send (see the round-26 dump with live `Thought · 3s`), which is when such a heartbeat would
land. `background.complete` would clear it too if it fires for the auto-backgrounded terminal command
in that turn.

Deliberately NOT fixed blind: a wrong guard here leaves a **stuck** Stop button / busy composer — worse
than the current defect. Next round's experiment (one device session, decision-useful): start a slow
turn and capture which of `status.update` / `background.complete` / `session.reclaimed` arrives
within the first 5 s (log the events, or diff them in `agent.log` / the app's event stream), then
either (a) ignore `status.update {busy:false}` while a send is in flight for that session
(`sendingSessions`), or (b) trust only a terminal run event / explicit stop to clear busy — whichever
the evidence supports.

### BUG-130 experiment result (round 28) — `status.update` is the culprit by elimination

Controlled run on the installed build: sent *"Run 'sleep 30 && echo R28' …"* at **20:16:57**; the
turn was live (`Thought` nodes present) and the app log shows it ending at **20:17:39** — a 42-second
turn. At ~14 s in, in the middle of that run, the composer was **idle** (`EditText "Ask Mochi…"`, no
Steer, no Stop).

Then the elimination: the two *logged* writers never fired — the log from 20:16:57 to 20:17:39 has
**zero** `background complete` and zero `session reclaimed` lines (52 log lines scanned, 0 matches on
`background complete` / `session reclaimed` / `busy` / `queue`), and the send clearly succeeded (so
`chat.ts:1877/1888` is out). That leaves the one silent writer:

```ts
case 'status.update': {
  if (p.busy === false) {          // payload alone — no corroboration
    flushStreams()
    patchSession(eSid, { busy: false })
    maybeFlushQueue(eSid)
  }
```
`chat.ts:2592-2596`. A gateway heartbeat reporting the *session* not busy lands within the first
seconds of the turn and switches the composer back to idle, which is exactly when Steer/Stop
disappear.

**Fix approach for the next round (deliberately not blind):** on `status.update {busy:false}`, do not
clear a busy state the client itself started in the last few seconds — either (a) require
corroboration from the session's real running state before clearing, or (b) defer ~1–2 s and clear
only if no stream/tool activity arrived in between. Guarding unconditionally would risk a *stuck*
Stop button, which is worse than today's defect, so the guard must be event-pair-aware: a real finish
must still clear promptly.

### BUG-130 round 29 — the `status.update` fix was implemented, device-tested, and REVERTED (negative result)

Wrote the corroborating guard (`busyActivityAt` + a deferred, never-dropped clear in the
`status.update` handler: while a turn was proven active within the last 4 s — send, `message.delta`,
`tool.start` — the heartbeat's clear is rescheduled instead of applied). `tsc`/eslint clean, rebuilt,
installed. **It did not change the symptom**, and the follow-up sampling is what makes this round
useful:

| sample (installed guard build) | composer |
|---|---|
| +2 s into a 40 s turn | `EditText "Ask Mochi…"` — idle (no Steer/Stop/busy placeholder) |
| +10 s, established session (previous turn had ended) | idle |
| +11 s, fresh session created by that send (turn 20:23:25→20:24:16, 51 s per the log) | idle |

Because the guard would have *deferred* any `status.update {busy:false}` for 4 s, an idle composer at
**+2 s** falsifies the round-28 conclusion: **`status.update` is not the clearing path.**

New leading hypothesis: **`busy: true` never reaches the entry the composer reads.** The composer
subscribes to `agentBusy = computed(view, s => s.busy)` where `view` follows `[sessionsById,
activeSession]` — the ACTIVE session entry — while the send path patches `sessionsById[sid]` with the
key it holds at send time. If those two key spaces diverge in this flow (stored id vs live id, or the
fresh-`New chat` placeholder vs the entry created a moment later), the optimistic `busy: true` lands
on an entry nothing renders and the composer stays idle for the whole run. That fits every
observation, including why an earlier round *did* see Steer/Stop (a flow where the keys agreed).

Reverted the guard: it changed the timing of a real clear (up to +4 s on a genuine finish) with no
verified benefit, and leaving an unproven behaviour change in the tree is worse than a clean negative
result. Next step is to instrument the key spaces, not the events: log `sid` at the send patch and
`activeSession`/`view.id` at the composer, and compare on the phone.

### BUG-130 round 30 — closed list of `busy:false` writers, and the contract fact that reframes it

Every site that clears busy, with its handler (auto-extracted):

| line | handler | ruled in/out |
|---|---|---|
| 148 | initial state | — |
| 1877 / 1888 | send FAILED | out — the send succeeded |
| 1932 | explicit stop | out — nothing was stopped |
| 2347 | `session.reclaimed` | out — no such line in the app log during the run |
| **2493** | **`message.complete`** | **new prime suspect** — clears busy AND marks every running tool `done`, unconditionally |
| 2577 | `background.complete` | out — no such line in the app log |
| 2595 | `status.update` | falsified by the round-29 +2 s sample (the guard would have deferred it) |
| 2624 | `error` | out — the turn completed normally |

Verified in source this round: the send patch itself is unconditional and correct —
`const s = sessionsById.get()[sid]; if (s) patchSession(sid, { messages: […], tools: [], busy: true })`
(`chat.ts:1806-1821`), so a *set* failure would require `s` to be missing at that instant (possible but
it would also have dropped the optimistic user row, which was visible on screen).

Why `message.complete` is the best remaining fit: `tui_gateway/contracts/events.py:190` documents it as
*"The turn ended: final text, usage and outcome"*, and the client acts on that reading — but the
gateway **emits it from four places**, only one of which is the parent turn's end
(`prompt_turn.py:985`); the others are the **subagent mirror** (`agent_callbacks.py:77`, `{"text": summary}`
— a child's message surfaced in the parent stream), the turn-error path
(`session_auto_continue._emit_terminal_turn_error`) and the compute-host bridge
(`compute_host_bridge.py:240`). Any of those arriving mid-turn makes the app clear `busy` and freeze
its tool list, which is exactly the observed state (composer idle 2 s into a 45-50 s turn, Steer/Stop
gone, tool chip still showing `terminal`).

**Next step (narrow, no guessing):** log the raw `message.complete` payloads for one slow turn on the
phone and see which emitter is firing mid-turn — the tell is a payload with `text` and no `usage`/
`status` (the mirror shape) versus a full `_complete_turn_payload`. Then gate the clear: only a
parent-turn completion (usage/status present, or the session no longer running) may clear `busy` and
finalize tools; a mirror/error emission must not.

### BUG-130 round 31 — CORRECTION: the round-28 "elimination by log" was unsound

`src/lib/log.ts::log()` writes **only** to an in-memory ring buffer (`diagLog`, capped, rendered by
Settings → "Copy diagnostics"); `console.log` output is `__DEV__`-only and a release build emits none.
So **no client-side `log('info','chat', …)` line can ever appear in `agent.log`** — which means round
28's argument ("no `background complete` / `session reclaimed` lines in agent.log, therefore those
handlers did not fire") was reasoning about an empty channel. **That elimination is retracted**, and
with it the certainty that `status.update` was the culprit (round 29's +2 s falsification of
`status.update` still stands, since it was a behavioural test, not a log).

What survives, on code-reading grounds only:

- the send path sets `busy: true` unconditionally (`chat.ts:1806-1821`);
- `message.complete` (`:2437`, clearing at `:2493`) clears busy **and** finalizes every running tool,
  and the gateway emits that event from four sites — the true turn end (`prompt_turn.py:985`) plus the
  subagent mirror (`agent_callbacks.py:77`, text-only payload) and two error paths;
- every other `busy:false` writer needs a cause that did not occur (send failure, explicit stop,
  session reclaim, background completion, turn error).
So `message.complete` remains the best fit, but it is no longer *proven* by exclusion.

Also established this round: **the gateway does not stream turn events to a second client.**
`.devtest/eventwatch.py` (new: zero-dep WS watcher that submits a prompt and prints every notification
with its payload keys) received **zero notifications in 20 s** on its own socket, so the capture must
happen inside the app. A temporary diagnostic was added to the client's `message.complete` handler
(payload keys, `status`, `usage` presence, text length, `busyBefore`) and ships in the installed build;
the symptom is unchanged on it (0 Steer/Stop nodes 14 s into a 45 s turn), and the diagnostic text is
readable via Settings → Copy diagnostics (clipboard) rather than from `agent.log`.

**Next round (cheap, decisive):** surface `diagLog` where a dump can read it (paste the clipboard into
the composer, or render the ring on the Diagnostics row), capture the `message.complete:` lines for one
slow turn, and pin the emitter — a mirror payload is `{text}` with no `usage`/`status`.

## Wave 9 — PR map (2026-10-11)

Base for all three: **`m9/integration`** (the M9 fleet/bots stack was unpushed local work; pushed as a
branch so these diffs stay small and reviewable — nothing was pushed to `main`).

| PR | contents | device verification |
|---|---|---|
| **#56** `fix/browser-relay-refs-gate` | BUG-104, BUG-105, BUG-106, BUG-107, BUG-125 + BUG-118 (same file as the boot gate) | relay reachable over IPv4; navigate/snapshot/type/click all succeed and drive the **visible tab**; restart → gate correctly off; open Browser → new chat has the tools, no restart |
| **#57** `fix/mobile-bots-share-search-i18n` | BUG-108, BUG-110 (client half), BUG-111, BUG-112, BUG-113, BUG-114 (client), BUG-116 | bot detail loads + saves with SOUL intact; delete works end to end; bot chip visible and reversible; bot rows back after a restart; cold share lands; body-only search finds its conversation; AR/EN switch works and persists |
| **#58** `fix/runtime-fleet-linux-search` | BUG-109, BUG-123, BUG-114 (server) | fleet RPCs answer, Crew has real data, Freeze/Unfreeze + kill switch work; Linux reset → reinstall → guest back; search returns real snippets (was `[]` for everything) |

**Still open, in priority order** (repros in the entries above): **BUG-130** (no Stop/Steer during a run
— writers narrowed to `message.complete`; the capture instrument and the two falsified hypotheses are
recorded in its entry), BUG-086, BUG-115, BUG-117, BUG-126, BUG-127, BUG-129, BUG-131, BUG-120, BUG-121,
BUG-036, BUG-074, BUG-119, BUG-122, BUG-124, BUG-128, and the three PR-fixed items awaiting an on-device
confirmation in the user's next dev build (BUG-101, BUG-102, BUG-103).

Needs a human or a second machine: voice **audio** content, and real second-machine pairing.

---

## BUG-132 [HIGH] (NEW, WIP) Browser tools are not always available — the agent boots the relay but a cold-start race still hides the tools

**Requested behaviour:** the browser is an always-on toolset like the terminal — the agent never
improvises with curl, and the relay/browser engine stay alive for the whole app process (chat deletes
are irrelevant; only closing the app ends it).

**Built and working (verified on device):** `AgentBrowserHost` (`app/src/components/AgentBrowserHost.tsx`,
mounted in `_layout.tsx`'s main return) — an app-owned offscreen "agent tab" (2×2 WebView) that calls
`ensureBrowserRelay()` for the whole process lifetime. On a fresh boot with the Browser screen **never
opened**, the relay now comes up by itself (socket 9334 LISTEN; `relay.json` carries the live pid).
The host's first attempt mounted inside `_layout`'s `!cfg` early-return and silently unmounted once the
config loaded — fixed by moving it into the main (connected) return.

**Still broken (the actual symptom):** a new chat's turn right after a fresh boot still found **no
browser tools** and improvised with the terminal (agent.log for session 20261011_224734: `tool_search`
→ `Tool terminal returned error` → more terminal calls; zero `browser_*`).

**Root cause of the remaining gap — a cold-start race with TWO arming paths that can both miss:**
1. JS host mounts early (~cfg load) → `ensureRunning` starts the relay ✓ → then the native module calls
   `moch.browser_gate.activate` — but Python is **not booted yet** at that point, so the call throws and
   `ensureRunning`'s promise REJECTS (the module's try/catch wraps the Python call). `ensureBrowserRelay`
   catches, reports `running:false`, and the host **never retries** — the gate never arms from this path.
2. Python boots later and `hermes_boot`'s pid-gated arming reads `relay.json` — but if the relay started
   *after* Python read the file, the pid is stale and it does not arm either.

**Fix shape (next session):** make the native `ensureRunning` retry the `browser_gate.activate` call
(e.g. 5 attempts / 3 s apart, in its existing background thread) until Python acknowledges — the relay is
already up by then, so retries are cheap — OR re-check `relay.json` at the END of the Python boot instead
of only during it. Also investigate a new regression: `session.list` rows now report `tool_names` empty
for ALL sessions, including ones that previously carried populated catalogs — catalog checks made via
`session.list` are unreliable until that is understood.

**Installed state:** the phone runs a build with `AgentBrowserHost` (harmless: one offscreen 2×2
WebView + a relay that boots with the app). The component + its `_layout` mount line are in the working
tree, deliberately **not** in any PR until the feature actually works end to end.

### BUG-132 round 32 — the remaining gap is a BOOT-TIMING race, instrumented

On-device acceptance after the cache-key fix: relay auto-starts at boot ✓ (socket up, Browser
screen never opened), but the acceptance turn **still improvised with curl** (`tool_search` →
terminal; no `browser_*`), answering correctly only because curl worked. Probes: `config.yaml` on
device is EMPTY (so toolset defaults apply — not the stripper); logcat showed no arm line, meaning
the native retry loop had already exhausted: **10×3 s = 30 s < this cold boot's time-to-Python**
(first boot after an install is the slow case — exactly the user's scenario).

Fix applied (build in progress, unverified on device yet): the native arm loop now polls
`Python.isStarted()` every **1 s for up to 120 s**, arming the moment Python exists, and logs
`armed/ticks/pid` so the next failure is self-diagnosing. Together with the cache-key fix (stale
catalogs are unreachable once the gate flips) this closes the race without ordering assumptions:
whichever of {native retry, gateway pre-serve re-arm} lands first arms the gate, and no pre-arm
catalog survives the flip.

---

## BUG-133 [HIGH] (NEW, WIP) Keyboard opens over inputs app-wide — the input and everything at the bottom must rise ABOVE the keyboard

User report (2026-10-12): "find all inputs/anything that will open the keyboard, and make sure when
the keyboard opens the input (and everything in bottom) will go above the keyboard and not stay with it."
Intake: app-wide keyboard-avoidance audit — enumerate EVERY keyboard-opening surface (TextInput,
autoFocus, WebView focus, sheets with inputs) and the avoidance each one has today; fix so the focused
input and everything below it lift above the keyboard on every screen. Verification wave: 5 read-only
subagents on disjoint scopes (chat composer / forms+onboarding / tab screens+shell / sheets+modals /
platform wiring+terminal+webview+native RNKC sources). Build in worktree `worktrees/keyboard-avoidance`
from origin/main.

### BUG-132 round 33 — DECISIVE NEGATIVE: the tools are absent from the callable kit itself

Full fix package installed and verified live (native relay start in MainApplication.onCreate:
socket up at boot, `armed=true ticks=1 pid=<live>`; check_fn scope partition; live-session refresh;
Fragment hoist; 118 tests OK; build 02:45). Acceptance still fails:

- turn: "Use your browser tools to open example.com…" → `tool_search` + `terminal` (curl), no browser_*.
- DECISIVE PROBE: *"Call the tool named browser_navigate with url https://example.com — if that
  tool does not exist in your toolset, reply exactly NO-SUCH-TOOL."* → the agent answered
  **"No browser tool in my kit, but I can grab it with a fetch instead."**

That eliminates the arm/env/cache/check_fn/live-refresh layers entirely — the model's CALLABLE SET
lacks browser_* even when named explicitly. The remaining suspects, for the next session:

1. **Toolset selection on device**: `_load_enabled_toolsets(platform)` → `_get_platform_tools(cfg, "cli")`
   with the on-device config.yaml being EMPTY (verified) — does the empty-config path really yield the
   hermes-cli composite including `browser`, or does it fall back to a minimal set? The static analysis
   said composite, but it was never verified against an empty config on device.
2. **The APK's baked toolsets.py** vs the tree: does the baked copy's `_HERMES_CORE_TOOLS` contain the
   browser names? (An earlier check said byte-identical — re-verify against the 02:45 APK.)
3. **Instrument the truth**: one log line of the resolved tool names at agent build (agent_init._load_tools,
   even in quiet_mode) would have made every round of this diagnosable from agent.log alone; add it first.

Also requested by the user (new feature, not yet started): browser tab management tools —
navigate BETWEEN tabs, create/delete/manage multiple tabs (the Browser screen already has a tab
strip; needs browser_tab_* tools + relay support for target selection).

### BUG-132 round 34 — THE REFRAME: it was never browser-specific

Asked directly (*"List your exact tool names, one per line"*), the agent's complete kit on the
current build (all four fixes installed, armed=true, env set) is EXACTLY:

    skill_view, skills_list, terminal, tool_search, tool_describe, tool_call

Six tools — the deferred/bridge base. No browser_*, and also no file tools (read_file/patch), no
memory, no delegate_task: the ENTIRE extended toolset is absent from these sessions. The browser is
simply the most visible casualty. This matches every historical 6/8-tool catalog observation and
explains why every arm/cache/refresh fix changed nothing: the selection never included the rich
toolsets to begin with.

What differs in the rare 21/22-tool sessions (round 14, 17:51; round 4, 15:02)? Those are the
outliers to explain, not the baseline. Suspects for the selection difference, in order:

1. `_load_enabled_toolsets(platform)` / `_get_platform_tools(cfg, "cli")` with the on-device EMPTY
   config.yaml vs a populated one — the empty-config path may yield a minimal set, not the
   hermes-cli composite the static analysis assumed. NEXT STEP: run that exact call on the PC with
   an empty config and print the result; then log the resolved enabled_toolsets at agent build.
2. The tool_search bridge masking: with this kit, tool_search CANNOT surface core tools by design,
   so "search then curl" is the model's rational fallback (amplifier, not cause).
3. Compare a 6-tool session's creation context vs a 21-tool one (profile? config write in between?
   registry generation?) — the one variable that flipped.

USER FEATURE REQUEST (queued, not started): browser tab management tools — create/delete/switch/
list tabs (the Browser screen has a tab strip; needs browser_tab_* tools + relay multi-target).

### BUG-132 round 35 — composite fix landed; kit grew; browser still absent WITHOUT any check_fn evaluation

**Fix applied this round** (toolsets.py): registered the missing `hermes-mobile` composite
(mirroring hermes-cli, the hermes-cron precedent). Verified on PC: `_get_platform_tools(cfg,
"mobile")` now returns the full 18-toolset list (browser/file/memory/delegation/...) instead of the
bare `['hermes-mobile']` name. 118 tests OK; build succeeded; installed on device.

**Device result:** the agent's kit GREW (was 6: skill_view/skills_list/terminal+bridge; now also
cronjob_manage, todo_list, desktop_project) — the composite is provably live in the APK. But the
acceptance turn STILL answered "Example Domain — though no browser tools are available in this
session" (fetched via curl; turn used tool_search + terminal), and the kit listing shows no
browser/file/memory.

**The remaining mystery, precisely:** browser/file/memory tools are absent from the resolved kit
while the agent.log shows ZERO `check_fn ... returned False/raised` lines for them this boot —
i.e. their check_fns are never evaluated, so the filtering happens UPSTREAM of check_fn, inside
toolset→tool resolution (registry.get_definitions / toolset member expansion), or the model's own
listing is lossy (verify with the instrument below before trusting it).

**Successor's first move (the instrument that was never added):** one `logger.info` in
`agent/agent_init.py::_load_tools` printing the resolved tool names (the "Final tool selection"
print is suppressed by quiet_mode on the embedded build). One device turn then makes the kit
readable from agent.log, separating "tools genuinely absent" from "model lists them lossily".
Then bisect upstream: whether `enabled_toolsets` reaching _make_agent contains browser, and
whether registry.get_definitions drops the browser toolset members without logging.

**Verified this round (keep):** platform 'mobile' expands via the composite (PC);
desktop_project/todo_list/cronjob_manage appearing = _gui_surface_toolsets + composite both live;
relay native-start + armed=true ticks=1 still hold; suite green; PR #61 carries everything.

### BUG-132 RESOLVED (round 36) — the agent uses browser_navigate on a cold boot

Root causes, final list: (1) the missing `hermes-mobile` composite collapsed toolset selection to
{skills, terminal}; (2) a BOOT WARM-UP window — device-measured with the new kit instrument:
6 tools at T+60s vs 21 (all ten browser_*) at T+5min on the SAME build — the tool registry matures
minutes after boot, and sessions built in the window snapshot the cold kit.

Fix (this round): scheduled warm-up re-arms in gateway_server — timers at 45/150/420 s re-run
browser_gate.activate (pid-gated via relay.json), which clears both caches AND walks live sessions
with refresh_agent_mcp_tools (append-only). An early chat is healed IN PLACE.

VERIFIED ON DEVICE: fresh boot → chat created at T+64s curled ("no browser tools"); at T+105s the
log shows `gate live-refresh: 1 session(s)`; the SAME chat's next turn used **browser_navigate** and
answered "Example Domain". Kit instrument retained (logger.info in agent_init._load_tools) — the
one line that made this diagnosable.

Residual (cosmetic): the first ~1-2 min after boot still build cold kits (healed within ~90 s by the
re-arm). A true pre-warm (loop the catalog build at boot until browser_* resolve) would close even
that — queued as polish. Scope-partition experiment reverted with evidence (non-None scope broke
check_fn evaluation; the env-in-key + TTL + activate clears bound the original poison window).

### BUG-132 round 37 — the warm-up is now USER-VISIBLE and self-healing (done)

The user's ask: never look broken, and have MOCHI say it. Two additions in gateway_server:

1. **Pre-warm loop** (`moch-browser-prewarm` thread): polls every 15 s (memo cleared each pass —
   the probes themselves drive the lazy installs that ARE the warm-up), and on first readiness runs
   the full activate (cache clears + live-session refresh). Replaces the fixed 45/150/420 s timers —
   healing now happens at the earliest physically possible moment instead of a scheduled tick.
2. **Warming note**: while armed-but-not-ready, prompt.submit gets a bracketed system note (the
   established out-of-band pattern; upstream captured BEFORE replacement — the first attempt
   recursed into itself and produced "Send failed / internal error", fixed and re-verified).

DEVICE-VERIFIED, same chat, one boot:
  T+0:49 cold  → "The in-app browser is still warming up — it should be ready in a minute or two. Send the request again…"
  T+4:41 warm  → "The browser's up. Title: Example Domain." (log: browser_navigate completed 0.81s)

The fixed 45/150/420 timers were removed in favor of the loop; stale scope-partition test removed
with the revert. 117 tests OK.

### BUG-132 round 38 — AUTO-CONTINUE: the warm-up finishes the user's task by itself

The warming-note wrapper now records the session that asked during the window; the pre-warm loop,
on first readiness, submits ONE short continuation per waiting session through the normal queue:
"[SYSTEM: The in-app browser is now ready. Carry out the user's earlier browser request now.]"
The original request is already in the agent's context, so the extra cost is a single cheap turn —
token-frugal by construction, queue-safe if a turn is running, and one-shot per session.

DEVICE-VERIFIED, no user resend: cold ask at T+49s → warming message; at warm the chat continued
BY ITSELF → "Page title: Example Domain — loaded successfully from https://example.com."

Kit note (user question): the WARM kit is 22 tools incl. read_file/write_file/patch/search_files/
memory/vision_analyze — the warm-up fix recovered the whole family, not just browser. Still absent
vs PC: web_search/web_extract (need a configured search backend; on-device config.yaml is empty)
and delegate_task (needs nemo_relay, not in the APK). In flight: tab-management tools + a
lazy-deps bundling recommendation (GLM subagents).

### BUG-132 round 39 — Tier A bundled; the doomed pip churn is gone

Per the GLM bundling investigation: the ONLY check-time lazy install was tts.edge (edge-tts), whose
aiohttp dep is compiled with no Android PyPI wheel — the runtime install could NEVER succeed, so
every catalog rebuild retried a doomed pip subprocess each boot. Tier A applied to build.gradle
(+~1.2MB): edge-tts==7.2.7 + aiohttp==3.10.10 + Pillow==11.0.0 from Chaquopy's prebuilt repo
(--extra-index-url chaquo.com/pypi-13.1; BUILD SUCCESSFUL — wheel resolution verified).
Plus: HERMES_DISABLE_LAZY_INSTALLS=1 in hermes_boot (unbundled features fail fast, no pip spawns)
and a boot-time import pre-warm thread (edge_tts/PIL/aiohttp) paying first-import at boot.

DEVICE-VERIFIED (bundled build): cold ask at T+50s → auto-continue → "The page title is
'Example Domain'." — full cycle, no resend.

Deferred (documented, not shipped): Tier B anydoc wheel (+3.4MB, unlocks doc extraction — note
read_file's schema CLAIMS anydoc is bundled but it never was: drift), Tier C ddgs/lxml/primp
(+4-5MB, lights web_search/web_extract — or configure a search API key instead).

## BUG-134 [HIGH] Terminal ≠ agent environment — gh auth done in the terminal is invisible to the agent
User report (2026-10-12): "the terminal is not the same as the terminal that the agent do commands on, for
example i installed gh cli and i authed with my account in the terminal, and i told the agent to check if
i am authed or not, it said no not authed!"
Intake: the user's Terminal screen (persistent `bash -i` via `moch/terminal.py`) and the agent's one-shot
`exec_in_guest` are supposed to share ONE Moch Linux guest — same rootfs, same HOME, same PATH-relevant
env. Something diverges (HOME, PATH, env sanitization, GH_* override, separate proot launch env) so state
written from the terminal (gh auth → `~/.config/gh/hosts.yml`) is not what the agent's exec sees.
Verification wave pending (read-only, scope: `app/python-runtime/moch/{terminal.py,linux_env.py,
linux_session.py}`, `HermesRuntime.kt`/`HermesBridgeModule.kt` exec paths, hermes-src exec tool).

**Verified (read-only adversarial agent, 2026-10-12): CONFIRM, worse than reported — the intake's
"same HOME" assumption is FALSE.** Same proot rootfs, DIFFERENT $HOME: the Terminal's bash gets
HOME=/root (terminal.py:159-161 sets it explicitly); the agent's guest shells inherit the Chaquopy
process HOME=/data/user/0/<pkg>/files — a path that does NOT exist inside the guest rootfs (only
workspace/scratch/dev/proc are bound). Terminal gh auth writes guest /root/.config/gh/hosts.yml; the
agent's `gh auth status` reads /data/…/files/.config/gh/hosts.yml → ENOENT → "not logged in"
(truthful). Chain: agent tool → environments/local.py:907-928 `_run_bash` → PATH-shim bash
(hermes_boot.py:105-107) → HERMES_EXEC_TRAMPOLINE /system/bin/sh → _shim_body (linux_env.py:220-242,
exports ONLY LD_LIBRARY_PATH/PROOT_LOADER/PROOT_TMP_DIR — never HOME/PATH) → `apply_subprocess_home_env`
no-ops on Android host (hermes_constants.py:936-971). EVERY $HOME-relative class diverges: ~/.gitconfig,
~/.ssh, ~/.netrc, ~/.aws, ~/.npmrc, ~/.config/*, ~/.cache…; agent-side $HOME writes inside the guest
create a phantom /data tree (proot -0 fake-root allows it) — silent state forking in BOTH directions.
Bridge `exec_in_guest` (linux_env.py:554-569) = a THIRD env (raw os.environ). linux_session.py has the
correct env but ZERO production callers (dead code). GH_TOKEN override and not-in-guest hypotheses
DISPROVEN. Open sub-question: the terminal's guest PATH works only by accident (lazy
hermes_cli.gateway import appends /bin dirs to os.environ at runtime — unpinned by any test).
Fix shape (choke point = the shim): `build_guest_launch` (linux_env.py:192-196) sets HOME=/root +
prepends guest PATH; `_shim_body` exports the same; bump SHIM_FORMAT 5→6 so the existing repair gate
(hermes_boot.py:91-104) rewrites installed shims; with HOME=/root the agent's login bash natively
sources /root/.profile + /root/.bashrc ⇒ dotfile parity for free; pin with test_linux_exec.py
assertions. Deferred (documented): user-terminal env leak (raw os.environ incl. session token into the
PTY — the terminal is the leaky surface, agent scrubs), cwd divergence (/root vs workspace), rc-file
semantics triple (terminal misses login exports), dead linux_session.py, bot profile homes unbound in
guest, PAGER/TERM asymmetries.

*(fixed in PR #123 — `build_guest_launch` + `_shim_body` now export `HOME=/root` and the guest PATH
prefix (SHIM_FORMAT 6 repairs installed shims at next boot); terminal.py deduped; contract pinned in
test_linux_exec.py. Full python battery 161 passed / 5 pre-existing skips, re-run by the Lead.
python-runtime ships inside the APK — on-device check pending the user's next dev build: terminal
`gh auth login` → agent `gh auth status` must report the same account; same for git config.)*

## BUG-135 [MEDIUM] Links in agent responses and terminal output are dead text — must be tappable and open in the built-in browser in a new tab

User report (2026-10-12): "the terminal/agent responses give me a link to open or something they should be
clickable and open in the built-in browser in a new tab!"
Intake: two surfaces render URLs as plain text today — chat message bubbles (`Chat.tsx`) and the xterm.js
terminal WebView (`app/android/app/src/main/assets/term/index.html`). Both need URL detection + tap →
open the URL as a NEW TAB in Moch's built-in Browser screen (not the OS browser). Verification wave
pending (read-only scope: Chat.tsx message rendering + any existing link handling, term/index.html +
`src/lib/terminal.ts` plumbing, Browser screen tab-open API).

**Verified (read-only adversarial agent, 2026-10-12): CONFIRM, understated.** (a) Bare URLs are dead
text everywhere: assistant text renders `@ronradtke/react-native-markdown-display` with NO
`markdownit`/`onLinkPress` props (Chat.tsx:223, CommandOutput.tsx:195) and the lib ships linkify
DISABLED (createMarkdownIt.ts:18-19) — zero autolink/Linking.openURL anywhere in src. (b) Markdown
`[text](url)` links in completed text ARE tappable — but open the OS BROWSER (lib default
openUrl.ts:14) — wrong target even where "working". (c) Terminal: bundled xterm has OSC-8 parsing +
auto-registered OscLinkProvider but no `linkHandler` (default confirm()+window.open — both unhandled
in the RN WebView) and NO web-links addon for bare URLs; worse, the WebView sits in a
`pointerEvents:"box-only"` wrapper (terminal.tsx:385, BUG-100) so taps NEVER reach xterm — every tap
re-focuses the hidden input. (d) NO path exists to open the Browser screen WITH a URL: no route
params (browser.tsx has no useLocalSearchParams), `addTab` (browserRelay.ts:147, module-level
nanostore — callable from anywhere, mounts the tab when the screen opens) is only called in-screen.
Fix shape: `openInAppBrowserTab(url)` helper beside addTab + `router.navigate('/(tabs)/browser')`;
Chat/CommandOutput get `markdownit = MarkdownIt({typographer,linkify})` (re-exported by the lib, zero
new deps) + `onLinkPress` → helper, return false (kills OS-browser default); terminal: OSC-8
`linkHandler` + inlined web-links UMD both `say({type:'link',url})` over the EXISTING postMessage
channel, RN-side hit-test via the box-only wrapper's onTouchEnd → `window.__linkAt(x,y)` (px→cell via
renderService dimensions, fit-addon precedent), `{type:'link'}` branch in handleWebMsg → helper;
link-tap gesture must suppress the IME refocus. Adjacent dead-text surfaces noted: streaming tail
(BUG-040 trade — leave), thinking text, ToolRow preview, CommandCard error/usage/notice, clarify
question. Agent-side new-tab is BUG-136's root (relay 405).

*(fixed in PR #125 (stacked on #124, merge that first) — one shared linkified MarkdownIt instance +
onLinkPress→`openInAppBrowserTab` (addTab + navigate to the Browser screen, never the OS browser) on
Chat + CommandOutput; the constructor is require-bound because the lib's CJS-with-JSX dist loses
NAMED ESM bindings under tsx (the imports-gate stub now mirrors the real exports); terminal:
`window.__linkAt(x,y)` hit-test over the existing postMessage channel + OSC-8 linkHandler seam +
140 ms-deferred IME refocus arbitration (link taps open the Browser, other taps unchanged); pure
matcher extracted+tested in lib/terminal.ts (18 new cases). Typecheck clean, 15/15 suites green
(test:terminal 54/54, imports gate PASS, browser-relay 34/34). Chat links are JS/OTA-able; the
terminal asset ships inside the APK — on-device check pending the next dev build.)*

## BUG-136 [HIGH] Browser tab control tools fail with 405 — only the tab list works

User report (2026-10-12): "the browser tab control tools don't work, they return 405 error, only the tab
list that works!"
Intake: PR #120 shipped tab management tools; the CDP relay (`CdpRelay.kt`) deliberately 405s
`/json/new|close|activate` as "native-owned" and `browser_webview.py` is supposed to fall back to
native/CDP paths — on device the agent still surfaces the 405 for every lifecycle op while `/json/list`
works. Verify which link in the fallback chain is missing (relay endpoints unimplemented vs bridge tab
ops unwired vs `Target.*` fallback impossible on WebView) and what the minimal working route is (tab ops
must end at the RN/Kotlin tab owner). Scope: `app/hermes-src/tools/browser_webview.py`, tab-tool
registration, `app/src/lib/browserRelay.ts`, `CdpRelay.kt`/`BrowserRelayModule.kt`, RN browser screen,
`app/python-runtime/tests/test_browser_tab_tools.py`.

**Verified (read-only adversarial agent, 2026-10-12): CONFIRMED, worse than reported.** The literal 405
surfaces for `browser_tab_create`/`browser_tab_switch`; `browser_tab_close` fails EARLIER with a
misleading "refusing to close the last remaining tab" (the relay's `/json/list` is filtered to exactly
ONE tab, so the close-guard always fires) — and "only the list works" is itself generous: the list can
only ever show the ACTIVE tab (1-tab fiction). Net: 3/4 tools fail, the 4th is degraded. Knowingly
shipped: PR #120's message lists the Kotlin/RN endpoints as follow-ups; its 165 green tests ran against
a SIMULATED relay/headless Chromium, never the real one (test_browser_tab_tools.py stubs
`_webview_tab_targets`→3 tabs, `_relay_lifecycle`→200, `Target.*` fallbacks — all impossible on device).
Mechanism: `CdpRelay.kt:210-212` 405s `/json/new|close|activate` by design; `browser_webview.py`'s
`Target.*` fallbacks run over the "browser" ws which the relay tunnels to the ACTIVE PAGE's socket
(`CdpRelay.kt:213-226`) — WebView has no browser-level target, so every fallback is impossible. MISSING
WIRE: tabs are owned by RN nanostores (`browserRelay.ts:147-174` addTab/closeTab/switchTab +
`(tabs)/browser.tsx:262-290` WebView pool) but NOTHING connects Python/Kotlin to them — no bridge
methods, no DeviceEventEmitter listener (only ShareInModule emits). FEATURE-BROWSER.md:125-127 designed
"tab switch via bridge call, not CDP" — never built. Fix shape: relay implements the three lifecycle
endpoints via a `mochTabOp` DeviceEventEmitter round-trip (op+requestId, latch ~5s) acked by
`browserRelay.ts` after driving the nanostores; needs a tabs⇔targets registry (targetId per BrowserTab;
relay diffs upstream `/json/list` to answer `/json/new` with the new page's JSON); zero Python changes
required (it already PUTs and parses 200s). Adjacent defects found: silent wrong-tab driving after any
manual tab switch (supervisor stays pinned to the old page; resync only runs after a successful
activate/close); AgentBrowserHost/browser.tsx active-URL last-writer-wins race; `chosenPageJson`
first-page fallback on ambiguous/stale URL match; tab ids go stale after onRenderProcessGone remount;
fixed port 9334 squattable (confusion/DoS only).

*(fixed in PR #124 — the relay's three lifecycle endpoints now round-trip to the RN tab owner: one
`mochTabOp` event {requestId, op, url/targetId} → 5 s latch ack via the new `tabOpAck` bridge method,
open resolves the new DevTools target by diffing the unfiltered upstream list (≤3 s) and answers 200
with the page JSON; honest 400/409/502/503/504 statuses; `GET /json/moch-tabs` (token-gated) exposes
the FULL page list; browserRelay.ts applies ops to the nanostores (RN-side last-tab guard as defense
in depth) and keeps a tabs⇔targets registry (self-healing after onRenderProcessGone); python
tab_list prefers moch-tabs and skips the impossible Target.* fallbacks on the relay. 56/56 tab-tool
tests, 34/34 relay tsx checks, typecheck clean, full sweep 15/15; Kotlin is source-level verification
only (no Kotlin test infra) — on-device check pending the next dev build (new APK: Kotlin changed).
PR #125 stacks on this branch.)*

## BUG-133 [HIGH] Keyboard opens over inputs app-wide — the input and everything at the bottom must rise ABOVE the keyboard

User report (2026-10-12): "find all inputs/anything that will open the keyboard, and make sure when the
keyboard opens the input (and everything in bottom) will go above the keyboard and not stay with it."

Verified app-wide by 5 read-only adversarial agents on disjoint scopes (chat composer / forms+onboarding /
tab screens+shell / sheets+modals / platform wiring+terminal+webview), grounded in the native + library
sources: under RN 0.86 edge-to-edge (targetSdk 36) the manifest's adjustResize is inert and RNKC forces
adjustNothing inside Modals — JS-side lifting is the only mechanism. Confirmed NOT COVERED: fleet
create-bot box (input AND buttons), Sidebar rename dialog, ModelPickerSheet (RN-core KAV is a literal
Android no-op — worst: API-key form + Save), automations modal ('height' undershoot), all four form
screens + PairForm/ProviderKeyForm, agent tab inline key form, browser WebView in-page inputs; PARTIAL:
chat (composer floated one nav-bar inset above the keys + hop), search lists (results behind keys);
KeyboardProvider was missing on the !cfg onboarding branch entirely.

*(fixed in PR #62 — chat-pad / connectors-KAV patterns ported to every surface + KeyboardAwareScrollView
on the form screens + provider hoist; typecheck clean, 15/15 suites pass, zero new lint — on-device check
pending user's next dev build; JS-only, Metro reload is enough.)*

Deferred: SessionToasts render under open sheet Modals (RNKC OverKeyboardView is the fix surface);
chat pathological tall-stack overflow in clarify cards (flexShrink on s.sheet/s.runFooter).

## M9 crew-loop slice (2026-10-12) — close the headline demo chain

- [x] **BUG-137 [HIGH] M9 headline false: bots cannot spawn sub-bots — SpawnBotService has no tool door (M9.1a stage 3 never landed)** — `app/python-runtime/moch/spawn_bot.py:81` (service + tests only; zero registration in `hermes-src` tools/plugins, no wiring in `gateway_server.py` boot) — "bots create their own sub-bots" is a service without a caller — wire the stage-3 toolset wrapper (Moch-side, flag-gated, no vendored edit) + surface the first-spawn-of-day `approval-required` refusal through the existing approval card machinery. *(fixed in PR #122 — `moch/spawn_tool.py` registers onto the `delegation` toolset at boot (verified live: resolve_toolset includes it), approval card via `request_tool_approval`, parent-depth ancestry; 5 tests green — on-device check pending user's next dev build.)*
- [x] **BUG-138 [HIGH] Crew board is read-only from the app — the "user puts work on the board" loop cannot close** — `app/app/(tabs)/crew.tsx:15` (write ops deferred), `app/python-runtime/moch/rpc_fleet.py:157` (`moch.kanban.tasks` is read-only) — bots have board tools but the user has no write surface — add `moch.kanban.create/assign/complete` RPCs + Crew screen buttons. *(fixed in PR #122 — create/assign/complete/block RPCs through kb mutators (assignee validated, frozen refused), db_path pinned at RPC entry (wrong-board race), dispatch poke + 60s heal ticker (`moch/kanban_dispatch.py` — nothing dispatched before), Crew create box + Complete/Reassign; 5 tests green — on-device check pending. Deferred: kanban knocks, block UI, breaker parity for synthetic pids.)*
- [x] **BUG-139 [MEDIUM] Bot creation has no checklist — context/skills/model knobs exist at the RPC layer but are unreachable from the UI** — `app/src/lib/fleet.ts:101` (`createProfile` sends only name/description/soul), `hermes-src/tui_gateway/methods_profiles.py:366` (`clone_from`/`no_skills`/`model`/`provider` accepted but unused by the app) — new bots always start strangers with default skills — checklist UI ("ideas about me" = USER.md copy as a file, selective skills, model pin) + small selective-copy additions in `moch/rpc_fleet.py` (not vendored edits). *(fixed in PR #122 — `moch.profiles.seed` + `moch.skills.list`, checklist rows in the create box (USER.md default ON, MEMORY.md OFF, skill picker; persisted defaults; dst-exists/symlink guards), EN/AR; 3 tests green — on-device check pending. Deferred: model pin (needs a pick-only sheet; ModelPickerSheet applies config — wrong shape).)*
## Security audit (C-items) — 2026-10-12 wave

- [x] **C-06 / BH-000039 [LOW, security] WebView debugging enabled process-wide in release builds — resident agent WebView holds the browsing session** — `MainApplication.kt:71`, `AgentBrowserHost.tsx:53`, `BrowserRelayModule.kt:145` — *(resolved in PR #128 — verified NOT code-fixable: CdpRelay's upstream IS the DevTools abstract socket (`CdpRelay.kt:544-558`), a `BuildConfig.DEBUG` gate kills every browser tool in release (the PR #61 always-available-browser feature). Verified attack surface is narrow: abstract unix socket (no network path), `SO_PEERCRED` rejects other apps, relay TCP token-gated — the only real path is an adb-AUTHORIZED host (USB debugging + prior RSA trust). Posture documented in SECURITY.md (root) + in-code comment at the enable call; changing it needs a separate non-debuggable WebView profile for authenticated browsing — deferred as a product decision)*
