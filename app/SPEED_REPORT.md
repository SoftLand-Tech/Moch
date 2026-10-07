# Relay speed pass — what changed and why

A focused performance pass over the drawer, chat switching, and streaming UI. The WS/JSON-RPC protocol and ChatSegment model are unchanged; `src/lib/gateway.ts` now overlaps connection-config persistence with dialing, and the chat view renders a live text segment as plain `Text` before switching to Markdown at completion.

## What you should feel

**The drawer.** It opens the instant you tap the hamburger or swipe in from the left edge — the panel finger-tracks the swipe, and a flick finishes the open. Open/close animations are snappier (190ms open / 150ms close, down from 220/180 — `src/components/Sidebar.tsx:132-133`). The chat list inside scrolls smoothly even with a long history, and typing in the drawer's search no longer re-renders every row. Before the first open, the drawer costs literally nothing — it isn't mounted. On web, a closed drawer is fully out of the tab order. Android's back button closes the drawer instead of navigating away.

**Chat switching.** Tapping a chat in the drawer or the Chats screen swaps the conversation **in the same tick as the tap** — no spinner, no blank frame, no "New chat" flash. A chat you've visited before reuses its whole in-memory state (tool log, todos, busy pulse, scroll position ride along — `src/lib/chat.ts:1085-1094`); a cold chat shows its title immediately and paints its cached transcript while the resume RPC runs in the background (`src/lib/chat.ts:1104-1109`). New Chat is the same: the fresh chat takes the screen immediately and `session.create` happens behind it; a message typed and sent during that window lands in the **new** chat, never the old one (`src/lib/chat.ts:933-1002`). Cold start paints your last conversation from cache before the connection finishes resuming it (`src/lib/chat.ts:821-832`). Rapid A→B tapping is never yanked back to A — activation is guarded (`src/lib/chat.ts:779-780, 1079`). If a switch or create fails, you're already on the target chat, so the failure shows as a tappable "Couldn't open this chat — tap to retry" strip right there (`src/lib/chat.ts:230`, `app/(tabs)/chat.tsx:515-523`).

**Everything else.** The Skills tab renders its lists instantly instead of hiding them behind a spinner on every visit (`app/(tabs)/skills.tsx:26,37-40`). The model picker opens without a boot RPC (`src/components/ModelPickerSheet.tsx:49-64`), and repeat opens of a command's options sheet render instantly instead of showing a loading row (`src/lib/slash.ts:80-87`, `src/components/CommandOptionsSheet.tsx:48-77`). While a reply streams, the Settings screen no longer re-renders 30 times a second (`app/(tabs)/settings.tsx:97`). Sending and steering fire their haptic on the same frame rather than after a bridge round-trip (`app/(tabs)/chat.tsx:313,324,331`). The cold-start splash can be tapped to skip (`src/components/AnimatedSplash.tsx:46-52,83-88`).

## What changed, per area

### Drawer (`src/components/Sidebar.tsx`)

