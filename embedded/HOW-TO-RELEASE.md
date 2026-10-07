# How to release a Moch APK

Operating instructions for any agent (or human) cutting a sideload build.
Everything here was learned the hard way — read it before your first build.

## The command

From the repo root:

```bash
bash app/android/gradlew --project-dir app/android assembleRelease
# equivalent: cd app/android && ./gradlew assembleRelease
```

Output: `app/android/app/build/outputs/apk/release/app-release.apk`.

**Signing**: if `app/android/keystore.properties` exists, the release build
is signed with that keystore; otherwise it falls back to the **debug
keystore** (build.gradle line ~140). The fallback is intended — these are
sideload builds for the user's phone, not Play builds. Consequence: do not
"fix" the fallback, and never mix keystrokes — an APK signed with a
different key than the installed one requires an uninstall first (app data,
including the provisioned Linux guest, is lost).

## What goes into the APK (six input streams)

| You changed… | What re-runs |
| --- | --- |
| `.py` under `app/python-runtime/` or `app/hermes-src/` | Chaquopy recompiles to bytecode → `assets/chaquopy/app.imy` |
| `app/python-runtime/requirements-embedded.txt` or `app/wheels-android/*.whl` | Chaquopy pip task re-resolves dependencies |
| TS/JS under `app/` (app, src, components) | Expo `export:embed` JS bundle — the slowest task |
| Kotlin/Java under `app/android/app/src/main/java/` | AGP compile |
| `AndroidManifest.xml` / res | AGP process/merge |
| `jniLibs/arm64-v8a/libproot-loader.so` | nothing compiles — committed binary, copied as-is |

Gradle's up-to-date checks skip unchanged tasks (the
`N actionable tasks: X executed, Y up-to-date` line). A pure-Python change
rebuilds only the Chaquopy package + APK assembly; a JS change re-runs the
~10-minute bundle. If the log shows almost everything up-to-date but you
expected your change in — you probably edited the wrong tree.

## Release checklist (in order, no skipping)

1. **Unit gate** — must end with `ALL TESTS PASSED`:
   ```bash
   python3 app/python-runtime/tests/test_linux_exec.py
   ```
   (stdlib-only; passes on desktop 3.14 and on 3.11.)
2. **Bump `versionCode` + `versionName`** in
   `app/android/app/build.gradle` (~line 114). Not cosmetic: Android's
   package installer refuses to update to the same or lower versionCode,
   and the user sideloads builds over each other. Every handed-over build
   must have a strictly higher versionCode than the previously installed
   one.
3. **Build** (command above). Expect 3–12 min depending on what re-runs.
4. **Prove your change actually shipped** — a green build does NOT prove
   your edit is in the APK:
   ```bash
   mkdir -p .research/apkcheck && cd .research/apkcheck
   unzip -q -o ../../app/android/app/build/outputs/apk/release/app-release.apk assets/chaquopy/app.imy
   python3 -c "import zipfile; d=zipfile.ZipFile('assets/chaquopy/app.imy').read('moch/linux_env.pyc'); print(b'<your marker string>' in d)"
   cd ../.. && rm -rf .research/apkcheck
   ```
   (.py changes land as `.pyc`, so grep for a **string literal** from your
   change — e.g. a flag name, a format marker.) For dependency changes
   run `python3 embedded/verify-apk-python.py` instead — it checks every
   requirements pin is really inside the APK (it exists because a build
   once shipped with a hollow, metadata-only package).
   Also check the APK mtime changed — a silently-dead build leaves the
   previous APK in place looking plausible (this happened).
5. **Hand over** `app-release.apk` with the versionCode and what to test.

## Known failure modes on this machine

- **Gradle daemon OOM** (7.6 GB box): the daemon gets killed at default
  worker count. Retry with `--max-workers=2`. A background build that dies
  early leaves an empty log and no notification — always re-check the APK
  mtime/size before handing over.
- **`NODE_ENV` warning** in build output: cosmetic, ignore.
- **Never run `npx expo prebuild`** — it regenerates `app/android/` and
  deletes the Chaquopy wiring this project depends on.
- **Don't publish JS to the Expo channel before it is merged** — the
  sideload APK bundles its JS; the channel is a separate surface.
- **Bumping the pinned proot/loader**: the loader is a committed binary
  (`app/android/app/src/main/jniLibs/arm64-v8a/libproot-loader.so`).
  Regenerate it with `embedded/vendor-proot-loader.sh` (downloads the
  pinned Termux .deb, sha256-verifies, extracts) and commit the new `.so`
  — the gradle build will not fetch it for you. Keep
  `embedded/licenses/proot-COPYING` and the source-offer note accurate.

## Device verification model

No emulator, no adb in this project's workflow — **the user tests purely
in-app on their phone**. Hand over an in-app test procedure with each
build (example: ask the agent `cat /etc/os-release && pwd && whoami`).
Field-test history and the full exec matrix live in
`embedded/MILESTONE-8.md`; architecture and design decisions in
`embedded/EXEC-DESIGN.md`. When a field round finds a bug, the pattern
that works: get the verbatim error text from the chat, fix at the Moch
launcher level, bump `SHIM_FORMAT` (in `app/python-runtime/moch/linux_env.py`)
if the shims changed — the boot-time repair gate then rewrites them on the
user's phone automatically — and bump versionCode for the next sideload.
