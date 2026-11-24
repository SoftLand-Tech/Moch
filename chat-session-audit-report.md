# Moch Chat Session System — Complete Audit Report

**Date:** 2026-10-07 · **Scope:** chat session system (list / create / switch / resume / delete / send / offline / reconnect) across `app/(tabs)/{chat,sessions}.tsx`, `src/lib/{chat,sessionList,chatListState,gateway,sendQueue,drafts,backendIdentity,mediaSend,mediaCache,sessionList,voice,theme}.ts`, `src/components/{Chat,Sidebar,ScreenShell,SessionToasts}.tsx`, `src/protocol/*`, `app/_layout.tsx`, `app/setup.tsx` — plus UI/UX/a11y/copy.
**Method:** 5 parallel subagents (GLM-5.3-Flash) on disjoint scopes + Lead verification pass against source (incl. server contract `hermes-src/tui_gateway/methods_session.py`). READ-ONLY — nothing was modified.
**Result:** ~110 unique findings — **5 URGENT · 14 HIGH · 30 MEDIUM · 30+ LOW** after dedup.

---

## 🔴 URGENT

**U1. Auto-reconnect is dead code — a dropped socket strands the app until a manual tap.**
`src/lib/gateway.ts:53,426,445` — `lastConfig` is only ever assigned in `retryNow()` (and cleared in `clearConfig()`); `dial()`/`connect()` never set it. `scheduleReconnect()`'s first line (`if (!wantConnection || !lastConfig || manualClose) return`) therefore always bails after a socket drop: no retry is ever armed. The full-screen "Connection failed" veil even promises "auto-retrying…" only when `attempt > 0`, which can't happen. Recovery only via manual Retry or a background→foreground cycle (`onForeground` → `retryNow`). Queues/outbox never flush because `isConnected` never recovers.
**Fix:** set `lastConfig = v` in `dial()` after `validateConfig`; clear only in `disconnect()`.

**U2. `flushOutbox` permanently drops every queued message after the first failure.**
`src/lib/chat.ts:781-794` — `outbox.set([])` clears the whole queue, then the loop re-enqueues ONLY the item that threw (`enqueueOffline(text); throw err`). Items after the failed one are gone forever; the sole caller `app/(tabs)/chat.tsx:243-253` swallows the throw (`.catch(() => {})`). Silent message loss across any reconnect flap.
**Fix:** dequeue one at a time (remove after success), never clear-then-iterate.

**U3. Send during an in-flight ack silently vanishes — no bubble, no error, no queue strip.**
`src/lib/chat.ts:1544-1548` — when the per-session lock is held (`sendingSessions.has(lockKey)`; fast second Send, queue-flush race), `enqueueOffline(text)` runs and `sendPrompt` returns normally. The composer was already cleared (`chat.tsx:648`). No user row, no queued-bubble, no toast; the text sits in the outbox which flushes only on the next offline→online edge — possibly never if the socket stays up.
**Fix:** route lock-conflict sends to the per-chat busy queue (`enqueueSend`), not the global outbox.

**U4. Deleting from the Chats tab is broken three ways.**
`app/(tabs)/sessions.tsx:128-135` vs the correct drawer flow `src/components/ScreenShell.tsx:301-332`:
1. No detach + no `session.close` first → the gateway refuses live sessions (`hermes-src/tui_gateway/methods_session.py:980`: `_err(4023, "cannot delete an active session")`), so deleting any recently-opened chat fails.
2. `forgetSession(s.id)` is passed a STORED id but the function is keyed by LIVE id (`src/lib/chat.ts:1371-1411`) → the whole cleanup branch is skipped: `pendingBySession` never cleared (the amber "N questions waiting" banner on this very screen sticks until restart), attention/draft/send-queue never cleared, `storedIdMap` never scrubbed, `forgetChatMarks` never called, `LAST_SESSION_KEY` still resumes the deleted chat next boot.
3. A session already deleted elsewhere surfaces "Delete failed: session not found" and keeps the stale row (no `isSessionNotFound` tolerance, unlike the drawer at `chat.ts:1513-1515`).
**Fix:** reuse ScreenShell's `handleDelete` (detach if active → `session.close` live → delete → `forgetSession(live)` + `forgetChatMarks`), treat not-found as success.

