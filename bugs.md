# Moch — bugs.md

Every confirmed issue in the chat session system, sorted **urgent → low**, ready to fix one by one.
Check off `- [ ]` as you fix. All findings were adversarially verified against source (63 confirmed, 14 corrected-mechanics, 0 rejected). Line numbers are current as of 2026-10-07. Paths are relative to `app/` (e.g. `app/src/lib/chat.ts` from the repo root).

**99 issues: 7 URGENT · 25 HIGH · 43 MEDIUM · 24 LOW.**
**Wave 2 (BUG-082–089):** user-reported symptoms, adversarially verified 2026-10-07 — approval overflow (URGENT), thinking vanish, busy-looks-dead-on-return, flaky status indicators — placed in severity order.
**Wave 3 (BUG-090–093):** user-reported terminal ( drawer → Terminal ) input UX, on-device 1.0.6, verified 2026-10-08. The working tree carried an UNCOMMITTED, UNVERIFIED fix attempt for all four — wave-3 entries describe HEAD (shipped) behavior; the build step must judge the attempt, not assume it works. *(Shipped in PR #46 / 1.0.7 build; on-device video confirms caret, lift, tap-focus and typing all work.)*
**Wave 4 (BUG-094–096):** same terminal, on-device 1.0.7 video (debug.mp4, 2026-10-08) — caret/lift/tap fixed, but flicker+lag, backspace, and helper-key feedback remain. Video-verified against frames 9–18s. *(094/095 shipped in PR #46 commit 2 / 1.0.8.)*
**Wave 5 (BUG-097–099):** on-device 1.0.8 vs Termux comparison videos (termux.mp4, moch-terminal.mp4, 2026-10-08). 1.0.8's sentinel backspace reaches the shell but the display cannot show erasures — the v1 append-only renderer has hit its ceiling; the documented xterm.js WebView swap is now the fix.
**Wave 6 (BUG-100):** user report on-device 1.0.9 RC3 (2026-10-09): cannot type at all. Root cause found in RN core sources, not guessed: pointerEvents is enforced only on ReactViewGroup containers, so the RC3 WebView renderer's `pointerEvents="none"` was a silent no-op and the WebView became the touch target.
**Wave 7 (BUG-104):** on-device 1.0.11-browser (2026-10-10): with the Browser screen open and tools advertised, EVERY agent browser tool returns "No browser page…" — the per-page (WebView) attach auto-detect could never engage. Root-caused in source and adversarially verified with a live relay + Chromium reproduction.

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

- [ ] **BUG-086 [HIGH] Sessions started elsewhere (automation/CLI/another device) show NO running/done/error dot in any state — and their approval questions are unanswerable** — `src/lib/chat.ts:2065-2066,239-244,282-289,2002-2003,1884,224-228` + `src/lib/sessionList.ts:22-31`
  Events for sessions not in `sessionsById` are dropped wholesale; `session.list` carries no running field; busy dots derive only from `sessionsById`. Foreign approval requests DO land in `pendingBySession` (`:1884`) so the footer count shows "waiting on you", but no row dot exists (`flagAttention` early-returns, `:2002-2003`) and `pendingRequest` (`:224-228`) requires that foreign session to be active — silently permanently blocked.
  *Fix:* server: add running/state to `session.list` (or status events). Client: resolve untracked pending entries to stored ids (`storedIdMap`/`sessionRows`) instead of early-returning, and make them openable/answerable.

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

- [ ] **BUG-104 [HIGH] Moch Browser: every agent browser tool fails "No browser page. Call browser_navigate first (and keep the Moch Browser screen open)" even with the screen open and a live tab** *(fixed — on-device check pending user's next dev build)* — `app/hermes-src/tools/browser_supervisor.py` (`_attach_initial_page`) + `browser_supervisor_frames.py` (`_enable_page_domains`)
  Three defects compound so the per-page (WebView) attach mode can NEVER engage through its automatic path: (1) the mode probe URLs are derived from the supervisor's ws:// cdp_url (`self.cdp_url.split("/devtools/",1)[0] + "/json/version"`) and fed to `requests`, which has no ws:// adapter → InvalidSchema every time → swallowed at debug level → `relay_browser_level` stays None (verified live: "No connection adapters were found for 'ws://…'"); (2) the stock browser-level branch then sends `Target.getTargets`/`createTarget` over the relay's page-tunneled socket, where a WebView has no browser-level surface → attach raises → swallowed by `_ensure_cdp_supervisor` ("non-fatal", debug-only) → webview tools return `_NO_SESSION` verbatim; (3) even in the per-page branch, `_enable_page_domains(None)` sent `Target.setAutoAttach` sessionless — another browser-level command a WebView page socket rejects. Masked in verification: `MOCH_BROWSER_FORCE_PER_PAGE` was a no-op for branch selection (the `if relay_browser_level is False:` gate never consulted it), and the PC proof passed via the stock branch because desktop Chromium tolerates Target.* over the tunneled page socket — the shipped per-page path was never exercised anywhere. An identical `_NO_SESSION` also fires when `BROWSER_CDP_URL` is unset (tools advertised via a stale relay.json while the relay is down) — same symptom, different cause; the per-page attach INFO log line now distinguishes them in logcat.
  *Fix:* derive probe URLs via `_http_probe_root()` (ws→http / wss→https, same authority + token) for BOTH the version and list fetches; a failed probe under `MOCH_BROWSER_RELAY=1` defaults to per-page (by probe time the ws dial already succeeded, and the relay only tunnels when a LIVE page exists — 503 otherwise); force flag actually forces (`relay_browser_level is False or force_per_page`); per-page branch enables only Page+Runtime sessionless (drops Target.setAutoAttach); probe-failure default logged at INFO; regression suite `app/python-runtime/tests/test_browser_attach.py` (8 cases, py3.11+py3.14 green) asserts per-page ENGAGEMENT — `_page_session_id is None`, zero `Target.*` commands, rewritten probe URLs, relay-default, force knob, stock default preserved without the env.

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
- [ ] **BUG-036 [MEDIUM] 120s request timeout → 2-minute hangs + double-submitted prompts** — `src/protocol/json-rpc-channel.ts:135,241-249` + `src/lib/chat.ts:1655`. Timeout only rejects; `prompt.submit` has no idempotency key so timed-out-but-delivered + retry double-submits. *(Client-side half; server dedupe is the real fix.)*

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
