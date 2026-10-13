# Browser speed & native pass — what changed and why

A focused pass over the Moch Browser (the visible multi-tab WebView pool the
embedded agent drives over the CDP relay). Produced by a 13-agent research
fleet (10 parallel auditors over RN UI, WebView config, the Kotlin relay, the
Python attach path, cold start, native gestures, external best practice, bug
history, races, and memory — then 3 adversarial verifiers), followed by a
contract-guarded implementation of the safe tier. 59 findings total; the
implemented subset is everything surgical + low-risk. Contracts C1–C5 and
every fixed bug (BUG-104/105/107/116/118/125/127/133/136) are preserved by
construction — see "What is verified".

## What you should feel

**Opening the Browser.** The chrome and the first tab paint on the first
frame when the relay is already up (it boots at app launch via
AgentBrowserHost) — no more full-screen spinner serializing relay check →
tab create → WebView mount → DNS. The relay check still runs, in parallel,
and its failure still shows the retry screen.

**Loading a page.** A Chrome-style 2dp progress bar under the URL row tracks
`onLoadProgress` of the visible tab and fades out at completion — replacing
the old "… " prefix on the tab title as the only load signal. The tab strip
no longer re-renders the entire pool several times per load (store writes are
change-guarded, and the pool/tab-strip/URL rows are memo boundaries).

**Navigating history.** The URL row gains ← / → buttons gated on live
`canGoBack`/`canGoForward`, and the hardware Back button now goes back
*in the page* before leaving the screen (Ask row closes first; an open
drawer still wins — Sidebar's handler registers only while open, and
last-registered runs first). Previously Back always exited the screen.

**Reloading.** The reload button calls `ref.reload()` on the live WebView
instead of remounting it. The old key-bump recreated the renderer, minted a
NEW DevTools target id (agent attach churn, stale-target 409s) and reloaded
the originally-REQUESTED url, not the live one.

**Typing in the URL bar.** Keystrokes re-render only the URL row (it owns
its draft state). Tapping the field selects the whole address; a clear (✕)
appears while editing; submitting blurs the keyboard. `selectTextOnFocus`,
submit-blur and clear follow the Sidebar-search house patterns.

**Touch feedback.** Light haptics (fire-and-forget, the chat.tsx pattern)
on URL submit, reload, back/forward, tab switch and new tab; a selection
tick on tab close.

**Every app start.** The always-on agent host WebView parks at
`about:blank` instead of fetching `https://example.com` — the DNS+TLS+HTML
round-trip per cold start is gone; the DevTools page target it exists to
provide registers exactly the same way. The Kotlin relay hides BOTH host
prefixes from tab listings, so a mixed JS/native deploy (OTA ahead of the
native build or behind it) never leaks the host page into the agent's tab
list.

**Agent-driven browsing.** `browser_navigate` now returns the compact
snapshot its schema always promised (one saved LLM round-trip per
navigation), settles with ONE CDP eval per poll at a 0.1s cadence instead of
three serial evals on a 0.4s cadence, and `browser_tab_create` stops waiting
out its 5s deadline for a title that arrives asynchronously. A swallowed
TypeError in the webview snapshot truncation path is fixed — snapshot
thresholds (and the spill-to-file paging note) now actually run in webview
mode.

**The relay itself.** HTTP head parsing is buffered (it read one byte at a
time across JNI on both legs), the Content-Length regex is hoisted (it
recompiled per upstream response, including every tab-open poll iteration),
tab-open resolution polls 40ms-first then backs off to 250ms (was a flat
250ms — ~125ms average added latency per agent tab open), the WS pump
buffers dropped from 1MiB to 64KiB per direction (2MiB → 128KiB resident
per tunnel), and `tabTargets` moved off the native-modules bridge thread
(it did LocalSocket I/O there on every URL sync/tab op, stalling the bridge).

## What changed, per file

### `app/app/(tabs)/browser.tsx` (rewritten, same contracts)

- **Instant paint** — `booting` hydrates from `relayStatus.get()`; the first
  `addTab` fires immediately and `ensureBrowserRelay()` runs in parallel
  (C2 intact: agent attach goes *through* the relay, which only answers once
  ensure resolves). BUG-118 retry + AppState re-arm preserved.
- **Ref-based reload** — per-tab `wvRefs` map; `reloadNonce` and its key
  segment deleted (`renderKeys` stays the only remount path, for
  BUG-116/BUG-136 render-process recovery, which keeps its setTimeout AND
  gains an event-driven re-map on `onLoadEnd`).
- **Back/forward + hardware Back** — per-tab `canGoBack/canGoForward`
  tracked from `onNavigationStateChange`; ←/→ buttons in the URL row; a
  Platform-gated BackHandler (Ask-row close → page back → default).
- **Progress bar** — `onLoadProgress` → reanimated shared values → 2dp bar
  under the URL row; resets on tab switch; only the visible tab drives it.
- **Render storms killed** — `updateTab` change-guard (browserRelay.ts),
  memoized `TabChip` / `TabPage` with stable per-tab handler bundles and a
  memoized `source={{uri}}`, and `UrlRow`/`AskRow` extracted so drafts are
  row-local (SPEED_REPORT A2-4/A2-18 patterns).
