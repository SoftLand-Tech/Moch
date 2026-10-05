# Embedded Hermes Runtime — Technical Assessment

Status: assessed 2026-10-05, before any file was modified. Milestone 1 implementation
follows this document. This fork (`~/ai/learning/Moch`) is the experimental home of the
embedded architecture; the canonical remote-client repo is untouched.

## Verdict

**Feasible.** Embed Hermes with **Chaquopy 17.0** (MIT) inside the existing Expo/React
Native app, driven from Kotlin through the app's *existing* v7 JSON-RPC protocol layer.
Milestone 1 (CPython executing inside the APK) is implemented in this change set.
The main open risk is Milestone 2: Hermes' handful of native Python dependencies
(cryptography, pydantic-core, aiohttp, …) need Android builds — solvable, but it is the
real work; everything after it is integration.

## What exists today

- **App** (`app/`): Expo 57 / RN 0.86.3, expo-router, nanostores, Fabric (new arch),
  arm64-only (`reactNativeArchitectures=arm64-v8a`), R8 minify on in release.
  It is a *remote client*: `src/lib/gateway.ts` dials a WebSocket (adapter:
  `src/protocol/rn-socket.ts`) and speaks Hermes' v7 JSON-RPC gateway protocol.
- **The load-bearing discovery** — the protocol layer is already transport-agnostic:
  `src/protocol/json-rpc-channel.ts:96` defines `JsonRpcTransport { send(text: string) }`,
  and the WebSocket is only one implementation. The entire stack above it
  (request/response, heartbeats, server→client requests like approval/clarify, event
  decoding, sessions, chat UI) never touches a socket. **The native bridge can carry the
  same JSON-RPC frames and none of that code changes.**
- **Android** (`app/android/`): expo prebuild output, AGP from Expo's catalog
  (compatible range for Chaquopy 17.0 is AGP 7.3–9.2), Gradle 9.3.1 wrapper, NDK
  27.1.12297006, JDK 21, SDK present. Release builds **fall back to the debug keystore**
  when `keystore.properties` is absent (`app/android/app/build.gradle:47`) — local
  sideload APKs need zero signing setup. Manifest already has `FOREGROUND_SERVICE`,
  `INTERNET`, `CAMERA`, `RECORD_AUDIO`; no custom native modules today (Expo modules only);
  `MainApplication.PackageList` is the insertion point for ours.
- **Hermes** (installed at `~/.hermes/hermes-agent`, inspected read-only): **v0.21.3**
  (commit 3adc178), Python **3.11.16** venv, uv-managed, every direct dep exact-pinned.
  Entry points: `hermes` (CLI), **`hermes-agent` = `run_agent:main`** (the agent loop —
  the programmatic embedding surface), `hermes-acp`. The gateway the app talks to is
  `tui_gateway/` and its contract is `apps/shared/src/gateway-contract.generated.ts` —
  the same contract our Kotlin↔Python bridge will serve.
  Hermes already knows about Android: `nemo-relay` is marker-excluded when
  `'android' in platform_release` (pyproject.toml:186), and there is a `[termux]` extra
  ("Baseline Android / Termux path for reliable fresh installs").

## Hermes dependency weight (core loop vs extras)

Core `[project].dependencies` is small and almost entirely pure Python: openai,
httpx[socks], rich, tenacity, pyyaml, ruamel.yaml, requests, jinja2, pydantic,
prompt_toolkit, croniter, packaging, Markdown, PyJWT, websockets, pathspec, fastapi,
uvicorn[standard], python-multipart, ptyprocess, psutil, Pillow, pillow-heif,
cryptography, fire, firecrawl-anydoc, python-dotenv, certifi, snowballstemmer.

Native (.so) among core (verified against the installed venv):

| Distribution | Native part | Android outlook |
| --- | --- | --- |
| pydantic-core | Rust ext | needs Android wheel (M2) |
| cryptography | Rust + OpenSSL | needs Android build (M2); hermes already builds it from sdist on Termux |
| Pillow / pillow-heif | C | Chaquopy publishes prebuilt Pillow; heif likely deferred (image exif path) |
| psutil | C | small; likely compiles or stubs on Android |
| pyyaml / ruamel.yaml | optional C accel | both have pure-Python fallbacks — ship pure |
| websockets | C speedups | pure-Python fallback exists |
| uvicorn[standard] extras (uvloop, httptools, watchfiles) | C | **Android-incompatible**; uvicorn runs fine without them (plain asyncio) |
| jiter (openai dep) | Rust ext | needs wheel (M2) or pin openai without it |

