# Change Report — Automation Knocks & Runtime Controls

Scope: everything committed between your last tested build and now.
Commits: `8c8ea0d` (M7), `6ce6671`, `cfdfc0e`, `700d3ff` (+ earlier arc fixes
`3451114`, `57dba09` already in your build). APK:
`app/android/app/build/outputs/apk/release/app-release.apk`, 113 MB.

## 1. Automation knocks — why they exist at all (`8c8ea0d`)

**Problem:** hermes' `deliver: local` has no live adapter under embedded serve,
so background jobs completed with `delivery_outcome: suppressed` — execution
recorded, output saved, **nobody notified**.

**Solution (two new files + one wiring point):**
- `app/python-runtime/moch/cron_knocks.py` — daemon thread watching
  `files/Moch/cron/executions.db` (read-only, every 15 s). For each newly
  finished run it calls an injected Android notifier with the job name
  (from `jobs.json`) and the error text when failed.
- `app/android/.../CronKnockNotifier.kt` — posts the local notification on
  the existing `hermes-alerts` channel; tap-through opens the app.
- `HermesRuntime.kt` — after the gateway is up, hands the notifier object to
  Python (Chaquopy interop) and arms the watcher.

Works while backgrounded because both sides live inside the
foreground-service process.

## 2. The three bugs you found by testing (each fixed, each verified)

### 2a. First execution swallowed (`6ce6671`)
The watcher's "don't notify for old runs" logic primed its seen-set on the
**first successful database read**. On a fresh install the database doesn't
exist until the *first job finishes* — so that job's own row was classified
as history and never knocked. Fix: prime exactly once on the **first loop
iteration** (empty if no DB yet). Host-verified with the no-DB-then-first-run
scenario.

### 2b. Notification permission (`cfdfc0e`)
The foreground-service notice is **permission-exempt** on Android 13+, so a
fresh install shows "Moch agent is running" while every regular notification
(knocks) is silently dropped without the `POST_NOTIFICATIONS` runtime grant.
The app only asked on first message-send. Fix: permission is now requested at
**"Use this phone" pairing** — the embedded flow's natural moment.
(Manual workaround that also works immediately: Settings → Apps → Moch →
Notifications → allow.)

### 2c. The silent interop collision (`700d3ff`)
Our Kotlin method was named `notify` — colliding with the **final
`java.lang.Object.notify()`** threading primitive. Chaquopy's Python→Java
overload dispatch on that name is unreliable, and our catch swallowed the
failure. Fix: renamed to `knock` in both languages; **every attempt now logs
to logcat** (`[cron-knocks] firing knock: …` or
`notify failed: <type: reason>`), so a failure can never hide again.

## 3. Settings → "ON-PHONE RUNTIME" (`8c8ea0d`)

Live status row (5 s poll: running/starting + `hermes 0.21.3 · 127.0.0.1:9119`),
**Restart runtime** (true fresh Python: alarm relaunch + process exit),
**Battery optimization → exempt** (system dialog — helps MIUI kill less),
**Stop runtime** (red: service stop + process exit). Also the returning-user
fix: saved pairing now skips onboarding straight into chat.

## 4. Also in your build from the same arc (for completeness)

- `3451114` — automations never fired on schedule: hermes' in-process cron
  ticker only arms under `HERMES_DESKTOP=1`; now set. Device-verified
  (background fire produced `BACKGROUND TEST OK`).
- `57dba09` — real Stop teardown, restartApp relaunch, battery-exemption
  bridge.

## Verification status

| Change | Verified by |
| --- | --- |
| Knock logic (no-DB, first run, failure path) | Host harness, 3 scenarios |
| `notify`→`knock` contract | Host harness + compile |
| Permission flow | Code path + Android 13 semantics (needs your retest) |
| Settings section | Typecheck + build |
| Pins inside APK (44) | `embedded/verify-apk-python.py` |

**Not yet device-verified:** a knock actually appearing on the phone —
that's the one open item, pending your install + 2-minute job test.

---

# ADDENDUM — live device diagnosis (phone plugged in, root causes found)

Your persistence paid off. Two **real** root causes were found by running the
instrumented build on the device (`6782b0d`):

## Root cause A — split home (why the watcher saw nothing)

hermes resolves its home to **`$HOME/.hermes`** (its platform default), while
`moch/hermes_boot.py` assumed **`$HOME/Moch`**. Result: hermes wrote
config/state/**cron** under `files/.hermes/`, the watcher polled the empty
`files/Moch/cron/` — `db-missing`, forever. The app *looked* fine because
everything else (workspace, token, gateway) used the Moch home consistently.

Fix: `_hermes_home()` now mirrors hermes' own resolution (`HERMES_HOME` env,
else `$HOME/.hermes`) and `HERMES_HOME` is pinned explicitly at boot.
Side effect: the gateway token file moves to `.hermes/` (new token) — handled
automatically by the live-token refresh added earlier.

## Root cause B — R8 renamed the interop method (why the call then failed)

With the DB finally found, the watcher logged:

    [cron-knocks] firing knock: Awesome finished
    [cron-knocks] notify failed: AttributeError: 'a' object has no attribute 'knock'

The release build's R8 **renamed `CronKnockNotifier.knock()`** (class showed
as `'a'`), so Chaquopy's reflective lookup failed. This never appears in debug
builds. Fix: keep rule `-keep class …CronKnockNotifier { public *; }`.

Also fixed: job names read `id` from `jobs.json` (the file uses `id`, not
`job_id` — titles showed raw ids).

## Device evidence (19:01)

    [cron-knocks] arming watcher (notifiers=1)
    [cron-knocks] firing knock: Awesome finished
    dumpsys notification: android.title=String (Awesome finished)

**Knocks now land on the phone.** Report closed.

