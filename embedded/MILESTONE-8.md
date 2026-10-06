# Milestone 8 — guest exec under targetSdkVersion 36

Status: **implemented per `embedded/EXEC-DESIGN.md` (rev 4); unit-tested
locally (`app/python-runtime/tests/test_linux_exec.py`, 36 tests).
On-device 2026-10-06 (versionCode 6, commit `6c48c29`): the AGENT-CHAT
path is verified — `cat /etc/os-release && pwd && whoami` through hermes'
terminal tool returns Ubuntu 24.04.4, the host-spelled workspace cwd, and
root, at targetSdkVersion 36. Two field fixes landed on the way:
`deca8a1` (proot PROOT_TMP_DIR never created on wizard-only installs —
proot died at startup) and `6c48c29` (hermes' wrapper `cd`s to the host
workspace path inside the guest — fixed by self-binding the workspace and
$TMPDIR at their host paths, `-b "$WS:$WS"` / `-b "$SC:$SC"`). The full
exec matrix below has not yet been run on device.**

Field round 3 (2026-10-06, node/npm install attempt) surfaced two more
Moch-vs-proot-distro gaps, fixed the same day: (1) ubuntu-base ships an
EMPTY `/etc/resolv.conf` — apt could not resolve anything (now seeded at
bootstrap + guarded in the shim, public resolvers); (2) **link(2) is denied
on app storage** (kernel/SELinux), killing dpkg's hardlink-based atomic
updates — every `apt-get upgrade` died with EACCES. Fix: proot-distro
parity flags, verified against the cloned `proot_distro` source and the
pinned binary (`proot_distro/commands/login/proot_cmd.py`):
`--link2symlink` (hard-link emulation — Termux's standard answer, on for
every non-Termux distro login), `--sysvipc`, `-L` (lstat sizes for dpkg),
and a faked `--kernel-release` utsname (`\Linux\localhost\6.17.0-moch\…`),
plus the resolv seeding. `--kill-on-exit` deliberately NOT adopted:
Moch/hermes keeps background processes alive across terminal calls, which
that flag would kill. SHIM_FORMAT 5, versionCode 7.

## What changed (the one-paragraph version)