Everything heavy in the inspected venv (ctranslate2, faster-whisper, onnxruntime,
av, numpy, tokenizers, nemo-relay) comes from **optional extras** (voice, google,
telegram, …) that the embedded build simply will not install.

## Embedding decision

**Chaquopy 17.0.0** — MIT license, Python 3.10–3.14 (we pin **3.11**, matching the
runtime hermes actually runs on), AGP 7.3–9.2 ✓, min API 24 ✓ (Expo 57 minSdk),
ships CPython + stdlib per ABI from Maven Central, `pip install` at build time,
no NDK needed for pure-Python. Alternatives rejected: python-for-android (Kivy-app
shaped, not an embeddable runtime for RN), Termux packages (bionic prefix-relocation
hack, not maintainable), BeeWare/Briefcase (packages whole apps, not a runtime inside
an existing RN app).

Layering (per the target architecture): RN ⇄ `HermesBridgeModule` (NativeModule +
NativeEventEmitter) ⇄ Kotlin `HermesRuntime` ⇄ Chaquopy CPython ⇄ hermes runtime —
never the JS thread, never a WebSocket.

## Compatibility matrix (draft — verified only where marked)

| Hermes feature | Android status | Notes |
| --- | --- | --- |
| Agent loop | expected works | pure Python; proven in M2 |
| LLM APIs (OpenAI/Anthropic/…) | expected works | cloud HTTP; watch native transitives (jiter) |
| Memory | expected works | files + sqlite3 (stdlib, ships with CPython) |
| Skills | expected works | files under app storage |
| MCP | likely | mcp package is pure-ish (httpx/anyio) |
| Shell | degrades | no shell binaries in app sandbox; Python-side tools only |
| PTY | unknown | kernel ptys exist; `/dev/ptmx` access from app sandbox must be tested (M5) |
| Files | works (scoped) | app-private dirs day one; SAF for user dirs later |
| Cron/automations | degrades→works | in-process scheduler (croniter is pure) instead of system cron |
| Browser automation | blocked | no Playwright/Chromium in the app sandbox |
| Docker | blocked | no daemon/socket on Android |
| Voice | degrades initially | local STT natives too heavy; Android speech APIs / cloud TTS as fallback |
| Background tasks | works via FGS | Milestone 6; manifest already has FGS permissions |

Do not read "expected works" as verified — each row converts to *works* only at its
milestone's on-device proof.

## Size / compatibility targets

- Arm64-v8a only (already the project's setting). Minimum Android: API 24 (both Expo 57
  and Chaquopy 17.0 floor). Measure, don't guess: M1 build reports the exact APK delta
  for runtime + stdlib; hermes deps add more in M2 (estimate: core pure-Python deps
  ≈ 15–25 MB compressed; native wheels unknown until built).

## Risks (ordered by expected pain)

1. **Native wheels in M2** — cryptography/pydantic-core/jiter/aiohttp need
   aarch64-linux-android builds. Mitigations in order: Chaquopy prebuilts → Chaquopy's
   own package build scripts → Termux patch sets → dependency substitution (e.g. aiohttp
   → httpx-based paths) where hermes allows.
2. **expo prebuild wipe** — `app/android/` is generated; our gradle/Kotlin/manifest
   edits would be regenerated away. Mitigation: hardening task to move edits into an
   Expo config plugin (pattern exists: `app/plugins/with-android-release.js`); until
   then, do not run `npx expo prebuild` in this fork.
3. **Process model** — Chaquopy runs Python in-process (a thread + GIL), not a separate
   process. Crash isolation is weaker than a child process; long tasks must run on
   Python threads, never the UI thread; FGS keeps the process alive (M6).
4. **R8 + Chaquopy** — minified release must keep Chaquopy runtime classes; Chaquopy
   ships consumer rules, verify in the M1 release build.
5. **stdlib `ptyprocess`/subprocess semantics** — verified only at M5.

## Milestone 1 scope (this change set)

Minimal, provable, reversible: Chaquopy plugin + Python 3.11 + a `moch.bootstrap`
selftest module; Kotlin `com.hermes.pocket.hermes` package
(`HermesRuntime` lifecycle + `HermesBridgeModule`/`Package` RN surface, `status()` only);
boot at app start on a background thread; logcat proof `MochHermes`; TS wrapper
`src/lib/hermesRuntime.ts`. No UI changes, no hermes code yet, no pip deps yet.