**U5. The offline experience is three layers that contradict each other — and the banner is inverted.**
- `app/_layout.tsx:251` renders a full-screen opaque veil (`rgba(0,0,0,0.94)`) over the WHOLE app on any outage, making the chat screen's carefully engineered grace-period banner, queue strip and cached history unreachable (`chat.tsx:112-129,836-860`) exactly when they were designed to shine.
- The banner's own condition is inverted: `chat.tsx:129` `reconnects < 2` shows OFFLINE only during attempts 0–1 and hides it from the 2nd retry onward — the comment says "appears when reconnects keep failing (3rd+ attempt)". Its `Connecting…` branch (`chat.tsx:843`) is unreachable behind the `connState !== 'connecting'` gate.
- Today the inversion is masked by U1 (attempt never increments), so users see only the veil.

---

## 🟠 HIGH

**H1. Outbox flushes to the WRONG chat, duplicates sends, and strands stale "failed" rows.**
`chat.ts:764-767,781-794,1605,1697-1707` — the outbox is an unpinned `string[]`; `flushOutbox` → `sendPrompt(text)` targets whatever chat is active at flush time (compose offline in A, switch to B, reconnect → A's text becomes B's prompt: a real model turn billed to the wrong conversation). On failure the text is double-enqueued (sendPrompt's catch AND flushOutbox's catch). `retryMessage` resends without clearing the outbox copy → Retry + reconnect = the same prompt 2–3×, while the old row stays 'failed' forever even after the flush succeeded.
**Fix:** store `{storedId, text}`, pin the flush, enqueue in exactly one layer, reconcile rows.

**H2. Stale reconnect timer silently reverts the phone to the PREVIOUS computer.**
`gateway.ts:409-411,432-436` + `json-rpc-gateway.ts:175-179` — switching computers fires the supersede `dropSocket` → state 'closed' → `scheduleReconnect()` arms a timer for the OLD `lastConfig`; nothing cancels it when the new dial succeeds (`cancelReconnect` only runs at the top of `connect()`). ~1s later it dials machine A, supersedes the healthy B socket, re-persists A and re-scopes caches back. User picks B, phone flips back to A.

**H3. The foreground dead-socket probe detects the corpse but can't rebuild it; heartbeat is optional.**
`gateway.ts:608-618` probes with `gateway.ping`, then `retryNow()` → `cli.connect(url)` hits the same-URL idempotence guard (`json-rpc-gateway.ts:174`) because a half-open socket still reads OPEN — the "rebuild" is a no-op that re-declares 'open' on the dead socket. Liveness then depends on the heartbeat, which only starts if `gateway.ready` advertises `heartbeat:true` (`json-rpc-gateway.ts:334-337`). Without it, sends hang the full 120s request timeout.
**Fix:** `client.invalidate(...)` on probe failure; start a conservative heartbeat unconditionally.

**H4. Gateway `error` events render as normal assistant replies.**
`chat.ts:2329-2334` — the streaming branch finalizes with `text: last.text || msg` and NO `status:'failed'` (contrast `message.complete` at :2183-2188). If the bubble had text, the error is discarded and the turn just ends looking complete; if empty, the raw error string renders as the agent's answer with copy/Listen buttons. No failed marker, no retry affordance.