- **Layout** — the screen's own top `SafeAreaView` edge is gone (ScreenShell
  already insets the top bar — this killed a double status-bar band); bottom
  behavior is byte-identical (the pool's kbPad stays the single IME owner,
  BUG-133's verified pattern).

### `app/src/lib/browserRelay.ts`

- `updateTab` shallow-compares the patch before setting — no-op writes (most
  nav-state repeats) no longer mint array identities that re-rendered the
  whole screen.

### `app/src/components/AgentBrowserHost.tsx`

- `AGENT_START_URL: 'about:blank'` (zero network per start; target parity).
  Lockstep: `CdpRelay.AGENT_TAB_URL_PREFIXES` hides both prefixes.

### `app/android/.../CdpRelay.kt`

- Buffered head parsing on client + upstream legs (the tunnel pumps consume
  the SAME buffered streams — no bytes lost).
- `CONTENT_LENGTH_RE` hoisted; `PUMP_CHUNK` 1MiB → 64KiB.
- `resolveOpenedPage` front-loads its poll (40ms × 6, then 250ms; same
  3s deadline and fallback).
- `AGENT_TAB_URL_PREFIXES = [about:blank, https://example.com/]` — both
  hidden (deploy-order-safe).

### `app/android/.../BrowserRelayModule.kt`

- `tabTargets` resolves on a background thread (the ensureRunning shape) —
  no more LocalSocket I/O on the bridge thread.

### `app/hermes-src/tools/browser_webview.py`

- `webview_snapshot` compact mode actually truncates (the `full=` kwarg
  TypeError is gone); `full=True` still returns the raw text.
- `webview_navigate`: merged settle eval (href+title+readyState in one),
  0.1s cadence, and a best-effort auto-snapshot merged into the response
  (never fails the navigation).
- `_poll_new_tab` breaks when the URL lands (title is best-effort display
  metadata) and polls at 0.15s.

## Deliberately NOT done (the roadmap, ordered)

1. **Edge-swipe back/forward** (fleet F1/R8) — two inset 24-28dp PanResponder
   strips over the pool, Sidebar A2-21 pattern, gated on canGoBack. Medium
   effort, needs on-device tuning against Android 10+ gesture nav.
2. **Full-size stacked pool** (R7) — all pages absolute inset-0 with
   opacity toggling instead of 1px parking: kills the relayout/reflow on
   every tab switch and gives parked tabs real-resolution screencast
   surfaces. Amends C1's mechanics (not its invariants); needs a memory
   check with many tabs.
3. **Renderer priority demotion** (R6) — inactive tabs + agent host at
   RENDERER_PRIORITY_LOW via a small BrowserRelayModule hook. Needs native.
4. **Relay upstream-list memo** (K1) — ~200ms TTL around upstreamPages(),
   invalidation on tab ops; also embeds the active target id in /json/version
   to skip a probe on first attach.
5. **Tab-strip layout animations** (F5) — reanimated entering/exiting/
   LinearTransition on the pills + Ask-row fade.
6. **Python supervisor self-heal** (LAT-3/5) — treat an inactive (backoff-
   parked) supervisor as missing + interruptible stop(); cache the
   Moch-Browser-Level probe per process.
7. **Warming indicator + pre-warm follow-ups** (OPEN-2/OPEN-3, GH #148) —
   a schema-valid `moch.browser.status` RPC rendered as a "Browser warming
   up…" chip; per-turn toolset resolution to kill the cold-kit window.
8. **Start page** (CS-03) — a local quick-start page instead of google.com
   (needs the URL-bar autofocus + search-fallback wiring done together).
9. **ScreenShell boot-loader dedup** (CS-06) — one-shot the session/catalog
   loaders so a first Browser mount doesn't contend with them.
10. **Pull-to-refresh** — infeasible as-is: `pullToRefreshEnabled` is
    iOS-only in react-native-webview 13.16.1, and a JS-side PTR cannot see
    the page's scroll offset without injected postMessage. Only do the
    URL-row pull variant if users ask.

## How this was produced

13 subagents in a `moch-browser-speed-native` workflow: ui-render-perf,
webview-config, kotlin-relay-perf, python-attach-perf, startup-cold-path,
native-gestures-ux, web-best-practice, open-bugs-sweep, races-and-remounts,
mount-and-memory (audit phase) → contract-guard, prioritizer, ux-critic
(verify phase). 59 findings; the implemented set is the intersection of
{high perceived impact} × {effort S} × {low risk} × {passes contract guard}.
The verify-phase output was partially truncated in transit; the Lead
re-guarded every implemented finding against the source directly.

## What is verified

- `npm run typecheck` — clean.
- `npm run lint` — 0 errors (32 pre-existing unused-disable warnings repo-wide).
- `npm run verify` — full 20-suite chain green (includes `test:browser-relay`
  over the rewritten store; `test:slash` passed standalone 27/27 after one
  environmental live-gateway settle race in the first chain run, then green
  in the full rerun).
- `python3 -m unittest discover -s tests` in `python-runtime` — 258 tests,
  OK (9 skipped), including the browser tool suites over the changed
  navigate/snapshot/poll paths.
- `:app:compileDebugKotlin` — **BUILD SUCCESSFUL** (the only warning is a
  pre-existing deprecation in the unrelated ShareInPackage.kt).

## Still needs hands-on verification (device)

- First Browser open: chrome paints immediately when the relay is up; relay
  error path still shows retry.
- Progress bar: tracks load, fades at 100, resets on tab switch and on the
  agent driving a background tab (must NOT move).
- Hardware Back: closes Ask row → goes back in page → exits screen; drawer
  back still closes the drawer when open.
- Reload: page reloads at the LIVE url, DevTools target id unchanged (watch
  `refreshTabTargetIds` churn in logs), agent keeps driving without
  "No browser page".
- about:blank host: tools advertised at boot, attach works with the Browser
  screen closed, `browser_tab_list` shows no phantom host tab.
- URL bar: focus selects-all, clear works, submit blurs, keyboard avoidance
  unchanged (BUG-133 patterns) — pool kbPad still the single owner.
