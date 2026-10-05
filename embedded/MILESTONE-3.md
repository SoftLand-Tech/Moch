# Milestone 3 — Message round trip over an in-process gateway

Status: **host-proven end to end except the LLM call itself** (needs a real
provider key, which is your on-device step). APK build + phone proof manual.

## Architecture decision: reuse hermes' own gateway, don't write a bridge

Instead of inventing a Kotlin↔Python message bridge, Moch now runs **hermes'
actual serve gateway in-process** (`hermes_cli.web_server.start_server`,
headless mode) bound to `127.0.0.1:9119`, exactly like the desktop shell does.
The RN client — which already speaks hermes' v7 JSON-RPC protocol over
WebSocket against the relay — connects to `ws://127.0.0.1:9119/api/ws?token=…`
instead. Zero new protocol code: chat, sessions, streaming (M4 comes free),
approvals, **and provider/API-key setup** (`model.save_key`, the existing
ProviderKeyForm flow) all work unchanged.

```
RN chat UI ── WS ws://127.0.0.1:9119/api/ws?token=T ──> embedded hermes gateway
      │                                                       │
      └── Kotlin only starts/stops it + hands out host:port/token └─> LLM API
```

## What changed

| File | Change |
|---|---|
| `app/python-runtime/moch/gateway_server.py` | NEW — boots `hermes_cli.web_server.start_server` (headless serve) on a daemon thread; readiness = TCP accept; **stable token** (`<home>/.moch-gateway-token`, 0600) + **fixed port 9119** so the saved client config survives app restarts |
| `app/python-runtime/moch/hermes_boot.py` | unchanged from M2 |
| `embedded/vendor-hermes.sh` | vendor set now includes the serve path: `tui_gateway` package + `hermes_logging.py` (found by actually booting the server — static census missed lifespan imports) |
| `app/hermes-src/` | re-vendored: 1871 files / 43 MB |
| `app/python-runtime/requirements-embedded.txt` | +fastapi/uvicorn/starlette/python-multipart/pydantic/openai (+transitives, jiter) — hermes' own pins; uvicorn WITHOUT `[standard]` (uvloop/httptools have no Android builds) |
| `embedded/build-android-wheels.sh` | NEW recipe: maturin cross-build of pydantic-core 2.46.4 + jiter 0.13.0 for aarch64-linux-android using Chaquopy's Android CPython target (Maven Central `com.chaquo.python:target:3.11.14-0-arm64-v8a`) as `PYO3_CROSS_LIB_DIR` + synthetic `_sysconfigdata` (abi3 needs only version/suffix facts; suffix `.cpython-311.so` follows the target zip's own convention); wheels retagged to `android_24_arm64-v8a` into `app/wheels-android/` (committed) |
| `app/android/app/build.gradle` | pip `--find-links ../../wheels-android` |
| `HermesRuntime.kt` | starts the gateway after hermes boot; `gatewayInfoJson()` |
| `HermesBridgeModule.kt` | `getGateway()` → {running, ready, port, token, error} |
| `app/src/lib/hermesRuntime.ts` | `getEmbeddedGateway()` |
| `app/src/components/PairForm.tsx` | **"Use this phone"** button (onboarding + Add computer): reads gateway info from the bridge, `connect({host: '127.0.0.1:9119', token, tls:false, name:'This phone'})` — pairs like any computer |

## Host verification (done)

Clean CPython 3.11.16 venv, only `requirements-embedded.txt` + vendored trees,
empty `HERMES_HOME`:

```
gateway ready on port 46597                                  (9s cold boot)
first frame: {"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready",...}}
session.active_list -> result OK
model.options -> result OK (providers, model inventory)
EMBEDDED-GATEWAY-PROOF-OK  (exit 0)
```

Also observed on the stream: `setup.ready {provider_configured: true,
inference_provider: huggingface, free_tier: false}` — hermes' free-tier
bootstrap works, meaning a fresh install has a working no-key path too.
`tsc --noEmit` clean. Android wheels for pydantic-core and jiter are **built
and committed** under `app/wheels-android/` (verified: correct
`cp311-cp311-android_24_arm64_v8a` tags, `.cpython-311.so` module names,
zip integrity).

## Your manual steps

1. ~~`./embedded/build-android-wheels.sh`~~ done — wheels are committed; rerun
   only when bumping pins (needs rustup + NDK).
2. `cd app/android && ./gradlew assembleDebug` — now also pip-installs the
   M3 deps (pydantic-core/jiter from the local wheels; **psutil builds from
   sdist via NDK** — watch for it) and bundles the 43 MB vendored tree.
3. Sideload, open Moch → onboarding shows **Use this phone** → tap it.
4. Configure a provider key when prompted (or ride the free tier), send a
   message. `adb logcat -s MochHermes python.stderr python.stdout` shows the
   boot lines + any serve-path errors.

## Known risks / open items

1. **Android serve-path landmines** — hermes' lifespan starts a PTY reaper,
   cron ticker, reconcile thread etc. on Linux assumptions. Host boot proves
   the code path; on-device behavior (bionic, no /dev/ptmx guarantees) is the
   real test. Failures will name themselves in logcat; we patch the vendored
   tree minimally then.
2. **psutil NDK sdist build** during gradle (7.1.3; hermes pins 7.2.2 — API
   surface identical).
3. **stop/restart lifecycle** deferred to M6 (foreground service) —
   `gateway_server` runs for the process lifetime by design for now.
4. The WS client (RN) sends no Origin header; hermes' loopback DNS-rebinding
   check tolerates absent Origin (browser-only defense) — verified by code
   read, confirmed on-device in your test.
5. RN WebSocket to cleartext `ws://127.0.0.1` needs `usesCleartextTraffic`
   — already enabled in this app's manifest config.

## Next: Milestone 4

Streaming — largely free (the gateway already streams deltas; the app already
renders them). M4 = verify on-device streaming + cancellation, then harden
(cancellation paths, backpressure) rather than build.
