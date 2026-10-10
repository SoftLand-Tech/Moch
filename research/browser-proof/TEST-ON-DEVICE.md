# Moch Browser — device verification runbook

The PC proofs (research/browser-proof/) verified the full Python path against
real Chromium. What only a real device can verify is the Kotlin relay against
a real Android WebView (abstract unix socket + SO_PEERCRED + DevTools-over-
WebView semantics). This runbook is for the session with the phone on adb.

## Pre-reqs
- Phone on adb (`adb devices` shows it), Moch debug/release APK installed.
- This branch built: `cd app/android && ./gradlew assembleRelease` (arm64-only;
  a real device, NOT the x86_64 emulator).

## Order (10 min)

1. **Relay up + state file.** Open the Browser screen (drawer → Browser).
   Then check on the device (or `adb shell run-as com.hermes.pocket`):
   `files/.hermes/browser/relay.json` must exist with `{"token","port","pid"}`.
   `adb logcat -s CdpRelay` should show `relay up on 127.0.0.1:<port>`.

2. **DevTools socket exists.** With a tab open:
   `adb shell cat /proc/net/unix | grep webview_devtools_remote_<pid-from-json>`
   — the abstract socket must be listed.

3. **/json/version through the relay** (port-forward the relay port):
   `adb forward tcp:19334 tcp:9334` (port from relay.json), then on the PC:
   `curl http://127.0.0.1:19334/<token>/json/version`
   Expect: Chromium `Browser` field, rewritten `webSocketDebuggerUrl`,
   `"Moch-Browser-Level": false`. Bad token → 403.

4. **/json/list filter.** With exactly one tab on `https://example.com`:
   `curl .../<token>/json/list` → exactly ONE target, url = example.com.
   Open a second tab, switch — the filter must follow the VISIBLE tab
   (or fall back to the first when 0 or 2+ match — documented degradation).

5. **Agent end-to-end.** In chat: "Open example.com in my browser and click the
   More information link". The agent should:
   - attach (logcat: `per-page attach (WebView mode) -> https://example.com`)
   - navigate the VISIBLE tab (watch it move)
   - snapshot with refs, click, screenshot into workspace.
   Then: "search google for hermes agent and open the first result" — multi-step.

6. **Sessionless dialog path.** On a page with `alert()`: ask the agent to press
   the button; the dialog must appear in chat (Fetch bridge, sessionless) and
   accept/dismiss must unblock the page.

## Known device-only risks (from the spec, watch for these)
- WebView DevTools HTTP Host check: we send `Host: localhost` — should pass.
- `Target.getTargets` on WebView: relay never issues it in per-page mode; if
  any STOCK path slips through, you'll see "Inspected target navigated" or a
  500 — check which branch ran in logcat.
- Cookie persistence: reload a logged-in site after app restart (CookieManager
  flush on pause is B1 polish — may lose cookies until then).

## Rollback
Browser screen never started ⇒ relay.json absent ⇒ BROWSER_CDP_URL unset ⇒
browser tools fall back to stock behavior (PC/linked mode unchanged).