- **Mount on first open** (A2-16): the drawer subtree renders on the first open and stays mounted — only a 28dp edge strip exists before that (`Sidebar.tsx:211,542-556`), so unvisited screens carry no drawer cost at all. On web, after the close animation finishes, panel and scrim get `display:'none'` — the only thing browsers reliably drop from tab order (RNW keeps `role=button` elements tabbable under pointerEvents/aria-hidden); it also auto-blurs anything focused inside (`Sidebar.tsx:216,314-316,538`).
- **Tuned list** (A2-17): the SectionList now renders `windowSize={5}`, `maxToRenderPerBatch={8}`, `updateCellsBatchingPeriod={50}`, `initialNumToRender={12}` — a drawer doesn't need ~20 viewports of pre-render (`Sidebar.tsx:679-682`).
- **Stable rows** (A2-18): rows are a module-scope `React.memo` component handed stable, ref-based callbacks, so store ticks and dialog state stop re-rendering the whole list (`Sidebar.tsx:142,372-379,484-498,864-903`).
- **Tight open/close timing** (A2-19): the slide runs from a `useLayoutEffect` on the `open` flip — no extra render between tap and first animated frame (`Sidebar.tsx:291-317`).
- **Refresh on open, not on close** (A2-20): the session-list refresh now fires when the drawer *opens*; previously it fired in the close branch, landing a 200-row store write mid chat-switch on every row tap (`Sidebar.tsx:296-304`). The old accidental mount-time refresh is gone too (still covered by ScreenShell's online effect + 60s poll, `src/components/ScreenShell.tsx:57-69`).
- **Swipe gestures** (A2-21, the headline): swipe right from the left edge to open (finger-tracking, velocity/progress snap, settles on both release and terminate), drag left on the panel/scrim to close, and Android hardware back closes the drawer while open (`Sidebar.tsx:422-481,321-328`). The edge strip starts 56dp below the top inset so it never covers the hamburger (`Sidebar.tsx:125,550,577`).
- **Memoized animation nodes** (A2-22): the panel translate and the three dialog scale interpolations are memoized so they aren't rebuilt every render (`Sidebar.tsx:354-357,532-534`).

### Chat switching (`src/lib/chat.ts`, `app/(tabs)/chat.tsx`, `src/components/ScreenShell.tsx`, `app/(tabs)/sessions.tsx`)

- **Optimistic switch** (A2-1): `switchToSession` is a plain synchronous swap — in-memory hit reuses the entry; a cold row seeds a placeholder carrying the row title before any RPC (`chat.ts:1058-1118`).
- **Stored-keyed transcript cache** (A2-2): transcripts are now keyed by the durable stored id under a `.v2` suffix (`chat.ts:147`), with a lazy one-time migration from both interim and legacy live-keyed v1 entries that removes every mapped old key (`chat.ts:490-520`). This is what makes cold switches and cold starts paint instantly.
- **Optimistic new chat** (A2-3): `newChat` seeds a provisional entry this tick, creates in the background via a shared in-flight create, and re-keys to the real ids in one synchronous set, migrating drafts and queue off the pseudo id (`chat.ts:933-1002`).
- **No flash on live-id rotation** (A2-5): resume merges the previous entry's content into the new live entry and deletes the stale one plus its orphans in the same synchronous block, with a guarded re-point of the active session (`chat.ts:733-796`).
- **Persist hitch removed** (A2-6): all five persist call sites go through a trailing 500ms per-chat debounce whose timer re-resolves the current entry at fire time, so JSON.stringify of a 300-message transcript never runs on the swap or turn-end frame (`chat.ts:437-462`; call sites at `chat.ts:1173,1192,1273,1764,1877`; timer cancelled in `forgetSession` at `chat.ts:1134-1138`).
- **Scroll resets on swap** (A2-7): the FlatList is keyed by stored id — a real swap mounts a clean list (reset stick/scroll state), while a live-id rotation keeps your scroll position (`app/(tabs)/chat.tsx:134-139,525-531`).
- **Single resume everywhere** (A2-8 + design): one shared, deduped in-flight resume per stored id (`chat.ts:803-815`) so a switch, a racing send, and the boot/deep-link paths can never mint two live handles and split history. Deep links consume a fresh pending target before falling back to last-session (`chat.ts:872-880`).
- **Boot paint** (A2-9): cold start seeds the placeholder + cached transcript and activates immediately, then resumes (`chat.ts:821-832`).
- **Failure surface** (rev): a `chatBanner` atom renders as a tap-to-retry strip on the chat screen, styled like the offline banner; sessions.tsx's switch/new Alert catches are downgraded to no-ops with the banner as the surface (`chat.ts:230`, `chat.tsx:515-523`, `app/(tabs)/sessions.tsx:98-109`). The delete-confirmation Alert flow is untouched (`sessions.tsx:112-132`).
- **RPC ids** (rev): every slash/completion path resolves the session through `activeLiveId()` so optimistic placeholder keys never reach the gateway (`chat.ts:906-918`; used at `chat.tsx:214,264,983`).

### Everything else

- **extraData memoized** (A2-11): identical value, Fabric contract untouched — keystrokes and the 1Hz recording timer stop paying an O(messages×segments) rebuild (`app/(tabs)/chat.tsx:464-473`).
- **Haptics off the send path** (A2-13): `void Haptics.impactAsync(...)` fires before the await (`chat.tsx:313,324,331`).
- **Storage awaits off the swap path** (A2-14): last-session and id-map writes are fire-and-forget where the visible swap used to wait on them (`chat.ts:708,716,729`).
- **Skills tab instant** (A2-23): renders the in-memory catalog and only force-fetches when empty; first-ever load keeps its spinner (`app/(tabs)/skills.tsx:26,37-41`).
- **Model picker opens without a boot RPC** (A2-24): the open path uses `activeLiveId()` — a plain store read in the steady state — with the force refresh in the background; `ensureSession` stays on the apply/save paths (`src/components/ModelPickerSheet.tsx:42-64`).
- **Command options cached** (A2-25): dynamic subcommand choices are cached per command, cleared on every successful catalog fetch and on reset (`src/lib/slash.ts:80-87,99,127`); the sheet seeds from the cache so repeat opens are instant, and only successful loads are cached (`src/components/CommandOptionsSheet.tsx:48-77`).
- **Settings churn gone** (A2-26): subscribes to a computed message *count* instead of the messages array; clipboard handlers read the live array imperatively (`app/(tabs)/settings.tsx:97,126,136`).
- **Splash tap-to-skip** (A2-27): tapping anywhere stops the intro and starts the exit fade; natural timings unchanged (`src/components/AnimatedSplash.tsx:46-68,83-88`).

## Considered and not done

**Merged as duplicates (8 findings)** — verified to be the same defect as a keeper, not dropped as wrong:

- *Drawer close-stutter onOpen* → merged into the refresh-on-open fix (A2-20); the alternative (fire onOpen at close-animation completion) was rejected because it still lands the 200-row write mid chat-swap.
- *ScreenShell 30Hz re-render*, its node-repro variant, and the "every flush re-renders every screen" umbrella → one root cause, merged into the render-perf keeper (A2-4). Its nanostores repro was re-run against installed 1.5.2 and confirmed (31 notifications for 30 flushes on fresh array identities vs 2 on joined-string/boolean).
- *Sidebar rows un-memoized* → duplicate of the RecentRow keeper (A2-18).
- *Slash palette mounts 120 rows* → merged with the palette-virtualization keeper (A2-12) so one fixer owns the palette.
- *persistSession stringify at turn end* → duplicate of the debounce keeper (A2-6), extra call sites folded in.

**Deliberately out of scope this pass** (owned by the render-perf cluster, by plan):

- **A2-4** — stable store identities in `chat.ts` so stream flushes stop re-rendering ScreenShell/sessions at ~30Hz. This is the biggest remaining known perf item; the Settings-tab consumer slice was done separately (A2-26) because it was self-contained.
- **A2-10 / A2-12** — slash palette debounce and virtualization. The palette's session resolution did move to `activeLiveId()` (`chat.tsx:214,222`), but the 120ms timer and ScrollView remain.

**Skipped — outside every owned file set, needs an owner:**

- **A2-28** — `src/lib/gateway.ts` reconnect ordering (start `cli.connect` before/alongside the config storage writes). ~~Not edited by anyone this pass.~~ **UPDATE (2026-10-07): done since — `dial()` now persists concurrently with the handshake (`persistChain` runs un-awaited alongside `cli.connect`), so this item is closed; the line above is kept for history.**
- **A2-29** — voice-transcribe base64 encode stutter in `src/lib/voice.ts`. Also needs a product call: a lower-bitrate preset trades transcription quality, and an upload path would change the gateway's `/api/audio/transcribe` contract.

**Known platform limits accepted:**

- Android 10+ gesture navigation owns the left-edge swipe — there is no `systemGestureExclusion` API in RN 0.86.3 (verified by grep over `node_modules/react-native/Libraries/`) and react-native-gesture-handler is not installed. On gesture-nav devices the edge swipe will trigger system back; the drawer at least closes via the BackHandler subscription (`Sidebar.tsx:321-328`).
- The 28dp edge strip swallows taps that start inside it (RN has no touch re-dispatch). It starts below the top bar so the hamburger is fully tappable; the accepted dead zone is the bottom-left ~16dp (with hitSlop) of the chat composer's attach button.

## What is verified

- `npm run verify` completed successfully after the command-output suite was wired into the gate: app/scripts typecheck, protocol, imports, live gateway, session order, chat list, attention, queue, slash, interactive, and command-output suites.
- `scripts/test-command-output.ts`: 58 passed, 0 failed.
- Not verified on a physical device or emulator; no profiler timing measurements were taken.

## Still needs hands-on verification (device/emulator)

1. **Android 10+ gesture-nav AVD**: confirm the left-edge swipe triggers system back and that the drawer closes cleanly when open (BackHandler), and that 3-button-nav devices get the real edge-swipe open.
2. **Hamburger tap offsets**: tap the hamburger at several x positions to confirm the edge strip never eats it (strip starts at `insets.top + 56`, `Sidebar.tsx:125,550`).
3. **Render-cost matrix row**: visit all six tabs, then edge-swipe the drawer open on each — confirm no first-open jank now that unvisited tabs carry only the strip and visited tabs carry the tuned list.
4. **Dead-zone feel**: try tapping the chat composer's attach button at its bottom-left corner; confirm the accepted ~16dp strip is not annoying in practice.
5. **Web**: Tab through the page with the drawer closed — nothing drawer-owned should be focusable; open the drawer, focus the search, close it — focus should be released and the panel gone from tab order (`display:'none'` after the close animation).
6. **Switch feel against a real gateway**: rapid A→B→C row taps, New Chat double-taps, send-during-new-chat-window, offline switch (cached transcript + retry strip), and cold start into a long conversation (boot paint).
7. **Voice transcription stutter** — unchanged this pass (A2-29 skipped); if it still hitches on long recordings, it needs its own owner.

---
*Generated from the speed-pass implementation log; every code claim cites `path:line` in the working tree at report time.*
