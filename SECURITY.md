# Security posture notes

This file records deliberate, reviewed security trade-offs in Moch so the next auditor reads the decision, not just the mechanism.

## Two different relays

| Term | Status | Purpose |
|---|---|---|
| **Local CDP relay** | Current | `CdpRelay` proxies the app's WebView DevTools socket to a token-gated loopback listener so on-device Hermes browser tools can control the Moch Browser. It is not a remote-gateway service. |
| **Remote WebSocket relay** | Legacy; retired from the current product path | `relay/` and `moch-link/` connected stable **v1.0.0** phones to Hermes machines elsewhere. Current CI builds do not require it. |

The current development build is **1.0.53-beta.3, versionCode 58**. Its standard path boots the embedded on-device Hermes control plane and can run OpenCode inside Moch Linux. Stable **v1.0.0** is the legacy linked/relay-only build and does not contain that embedded runtime or OpenCode.

Local-first describes the control plane, not zero network traffic. Hosted model providers, OpenCode's free hosted models, downloads, OTA, push registration, web browsing, web search, remote MCP servers and terminal commands may still use the internet.

## Current local CDP browser relay

### WebView debugging is enabled in release builds (accepted posture)

`MainApplication.onCreate` calls `WebView.setWebContentsDebuggingEnabled(true)` process-wide, in every build type, including production. This is a **functional requirement, not an oversight**:

- The agent's browser tools run over CDP. `CdpRelay` (see `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt`, `connectUpstream()`) is a loopback proxy to this app's WebView DevTools abstract Unix socket `webview_devtools_remote_<pid>`. That socket **only exists while debugging is enabled** — gating it on `BuildConfig.DEBUG` would disable every `browser_*` tool in release builds.
- The local relay must be alive from process boot, including `START_STICKY` restarts where no React Native UI ever mounts; that is why the enable call lives in `Application.onCreate` rather than behind the Browser screen.
- This local relay does not connect to, replace or expose the retired remote WebSocket relay.

### Actual attack surface (verified 2026-10-12)

- The DevTools endpoint is an **abstract-namespace Unix socket** — there is no network path to it, on-device or off-device.
- Other apps on the phone **cannot** connect: Chromium's `SO_PEERCRED` peer check (the same mechanism the local relay itself relies on) rejects different UIDs. The local relay's loopback TCP listener (`127.0.0.1:9334`) is token-gated with a random per-install token in app-private storage.
- The one real path is **adb**: `adb forward localabstract:webview_devtools_remote_<pid>` → `chrome://inspect`, which requires USB debugging (or paired wireless debugging) **and a previously RSA-authorized host** — physical access plus an already-trusted debugging machine, not a remote or unauthenticated vector.
- Blast radius if that precondition is met: the **shared WebView profile** (cookies/local storage of sites opened in the Moch Browser screen and by the agent's resident tab). Logins typed there are readable.

### If this posture must change

A separate, non-debuggable WebView profile for authenticated browsing (or dropping the Browser screen's shared profile) would decouple user logins from the agent's CDP surface. On-demand scoping of the debug flag was evaluated and rejected during BUG-132 — boot-alive is the feature.

## Retired remote WebSocket relay

The `relay/` server and the `moch-link/` tunnel were the network path used by stable **v1.0.0** linked setups. They paired a phone with a Hermes gateway on another machine and routed WebSocket traffic through a remote service. They are not part of the standard current local-first CI path.

Historical relay documentation remains in [`relay/README.md`](relay/README.md), and historical linking instructions remain in [`moch-link/README.md`](moch-link/README.md). Keeping that code and documentation does not make a remote relay necessary for current builds.

## Related notes

- `usesCleartextTraffic="true"` is app-wide as of writing; pairing/transport gating is tracked separately (see `bugs.md`, audit item C-05).
- Release signing intentionally fails fast without `android/keystore.properties` (audit item C-04); the stock React Native template `debug.keystore` is no longer tracked.
