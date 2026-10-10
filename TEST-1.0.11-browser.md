# What to test — 1.0.11-browser (versionCode 14)

Browser feature, first on-device build. ~5 minutes, in-app only.

## Setup (one time)
1. Install the APK over the current one (same key — updates in place).
2. Open Moch → drawer (☰) → you should see a new **Browser** row under Chat.

## Test 1 — The browser itself
3. Tap **Browser**. A tab opens on google.com. Type a search, tap a result —
   normal browsing must feel normal (scroll, zoom, back).

## Test 2 — The agent drives the VISIBLE tab
4. Tap the ✨ (sparkles) button right of the address bar.
5. Type: `Find the Wikipedia article about cats and open it`
6. Send it. EXPECT: the browser tab itself navigates (google → results →
   Wikipedia) while you watch, and the chat streams the agent's steps.
   THE POINT of this feature: the agent moves the page you are looking at.

## Test 3 — Refs and clicks
7. Ask: `click the first link in the article body`
8. EXPECT: the visible page changes; the agent reports which link it clicked.

## Test 4 — Ask Moch on the current page
9. Navigate somewhere manually, tap ✨, type: `summarize this page`
10. EXPECT: composer prefills with the page URL + your ask (nothing auto-sends);
    tap Send; agent reads the live page and answers with real content from it.

## What failure looks like (send me the verbatim text)
- Browser row missing → JS bundle issue.
- "Browser relay unavailable" red screen → relay/native issue (screenshot it).
- Agent says browser tools are unavailable → boot gate didn't flip (check the
  exact wording — it distinguishes which gate failed).
- Tab doesn't move while the agent "works" → attach went somewhere else; grab
  the agent's chat text verbatim.

## If it all works
Cookies/logins persist across app restarts (Chrome-style). Logging into a
site in the Browser tab once means the agent stays logged in on later tasks.