**H5. Stop never finalizes the streaming bubble — stuck cursor/dots forever.**
`chat.ts:1709-1722` + `chat.tsx:1390-1398` — `stopRun` clears `busy` but nothing sets `streaming:false` on the tail message (`status.update` path at `chat.ts:2313-2321` doesn't either). If no terminal `message.complete` follows the interrupt, the bubble shows `▍`/ThinkingDots forever and copy/time actions never appear (`!m.streaming` gate, `Chat.tsx:231`).

**H6. Uploads have no timeout — one stalled upload wedges the chat.**
`src/lib/mediaSend.ts:113-119` — `uploadAsync` has no deadline (only the legacy JSON fallback sizes one). A hung upload holds `sendingSessions` forever; every later send to that chat is silently rerouted to the outbox (U3 behavior) until app restart. **Fix:** race the upload against `uploadTimeoutMs(size, ATTACH_RATE_KBPS)`.

**H7. Session lists are ordered by CREATION time — active old chats never rise, and timestamps mislead.**
`src/lib/sessionList.ts:47-50` re-sorts by `started_at` (creation, never changes), destroying the server's `order_by_last_active=True` ordering (`methods_session.py:138`; the compact row carries no `last_active`). Fallout: the Chats tab never bubbles a recently-used old chat; the drawer's Today/Yesterday/Older buckets (`Sidebar.tsx:391` via `ts = toMs(started_at)`, contradicting the "latest activity" doc) bucket by creation; the meta "· 3d ago" reads as last-used when it means created.

**H8. Visiting the Models tab mints a real server session — violating the documented local-only invariant.**
`app/(tabs)/agent.tsx:66-74` runs `ensureSession()` on mount → `session.create` (`chat.ts:1082-1091`) + an optimistic saved row (`chat.ts:943`) titled "New chat" with zero messages — exactly the orphan the "unsent chats are LOCAL ONLY" rule exists to prevent (the chat screen deliberately avoids this, `chat.tsx:233-239`). Same pattern: `automations.tsx:115`, `ModelPickerSheet.tsx:125,151`.

**H9. A failed detached-reattach silently swaps the user into a brand-new session.**
`chat.ts:1101-1106` — when the on-screen chat's handle was released and `resumeShared` fails ("session not found" after a serve reinstall), the catch creates a FRESH session and switches the screen: the user's send lands in an empty new chat, the cached transcript is yanked off-screen, and the error is swallowed to a `log('warn')`.

**H10. Steer and slash output graft onto the WRONG session after a mid-RPC switch.**
`chat.ts:1724-1748` — `sid` is captured, the RPC awaited, then the user row is built from `messages.get()` (the now-ACTIVE session's). Steer → immediately switch chats → the steer text appears in the other chat and is lost from the original. Same class: slash `pushLocalMessage` output cards (`chat.tsx:425-455`).

**H11. Embedded first-run setup can fail silently into an infinite spinner.**
`app/setup.tsx:75` — `await linuxBootstrap(...).catch(() => {})` then `onNext()` unconditionally; the button has no busy state (double-tap restarts a minutes-long download) and `InstallStep` (`setup.tsx:161-185`) polls `linuxStatusLive` forever with no error text and no retry.

**H12. The theme system's core contract is already broken in shipped UI.**
`theme.ts` forbids hard-coding token rgba / module-scope snapshots. Violations: `settings.tsx:516` hard-codes Mocheme's accent wash (settings icon chips stay orange under the Relay theme) and `:519` invents a third red (`#EF4444`) matching no token; the `'#241A08'` amber banner is duplicated in `chat.tsx:1499` and `sessions.tsx:247` (clashes with Relay's teal band); `SessionToasts.tsx:23-27` snapshots `C` at module scope (latent palette freeze); scattered raw whites (`chat.tsx:1410,1575`, `Sidebar.tsx:1044,1198`, `SessionToasts.tsx:62`) and iOS-only `RefreshControl tintColor` on this Android-only app.

**H13. Chats tab is a feature-poor duplicate of the drawer — and its only destructive action is undiscoverable.**
No rename, no pin/archive (the marks system `chatListState.ts` is entirely unused here), archived chats shown in the flat list with no indicator while the drawer hides them, and delete exists ONLY as an unhinted long-press (`sessions.tsx:201`) — no ⋯ menu (the drawer row has one, `Sidebar.tsx:966-973`), no haptic, no double-tap guard (drawer guards via `dialogBusy`, `Sidebar.tsx:456-464`).

**H14. Recording auto-stop fires an async side effect from inside a state updater.**
`chat.tsx:723-728` — `finishRecording()` (async: recorder stop, haptics, transcription, possible alerts) is invoked inside the `setRecSecs` updater, which React may double-invoke → spurious "Recording failed" alert / doubled transcript at exactly the 2-minute mark.

---

## 🟡 MEDIUM

**Session list & screens**
1. **Silent 200-session cap** — `sessionList.ts:66` `limit: 200`, no pagination/load-more/"showing N of M"; older chats just vanish.
2. **No loading state on first open** — blank void (`sessions.tsx:221-232` renders `null` while loading, no skeleton); with an error AND empty list, "tap to retry" + "No conversations yet" show simultaneously.
3. **Dead offline retry + double banners** — `load` early-returns `if (!online)`, so the error row's retry is a dead button; the drawer's unguarded `loadSessions()` can set the shared error atom → two "Not connected" banners stacked, one dead.
4. **"N questions waiting" banner doesn't deep-link** — `sessions.tsx:164-173` navigates to whatever chat is active; `pendingStoredIds` (`chat.ts:247-256`, built for exactly this) is used NOWHERE.
5. **Stale `session.list` race on computer switch** — no generation guard (`sessionList.ts:58-83`): machine A's in-flight response can repopulate the list on machine B.
6. **Drawer "local" sessions never reconciled** — chats deleted elsewhere persist in the drawer (`ScreenShell.tsx:212-223`) until restart/backend switch; tapping always fails to the retry banner.
7. **Rename never updates the open chat's header** — `ScreenShell.tsx:289-299` patches only `sessionRows`; the header waits for an event echo or the 60s poll.
8. **Toast ergonomics** — newest renders at the BOTTOM (`SessionToasts.tsx:79-83`), no swipe/close (only exits: tap-to-navigate or the timer), replacement remounts with a flash.
9. **First tap after searching only dismisses the keyboard** — `sessions.tsx:187-190` lacks `keyboardShouldPersistTaps="handled"`; `returnKeyType="search"` has no handler.

**Lifecycle & state**
10. **`message.complete` drops the final answer** if no streaming row exists (`chat.ts:2174-2213` — missed `message.start` ⇒ server's final text discarded while busy flips false).
11. **Deep link to a deleted/foreign session strands a ghost "New chat"** with a forever-failing retry banner (`_layout.tsx:199-205` → `seedPlaceholder` → resume 404); notification taps are also dropped SILENTLY after the 60s staleness window.
12. **Drawer delete detaches BEFORE deleting, with no rollback** — `ScreenShell.tsx:301-332`: a failed delete leaves the user in an empty new chat with the old row still listed.
13. **Backend-switch cache scoping leaks** — media caches are NOT fingerprint-scoped (`mediaCache.ts:34-43` keys by path only): after switching machines, same-named paths render machine A's cached images/audio. Managed-root cache keyed by host only (`mediaSend.ts:69-92`) → uploads can target the wrong machine's home dir. Shelved `.orphan.<fp>` blobs accumulate forever with no cap; the one-time `'legacy'` shelf (first-run migration) can never be restored; a transient AsyncStorage read error is treated as "foreign backend" → full purge; concurrent dials can run `syncBackendIdentity` out of order (`gateway.ts:515-517`); a failed post-switch reload leaves the OLD machine's outbox live in memory (`backendIdentity.ts:128-131`).
14. **`resetSessionCaches` leaves residue** — `chatBanner` (stale retry against a dead stored id), `streamBufs` (never deleted anywhere), `queuedAttachments`, `mochiMoment` survive a backend switch (`chat.ts:1424-1445,404-419,806-820`).

**Messaging**
15. **120s request timeout → 2-minute hangs + double-submit retries** — `json-rpc-channel.ts:135,241-249`; `prompt.submit` has no idempotency key, so timed-out-but-delivered + "tap to retry" double-submits a real prompt.
16. **"Forget this computer" never closes the socket** — `clearConfig` (`gateway.ts:377-385`) doesn't `client.close()`; Settings forgets without `disconnect()` (`settings.tsx:283-295`) → revoked machine stays connected, hero shows green "Connected" with no host.
17. **Debounced queue/draft/transcript writes lost on a quick kill** — 400–500ms debounces (`sendQueue.ts:52-63`, `drafts.ts:41-54`, `chat.ts:534-559`) with no `AppState` background flush (`_layout.tsx:150-160` handles only 'active'; the flush fns are test-only).

**Chat UI**
18. **Composer double-inset above the keyboard** — SafeAreaView bottom edge (`chat.tsx:817`) + `paddingBottom: Math.max(insets.bottom, 10)` (`chat.tsx:1243`) stack; the pill floats 24–48px above the keyboard on gesture-nav devices.
19. **Composer attachments are not scoped to the chat** (drafts are) — `chat.tsx:177` plain state: switch chats with chips pending and Send delivers them (and caption text) to the NEWLY active chat.
20. **Every resume re-keys ALL messages** (`chat.ts:1484-1490` `id: nid()`) → full FlatList remount: images blank + reload, scroll hitches (also on the reconnect resync, `chat.ts:2050-2058`).
21. **Streaming renders as raw plain text; markdown/links/code snap in at completion; the `▍` cursor sits on its own line below the paragraph** (`Chat.tsx:213-224`).
22. **Failed slash command loses the typed text** (`chat.tsx:608-611` clears before `runSlash`, catch doesn't restore — unlike plain-send at :656); **no escape for literal "/" messages** (`/usr/bin/env` becomes a command error); **"Browse slash commands" starter is a dead end** (inserts "/" but doesn't focus the composer, so no palette).
23. **TTS state never resets on natural playback end; two bubbles can show stale "stop"** (`voice.ts:120-125` — no completion subscription; wrong a11y label too).
24. **No timestamps on user messages, no day separators** (`Chat.tsx:231-296` — `ts` exists on every message but is only rendered for assistant rows).
25. **Status header looks tappable but does nothing** (`ScreenShell.tsx:368-378,411-421` — pressable with no `onPress`, sibling to a "tap to retry" banner).

**Cross-cutting**
26. **Search icon does three different things; the Chats screen is orphaned** — chat header search navigates to sessions but never focuses the field (`chat.tsx:820`); the sessions tab's own icon just clears the query (`sessions.tsx:142`); the drawer nav has no "Chats" entry at all (`ScreenShell.tsx:188-195`).
27. **New-chat confirmation inconsistent across 4 entry points** — Settings confirms (`settings.tsx:297-302`); drawer, Chats tab, and `/new` all switch immediately.
28. **Denying an approval plays a Success haptic** (`chat.tsx:1116-1119`) — positive feedback on the one action that refuses the agent (AlertDialog correctly uses Warning for destructive).
29. **Sub-44dp touch targets on the controls used mid-stream** — steer chip 26–28px, tools-toggle, queue row buttons, jump FAB 40×40, drawer ⋯ 40dp, Skills pills 34dp (no hitSlop compensation).
30. **Copy contradicts itself about key storage** — `setup.tsx:94` "Keys are stored on this phone" vs `agent.tsx:306` "stored on your server" (truth: server-side, `model.save_key`). Plus dev jargon + a dead CLI in copy ("Run `moch model`" — the npm CLI is deprecated; "JSON-RPC" in Settings; raw `e.message` alerts everywhere).
31. **Perf: admitted-skipped items still shipped** — slash palette: 120ms-debounced RPC + up to 120 rows unvirtualized (SPEED_REPORT A2-10/A2-12 open); voice transcription base64-encodes whole recordings on the JS thread (A2-29 open); **every visited tab keeps a 60s `session.list` poll forever** (`ScreenShell.tsx:167-175`, no focus gate; tabs stay mounted).
32. **Reduced-motion support is one-off** — ThinkingDots checks it once on mount (no listener); StatusDot pulse and toast slide-in never check it.
33. **Setup notifications card is a no-op** — `setup.tsx:140` `setNotif(notif || true)` requests nothing; a user who denied can flip the card to "allowed" by tapping; its doc comment points at a Settings row that doesn't exist.

---

## 🟢 LOW

- `fmtWhen` shows "just now" indefinitely for future/clock-skewed timestamps; labels only refresh via the 60s poll (`sessions.tsx:36-50`).
- DST drift in `weekStart` mis-buckets Yesterday/Previous-7-days by an hour (`chatListState.ts:142-167`).
- Dead/duplicated code: write-only `sending` flag (`chat.ts:1502`), exported-dead `resumeSession` (still cited by `attention.ts:19`), `interface Sess` duplicates `SessionRow`, unused `Ionicons` imports (6 files), dead `warn`/`note` styles, duplicate `connectionState` subscriptions in chat.tsx, inline FlatList styles recreated per render.
- `loadSessions` inflight/force race allows a third concurrent fetch and premature spinner clear (`sessionList.ts:52-83`).
- Transcripts of server-deleted chats persist forever if never opened locally (no reconciliation sweep).
- storedIdMap 200-cap evicts by insertion order, not recency (`chat.ts:737-748`); same for queue/draft eviction.
- `stopRun` clears busy even when the interrupt RPC failed (`chat.ts:1712-1718`) — UI idle while the server still generates; queue head may flush into a busy session.
- Server request with missing `session_id` filed under `''` becomes unanswerable (`chat.ts:1867`).
- Malformed WS frames dropped with zero telemetry (`json-rpc-channel.ts:369-377`).
- Base64-of-16-bytes probe-key invariant is not validated anywhere client-side; short tokens surface as opaque connect errors (`gateway.ts:134-141`).
- Reconnect backoff has no jitter; per-server token silently falls back to plaintext AsyncStorage with no warning (`gateway.ts:201-208`); `client.capabilities` re-advertised per ready frame.
- Queue flush into a session deleted mid-flush drops the head (and its attachments) silently (`chat.ts:1778-1780`).
- Raw server strings in UI: `item.source` verbatim, "cannot delete an active session", optimistic row stuck at "0 msgs" until the next poll.
- Retry errors swallowed (`chat.tsx:777`); send with no storedId silently no-ops (`chat.tsx:631`); clarify mini-send with empty text does nothing visibly (`chat.tsx:1194`); steer failure drops a queued item's attachments (`chat.tsx:1300-1307`).
- Enter key inserts a newline despite `returnKeyType="send"` (web-only send path); recording timer side-effect (see H14); todos capped at 4 with index keys and no "+N"; expanded thinking silently truncated at 4000 chars; history rows capped at 8000 vs 32000 streamed, unmarked; transcript export silently truncates at 50,000 chars while reporting success.
- One-frame top flash on chat switch (`chat.tsx:202-220` uses post-paint useEffect for the reveal gate).
- A11y: no `accessibilityRole` on rows/banners/chips/FAB (announced as plain text); internal `qid` leaked into a clarify label; delete invisible to screen readers; header connection control labeled but inert.
- Docs drift: SPEED_REPORT A2-28 marked "not edited" but is done; TODO.md's cold-launch-lands-on-pairing issue STILL TRUE (`app/index.tsx:24-29` — saved computers but no active pointer shows the full PairForm, no "continue as <name>"); `setup.tsx:60` typo "rocksolid".

---

## ✅ Verified clean (no action)
- Same-URL connect idempotence / different-URL supersede closes the old socket exactly once (`json-rpc-gateway.ts:174-179` + dial-generation guards).
- Request-id routing monotonic/collision-free; replay watermark/epoch logic coherent.
- Pairing tokens in SecureStore with legacy migration + redacted logs.
- Boot/switch lands on a local new chat (invariant b holds); local-only unsent chats hold on the chat surface (violated only via H8/H9); fingerprint scoping structurally correct for drafts/queue/outbox (caveats above).
- Chat FlatList storedId remount strategy, memoized bubbles, park/reveal scroll anchoring, sync slash paint — solid.

## Top 5 to fix first
1. **U1 auto-reconnect** (`lastConfig`) — one line; unblocks every offline flow.
2. **U2+U3+H1 outbox** — pin `{storedId,text}`, dequeue-after-success, single enqueue layer.
3. **U4 delete flow** — mirror the drawer's detach→close→delete→forgetSession(live).
4. **U5 offline UX** — veil only at boot; flip the banner condition to `reconnects >= 2`.
5. **H7 sort by last-active** — stop re-sorting the server's already-sorted list.

---
---

# ✅ VERIFICATION PASS (9 adversarial reviewers, GLM-5.3-Flash)

Every headline claim was independently re-checked against source by 9 verification agents (read-only). **77 claims checked: 63 fully CONFIRMED · 14 PARTIAL (real but corrected mechanics) · 0 NOT REAL.** 2 severity upgrades, 1 new bug found, 6 downgrades. Line numbers below are current-file exact (files live under `app/app/(tabs)/`, `app/src/`, `app/hermes-src/` relative to the repo's `app/` dir).

## Verdict summary by finding

**URGENT — all 5 stand:**
- **U1 ✅** — repo-wide grep: `lastConfig` assigned only in `retryNow` (gateway.ts:445), cleared :380; `dial()`/`connect()` never set it; `scheduleReconnect` bails at :426. Veil's "auto-retrying" gates on `attempt > 0` which can never be true (_layout.tsx:265).
- **U2 ✅** — chat.ts:784-785 clears the outbox AND persists the emptied queue **before** the loop (loss survives restart); catch re-enqueues only the failing item (:790); sole caller swallows (chat.tsx:248).
- **U3 ✅** — guard at chat.ts:1545-1548; composer cleared at chat.tsx:648; the outbox's ONLY UI render is inside the offline banner (chat.tsx:844) — invisible while connected; flush fires only on the offline→online edge (chat.tsx:248). Nuance: requires `busy=false` with the lock held (send racing a flush delivery) — path and consequences exactly as reported.
- **U4 ✅✅ (upgraded)** — server refusal verified (`methods_session.py:982-983`, 4023); **live handles persist 6h** (`_SESSION_TTL_S = 6*3600`, attached sessions hard-exempt, WS-orphan grace only ~20s) → Chats-tab delete reliably fails for hours. Stored-id≠live-id confirmed at the id-minting level (live = `uuid4().hex[:8]` vs stored = `YYYYMMDD_HHMMSS_<6hex>`; no fallback rescue). Stuck pending banner, leaked marks/drafts/queue, `LAST_SESSION_KEY` re-resume all verified line-by-line.
- **U5 ✅ (coupled fix warning)** — veil verified as a later sibling of `<Stack>` painting over everything, appearing the instant state leaves 'open' with no blip gate; banner inversion + dead `Connecting…` branch verified. **Fix-order caveat: flipping the banner to `reconnects >= 2` alone still leaves it veiled, and even with U1 fixed the backoff wait is spent in `'closed'` (first retry = 1s, inside the 2.5s grace) — the veil/banner contract must be redesigned jointly.**

**HIGH:** H1 ✅ (wrong-chat delivery traced through `ensureSession:1108 return current`; double-enqueue verified at chat.ts:1605 + 790 — specific to session-resolution failures; retryMessage/outbox reconciliation absent) · H2 ⚠️ (mechanism 100% real; reachable only after a first `retryNow` populates `lastConfig` — and fixing U1 without adding `cancelReconnect` on `'open'` (gateway.ts:412-415) would expose it on EVERY switch) · H3 ✅ (same-URL guard hits verbatim on half-open sockets; `invalidate()` called only from close/heartbeat-failure; heartbeat conditional at json-rpc-gateway.ts:334-337; 120s timeout confirmed, never touches the transport) · H4 ✅ **(upgraded)** — failed-row mitigation is weaker than reported: `flagAttention` **suppresses the toast when the user is watching the chat** (chat.ts:2015) — the exact mid-stream-error scenario · H5 ⚠️ **(downgraded)** — client gap real but hermes always emits terminal `message.complete` (prompt_turn.py:985; interrupts map to status "interrupted" :298); stuck-forever requires a hung turn thread; real residual hazard: stale streaming tail grafts the next turn (chat.ts:2158) · H6 ✅ (no timeout/abort anywhere in mediaSend.ts; lock released only at chat.ts:1692) · H7 ✅ (server orders by `order_by_last_active=True`; compact row carries only `started_at`; **zero `UPDATE … SET started_at`** in hermes-src — activity lives in a separate `last_activity_at` column; started_at immutable) · H8 ✅ (agent.tsx mount effect refires on online/sid change; automations/ModelPickerSheet calls are user-initiated only — narrowed) · H9 ✅ (catch at chat.ts:1101-1106 has no banner and **not even the guarded re-point** — can yank the screen mid-switch) · H10 ⚠️ **(direction inverted — worse)**: `patchSession(sid,…)` targets the OLD chat but sources `messages.get()` from the NEW active chat → switching mid-steer **replaces the old chat's transcript** with the other chat's messages; runSlash sub-claim confirmed as filed · H11 ✅ (setup.tsx:75 swallow + unconditional `onNext()`; InstallStep polls forever; downstream surfaces nothing) · H12 ✅ (rgba literals verified against both palettes; `#EF4444` matches neither; KIND_META latent) · H13 ✅ (verified against both render paths) · H14 ⚠️ **(downgraded)** — impure updater + non-idempotent `finishRecording` confirmed, but **no StrictMode anywhere in the app**, so no concrete double-fire path today.

**MEDIUM highlights:** 200-cap ⚠️ corrected — **client-chosen** (`limit: 200`); the server RPC honors any limit (the `maximum=200` clamp belongs to the unused REST api_server) → fix is trivial · stale session.list race ✅ (window ≈ one handshake; self-heals on next successful fetch) · toasts ✅ exact · media-cache cross-machine staleness ✅ (path-only `cacheKeyFor` overrides expo-image URL keying; token rides a header, not the URL) · managed-root cache ⚠️ narrowed (wrong-home upload only under locked/absolute roots; default `'~'` is machine-agnostic) · backend shelf issues ✅ (`.orphan.legacy` permanently unreachable; AsyncStorage read error → purge + `'legacy'` compounding; **outbox staleness BROADER than reported — no `resetOutbox` exists, stale even on successful switches** — but drafts/queue atoms are emptied pre-reload) · resetSessionCaches residue ✅ (`streamBufs` never `.delete`d anywhere) · drawer reconciliation ✅ (all 11 `sessionsById.set` sites checked) · dial-hook race ✅ (narrow-trigger; boot-alone correctly ordered) · forget-doesn't-close ✅ (connectionState stays 'open'; mitigator: switching to another server supersedes) · composer double-inset ✅ (keyboard-controller v1.21.9 mechanics verified — JS pad is the only lift; ~2× gesture inset while IME open) · attachments-not-per-chat ✅ (both send and busy-queue branches deliver to the new chat) · resume re-keys ⚠️ corrected (switch remount is by-design via `key={storedId}`; the re-key bites on on-screen resync/live-id rotation — aspect-probe reset → layout snap) · slash palette/voice perf ✅ (SPEED_REPORT A2-10/12/29 open, A2-28 stale) · 7 eternal pollers ✅ (~7 RPC/min steady-state; inflight dedup only collapses simultaneous calls) · 60s deep-link drop ✅ (silent, atom nulled before the staleness check) · header status chip ✅ (dead Pressable — actually has **zero** press feedback, less affordance than reported) · queue strip ⚠️ (fact real, impact masked by the veil) · deny-haptic ✅ (one handler for all choices) · key-copy ✅ (**zero** local provider-key persistence exists — setup copy is false) · setup notif no-op ✅ (denied users can flip it to "allowed") · new-chat inconsistency ✅ (1 of 4 surfaces confirms) · **search/Chats reachability ✅ (UPGRADED: in default Mocheme the Chats screen is reachable via NOTHING** — the icon only renders in Relay; `chat.tsx:820` is the app's only route there).

**LOW highlights:** malformed "/" text never sends as a chat turn (no escape — confirmed through slash.ts dispatch) · failed slash loses text ✅ (incl. `/reset` on a brand-new chat via `activeLiveId()` throw) · slash starter dead end ✅ (catalog sheet exists but unused) · TTS stale state ✅ (expo-audio player, no status listener; A keeps 'stop' icon + wrong a11y label) · no user timestamps/day separators ✅ · clarify empty-send ✅ · steer-full-queue drops attachments ✅ · Enter=newline ✅ (no `blurOnSubmit`; submit handler web-gated) · AttachmentChip 26px ✅ / **VoiceRecStrip ✅ actually 44×44 — not a violation (corrected)** · debounced-write kill window ✅ (flush helpers have zero production callers; queue loss = message lost, transcript self-heals) · storedIdMap/queue/draft insertion-order eviction ✅ (legacy v1 stranding acknowledged in-code) · transcript leak ✅ (bounded 300 msgs; same-machine deletes only) · `sending` dead + `resumeSession` dead ✅ · ''-keyed requests ⚠️ (real code, but the gateway contract stamps+validates `session_id` on every frame → unreachable today) · stopRun busy-clear ✅ (flush guard only saves the dead-socket case) · marks leak on tab delete ✅ (drawer clears at ScreenShell.tsx:327, tab never) · DST bucketing ✅ (concrete failing instant constructed) · inflight/force race ✅ (stale fetch can overwrite fresher rows) · retry-swallow ⚠️ corrected (failed-row append almost always fires; the true silent path is the `sendingSessions` early-return AFTER `retryMessage` deleted the row — compounding U3).

## 🆕 New bug found during verification
**Drawer RENAME is entirely broken (URGENT-adjacent).** `session.title` is a live-session-only method server-side (`contracts/common.py:194-197`; resolved only via the runtime-sid `_sessions` map → 4001 otherwise, server.py:1133-1149), but the drawer passes the row's STORED id (ScreenShell.tsx:293 ← Sidebar.tsx:450). Result: every manual rename fails "session not found", the title is never written to the DB, and the open chat's header has **no** update path at all (the cited event-echo fires only from the auto-titler; the rename's `session.info` echo is dropped at the live-key gate chat.ts:2063-2066; the 60s poll refreshes the wrong store).

## Net corrections to apply when fixing
1. H5, message.complete-drop, H14: downgrade (server emits terminal frames; no StrictMode).
2. H10: fix by snapshotting the TARGET session's messages before the await (corruption, not just misplacement).
3. H2: ship together with U1 (`lastConfig` in dial + `cancelReconnect` on 'open').
4. U5: redesign veil/banner jointly, not one-line flips.
5. 200-cap: just raise/remove the client limit.
6. VoiceRecStrip: remove from the touch-target list; AttachmentChip stays.
