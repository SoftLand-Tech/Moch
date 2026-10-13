# Security posture notes

This file records deliberate, reviewed security trade-offs in Moch so the
next auditor reads the decision — not just the mechanism.

## WebView debugging is enabled in release builds (accepted posture)

`MainApplication.onCreate` calls `WebView.setWebContentsDebuggingEnabled(true)`
process-wide, in every build type, including production. This is a
**functional requirement, not an oversight**:

- The agent's browser tools run over CDP. `CdpRelay` (see
  `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt`,
  `connectUpstream()`) is a loopback proxy to this app's WebView DevTools
  abstract unix socket `webview_devtools_remote_<pid>`. That socket **only
  exists while debugging is enabled** — gating it on `BuildConfig.DEBUG`
  would disable every `browser_*` tool in all release builds (the
  "always-available browser" shipped in PR #61).
- The relay must be alive from process boot, including `START_STICKY`
  restarts where no React Native UI ever mounts; that is why the enable call
  lives in `Application.onCreate` rather than behind the Browser screen.

### Actual attack surface (verified 2026-10-12)

- The DevTools endpoint is an **abstract-namespace unix socket** — there is
  no network path to it, on-device or off-device.
- Other apps on the phone **cannot** connect: Chromium's `SO_PEERCRED`
  peer check (same mechanism the relay itself relies on) rejects different
  UIDs. The relay's own loopback TCP listener (127.0.0.1:9334) is
  token-gated with a random per-install token in app-private storage.
- The one real path is **adb**: `adb forward localabstract:webview_devtools_remote_<pid>`
  → `chrome://inspect`, which requires USB debugging (or paired wireless
  debugging) **and a previously RSA-authorized host** — i.e. physical access
  plus an already-trusted debugging machine, not a remote or unauthenticated
  vector.
- Blast radius if that precondition is met: the **shared WebView profile**
  (cookies/local storage of sites opened in the Moch Browser screen and by
  the agent's resident tab). Logins typed there are readable.

### If this posture must change

A separate, non-debuggable WebView profile for authenticated browsing (or
dropping the Browser screen's shared profile) would decouple user logins
from the agent's CDP surface. On-demand scoping of the debug flag was
evaluated and rejected during BUG-132 — boot-alive is the feature.

## Related notes

- `usesCleartextTraffic="true"` is app-wide as of writing; pairing/transport
  gating is tracked separately (see `bugs.md`, audit item C-05).
- Release signing intentionally fails fast without `android/keystore.properties`
  (audit item C-04); the stock RN-template `debug.keystore` is no longer
  tracked.
