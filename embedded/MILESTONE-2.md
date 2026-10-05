# Milestone 2 — Vendored hermes runtime boots inside the app

Status: **code complete, host-verified; APK build + on-device proof are manual**.
Scope: the vendored hermes-agent source executes its real boot path
(`import run_agent`) inside the embedded runtime. No agent conversation, no
LLM calls — that is Milestone 3.

## What changed

| File | Change |
|---|---|
| `app/hermes-src/` | NEW — vendored hermes-agent **0.21.3** (commit `3adc178`), 1779 files / 41 MB: the verified import closure of `run_agent` (7 packages + root modules + `hermes_state_*` shims), minus `__pycache__`, tests, node_modules, and `hermes_cli/web_dist` (dashboard SPA, outside the closure) |
| `app/hermes-src/VENDOR.json` | provenance stamp (name/version/commit/source/synced) |
| `embedded/vendor-hermes.sh` | NEW — idempotent sync script; re-run after updating the hermes checkout, `git diff app/hermes-src` shows upstream drift |
| `app/python-runtime/requirements-embedded.txt` | NEW — exact pins (hermes' own venv versions) of the 21-package closure: all pure-Python except `psutil` |
| `app/python-runtime/moch/hermes_boot.py` | NEW — app-private hermes home (`$HERMES_HOME` → default `<HOME>/Moch`, i.e. `/data/data/com.hermes.pocket/files/Moch`), scratch/TMPDIR setup, `import run_agent`, structured boot report (ok/version/commit/home/newModules/jiter/errors) |
| `app/android/app/build.gradle` | chaquopy: second source root `../../hermes-src` + `pip { install("-r", ...requirements-embedded.txt) }` |
| `HermesRuntime.kt` / `HermesBridgeModule.kt` | start() logs the hermes boot report; `status()` now includes `hermesVersion` |
| `app/src/lib/hermesRuntime.ts` | `HermesRuntimeStatus.hermesVersion` |

## Key discovery (governs the whole plan)

Census of `import run_agent` in a clean interpreter: **pydantic, openai and
cryptography never import at boot**. The module-level closure is 41 hermes
top-levels + 15 third-party imports, all pure-Python except:

- `psutil` (C) — hard requirement at import; Chaquopy builds it from sdist
  with the NDK (the only native build in M2).
- `jiter` (Rust) — loaded only via `agent.jiter_preload`, which is guarded and
  degrades cleanly (verified absent → boot still `ok`).

The Rust trio (pydantic-core via pydantic, jiter via openai, cryptography)
only becomes load-bearing at **first model call (M3)** — that is where the
aarch64-android wheel work lands.

## Host verification (done, no APK build)

Fresh CPython 3.11.16 venv containing ONLY `requirements-embedded.txt` +
vendored trees, `HERMES_HOME` pointed at an empty temp dir:

```
{"ok": true, "version": "0.21.3", "commit": "3adc178", "newModules": 970,
 "jiter": false, "errors": []}
AIAgent: run_agent  (class present)
```

This proves: vendored file set complete, dependency set complete, guarded
jiter degradation works, `hermes_boot` logic correct. `tsc --noEmit` clean.

## Build (manual) — same as M1

```bash
cd app/android && ./gradlew assembleDebug
```

First build now also: pip-installs the 21 packages (psutil compiles via NDK —
needs `local.properties` SDK + `ndkVersion` NDK, both already configured) and
packages the 41 MB source tree as Chaquopy assets (pyc-compiled, compressed;
expect well under 41 MB in the APK — record the real delta here).

## Verify on the phone

```bash
adb logcat -s MochHermes
```

Expect, after the M1 `python alive:` line:

```
I/MochHermes: hermes boot: {'ok': True, 'version': '0.21.3', 'commit': '3adc178',
               'home': '/data/data/com.hermes.pocket/files/Moch',
               'newModules': <n>, 'jiter': False, 'errors': []}
```

`ok=True` + `newModules` in the hundreds is the M2 acceptance proof. If
`errors` is non-empty it will name the exact missing module/dep — attach that
log when reporting back. The hermes home tree (`config.yaml`, `state.db`,
`skills/`, …) will appear under `files/Moch/` on first real agent use (M3+).

## Known risks carried into the build

1. **psutil NDK build** — the one native compile. If gradle fails on it, the
   error will say so; that single package is then the M2 blocker (no stub is
   acceptable).
2. **Chaquopy asset path for `VENDOR.json`** — `hermes_boot` scans `sys.path`
   roots for it; Chaquopy extracts non-package data files at startup, so it
   should resolve. Degrades to `version: "unknown"` if not (boot still ok).
3. **First-boot extraction time** — 1779 files add to first-launch latency;
   measure on-device (M8 optimizes; `extractPackages` tuning later).

## Next: Milestone 3

Message round trip: RN → Kotlin → embedded hermes → LLM API → back, streamed.
Requires: Android wheels for pydantic-core + jiter (+ cryptography only if the
configured provider path imports it), provider config UI wired to hermes'
config.yaml, and the JSON-RPC frame channel over the bridge.
