# What to test — 1.0.15-browser (versionCode 18)

BUG-105 fix build: the browser tools can no longer be advertised against a
dead relay after an app restart. ~4 minutes, in-app only. Install over the
current build (same key — updates in place).

## The bug this fixes (what you saw)

After an app restart the agent listed browser tools but every call failed —
"No browser page. Call browser_navigate first (and keep the Moch Browser
screen open)" — the "the browser is dead" report. Cause: boot armed the
browser gate from `relay.json` left over by the PREVIOUS app process (the
relay only runs after the Browser screen is opened in the current one).

## Test 1 — restart, chat-first (the exact bug scenario)

1. Open Moch, open **Browser** once (drawer → Browser), let a tab load, then
   go back to Chat.
2. Force-stop the app (swipe it away) and reopen it.
3. Go STRAIGHT to Chat (do NOT open Browser) and ask: `open example.com in
   your browser`.
   EXPECT: the agent says it has **no browser tools available right now**
   (tools hidden — the gate is off because the relay is down). It must NOT
   pretend to browse or fail with "No browser page".
4. Now open **Browser** (drawer → Browser), go back to the SAME chat, and ask
   again: `open example.com in your browser`.
   EXPECT: tools are live immediately (no app restart needed) and the visible
   tab itself navigates while you watch.

## Test 2 — regression: normal agent drive

5. With the Browser screen open on any page, tap ✨ and send:
   `find the wikipedia article about cats and open it`.
   EXPECT: same as 1.0.13-browser — visible tab navigates, chat streams steps.

## Test 3 — browser screen first (open-order parity)

6. Kill the app, reopen, open **Browser** FIRST, then ask the agent to click
   something on the current page.
   EXPECT: works — screen-first order still arms the tools at boot.

## What failure looks like (send verbatim text)

- Test 1.3: agent HAS browser tools listed after a restart with Browser never
  opened → the stale gate is back (this exact bug).
- Test 1.4 / Test 2: "No browser page…" with the screen open and a tab loaded
  → attach regression (that would be BUG-104 territory — grab logcat
  `CdpRelay` + hermes lines).
- "Browser relay unavailable" red screen → relay/native issue (screenshot).

## PC-side verification already done (no device needed)

`python3 research/browser-proof/run_bug105_proof.py` → ALL BUG-105 PROOFS
PASSED (stale-file no-arm, dead-relay actionable error, full agent verb chain
through the mock relay to real Chromium, stock attach regression), plus an
A/B run proving HEAD (old) arms the stale gate while the fixed tree does not,
and the full python-runtime unit battery (106 tests).
