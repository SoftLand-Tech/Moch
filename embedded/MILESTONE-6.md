# Milestone 6 — Background execution

Status: **implemented + built; on-device acceptance is the manual step.**

## What was built

**`HermesService`** — a foreground service (`dataSync` type) that keeps the
process — and with it the embedded hermes runtime (CPython, gateway,
automations scheduler, in-process slash worker) — alive when Moch is
backgrounded, the screen is off, or the app is swiped away. This is the
platform-legit mechanism: no battery-optimization bypasses, no hacks.

- **Notification** (channel `hermes_runtime`, low importance, no badge):
  "Moch agent is running", tap → app, **Stop action** → explicit
  user-controlled teardown of the service.
- **Started at app boot** (`MainApplication.onCreate`, after the runtime
  boot kicks off). Start failures under background-start restrictions are
  logged and retried on next app open.
- **`START_STICKY`** — the system restarts the service (and therefore the
  process and the Python runtime) after a kill or crash. That is the
  controlled-recovery path.
- **Crash telemetry**: an uncaught-exception handler writes the last crash
  to `files/Moch/logs/crash-last.txt` (readable by the agent itself) and
  logs under the `MochHermes` tag, then delegates to the default handler.

**Manifest** (verified in the built APK): `FOREGROUND_SERVICE_DATA_SYNC`
permission + non-exported service with `foregroundServiceType="dataSync"`.
`POST_NOTIFICATIONS` was already merged via expo-notifications.

**JS surface**: `stopEmbeddedRuntime()` in `hermesRuntime.ts` → bridge
`stop()` → service teardown (M7 can hang a Settings toggle on it).

## Lifecycle status vs the original spec

| Spec call | Status |
| --- | --- |
| `startHermes()` | app boot (`MainApplication`) + START_STICKY restarts |
| `stopHermes()` | notification Stop action; `stopEmbeddedRuntime()` bridge |
| `restartHermes()` | START_STICKY covers crash/kill restarts; explicit in-app restart = process restart (v1 accepts relaunch, ~fast-boot now) |
| `isHermesRunning()` / `getHermesStatus()` | bridge `status()` / `getGateway()` (running/ready/port/error) |

Honest limits: Python cannot be unloaded in-process (Chaquopy has no
supported `Python.stop()` semantics for reuse), so "stop" stops the
*service*; Android then reclaims the process per its normal rules.

## On-device acceptance

1. Update, open, pair if needed. Notification "Moch agent is running" shows.
2. Start a long agent task, lock the screen for a few minutes → unlock:
   the task progressed.
3. Automations: schedule a 2-minute job, swipe the app away → it still
   fires (notification knock / run history).
4. Tap the service notification's **Stop** → service ends; automations no
   longer fire while swiped away until next app open.
5. `adb shell dumpsys activity services | grep -A3 HermesService` (optional)
   shows the foreground service while running.

## Notes

- Android 14+ requires the typed FGS permission; 15+ restricts starting
  FGS from certain states — we start it from `Application.onCreate` (app
  foreground path), which is compliant.
- `dataSync` is the closest honest type for an agent runtime; if Play
  policy ever matters, `specialUse` with a justification is the fallback.
