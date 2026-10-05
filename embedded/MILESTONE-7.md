# Milestone 7 — Embedded-mode UI polish

Status: **implemented, built (44-pin verified), knock logic host-verified.**
On-device acceptance is the manual step (phone was unplugged at build time).

## What was built

### 1. Automation knock notifications (the "silent background jobs" gap)

hermes' `deliver: local` has no live adapter under embedded serve, so
background jobs ran and saved output but never pinged the user
(`delivery_outcome: suppressed` in `executions.db`). No execution event
exists on the gateway either — only `cron.changed` (list-refetch).

Fix: an in-process watcher bridging Python → Kotlin via Chaquopy interop:

- `moch/cron_knocks.py` — daemon thread polls
  `<home>/cron/executions.db` (read-only, 15s interval). First pass primes
  the seen-set (never knocks for history); each NEW `completed`/`failed`
  row fires the injected Java notifier with job name (from `jobs.json`)
  and error text when failed.
- `CronKnockNotifier.kt` — posts a local notification on the existing
  `hermes-alerts` channel (created idempotently), tap-through to the app.
- Wired in `HermesRuntime.start` after the gateway comes up.

Works while backgrounded because the M6 foreground service holds the
process (both sides live in it). Host-verified: old rows don't knock, new
completed/failed rows knock with correct text.

### 2. Settings → "ON-PHONE RUNTIME" section

- **Live status row** (5s polling): running/starting/unavailable +
  `hermes 0.21.3 · 127.0.0.1:9119`.
- **Restart runtime** → `restartApp` (alarm relaunch + process exit; true
  fresh CPython).
- **Battery optimization → exempt** → the sanctioned system dialog
  (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`); state-aware label.
- **Stop runtime** (danger) → `stopEmbeddedRuntime` → service stop +
  process exit.

### 3. Earlier-in-arc UX fixes that belong to this milestone

- Returning users skip onboarding straight to chat (`index.tsx`).
- Loopback dials wait out the runtime boot and surface real runtime errors
  (`gateway.ts`), so "connecting" is honest instead of scary.

## Deliberately deferred

- **Files browser screen** — the agent covers workspace file ops via chat;
  a dedicated browser is post-M8 if still wanted.
- Knock payload richness (output excerpt) — currently name + status/error;
  reading the job's output file into the notification can ride on the same
  watcher later.

## On-device acceptance

1. Install → Settings → **ON-PHONE RUNTIME** shows "running" with port 9119.
2. Schedule a 2-minute automation, background the app → expect a
   **notification when it finishes** ("\<name\> finished" / "failed" + error).
3. Battery row → system dialog appears; accept; row shows "exempted".
4. Restart runtime → app closes and relaunches itself; runtime returns in
   ~10s.
5. Stop runtime → app exits fully; relaunch restores everything.