The raise 28 → 36 moves the app into the `untrusted_app` SELinux domain,
where **no app-data file can be execve'd** — which is exactly what M7.5's
chain did (shim script, proot's app-data loader, every guest exec). M8
keeps proot and the rootfs in private storage and moves the **one file the
kernel must exec per guest exec — proot's loader — into the APK as a native
library** (`jniLibs/arm64-v8a/libproot-loader.so`, extracted to
`nativeLibraryDir` = `apk_data_file`, exec-legal for every appdomain). The
PATH shims resolve it at runtime via `$MOCH_NATIVE_LIB_DIR`; hermes execs
the shim through `/system/bin/sh` (`HERMES_EXEC_TRAMPOLINE`) so the kernel
never executes an app-data script; provisioning is version-stamped instead
of existence-checked. The raise and this fix ship together in versionCode 4.

## Build & install

```bash
cd app/android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

## The bootstrap/exec probe

```bash
# Launch the app FIRST, then a PLAIN service start — NOT
# am start-foreground-service: the LINUX_TEST branch of
# HermesService.onStartCommand returns START_NOT_STICKY without ever
# calling startForeground (bootstrap takes minutes; rootfs extraction),
# so the foreground-service form would raise
# ForegroundServiceDidNotStartInTimeException and kill the process
# mid-test. With the activity foreground an ordinary service start is
# legal, carries no 5 s startForeground obligation, and does not rely on
# adb's shell-uid service-start privileges (which is the only reason
# M7.5's bare `am startservice` also worked).
adb shell am start -n com.hermes.pocket/.MainActivity
sleep 2
adb shell am startservice -n com.hermes.pocket/.hermes.HermesService \
  -a com.hermes.pocket.hermes.LINUX_TEST
adb logcat -s MochHermes | grep -i linux
```

Expected (same as M7.5, now under the raised target):

```
linux bootstrap: {ok=True, steps=[proot: ok, libtalloc: ok, ...stamp: ok]}
linux exec: {'ok': True, ... 'stdout': 'Linux ... aarch64 GNU/Linux\n...'
```

Any `EACCES` / `Permission denied` line is a failure of the design — re-run
with `PROOT_VERBOSE=9` (set in the guest env / via the shim) before triage.

## Guest exec matrix (`embedded/m8-guest-test/`)

Covers every subsequent guest exec: shells, `/usr/bin/env`, interpreters
(node/python/php/git), shebang scripts (incl. `/usr/bin/env` shebang and an
argument after the interpreter name), relative-path exec from `/workspace`,
bash → node → python → php child chains, backgrounded children + `wait`,
`npm install` + `npm run` (network permitting), and `exec_matrix.c` —
compiled **inside the guest** with `cc` — exercising `execve`, `execv`,
`execvp`, `execl`, `execlp`, `posix_spawn`, and a raw `syscall(SYS_execve)`
child (the termux-exec blind spot; proot catches the syscall itself).

### Getting the assets onto the phone

The workspace is app-private. Two routes:

1. **Debug build (simplest):** install the debug variant (debuggable →
   `run-as` works), push via `/data/local/tmp`:

   ```bash
   cd app/android && ./gradlew assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb push embedded/m8-guest-test /data/local/tmp/
   adb shell run-as com.hermes.pocket sh -c \
     'cp -r /data/local/tmp/m8-guest-test files/.hermes/workspace/'
   ```

2. **Any build:** ask the agent (its terminal runs in the guest) to write
   the files under `/workspace/m8-guest-test/` — the assets are small; e.g.
   `mkdir -p /workspace/m8-guest-test` then one `cat > file <<'EOF' … EOF`
   per asset (paste from this repo's `embedded/m8-guest-test/`).

### Running it

Inside the guest, install prerequisites first (ubuntu-base ships none of
them, not even a compiler):

```
apt-get update && apt-get install -y nodejs php-cli git build-essential
bash /workspace/m8-guest-test/run.sh
```

Invoke that line **through the agent terminal** (the hermes
`_run_bash` → `/system/bin/sh` shim → `linker64 proot` chain) — not only
via `linuxExec` — so the PATH-shim surface is what gets exercised. Success =
every line `<name>: OK`, summary `m8-guest-test: ALL OK`; `npm` may print
`SKIP (no network)` without failing (§9.2 "network permitting").

## Regression scenarios (both REQUIRED before release)

1. **Update-staleness** — the failure class the runtime-resolved
   `MOCH_NATIVE_LIB_DIR` designs out (Termux re-links `applib` on every
   service start for exactly this reason): after the matrix passes,
   rebuild/reinstall with `adb install -r` (this re-randomizes
   `/data/app/~~…/lib/arm64`), let the app restart, and run one command
   **through the agent-terminal path** (ask the agent to run `uname -a`).
   It must still succeed. (Via `linuxExec` this test would pass even with a
   broken steady-state exporter, because `exec_in_guest` resolves the loader
   in-process — only the shim path exercises the env-var contract.)
2. **M7.5 → M8 upgrade** — proves the boot-time shim-marker retirement has
   a caller: install the last pre-M8 APK (`81e4b79`), bootstrap the guest
   via the wizard, then `adb install -r` the M8 APK over it (**do NOT**
   re-run the wizard — nothing prompts it), force-stop and relaunch the
   app, and run one agent-terminal command. It must succeed; format-1
   shims with the baked app-data `PROOT_LOADER` would EACCES forever
   without the extended repair gate in `hermes_boot._prepare_home`.

## targetSdk 36 checklist status (EXEC-DESIGN.md §8)

- `targetSdkVersion 36`, `versionCode 4`, `useLegacyPackaging true` +
  `doNotStrip '**/libproot-loader.so'` — done (`app/android/app/build.gradle`).
  Device-verify `extractNativeLibs=true` and `lib/arm64-v8a/libproot-loader.so`
  present via `aapt2 dump badging` / `dump xmltree` on the built APK.
- `FOREGROUND_SERVICE_MEDIA_PLAYBACK` added (expo-audio's
  `AudioControlsService` gap). FGS dataSync, exported flags,
  `POST_NOTIFICATIONS` (expo-notifications merge), `FLAG_IMMUTABLE`,
  scoped-storage caps, cleartext/queries — already compliant.
- `ExpiredTargetSdkVersion` lint disable dropped (moot at 36).

## Accepted limitations carried by this release (not deferred)

- **Android 15+ `dataSync` FGS ~6 h timeout** (regression the raise itself
  introduces for targetSdk 35+): the always-on agent stops after ~6 h per
  boot until the `onTimeout()` → `HermesService.restartApp()` (or
  `specialUse` + Play justification) migration lands. Out of M8 code scope
  by design decision — this note is the carry.
- **Edge-to-edge is enforced** for targetSdk 36 on Android 16 devices (no
  opt-out; `windowOptOutEdgeToEdgeEnforcement` deprecated/disabled).
  Status/nav-bar inset handling in the RN UI is required follow-up work.
- `screenOrientation="portrait"` is ignored on sw ≥ 600 dp screens;
  predictive-back system animations default ON (`onBackPressed` suppressed)
  — Moch keeps legacy back behavior via the documented temporary opt-out
  `android:enableOnBackInvokedCallback="false"` (revisit before API 37).
- In-guest `/proc/<pid>/exe`/`comm` show the loader's host path (`AT_EXECFN`
  is corrected by the termux fork); `execveat` with a real dirfd returns
  `ENOSYS` in proot (only `AT_FDCWD` is translated; `fexecve` works via
  `/proc/self/fd/N` because `/proc` is bound). 32-bit guest binaries are
  unsupported (no 32-bit loader shipped; arm64-only).
- Debian-12 rootfs URL remains dead (pre-existing M7.5 defect, verified
  404): `bootstrap("debian-12")` fails at download loudly; fix (correct org
  `debuerreotype/docker-debian-artifacts`, `dist-arm64v8`,
  `rootfs.tar.xz` handling + device verify) is a tracked follow-up.
  Ubuntu 24.04 is the only supported distro in M8.

## Artifacts introduced

| Path | What |
| --- | --- |
| `app/android/app/src/main/jniLibs/arm64-v8a/libproot-loader.so` | the exec-able loader (unmodified, from the pinned termux `.deb`; sha256 `cbdef0e6…`) |
| `embedded/vendor-proot-loader.sh` | regeneration path for the jniLib (download → verify → extract; run this session, byte-identical) |
| `embedded/licenses/proot-COPYING` | GPLv2 text (proot is STMicroelectronics'; source offer: github.com/termux/proot @ v5.1.107.96) |
| `app/python-runtime/tests/test_linux_exec.py` | stdlib-only unit suite (§9.1), 34 tests |
| `embedded/m8-guest-test/` | on-device matrix assets (§9.2) |
