# Milestone 1 — Embedded CPython inside the Moch APK

Status: **code complete, not yet built** (builds/tests are done manually on the phone).
Scope: prove a real CPython interpreter executes inside the APK. No hermes code, no
pip dependencies, no UI changes. See `embedded/ASSESSMENT.md` for the full plan.

## What changed

| File | Change |
|---|---|
| `app/android/build.gradle` | buildscript classpath `com.chaquo.python:gradle:17.0.0` |
| `app/android/app/build.gradle` | `apply plugin: "com.chaquo.python"` + `chaquopy {}` block: Python 3.11, buildPython pinned, `srcDir ../../python-runtime` |
| `app/android/.../hermes/HermesRuntime.kt` | lifecycle owner: boots CPython on a background thread at app start, runs `moch.bootstrap.selftest()`, `status()` probe |
| `app/android/.../hermes/HermesBridgeModule.kt` | RN NativeModule `HermesBridge.status()` (read-only in M1) |
| `app/android/.../hermes/HermesBridgePackage.kt` | package registration |
| `app/android/.../MainApplication.kt` | registers `HermesBridgePackage`, calls `HermesRuntime.start(this)` in `onCreate` |
| `app/python-runtime/moch/bootstrap.py` | selftest module (json + hashlib + platform probes) |
| `app/src/lib/hermesRuntime.ts` | TS surface; UI code uses this, never `NativeModules.HermesBridge` directly |

## Build (manual)

```bash
cd app/android
./gradlew assembleDebug          # -> app/build/outputs/apk/debug/app-debug.apk
```

- Baseline (pre-Chaquopy) debug APK was 103,666,114 bytes (Oct 4). The M1 delta
  = Chaquopy CPython 3.11 + stdlib for arm64-v8a. Record the new size here after
  the first build.
- Release (R8 minify on; Chaquopy ships consumer keep rules — this build also
  validates assessment risk #4): `./gradlew assembleRelease`.
- buildPython is pinned to uv's cpython 3.11.16 (`~/.local/share/uv/python/...`)
  because system `python3` is 3.14 and Chaquopy requires matching major.minor.
  Override with `-PchaquopyBuildPython=<path>` (needed on other machines/EAS).

## Verify on the phone

1. Sideload the APK, open Moch.
2. Within ~2s of process start, logcat must show:

```
adb logcat -s MochHermes
I/MochHermes: python alive: {'ok': True, 'digest': '<16 hex>', 'monotonic': True,
               'python': '3.11.x', 'implementation': 'cpython',
               'platform': 'Linux-...-aarch64-...', 'machine': 'aarch64'}
```

`machine: aarch64` + `python 3.11.x` inside the app process is the M1 acceptance
proof. Failure modes log `python boot failed` (PyException) or
`runtime boot failed` (JNI/plugin) under the same tag.

## Guardrails

- Do NOT run `npx expo prebuild` in this fork — `android/` is generated output and
  the Chaquopy wiring + Kotlin package would be regenerated away (assessment risk
  #2). Hardening into an Expo config plugin is scheduled after the architecture
  proves out.
- Python sources live in `app/python-runtime/` (outside `android/`) for exactly
  that reason; it becomes the vendored hermes home in Milestone 2.

## Next: Milestone 2

Vendor the hermes agent into `app/python-runtime/` and run a minimal hermes entry
point inside the app. Real work there = Android builds for the native deps
(pydantic-core, cryptography, jiter, …) — see assessment risk #1.
