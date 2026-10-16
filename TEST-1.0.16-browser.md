# What to test — 1.0.16-browser (speed + native pass, BUG-140..146)

One pass over the Browser screen + relay + agent tool path: instant open,
ref-based reload, in-page back/forward, a load progress bar, haptics, and
agent-latency cuts. Nothing protocol-level changed — CDP attach semantics,
tab lifecycle round-trip, UA and the BUG-104/105/107/116/118/125/127/133/136
fixes are untouched. ~6 minutes, in-app only. Install over the current build
(same key). Full detail: `BROWSER-SPEED-REPORT.md`.

## Test 1 — open feels instant, first load has feedback (BUG-144/142)

1. Use the app a bit (Chat), then open **Browser** from the drawer.
   EXPECT: chrome + tab strip + URL row paint immediately — NO full-screen
   "Starting the browser relay…" spinner (the relay booted at app launch).
   A 2dp accent progress bar fills under the URL row while the first page
   loads, then fades out.
2. Kill the app, reopen, go to Browser IMMEDIATELY (relay still booting).
   EXPECT: brief spinner is allowed once, then chrome paints; no dead end.
3. Type an address, submit. EXPECT: bar runs again; keyboard dismisses on Go.

## Test 2 — reload no longer remounts the page (BUG-140)

4. Open any page, tap reload. EXPECT: fast reload at the LIVE url. Navigate
   within the site first (click a link), then reload — it must reload the
   page you are ON, not the one you originally typed.
5. With the agent driving: ask it to click something, then tap reload
   yourself, then ask it to click again. EXPECT: no "No browser page…"
   (the DevTools target survived; no re-attach churn).

## Test 3 — back/forward behaves like a browser (BUG-141)

6. Navigate 2-3 pages deep. EXPECT: ← enables, works; → works after going
   back; both gray out appropriately.
7. Hardware Back: EXPECT: closes the Ask row if open → else goes BACK IN THE
   PAGE (not out of the screen) → only exits the screen at page-history
   bottom. With the drawer open, Back still closes the drawer first.
8. Edge case: rotate/theme change — buttons still reflect the active tab.

## Test 4 — typing never stutters, tabs are quiet (BUG-143)

9. Open 3+ tabs, load a heavy page in one, and type fast in the URL bar of
   another. EXPECT: no jank; the loading tab's title updates without the
   whole strip flashing; tab switch/reset feels instant.

## Test 5 — agent latency + always-on host (BUG-145/146)

10. Cold-start the app, go straight to Chat, ask `open example.com in your
    browser`. EXPECT: tools advertised (host target at about:blank),
    navigate returns with a snapshot inline (the model should NOT need a
    separate browser_snapshot before clicking), clicks feel a beat quicker.
11. `browser_tab_list` / multi-tab: EXPECT: no phantom "about:blank" host
    tab listed; open/close/switch tabs via the agent still round-trips
    (mochTabOp) and lands on the right tab.

## What failure looks like (send verbatim text / logcat)

- Spinner on every open with the relay already up → BUG-144 regression.
- "No browser page…" after a reload → BUG-140 regression (grab logcat
  `CdpRelay` + hermes lines).
- Back exits the screen with page history present → BUG-141 regression.
- Extra "about:blank" tab in the agent's tab list → BUG-146 lockstep break
  (JS and native halves must ship in the SAME build).
- Progress bar stuck on screen / moving while the agent drives a background
  tab → BUG-142 regression.

## PC-side verification already done (no device needed)

- `npm run verify` — full chain green (typecheck, lint, 20 suites incl.
  `test:browser-relay` 34/34).
- `python3 -m unittest discover -s tests` in `python-runtime` — 258 tests OK
  (9 skipped), including the browser tool suites over the changed
  navigate/snapshot/poll paths.
- `:app:compileDebugKotlin` — BUILD SUCCESSFUL.
