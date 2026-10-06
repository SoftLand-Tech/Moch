# Moch Milestone 8 — guest exec under targetSdkVersion 36 (design)

Status: **design rev 4 — verified against Termux / proot / AOSP sources and
revised after three independent review rounds** (rev 2: shim staleness
across APK updates, mid-session trampoline wiring, the device-test
invocation crash, the mediaPlayback FGS permission hole, Android 16
behavior-change items; rev 3: steady-state `MOCH_NATIVE_LIB_DIR` exporter
at every boot, boot-time caller for the M7.5 shim retirement, trampoline
wrap guard, agent-terminal test surfaces; rev 4: `_safe_extract` predicate
pinned to the real rootfs tarball (absolute symlink targets allowed),
exact Chaquopy 17.0 `Python.getPlatform()` spelling, exact stamp/re-provision
predicate incl. rootfs wipe-on-URL-change, pinned unit-test seam, `cc` in
the device matrix, dead Debian-12 URL scoped out, citation fixes). The
implementer follows §4 (implementation plan), §8 (targetSdk raise
checklist) and §9 (test plan). The exec fix and the targetSdk raise land in
the **same release** — the raise is what breaks guest exec, so they must
never be shipped apart.

Goal (from the milestone brief): guest exec works under `targetSdkVersion 36`
(`untrusted_app` SELinux domain) — no root, no Termux installed, no second APK,
proot kept, rootfs stays in app-private storage, every subsequent guest exec
(bash → node → children), shebangs, `execve/execv/execvp/execl/execlp/
posix_spawn`, and raw-syscall exec callers all covered; normal (non-Moch)
Android exec paths untouched.

Evidence base: the M8 research packet (termux-exec v2.5.0 @ 2cd0ba6b, termux
proot fork v5.1.107.96, proot-distro, termux-app, termux-play-store/termux-apps,
AOSP sepolicy, Play policy pages) checked out under `.research/` (gitignored),
plus direct verification runs recorded inline as `[verified N]` below. Line
numbers for Moch files refer to HEAD `81e4b79` (branch `moch-linux-exec`).

Direct verifications run for this design (commands + outcomes):

1. `[verified 1]` `file` + `readelf -lW` on the loader extracted from the exact
   pinned `.deb` (`.research/proot_deb/.../usr/libexec/proot/loader`):
   `ELF 64-bit LSB executable, ARM aarch64, statically linked, stripped`;
   both `LOAD` segments `Align 0x4000` (16 KB-page safe).
2. `[verified 2]` `sha256sum` of the same files:
   loader `cbdef0e652c2b78af25d867e1719fdebbb0915e25aae2dd35b3b5c1835f6b551`
   (18,136 bytes), proot `1545b85b312505db6eb6908ff8b2ded0a77a3bd689c50ae85aa7c1d8445dd717`.
3. `[verified 3]` AOSP sepolicy (gitiles, fetched this session):
   `private/file_contexts:611` — `/data/app(/.*)?  u:object_r:apk_data_file:s0`;
   `public/global_macros:24` — ``define(`x_file_perms', `{ getattr execute execute_no_trans map }')``;
   `android-16.0.0_r1/private/app.te:443` and AOSP `main/private/app.te:443`
   (= local `.research/sepolicy/main_app.te.priv:443`) —
   `allow appdomain apk_data_file:file { getattr open read ioctl lock map x_file_perms };`;
   `android-13.0.0_r1/private/app.te:411` —
   `allow appdomain apk_data_file:file rx_file_perms;` (`rx_file_perms` =
   `r_file_perms + x_file_perms`, `global_macros:27`).
4. `[verified 4]` Chaquopy API, two sources: `AndroidPlatform.java`
   (chaquo/chaquopy master,
   `product/runtime/src/main/java/com/chaquo/python/android/AndroidPlatform.java`):
   `:55 public Application mContext;`, `:62 AndroidPlatform(@NotNull
   Context context)`, `:90 public @NotNull Application getApplication()`;
   and — review round 3, re-verified by me — `javap` on the **pinned
   runtime** `chaquopy_java-17.0.0.jar` (local gradle cache):
   `com.chaquo.python.Python.getPlatform()` is
   `public static synchronized com.chaquo.python.Python$Platform getPlatform()`
   and `Python$Platform` declares only `getPath()`/`onStart()` —
   `getApplication()` exists solely on the `AndroidPlatform` subclass, so
   the Python-side call must be `Python.getPlatform().getApplication()`
   with runtime-class dispatch (spelled in §4.3). `HermesRuntime.kt:33`
   starts Python with `AndroidPlatform(appContext)` before `boot()` at
   `:36`, so the platform exists at boot.
5. `[verified 5]` repo greps this session: the only hermes-side exec sites of
   the resolved shell are `app/hermes-src/tools/environments/local.py:898`
   (`_run_bash` Popen, argv built at `:896`) and
   `app/hermes-src/tools/process_registry.py:976` (`_scope_argv`,
   `[_find_shell(), "-lic", ...]`); no other `Popen`/exec of the bash path
   exists in the vendored tree (re-confirmed in review; the
   `file_operations.py` mention is a comment; `sys.executable` child-VM
   spawns hit `app_process64`, a system file).
6. `[verified 6]` aapt2 on the built release APK
   (`app/android/app/build/outputs/apk/release/app-release.apk`,
   `$HOME/Android/Sdk/build-tools/36.0.0/aapt2 dump badging` + `dump xmltree
   --file AndroidManifest.xml`, run this session): permission list contains
   `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` + `POST_NOTIFICATIONS`
   and **no** `FOREGROUND_SERVICE_MEDIA_PLAYBACK`; `AudioControlsService`
   carries `foregroundServiceType=0x00000002` (mediaPlayback);
   `HermesService` `0x1` (dataSync); `MainActivity` `screenOrientation=1`
   (portrait).
7. `[verified 7]` Termux Play re-validates its loader symlink on every
   service start precisely because `nativeLibraryDir` goes stale across app
   updates: `TermuxInstaller.java:313-346` `setupAppLibSymlink` (explicit
   `"Existing incorrect symlink"` repair at `:323`, broken-symlink deletion),
   called from `TermuxService.java:107`.
8. `[verified 8]` mid-session provisioning is real: the setup wizard calls
   `linuxBootstrap(...)` and continues without a process restart
   (`app/app/setup.tsx:74`), while `hermes_boot.boot()` runs `_prepare_home`
   once per process (result cached in `_BOOT_REPORT`,
   `hermes_boot.py:106-140`); and `_run_bash` children inherit
   `os.environ` (`_make_run_env` = `dict(strip_launch_profile_env(
   os.environ.copy()) | env)`, `local.py:655-660` — the launch-profile
   strip is a no-op for Moch's vars) — so env exported by Moch reaches the
   shim.
9. `[verified 9]` WebFetch of developer.android.com/about/versions/16/
   behavior-changes-16 (this session): for apps targeting API 36,
   `windowOptOutEdgeToEdgeEnforcement` is deprecated/disabled (edge-to-edge
   cannot be turned off on Android 16 devices; the opt-out still works on
   Android 15 devices); orientation/resizability/aspect restrictions are
   ignored on screens with smallest-width ≥ 600 dp (`screenOrientation`
   included, with listed exceptions); predictive-back system animations are
   enabled by default and `onBackPressed`/`KEYCODE_BACK` are not called,
   with `android:enableOnBackInvokedCallback="false"` as the documented
   temporary opt-out.

Review round 1 additionally re-verified (not re-run by me): proot
`event.c:513-517` sets `PTRACE_O_TRACEFORK|TRACECLONE|TRACEVFORK`, so guest
grandchildren (node → child processes) are traced and their execves get the
same loader substitution — the [E] loop in §3 holds for arbitrary depth.
Review round 2 findings were re-verified by me before this revision:
10. `[verified 10]` (a) repo grep for `bootstrap(` callers: the Moch
    Linux `bootstrap()` is invoked only from the setup wizard
    (`setup.tsx:74` via the bridge) and `ACTION_LINUX_TEST`
    (`HermesService.kt:108`) — the hermes-src hits are unrelated
    same-named functions (`free_tier_bootstrap`, `_launchctl_bootstrap`);
    no boot-time caller exists. (b) The background-spawn scrub chain is
    strip-list based and preserves `MOCH_*`:
    `local.py:301-305` `_sanitize_subprocess_env` →
    `_plugin_terminal_env_strip_keys()` + `_is_hermes_internal_secret`
    (`local_env_policy.py:172-181`, matches only `AUXILIARY_*`/`_BASE_URL`
    and `GATEWAY_RELAY_*` secret shapes). (c) `hermes_boot.py:69` sets
    `MOCH_WORKSPACE` at every boot (the pattern §4.5.2 reuses) and the
    shim-repair gate at `:74` fires only when `sh` is missing.

---

## 1. Root cause

**The failing syscall.** Under targetSdk ≥ 29 the app runs in the
`untrusted_app` SELinux domain. Inside a proot session the guest never
`execve()`s a guest binary directly: proot is the tracer of the tracee (the
future guest process), and when the tracee issues `execve("/bin/sh", …)` proot
rewrites the syscall's pathname argument *before letting it execute*
(`.research/termux-proot/src/execve/enter.c:718-723`):
`/* Execute the loader instead of the program. */ … status =
set_sysarg_path(tracee, loader_path, SYSARG_1);`. The kernel therefore performs
exactly **one** `execve` per guest exec — of proot's **loader**. Moch points
that at an app-data file (`app/python-runtime/moch/linux_env.py:242`:
`env["PROOT_LOADER"] = str(linux_dir / "libexec" / "proot" / "loader")`).
SELinux evaluates the `execute_no_trans` check on that inode, `app_data_file`
under `/data/data/com.hermes.pocket`, **denies** it, and the tracee's `execve`
returns `EACCES` — surfacing in the guest as `sh: /bin/sh: Permission denied`
(precisely the on-device failure at targetSdk ≥ 29).

**Which file type fails — and which do not.**
- Fails: the **loader** — a standalone, statically-linked ELF `EXEC`
  (`[verified 1]`). It is the single file the kernel must `execve`.
- Does NOT fail: the guest **main ELF** (`/usr/bin/bash` at host
  `<home>/linux/rootfs/usr/bin/bash`). It is never `execve`d — the loader
  `mmap`s its `PT_LOAD` segments `MAP_FIXED` with `PF_X`
  (`src/loader/loader.c:144-147`), which needs only `app_data_file:file
  { execute }` (mmap `PROT_EXEC`), still allowed for every untrusted domain
  (`.research/sepolicy/main/untrusted_app_all.te:26-27`, "For all
  untrusted_app* domains, dlopen() on app data files is still allowed" —
  termux-exec docs `technical/index.md:65`).
- Does NOT fail: the guest **PT_INTERP interpreter**
  (`rootfs/lib/ld-linux-aarch64.so.2`). proot resolves it
  (`add_interp`, `enter.c:164-222`) and the *loader* maps it
  (`loader.c:208-253` jumps to its entry point); the kernel never execs it.
- Does NOT fail (this design): **shebang targets**. proot expands shebangs in
  userspace (`src/execve/shebang.c:208` `expand_shebang`; the file is untouched
  vs upstream), so the kernel's `binfmt_script` never execs an app-data
  interpreter; the interpreter path goes through the same loader substitution.

**The permission.** `execute_no_trans` on `app_data_file:file`. Granted to
`untrusted_app_27` (`.research/sepolicy/android10/untrusted_app_27.te:34-37`:
`allow untrusted_app_27 app_data_file:file execute_no_trans;` — "for targetApi
26, 27, and 28"); granted to **no** 29+ domain (grep of
`main/{untrusted_app,untrusted_app_29,untrusted_app_30,untrusted_app_32}.te`
for `execute` returns nothing) — Android 10's W^X policy
(developer.android.com/about/versions/10/behavior-changes-10: "untrusted apps
targeting Android 10 cannot execve() files within the app home directory").

**Why targetSdk 28 works today.** `seapp_contexts` maps
`minTargetSdkVersion=28` → domain `untrusted_app_27`
(`.research/sepolicy/android16/seapp_contexts:215-221`), which holds the
`execute_no_trans` allow above — so today's pin
(`app/android/app/build.gradle:110`) lets the tracee exec the app-data loader,
and with it every guest exec. At targetSdk 36 the app lands in plain
`untrusted_app` (minTargetSdkVersion=34+) and that allow is gone.

**Two more Moch execs die of the same denial, even earlier.** Under 36 the
chain never reaches proot from two of the three launch paths:
1. hermes `Popen([<home>/linux/bin/bash, "-c", cmd])`
   (`app/hermes-src/tools/environments/local.py:896-903` — the PATH shim, an
   app-data `#!/system/bin/sh` script): the kernel checks `execute_no_trans`
   on the **script's own inode** before `binfmt_script` recursion, so a
   shebang pointing at `/system/bin/sh` does not save it. This is exactly why
   termux-exec parses shebangs in userspace (§2).
2. `moch/linux_session.py:49-53,66-68`: `Popen([<linux>/bin/proot, …])` with
   no `/system/bin/linker64` prefix — direct `execve` of an app-data ELF (the
   known inconsistency).

What still holds at 36 (unchanged Android 10 → main, per packet + [verified 3]):
`execute` (mmap `PROT_EXEC`) on `app_data_file`; `execute_no_trans` on
`system_linker_exec` (`untrusted_app_all.te:32` — the `linker64` trick is
policy-sanctioned); `self:process ptrace` (`untrusted_app_all.te:102-103` —
proot's mechanism); and — the fix this design rests on —
**`execute_no_trans` on `apk_data_file`** for every `appdomain`
([verified 3]), where `apk_data_file` labels everything under `/data/app`,
including the APK's extracted native-library dir (`nativeLibraryDir`).

---

## 2. How current Termux solves it

### 2.1 termux-exec (host-side, Termux prefix, bionic world — not for guests)

`libtermux-exec.so` is `LD_PRELOAD`ed into every Termux shell
(`TermuxShellUtils.java:131`). It interposes exactly the 8-symbol exec set —
`execve, execv, execvp, execvpe, execl, execlp, execle, fexecve`
(`TermuxExecDirectLDPreloadEntryPoint.c:33-99`; no `posix_spawn`/`system`/
`popen` wrappers exist, but bionic's `posix_spawn` calls the `execve`/`execvpe`
symbols, `bionic spawn.cpp:215,220`, so they are covered transitively). The
transform (`ExecIntercept.c:405-434`): `// Replace executable path if wrapping
with linker. if (shouldEnableSystemLinkerExec) { executablePath =
SYSTEM_LINKER_PATH; } … int syscallReturnValue = execveSyscall(executablePath,
argv, envp);` with `execveSyscall` = `syscall(SYS_execve, …)` (`:81-83`).
`SYSTEM_LINKER_PATH` is chosen at **compile time** by the `.so`'s own pointer
width (`TermuxExecLDPreload.h:13-17`: `#if UINTPTR_MAX == 0xffffffff …
"/system/bin/linker" #elif …0xffffffffffffffff … "/system/bin/linker64"`), not
by inspecting the target ELF. Wrapping applies when SDK ≥ 29, euid not 0/2000,
the process SELinux context is **not** `untrusted_app_25/27` (the SELinux
context proxies for targetSdk — there is no targetSdk API call,
`TermuxExecLDPreload.c:112-127`) and the path is under the Termux data dir
(`:162`). Shebangs are parsed in **userspace** (up to 340 bytes;
interpreter + one optional arg; `/bin`,`/usr/bin` interpreters rewritten to
`$PREFIX/bin`, `ExecIntercept.c:481-538`) — precisely because the kernel path
would check `execute_no_trans` on the script inode (§1). `argv` becomes
`[orig argv[0], real exe path, argv[1..]]` and bionic's linker consumes
`argv[1]` and shifts argv (`linker_main.cpp:791-798`), so `/proc/<pid>/exe`
shows `linker64` (documented, `technical/index.md:112`).

Hard limits Termux itself documents: *"Statically linked binaries will not
work"* (`technical/index.md:114`), and *"Packages that call the execve()
system call directly will need to be patched … or they should be run under
proot"* (`:116`; also `:37` — no override of raw `syscall(2)` execve). There is
**no proot-specific code in termux-exec 2.5.0** (repo grep: docs workaround +
a 2020 experiment note only), and nothing about loading a bionic
`LD_PRELOAD` into glibc/musl guests — that question is unanswered by the
sources (research gap).

### 2.2 How proot guests exec (any targetSdk) — the loader mechanism

Guest `execve` is ptrace-caught (`src/syscall/enter.c:1873`) and routed to
`translate_execve_enter` (`src/execve/enter.c:596`): `expand_shebang` resolves
scripts' interpreters; `add_interp` translates the guest `PT_INTERP`
(`/lib/ld-linux-aarch64.so.2` → host path) and collects `PT_LOAD`s; then
SYSARG_1 is replaced with the loader path (§1). At sysexit proot pokes a load
script below the tracee's stack pointer (`src/execve/exit.c:413
transfer_load_script`); the loader (`loader.c:111 _start`, raw syscalls only)
maps binary + interpreter `MAP_FIXED` with `PF_R/W/X` (`:144-147`), fixes
auxv (`AT_PHDR/AT_PHENT/AT_PHNUM/AT_ENTRY/AT_BASE/AT_EXECFN`, `:208-242`) and
jumps to the interpreter's entry. `execveat(AT_FDCWD)` is rewritten to
`execve` (`syscall/enter.c:1877-1888`; non-AT_FDCWD returns `ENOSYS`), and
`execv/execvp/execl*/posix_spawn` all converge on the `execve` syscall —
**proot sees every exec variant, every libc, static binaries and raw-syscall
callers alike, because it intercepts the syscall, not the libc symbol.**
The loader path comes from `$PROOT_LOADER` first
(`enter.c:571`: `return getenv("PROOT_LOADER") ?: PROOT_UNBUNDLE_LOADER
"/loader";`) — an env override, so relocating the loader needs **no rebuild**.
proot-distro itself launches with no `linker64`, no `PROOT_LOADER`, and pops
`LD_PRELOAD` before exec'ing proot (`login/__init__.py:527, 634-637`) —
termux-exec plays no role inside guests.

### 2.3 The honest finding: how Termux actually ships

- **GitHub/F-Droid `termux/termux-app`: avoids the problem entirely** — it
  pins `targetSdkVersion=28` (`gradle.properties:19`), staying in
  `untrusted_app_27`, where the app-data loader (and every prefix binary)
  execs directly. No `linker64`, no jniLib loader needed.
- **Play build (`termux-play-store/termux-apps`, targetSdk 37, minSdk 30)**
  runs proot guests by **placing the loader outside app data**: proot's
  loader lookup is patched to `$PREFIX/../applib/libproot-loader.so`
  (`tps-termux-packages/packages/proot/src-execve-enter.c.patch`, verbatim:
  `-"return getenv(\"PROOT_LOADER\") ?: PROOT_UNBUNDLE_LOADER \"/loader\";"
  +"return PROOT_UNBUNDLE_LOADER \"/libproot-loader.so\";"`), `applib` is a
  symlink to the APK's `nativeLibraryDir` (`TermuxInstaller.java:340`:
  `Os.symlink(nativeLibraryDir, …)`), and the loader ships as a per-ABI jniLib
  with legacy extraction (`build.gradle.kts:185-188` downloads
  `libproot-loader-ARCH-…so` into `src/main/jniLibs/<abi>/libproot-loader.so`;
  `:77-79` `useLegacyPackaging = true`) so it lands as an exec-able
  `apk_data_file`-labeled file. Host-side first execs of prefix ELFs go via
  `/system/bin/linker64` (`TermuxShellUtils.java:87-92`), and subsequent ones
  via termux-exec (§2.1). Fixed on Play since v0.126, 2024-06-14
  ("This version fixes proot usage", org README). The Play fork's proot is
  **older** (5.1.107.80) than the F-Droid pin (5.1.107.96, bumped 2026-10-01),
  and its patch **drops** the env override to hardcode Termux's `applib` layout.

Moch's pinned `proot_5.1.107.96_aarch64.deb` already contains everything
needed: the loader mechanism, `PROOT_LOADER` support (both confirmed by
strings/readelf on the exact `.deb`, packet + [verified 1]), and 16 KB-safe
alignment. What Moch lacks is only the **placement** of the loader and the
launcher consistency — exactly the Play build's lesson, but achievable with
the env override instead of a source patch.

---

## 3. Moch process flow (chosen chain)

```
 Moch app (targetSdk 36, SELinux domain: untrusted_app)
 =====================================================================
 [A] agent command
     hermes LocalEnvironment._run_bash            app/hermes-src/.../local.py:889
     _find_bash() -> PATH hit <home>/linux/bin/bash      (shim script)
         |
         |  argv = ["/system/bin/sh", <shim>, "-c", cmd]        <<< NEW (trampoline)
         v
 1. execve("/system/bin/sh")            system_file ............ ALLOWED
 2. mksh READS the shim script          app_data_file (read) ... ALLOWED
                                                                  (no exec of the script)
 [B] shim  (moch/linux_env.ensure_shims) — contains NO absolute /data/app path
     export LD_LIBRARY_PATH=<linux>/bin/lib      libtalloc: dlopen-only
     export PROOT_LOADER="$MOCH_NATIVE_LIB_DIR/libproot-loader.so"  <<< NEW
     export PROOT_TMP_DIR=<linux>/tmp
     exec /system/bin/linker64 <linux>/bin/proot -r <linux>/rootfs
          -b <workspace>:/workspace -b /dev -b /proc -0 -w /root /bin/bash "$@"
         |
 3. execve("/system/bin/linker64")      system_linker_exec ...... ALLOWED (execute_no_trans)
 4. linker64 mmap's proot ELF PROT_EXEC  app_data_file .......... ALLOWED (execute = mmap)
         |
 [C] proot 5.1.107.96 (termux build, UNMODIFIED, from pinned .deb)
     tracee calls execve("/bin/bash")   (guest path)
     proot rewrites the syscall arg:
       expand_shebang .................. scripts: interpreter resolved in userspace
       add_interp ...................... guest PT_INTERP -> host path, PT_LOADs collected
       SYSARG_1 := PROOT_LOADER ............... THE ONE kernel exec per guest exec
         |
 5. execve(<nativeLibraryDir>/libproot-loader.so)
     apk_data_file ..................... ALLOWED (execute_no_trans)  <<< THE FIX
     (file extracted from the APK at install: useLegacyPackaging=true)
         |
 [D] proot loader (static ELF, raw syscalls)
     reads the load script proot poked below the tracee's SP:
     open+mmap guest bash PT_LOADs ..... app_data_file mmap PROT_EXEC . ALLOWED
     open+mmap guest ld-linux + libs ... same
     fix auxv (AT_PHDR/AT_ENTRY/AT_BASE/AT_EXECFN), PR_SET_NAME
     jump to ld-linux entry ----------------> guest bash runs
         |
 [E] guest children: bash -> node -> python3 -> npm -> php -> git -> ...
     every exec variant (execve/execv/execvp/execl/execlp/posix_spawn,
     execveat(AT_FDCWD); libc, static, or raw syscall(2) caller) is ONE
     execve SYSCALL  ->  proot ptrace catches it  ->  SAME substitution as [C]
         |                                                        |
     shebang script  --->  expand_shebang -> interpreter ELF ----+
     #!/usr/bin/env python3   ->  /usr/bin/env ELF -> loader -> env -> python3
```

Notes on the chain:
- `exec_in_guest()` (`linux_env.py:228-261`) and `linux_session.py` enter at
  step 3 directly (they build the `linker64 + proot` argv themselves; the
  session module gets the same builder — §4.3).
- The RN bridge (`linuxExec`), the setup wizard, and `ACTION_LINUX_TEST`
  (`HermesService.kt:104-117`) all go through `exec_in_guest`.
- Steps 1-2 replace today's direct `execve(<shim>)` (EACCES under 36 — §1).
- `MOCH_NATIVE_LIB_DIR` is exported **at every boot** by
  `hermes_boot._prepare_home` (§4.5.2 — the `MOCH_WORKSPACE` pattern) and
  again by `bootstrap()`/`ensure_shims()` at provisioning; it is inherited
  by the shim child (`_make_run_env` = `dict(strip_launch_profile_env(
  os.environ.copy()) | env)`, `local.py:655-660` [verified 8]; the
  background-spawn scrub leaves it intact — §4.5.2). `exec_in_guest`
  resolves `loader_path()` at call time.
  No consumer ever persists an absolute `nativeLibraryDir`, so the chain is
  immune to `/data/app/~~<rand>/<pkg>-<rand>` re-randomization on app
  updates — the exact failure class Termux patches around by re-linking
  `applib` on every service start [verified 7].
- The only file whose *execve* permission matters inside the guest chain is
  the loader; everything else is mmap.
- The `[E]` loop holds at arbitrary process depth: proot sets
  `PTRACE_O_TRACEFORK|TRACECLONE|TRACEVFORK|TRACEVFORKDONE`
  (`src/tracee/event.c:513-515`, verified this session), so grandchildren
  of any guest process are traced too.

---

## 4. Implementation plan

Smallest set, mapped to the audit change-surface **as supplied with the M8
brief** (the audit agent's changeSurface list is not persisted anywhere
re-readable — `.zcode/workflow-runs/` holds only compiled scripts; coverage
was therefore cross-checked against direct greps this session and again in
review). Python changes stay stdlib-only and match `linux_env.py` house style
(module docstring milestone context, `_log()` to stderr, report dicts,
`# noqa: BLE001`).

### 4.1 Ship the proot loader as an APK native library — THE fix

- **New binary** `app/android/app/src/main/jniLibs/arm64-v8a/libproot-loader.so`
  = the `usr/libexec/proot/loader` file from the pinned
  `proot_5.1.107.96_aarch64.deb` (`PROOT_URL`, `linux_env.py:29`).
  SHA-256 `cbdef0e652c2b78af25d867e1719fdebbb0915e25aae2dd35b3b5c1835f6b551`,
  18,136 bytes, static ELF EXEC, `LOAD` align `0x4000` [verified 1, 2].
  Committed to the repo (nothing in `.gitignore` excludes it — verified).
- **New script** `embedded/vendor-proot-loader.sh`: downloads the pinned
  `.deb`, verifies the loader SHA-256, extracts
  `data.tar.xz:./data/data/com.termux/files/usr/libexec/proot/loader` (ar +
  tar), copies it to the jniLibs path, mode 0644. Documented as the
  regeneration path for the committed binary (provenance = Termux package
  repo, exact URL + SHA).
- **New license file** `embedded/licenses/proot-COPYING` (GPLv2 text from
  `.research/termux-proot/COPYING`) + a short notice in the script header and
  in §7.3: Moch redistributes an **unmodified, separately-built** GPLv2
  binary; source offer = the pinned termux fork tag
  (`github.com/termux/proot` @ `v5.1.107.96`).

### 4.2 `app/android/app/build.gradle`

- `targetSdkVersion 28` → `36` at `:110`; rewrite the comment at `:106-109`
  (it currently documents the 28 pin as the proot enabler; new text: exec now
  rests on the native-lib loader, see `embedded/EXEC-DESIGN.md`).
- `packagingOptions.jniLibs` at `:146-151`: stop deriving from the
  `expo.useLegacyPackaging` property (default `false`); set
  `useLegacyPackaging true` unconditionally — without extraction there is no
  `nativeLibraryDir` **file** to execve (uncompressed in-APK libs are only
  mmap-able). Belt-and-braces: `doNotStrip '**/libproot-loader.so'`.
- Lint block `:155-159` (`ExpiredTargetSdkVersion`): becomes moot — drop it
  and update the comment, or keep with a Play-forward note (implementer's
  choice; it is now unused).
- `versionCode` `:111` (currently 3) — hand-bump for the release that carries
  the raise (PROJECT.md "How they ship").
- Manifest (`AndroidManifest.xml`): one line — the
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission gap found in review (§4.6,
  §8); every 29→36 gate itself is already satisfied or auto-merged (§8).

### 4.3 `app/python-runtime/moch/linux_env.py`

- **New** `_native_lib_dir() -> str` — Chaquopy 17.0 API, spelled exactly
  (verified via `javap` on `chaquopy_java-17.0.0.jar` from the local gradle
  cache this session: `getPlatform()` is **static** on
  `com.chaquo.python.Python` and returns `Python$Platform`, whose interface
  declares only `getPath()`/`onStart()` — `getApplication()` lives on the
  **`AndroidPlatform` subclass**, so the call must dispatch on the runtime
  class, which Chaquopy's Python→Java bridge does):
  ```python
  from java import jclass
  Python = jclass("com.chaquo.python.Python")
  context = Python.getPlatform().getApplication()      # static, runtime-class dispatch
  native_lib_dir = context.getApplicationInfo().nativeLibraryDir
  ```
  `HermesRuntime.kt:33` starts Python with `AndroidPlatform(appContext)`
  before `boot()` at `:36`, so the platform is available at boot time.
  Override via `MOCH_NATIVE_LIB_DIR` env when already set (unit-test seam).
  Cache the resolved value per process. Import `java` lazily inside the
  function so module import stays testable.
- **Runtime resolution, never persisted.** `nativeLibraryDir` is unstable:
  every APK install/update moves the app to a fresh
  `/data/app/~~<rand>/<pkg>-<rand>/lib/arm64`. So **no file Moch writes may
  contain an absolute nativeLibraryDir** — a baked path is stale on the
  first guest command after every update, exactly the failure Termux
  repairs on every service start [verified 7]. Concretely:
  - `bootstrap()` and `ensure_shims()` begin with
    `os.environ.setdefault("MOCH_NATIVE_LIB_DIR", _native_lib_dir())` so
    every child (shim via `_make_run_env`, `local.py:655-660` [verified 8])
    inherits a fresh value;
  - `exec_in_guest`/`build_guest_launch` resolve `loader_path()` at call
    time.
- **New** `loader_path() -> Path`: `<$MOCH_NATIVE_LIB_DIR>/libproot-loader.so`;
  a missing file is a hard bootstrap error with a clear `_log` ("app built
  without libproot-loader.so — rebuild with the jniLib present").
- `exec_in_guest` env `:240-243`: `PROOT_LOADER = loader_path()`; add
  `env.pop("LD_PRELOAD", None)` (parity with proot-distro
  `login/__init__.py:527` — defensive; Moch never sets it today).
- `ensure_shims` `:57-66`: shim body changes to
  `: "${MOCH_NATIVE_LIB_DIR:?moch linux: MOCH_NATIVE_LIB_DIR unset (internal launcher bug — reinstall Moch or report)}"`
  + `export PROOT_LOADER="$MOCH_NATIVE_LIB_DIR/libproot-loader.so"`; the
  `exec /system/bin/linker64 …` line `:63-65` is **unchanged**. The body
  starts with a format marker comment `# moch-shim-format: 2`, and
  `ensure_shims` regenerates when the on-disk marker is absent or stale —
  this is what retires M7.5 shims (whose bodies bake the now-dead app-data
  loader path at `:61`). **The marker check needs a boot-time caller**:
  with old shims on disk, `hermes_boot.py:74` currently skips
  `ensure_shims` (it fires only when `sh` is missing) and nothing invokes
  `bootstrap()` after an app update — so §4.5 extends that repair gate to
  `sh missing OR marker absent/stale`, giving the retirement a first-boot
  trigger. The guest `/bin/sh` → bash repoint `:74-78` stays. The persisted
  paths that remain (`$LD/…`, `<home>/…`) are stable across app updates.
- **New shared builder** `build_guest_launch(guest_argv: list[str]) ->
  (argv, env)`: returns `[LINKER64, str(proot), "-r", rootfs, "-b",
  workspace+":/workspace", "-b", "/dev", "-b", "/proc", "-0", "-w", "/root",
  *guest_argv]` plus the env above. `exec_in_guest` `:244-256` uses it.
- **Version stamps** (replaces bare existence checks `:137, :166, :184, :211`):
  write `<linux>/.provision-stamp` (JSON) after successful provisioning with
  `{"mechanism": 2, "proot": PROOT_URL, "libtalloc": LIBTALLOC_URL,
  "shmem": SHMEM_URL, "rootfs": ROOTFS_URLS[distro]}`. **Exact re-provision
  predicate** (no special cases left implicit): `proot`/`libtalloc`/`shmem`
  re-run when the stamp is absent OR their URL differs; the **rootfs**
  re-runs **iff a stamp exists AND its rootfs URL differs** — and then
  `rmtree(rootfs)` first, never the current `mkdir(exist_ok=True)` +
  `extractall` merge-over (`:218-221`, which would leave stale files on a
  pin bump like ubuntu 24.04.4 → 24.04.5). Absent stamp + existing rootfs =
  keep it (the M7.5 → M8 upgrade path). Stamp caveat: the pinned Debian-12
  URL (`linux_env.py:41`, `debuerreumaker/...` on GitHub) is **dead — HTTP
  404, verified this session** (a pre-existing M7.5 defect: the org is
  misspelled; the real one is `debuerreotype/docker-debian-artifacts`,
  branch `dist-arm64v8`, whose artifact family is `rootfs.tar.xz` — the
  corrected artifact itself NOT verified here). `bootstrap("debian-12")`
  therefore already fails at download today; M8 scopes Debian-12 out
  (Ubuntu 24.04 is the tested distro), notes the fix as a tracked follow-up
  (URL + `tar.xz` handling + device verify), and the wizard's Debian option
  (setup.tsx:59) keeps failing loudly as it does now — no silent change.
  There is deliberately **no** `loader_sha256` key (the loader is no longer
  provisioned — it ships in the APK; its integrity is checked at build time
  by `embedded/vendor-proot-loader.sh`) and **no** `native_lib_dir` key
  (nothing persists that path anymore — §3 notes; the shim format marker
  covers regeneration).
- Deb extraction changes: drop `libexec/proot/loader`/`loader32` from the
  member list `:152` **and** from the existence gate `:137` (gate becomes
  `bin/proot` only) **and** from the chmod pass `:205` — the app-data
  loader is dead; 32-bit guests are out of scope (arm64-only, §5).
- **Architecture refusal:** `bootstrap()` returns
  `{"ok": False, "error": "Moch Linux requires an arm64 device"}` without
  downloading anything when `os.uname().machine` is not `aarch64` (covers
  `x86_64` builds where no loader jniLib exists) — implements the §5 limit.
- **Traversal-safe extraction** (Play's unsafe-unzipping scanner, §6 item 2;
  Python 3.11 `tarfile` has no `filter="data"` default). The predicate is
  pinned precisely — do **not** aim for `filter="data"` parity: the data
  filter rejects *absolute symlink targets*, and the pinned ubuntu-base
  tarball **contains 20 of them** (downloaded and enumerated this session:
  `etc/alternatives/awk -> /usr/bin/mawk`, `etc/rmt -> /usr/sbin/rmt`,
  systemd `*.wants` timer links, …; 29,870,567 bytes total), so data-filter
  parity would break rootfs provisioning on-device at the first such
  member. `_safe_extract(tf, dest)` therefore:
  - rejects **member paths** that are absolute or normalize outside `dest`;
  - rejects **relative symlink/hardlink targets that resolve outside
    `dest`** (`../escape`);
  - **allows absolute symlink targets verbatim** — they are guest-absolute
    paths, inert on the host until proot resolves them inside the guest,
    and they are expected in every distro rootfs.
  Used for the rootfs `extractall` `:220-221` and the deb `data.tar.xz`
  member extraction.
- `bootstrap()` env side-effect (fixes the mid-session gap, §4.5): on
  success it also sets `os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"`
  — the setup wizard provisions the guest in the same live process
  ([verified 8]) and `hermes_boot.boot()` never re-runs `_prepare_home`.
- `status()`: add `loader_ok: bool` (jniLib present) to the report.
- `reset()`: unchanged (rmtree removes the stamp with everything else).

### 4.4 `app/python-runtime/moch/linux_session.py`

- `_build_argv` `:49-53` → use `linux_env.build_guest_launch(["/bin/bash",
  "--norc", "--noprofile"])` so the persistent session gets the `linker64`
  prefix + `PROOT_LOADER` env like every other launch (the known
  inconsistency; draft constraint `.zcode/workflow-drafts/…dwf.ts:318`).
  Keep the extra session env (`TERM=dumb`, guest `PATH`, `HOME=/root`).

### 4.5 `app/hermes-src/tools/environments/local.py` + `tools/process_registry.py`

- New generic env contract: `HERMES_EXEC_TRAMPOLINE` — when set to a path,
  every exec of the resolved shell goes through
  `[<trampoline>, <shell>] + args`. Two call sites only ([verified 5]):
  `local.py:896` (`args = [bash, …]` → `[trampoline, bash, …]` when the env
  var is set) and `process_registry.py:976` (`_scope_argv`). Unset → argv
  byte-identical to today (desktop hermes unaffected; Android-without-Linux
  unaffected). **Wrap guard:** apply the trampoline only when the resolved
  shell path is **not** itself under `/system` — a device that sets
  `$SHELL=/system/bin/sh` makes `_find_shell` (`local.py:536-545`, `sh` is
  in `_SPAWN_COMPATIBLE_SHELLS`) return it, and `[/system/bin/sh,
  /system/bin/sh, -lic, …]` would make mksh try to read its own binary as a
  script, a regression against today's working direct exec (whether Android
  app processes carry `$SHELL` at all is device-dependent — unverified
  either way; the guard makes it moot). Accepted corner: with the guest
  absent, the `"/bin/sh"` fallback now fails as mksh `Can't open /bin/sh`
  (exit 2) instead of Popen's `FileNotFoundError` — same broken state,
  different error string.
- `app/python-runtime/moch/hermes_boot.py` `_prepare_home` `:73-86`, three
  changes:
  1. **`HERMES_EXEC_TRAMPOLINE`**: set
     `os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"` whenever
     `/system/bin/sh` exists (always on Android), **unconditionally** —
     alongside the PATH prepend. Do NOT gate it on the shims existing:
     `_prepare_home` runs once per process (`boot()` caches in
     `_BOOT_REPORT`, `hermes_boot.py:106-140`) while the setup wizard
     provisions the guest mid-session and continues in the same process
     ([verified 8] `setup.tsx:74`) — a shim-gated trampoline would leave
     the agent's first post-wizard commands exec'ing the shim directly →
     EACCES until a manual restart. Belt and braces: `linux_env.bootstrap()`
     also sets it on success (§4.3).
  2. **`MOCH_NATIVE_LIB_DIR`** (steady-state exporter — without this every
     agent command fails after any app restart, because the shim's `:?`
     guard fires and neither `bootstrap()` nor a shim regeneration runs on
     a normal boot with the guest already provisioned): import
     `moch.linux_env` lazily and `os.environ.setdefault("MOCH_NATIVE_LIB_DIR",
     linux_env._native_lib_dir())` at **every** boot, exactly the pattern
     `MOCH_WORKSPACE` already uses (`hermes_boot.py:69`). If resolution
     raises (e.g., Chaquopy `java` bridge not ready), leave it unset —
     `bootstrap()`/`ensure_shims()` still seed it (§4.3), and the scrub
     chain preserves it on every spawn path
     (`_make_run_env` = `dict(strip_launch_profile_env(os.environ.copy())
     | env)`, `local.py:655-660`; `_sanitize_subprocess_env`'s filter
     matches only `AUXILIARY_*`/`GATEWAY_RELAY_*` secret shapes,
     `local_env_policy.py:172-181` — both re-read this session).
  3. **Extended shim-repair gate** (M7.5 → M8 upgrade): the condition at
     `hermes_boot.py:74` becomes "sh missing **OR** the on-disk shim's
     format marker is absent/stale" (cheap first-line read), so
     `ensure_shims()` — which also seeds `MOCH_NATIVE_LIB_DIR` (§4.3) —
     runs once at the first post-update boot and retires format-1 shims
     whose baked app-data `PROOT_LOADER` (`linux_env.py:61` as of M7.5)
     is denied under `untrusted_app`. Without this, existing installs keep
     EACCES-ing indefinitely: the wizard shows "Already installed" and
     nothing prompts a `bootstrap()` re-run (`setup.tsx:71-74`).
- `_find_bash` itself (`local.py:459-486`) is **unchanged** — PATH resolution
  still lands on the shim (audit: keep the contract).

### 4.6 Kotlin/manifest touches — minimal, enumerated

- `HermesBridgeModule.kt` and the `exec_in_guest` argv/env contract:
  unchanged.
- `HermesService.kt`: **no change under the prescribed test procedure**
  (§9.2). The `ACTION_LINUX_TEST` branch (`:103-117`) returns
  `START_NOT_STICKY` **without calling `startForeground`** — a service
  started via `am start-foreground-service` must call `startForeground`
  within ~5 s or the system raises
  `ForegroundServiceDidNotStartInTimeException`, i.e. that invocation form
  would crash the app mid-bootstrap (rootfs extraction takes minutes).
  §9.2 therefore launches `MainActivity` first and uses plain
  `am startservice`. *If* a future change ever wants the foreground-service
  form, the same branch must first call
  `startForeground(NOTIFICATION_ID, buildNotification(),
  FOREGROUND_SERVICE_TYPE_DATA_SYNC)` — noted here so the constraint is
  explicit rather than implied by omission.
- `AndroidManifest.xml`: one line — add
  `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>`
  (§8, [verified 6]: `AudioControlsService` declares
  `foregroundServiceType=mediaPlayback` in the merged manifest while the
  permission is missing; at targetSdk 34+ its `startForeground` throws
  `SecurityException`, which expo-audio catches, so background-audio FGS
  fails silently today).
- `MainApplication.kt` / `HermesRuntime.kt`: no Context plumbing needed
  (`_native_lib_dir()` goes through Chaquopy).

### 4.7 Tests + docs (new files)

- `app/python-runtime/tests/test_linux_exec.py` — §9.1 (stdlib-only, exit 0,
  final line `ALL TESTS PASSED`; directory does not exist yet — verified).
- `embedded/m8-guest-test/` — on-device guest test assets (§9.2):
  `run.sh`, `hello.js`, `hello.py`, `hello.php`, `exec_matrix.c`,
  `shebang.sh`, `env_shebang.py`.
- `embedded/MILESTONE-8.md` — the adb procedure + expected outputs
  (successor to `MILESTONE-7.5.md:41-46`; must carry the
  `am start` + `am startservice` form of §9.2 and the warning about why
  `am start-foreground-service` would crash `ACTION_LINUX_TEST`).

---

## 5. Compatibility matrix

| Android | SELinux domain (targetSdk 36) | Guest exec | Basis / notes |
| --- | --- | --- | --- |
| 6–9 (API 24–28 devices, minSdk 24) | `untrusted_app_27` (no 29+ split existed) | ✅ expected | App-data exec allowed anyway in `_27`; loader-in-native-lib not source-verified at these versions (not checked this session) — same mechanism as 10+ expected. |
| 10 (API 29) | `untrusted_app_29` | ✅ expected | Denial side verified (packet); the `apk_data_file` allow was **not located** in the reorganized `app.te` at `android-10.0.0_r1` this session — flag for the device matrix if a 10 device exists. |
| 11 (API 30) | `untrusted_app_30` | ✅ | Rule not located in source at the `android-11` tag either; empirically covered by Play Termux (minSdk 30) whose loader exec works since 2024-06. |
| 12 (API 31) | `untrusted_app_32` | ✅ | Same as 11. |
| 13 (API 33) | `untrusted_app_32` | ✅ verified | `android-13.0.0_r1/private/app.te:411` `allow appdomain apk_data_file:file rx_file_perms` [verified 3]. |
| 14 (API 34) | `untrusted_app` | ✅ | Same rule family; identical block verified 13 → main (packet). |
| 15 (API 35) | `untrusted_app` | ✅ + caveats | (a) 16 KB-page devices: proot + loader `LOAD` align `0x4000`, Ubuntu arm64 rootfs `0x10000` — all 16 KB-safe (packet readelf + [verified 1]); RN/Chaquopy native libs are a separate build-level 16 KB concern. (b) **Regression the raise itself introduces:** the `dataSync` FGS ~6 h timeout applies to targetSdk 35+ — the always-on agent will be stopped after ~6 h per boot unless handled; M8 ships this as an explicit accepted limitation (§8), migration path = `Service.onTimeout()` + the existing `HermesService.restartApp()` (`HermesService.kt:75-87`) or `specialUse` + Play justification. Edge-to-edge opt-out still honored on Android 15 devices. |
| 16 (API 36) | `untrusted_app` | ✅ verified (exec) + UI changes | `android-16.0.0_r1/private/app.te:443` + `untrusted_app_all.te` exec rules identical to main [verified 3]; this is the raise target. UI behavior at 36 [verified 9]: edge-to-edge **cannot be opted out** on Android 16 devices (`windowOptOutEdgeToEdgeEnforcement` deprecated/disabled) — inset handling becomes required UI work, not precautionary; `screenOrientation="portrait"` (`AndroidManifest.xml:36`) is ignored on sw ≥ 600 dp screens; predictive-back animations default ON and `onBackPressed`/`KEYCODE_BACK` are suppressed — Moch keeps legacy back behavior only because `android:enableOnBackInvokedCallback="false"` (`:19`) is the documented temporary opt-out. |

Architecture limits (all versions): pinned artifacts are aarch64-only — on
`x86_64` devices (none in scope; RN builds arm64-v8a only per
`build.gradle:169-171` comment) Moch Linux must refuse bootstrap with a clear
message.

Known limits inherent to the mechanism (not introduced by this design; same
as Termux Play):
- `/proc/<pid>/exe` and `comm` inside the guest show the **loader's host
  path** (the exec'd file), not the guest binary; `AT_EXECFN` is corrected by
  the termux fork (`exit.c` `execfn_addr` fix, packet). Tools that read
  `/proc/self/exe` to re-exec themselves may misbehave.
- `execveat` with a real dirfd returns `ENOSYS` in proot
  (`src/execve/enter.c:1882-1885`; only `AT_FDCWD` is translated).
  `fexecve` in glibc falls back to a `/proc/self/fd/N` path — works only
  because `/proc` is bound.
- proot is ptrace-based: a ROM that denies app self-ptrace kills the whole
  feature (works on stock Android; `self:process ptrace` allowed,
  `untrusted_app_all.te:102-103`). `dpkg`/hardlink-heavy workloads may later
  want `--link2symlink` (proot-distro `proot_cmd.py:144-157`) — deliberately
  **out of scope** here (M7.5 device-verified `dpkg` without it).
- ptrace syscall overhead: guest exec-heavy workloads pay the usual proot
  cost; the persistent session (`linux_session.py`) already mitigates.

---

## 6. Play Store implications

**Does the approach allow targetSdkVersion 36? Yes.** Every exec in the chain
lands on a path SELinux permits at any targetSdk: `/system/bin/sh`,
`/system/bin/linker64` (`system_linker_exec`), and the jniLib loader
(`apk_data_file` `execute_no_trans` [verified 3]); everything else is mmap
`PROT_EXEC`, explicitly still allowed. No reliance on `untrusted_app_27`, no
root, no extra APK. Play requires API 36 for updates since 2026-08-31 anyway
(support.google.com/googleplay/android-developer/answer/11926878 — packet).

**Policies that still bite:**

1. **Device and Network Abuse — downloadable executable code**
   (answer/16273414: "an app may not download executable code (such as dex,
   JAR, .so files) from a source other than Google Play", except "code that
   runs in a virtual machine or an interpreter…"). Moch runtime-downloads the
   proot/libtalloc `.deb`s and the Ubuntu/Debian rootfs tarball into app data
   after install. Mitigation ladder:
   - *Smallest (status quo + this design):* keep the downloads. The proot
     guest is a userspace VM; Termux's Play build passes review while
     apt-downloading native packages under the same reading — but Google has
     never officially blessed that carve-out (research gap; rejection risk is
     real). The loader itself — the one binary that must exec — is bundled
     in-APK by this design, which removes the most policy-visible moving
     part.
   - *Clearly compliant (recommended for any actual Play submission):* bundle
     the rootfs seed (ubuntu-base is ~31 MB — 29,870,567 bytes as
     downloaded this session; figure quoted at `MILESTONE-7.5.md:19`) as an
     APK asset/jniLib, matching how Play Termux bundles its bootstrap
     (`TermuxInstaller.java:106-112`); apt-inside-guest afterwards is the
     same grey area Termux lives in.
2. **Unsafe unzipping scanner** (support.google.com/faqs/answer/9294009):
   Play flags apps that extract archives unsafely. Moch extracts the `.deb`s
   (pure-Python ar parser, `linux_env.py:85-101`) and the rootfs
   (`tarfile.extractall`, `:220-221`). The fix is specified in §4.3 with a
   pinned predicate (`_safe_extract`: reject absolute/escaping member
   paths and relative link targets that resolve outside `dest`, but allow
   absolute symlink targets — distro rootfs tarballs legitimately contain
   them; Python 3.11 has no `filter="data"` default, and data-filter
   parity would break the pinned rootfs — §4.3).
3. **Foreground-service declarations** (API 34+): already compliant (§8), but
   a Play submission needs the Console FGS-type declaration for `dataSync`,
   and the Android 15 6 h `dataSync` timeout (§5/§8) will eventually force
   `specialUse` + reviewer justification for an always-on agent.

Today Moch is sideloaded (lint block comment, `build.gradle:156-157`), so all
of the above is forward-looking; nothing in this design closes the Play door.

---

## 7. Decision rationale

**M1 — if a current Termux proot package already translates guest ELF exec
through `/system/bin/linker64` or equivalent: adopt it.**
No Termux proot package uses `linker64` for guest execs — `linker64` appears
only host-side (`TermuxShellUtils.java:89`, termux-exec). The *equivalent*
exists and is better: the loader substitution (§2.2), present in the exact
`.deb` Moch already pins (5.1.107.96, current termux-main, bumped 2026-10-01),
with the loader path env-overridable (`enter.c:571`, confirmed in the deb's
strings). **ADOPTED in the M1 form "bump pins, adjust launcher/env": no pin
change needed; adjustments = loader as jniLib + `PROOT_LOADER` →
`nativeLibraryDir` + launcher/trampoline fixes.** The Play fork's alternative
(`src-execve-enter.c.patch` hardcoding `applib/libproot-loader.so`) is
explicitly *not* taken: it pins Termux's symlink layout, drops the env
override, and rides an older proot (5.1.107.80).

**M2 — else if unpatched upstream proot achieves it: configure it. REJECTED.**
Upstream proot-me has no Android build support and **no `PROOT_LOADER` at
all** (0 occurrences at v5.5.0 — packet); the ~270-commit termux fork carries
all Android fixes (fake_id0/`--change-id`, link2symlink, statx/faccessat2,
seccomp/SIGSYS, ashmem-memfd, netlink, execveat-AT_FDCWD, AT_EXECFN, AArch64
SP alignment). "Upstream + config" is not a real option on Android.

**M3 — else minimal own fork/patch + NDK build under embedded/. NOT NEEDED.**
M1 covers everything with an unmodified binary, so no fork, no NDK toolchain
dependency, no build-time compile step. GPLv2 obligations that *do* apply to
redistributing the unmodified Termux-built loader in Moch's APK/repo: ship
the license text (`embedded/licenses/proot-COPYING`) and name the
corresponding source (termux/proot @ v5.1.107.96) in `vendor-proot-loader.sh`
— exactly what this design specifies. Moch aggregates a separate, unmodified
GPLv2 work (the proot process + its loader), makes no derivative of proot
source, and links nothing against it; that is standard GPL aggregation, the
same position the Termux packages hold.

**M4 — host-side termux-exec-style LD_PRELOAD is NOT sufficient alone; include
only where research shows a concrete need. NO SUCH NEED FOUND — EXCLUDED.**
(1) *Guest side:* Moch's guests are glibc (Ubuntu/Debian); termux-exec is a
bionic-linked `.so` whose loading behavior inside a glibc `ld.so` the sources
do not even address (research gap), it cannot see raw `syscall(2)` execve
callers (`technical/index.md:37`) or static binaries (`:114`), and Termux's
own documented answer for both is "run them under proot" (`:116`) — which is
already Moch's path for *everything*. proot's ptrace covers every guest
execve syscall regardless of libc or staticness; termux-exec would add zero
coverage inside the guest. (2) *Host side:* the only app-data execs outside
proot are the two resolved-shell launches (§4.5) and proot itself (launched
via `linker64` since M7.5). The process that would need the preload is
Chaquopy's in-app CPython — already running, with no exec boundary through
which an `LD_PRELOAD` could be injected. Two ~5-line trampoline call sites
solve it outright. There is therefore no place in Moch where M4 is either
sufficient or necessary.

**Constraint check (chosen mechanism = M1):** no root ✅ (userspace ptrace +
mmap only); no Termux installed ✅ (artifacts vendored from the package
repo); no second APK ✅ (loader rides Moch's own APK as a jniLib); rootfs
stays in private storage ✅ (unchanged, `files/.hermes/linux/rootfs`); proot
kept ✅ (unmodified pinned build); children + shebangs + `execve/execv/
execvp/execl/execlp/posix_spawn` + raw-syscall exec ✅ (all converge on the
one ptrace-caught `execve` — §2.2); normal Android exec untouched ✅
(`HERMES_EXEC_TRAMPOLINE` unset → byte-identical hermes argv; non-Moch execs
never see any of this); maintainable ✅ (no fork, no NDK, one vendored
18 KB binary with a regeneration script + SHA pin).

---

## 8. targetSdk 28 → 36 raise checklist

Applied by the implementer together with §4 (never after it):

- [ ] `build.gradle:110` `targetSdkVersion 36`; rewrite comment `:106-109`.
- [ ] `useLegacyPackaging true` + `doNotStrip` for the loader (§4.2) — verify
      on device that `/data/app/*/lib/arm64/libproot-loader.so` exists
      (`adb shell run-as com.hermes.pocket ls` is not needed; the guest test
      covers it functionally).
- [ ] `versionCode` hand-bump (`:111`).
- [ ] **Foreground service (API 34+): `HermesService` is compliant** —
      `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` declared
      (`AndroidManifest.xml:3-4`), `HermesService` has
      `android:foregroundServiceType="dataSync"` + `exported="false"`
      (`:35`) and calls `startForeground(NOTIFICATION_ID, notification,
      FOREGROUND_SERVICE_TYPE_DATA_SYNC)` on Q+ (`HermesService.kt:124-128`;
      verified in the built APK's merged manifest — packet audit).
      **Gap found in review, verified this session [verified 6]:** the
      merged manifest also contains `expo-audio`'s `AudioControlsService`
      with `foregroundServiceType=0x2` (mediaPlayback) but **no
      `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission anywhere** — at
      targetSdk 34+ its `startForeground` throws `SecurityException`
      (caught by expo-audio, so background-audio FGS fails *silently*).
      One-line fix in `AndroidManifest.xml` (§4.6); alternatively drop the
      service if audio-backgrounding is unused.
- [ ] **Accepted limitation, carried by this release (not deferred):**
      raising to 35+ opts the app into the Android 15 `dataSync` FGS
      **~6 h timeout** — a regression the raise itself introduces for the
      always-on agent (boot is unaffected; after ~6 h the system stops the
      runtime unless handled). M8 ships with this documented in
      `embedded/MILESTONE-8.md`; the migration path is an
      `onTimeout()` override chaining into the existing
      `HermesService.restartApp()` (`HermesService.kt:75-87`) or
      `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` + Play
      justification. Deliberately out of M8 code scope — but explicit, not
      a footnote.
- [ ] **`android:exported` (API 31+): already explicit** — `MainActivity`
      `true` (`:36`), `AudioControlsService`/`HermesService` `false`
      (`:30,:35`).
- [ ] **`POST_NOTIFICATIONS` (API 33+): already merged** by
      `expo-notifications` into the built APK (aapt2-verified, packet) and
      requested at pairing (commit `cfdfc0e`); source manifest needs nothing.
      Without the grant only cron-knock notifications are silent.
- [ ] **PendingIntent immutability (API 31+): already `FLAG_IMMUTABLE`**
      (`HermesService.kt:82,138,144`).
- [ ] **Scoped storage:** `READ/WRITE_EXTERNAL_STORAGE` already capped
      `maxSdkVersion="32"` (`:7,:11`); app lives in private storage — inert.
- [ ] **Cleartext / queries / back:** `usesCleartextTraffic="true"` stays
      (loopback WS, `:19`); `<queries>` block present (`:12-18`).
      Predictive back at 36 [verified 9]: system back animations default ON
      and `onBackPressed`/`KEYCODE_BACK` are suppressed for apps targeting 36
      on Android 16 devices — Moch keeps legacy back behavior **because**
      `android:enableOnBackInvokedCallback="false"` (`:19`) is the
      documented temporary opt-out (revisit before API 37, where Google's
      guidance says the opt-out path ends).
- [ ] **Edge-to-edge (API 36): enforced, no opt-out on Android 16 devices**
      [verified 9] — `windowOptOutEdgeToEdgeEnforcement` is
      deprecated/disabled for targetSdk 36 (the opt-out still works on
      Android 15 devices). Status/nav-bar inset handling in the RN UI is
      **required** follow-up work, not precautionary; flag visibly in the
      M8 release notes.
- [ ] **Orientation on large screens (API 36):** `screenOrientation=
      "portrait"` (`manifest:36`) is ignored on sw ≥ 600 dp screens
      [verified 9] (foldables/tablets/fold-open). Accept the
      unrestricted-orientation rendering or handle it in the UI; not an
      exec concern.
- [ ] **Device-test invocation:** launch the app first, then start the
      service plainly — `adb shell am start -n
      com.hermes.pocket/.MainActivity && sleep 2 && adb shell am startservice
      -n com.hermes.pocket/.hermes.HermesService -a
      com.hermes.pocket.hermes.LINUX_TEST`. With the activity foreground,
      an ordinary service start is legal and carries **no** 5 s
      `startForeground` obligation. Do **not** use `am start-foreground-
      service` for `LINUX_TEST`: that branch of
      `HermesService.onStartCommand` (`:103-117`) returns without ever
      calling `startForeground` (bootstrap takes minutes), so the system
      would raise `ForegroundServiceDidNotStartInTimeException` and kill
      the process mid-test (§4.6). (`MILESTONE-7.5.md:43-44`'s bare
      `am startservice` worked because `am startservice` from the adb
      shell — the `shell` uid — may start services largely irrespective of
      app state; the revised am-start-first procedure is preferred because
      it does not depend on shell privileges at all.)
- [ ] **The raise and the exec fix ship together** in one versionCode.

---

## 9. Test plan

### 9.1 Local, stdlib-only unit tests — `app/python-runtime/tests/test_linux_exec.py`

Run: `python3 app/python-runtime/tests/test_linux_exec.py`; exit 0; final line
`ALL TESTS PASSED`. Self-contained (sys.path bootstrap to
`app/python-runtime`), no pytest, no network, no Android. `linux_env` must
not import `java` at module scope (§4.3) so these run on CPython 3.11 desktop.
Cover:

1. `build_guest_launch()` argv shape: `LINKER64` prefix, `-r` rootfs, both
   binds, `-0 -w /root`, guest argv appended, `PROOT_LOADER` → native-lib
   path, `LD_LIBRARY_PATH`, `LD_PRELOAD` popped (fake `HOME` via env
   override + `MOCH_NATIVE_LIB_DIR` seam).
2. Shim generation (`ensure_shims` into a tmp home): body starts with the
   `# moch-shim-format: 2` marker, contains the
   `PROOT_LOADER="$MOCH_NATIVE_LIB_DIR/libproot-loader.so"` line and the
   `MOCH_NATIVE_LIB_DIR` unset-guard, keeps the unchanged
   `exec /system/bin/linker64` line, and contains **no absolute
   `/data/app` path** (grep the body — the update-staleness guarantee,
   §4.3); files mode 0755; guest `/bin/sh` repoint logic with a fake rootfs
   (dash symlink → bash); regeneration when the on-disk marker is missing
   or stale (a pre-M8 shim body is rewritten) — but **not** when it
   matches (steady state stays cheap).
3. Version-stamp logic, per §4.3's exact predicate: stamp write/read
   roundtrip; absent stamp re-provisions `proot` but **keeps** the rootfs;
   a differing URL constant re-provisions that step; **rootfs** re-runs
   only when a stamp exists AND its rootfs URL differs — and then wipes
   the old rootfs first (no merge-over); stamp keys are exactly
   `{mechanism, proot, libtalloc, shmem, rootfs}`.
4. Ar-parser regression (`_ar_extract_member`): synthesize a `.ar` in a
   tmpdir — odd-size member padding (2-byte alignment), member lookup,
   garbage-magic rejection.
5. `linux_session._build_argv` uses the shared builder (linker64 prefix
   present, `--norc --noprofile` preserved).
6. Trampoline + native-lib-dir wiring, **all three** paths:
   (a) `hermes_boot._prepare_home` sets `HERMES_EXEC_TRAMPOLINE=/system/bin/sh`
   unconditionally on Android — i.e. **also when the guest is not yet
   installed** (the setup wizard provisions mid-session in the same
   process, [verified 8]). **Test seam, pinned:** `_prepare_home` performs
   the check with `os.path.exists("/system/bin/sh")`, and the unit test
   patches `os.path.exists` via `unittest.mock` (stdlib — allowed; "no
   pytest" ≠ "no stdlib mock"). No production env override is added for
   this.
   (b) `_prepare_home` also `setdefault`s `MOCH_NATIVE_LIB_DIR` **when the
   guest is already provisioned and the shims are current** (steady state:
   neither `bootstrap()` nor shim regeneration runs — this is the
   every-boot-after-restart contract, §4.5.2);
   (c) `linux_env.bootstrap()` sets both on success in a process where they
   were previously unset (fresh-install → wizard → first terminal command
   flow).
7. Shim repair gate (M7.5 → M8 upgrade, §4.5.3): with a fake home holding
   an old-format shim (no `# moch-shim-format: 2` marker, baked app-data
   `PROOT_LOADER`), `_prepare_home` triggers `ensure_shims` regeneration;
   with a current-marker shim it does not (steady state stays cheap).
8. Trampoline wrap guard (§4.5): argv is wrapped for a shim path under the
   fake home but **not** for a resolved shell already under `/system`
   (`$SHELL=/system/bin/sh` corner).
9. `_safe_extract` helper, per §4.3's pinned predicate: member with `..`
   or absolute path rejected; relative link target resolving outside
   `dest` rejected; **absolute link target ACCEPTED** (synthesize a member
   `etc/alternatives/awk -> /usr/bin/mawk`, mirroring the real pinned
   rootfs — a data-filter-parity implementation would raise here and fail
   provisioning); normal tree extracted intact.

### 9.2 On-device (user's phone; no emulator exists in this environment)

Assets at `embedded/m8-guest-test/`, procedure in `embedded/MILESTONE-8.md`.

```bash
cd app/android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
# app first, then a PLAIN service start — NOT start-foreground-service:
# the LINUX_TEST branch never calls startForeground, so the FGS form would
# crash the process with ForegroundServiceDidNotStartInTimeException (§4.6,
# §8). With the activity foreground an ordinary start is legal, carries no
# 5 s startForeground obligation, and does not rely on adb's shell-uid
# service-start privileges (which is why M7.5's bare 'am startservice'
# also worked).
adb shell am start -n com.hermes.pocket/.MainActivity
sleep 2
adb shell am startservice -n com.hermes.pocket/.hermes.HermesService \
  -a com.hermes.pocket.hermes.LINUX_TEST
adb logcat -s MochHermes | grep -i linux      # expect: linux exec: Linux … aarch64 GNU/Linux
```

Then push the guest test assets into `/workspace` (bind-mounted) and run the
matrix inside the guest via the app (hermes terminal or `linuxExec` bridge →
`bash /workspace/m8-guest-test/run.sh`), asserting every line prints `OK`:

- shells: `/bin/sh -c`, `/bin/bash -c` (and via the PATH shims from the agent).
- `/usr/bin/env`: `env python3 env_shebang.py` (shebang
  `#!/usr/bin/env python3`), `env --version`.
- interpreters: `node hello.js`, `python3 hello.py`, `php hello.php`, `git
  --version`, `npm install` in a scratch dir (network permitting) — install
  first inside the guest with
  `apt-get install -y nodejs php-cli git build-essential` (ubuntu-base
  ships no compiler, and `exec_matrix.c` below is built in-guest with
  `cc`).
- child processes: bash spawning node→python→php chains; `npm run` spawning
  children; backgrounded children + `wait`.
- exec-variant matrix: `exec_matrix.c` (compiled **inside the guest** with
  `cc`) exercising `execve`, `execv`, `execvp`, `execl`, `execlp`,
  `posix_spawn`, and a raw `syscall(SYS_execve, …)` child; each child prints
  its variant + `OK`.
- shebang scripts: `shebang.sh` (`#!/bin/bash`), `env_shebang.py`
  (`#!/usr/bin/env python3`), a script with an argument after the interpreter
  name, and a script executed from `/workspace` via a relative path.
- **update-staleness regression** (the failure class §4.3 designs out,
  upstream evidence [verified 7]): after the matrix passes, rebuild/reinstall
  with `adb install -r` (this re-randomizes `/data/app/~~…/lib/arm64`), let
  the app restart, and run one command **through the agent-terminal path**
  (ask the agent to run `uname -a` in a session, i.e. the hermes
  `_run_bash` → shim → `/system/bin/sh` chain) — it must still succeed.
  The surface matters: run via the `linuxExec` bridge this test would pass
  even with a steady-state `MOCH_NATIVE_LIB_DIR` exporter missing, because
  `exec_in_guest`/`loader_path()` resolve in-process — only the shim path
  exercises the env-var contract.
- **M7.5 → M8 upgrade scenario** (proves the shim-marker retirement has a
  boot-time caller, §4.5.3): install the last pre-M8 APK (HEAD `81e4b79`),
  bootstrap the guest via the wizard, then `adb install -r` the M8 APK over
  it (do NOT re-run the wizard — nothing prompts it), force-stop and relaunch
  the app, and run one agent-terminal command — it must succeed; format-1
  shims with the baked app-data `PROOT_LOADER` would EACCES forever without
  the extended repair gate.

Success = every matrix line `OK` + the logcat probe. Any `EACCES`/
`Permission denied` line is a failure of this design and gets the full
proot-verbose treatment (`PROOT_VERBOSE=9`) before triage.

### 9.3 Not runnable in this environment (recorded, not run)

- The unit test (§9.1) and the device matrix (§9.2) do not exist yet — they
  are implementer deliverables (§4.7). This design session ran no gradle
  build, no emulator, no on-device test.
- Android 10/11 `apk_data_file` source verification remains open (§5); the
  device matrix covers the user's actual phone.

---

## 10. Open risks

1. **Chaquopy `getApplication()` path** (`[verified 4]` against master source,
   not executed on a device): if `Python.getInstance()` is unavailable in
   some early-boot context, the `MOCH_NATIVE_LIB_DIR` env fallback (settable
   from `HermesRuntime`/`MainApplication`) is the escape hatch — implementer
   wires it only if the primary fails on device.
2. **Android 10/11 `apk_data_file` rule** not located in the reorganized
   `app.te` at those tags (§5) — low residual risk; empirically covered by
   Play Termux (minSdk 30) for 11+, untested for 10.
3. **AGP/manifest interaction of `useLegacyPackaging`**: Expo's generated
   gradle currently derives it from a property defaulting to false (§4.2);
   the implementer must confirm with `aapt2 dump badging` on the built APK
   that extraction is on (`extractNativeLibs=true`) and that
   `lib/arm64-v8a/libproot-loader.so` is present.
4. **`proot` + `loader32` removal**: 32-bit guest binaries are now explicitly
   unsupported (no exec-legal 32-bit loader shipped); a 32-bit guest exec
   fails with proot's loader-not-found error. Accept for M8 (arm64-only).
5. **In-guest tools reading `/proc/self/exe`** see the loader's host path
   (§5); `AT_EXECFN` is fixed by the termux fork, but a minority of tools
   (some `git` hooks, self-re-exec'ing daemons) may misbehave — record in
   `MILESTONE-8.md` if the matrix trips one.
6. **Shims now require `MOCH_NATIVE_LIB_DIR` in the environment** (clear
   `:?` error if absent). Every in-app launcher exports it — at every boot
   (`_prepare_home`, §4.5.2), at provisioning (§4.3), and both survive the
   spawn scrub chain — but an out-of-band invocation (e.g. manual
   `adb shell run-as` exec of the shim) will hit the guard — by design, so
   the failure names its cause instead of a stale-path ENOENT.
7. **dataSync 6 h timeout (Android 15+, targetSdk 35+)** — accepted
   limitation of this release (§8): the always-on agent stops after ~6 h
   per boot until the `onTimeout`/`specialUse` migration lands.
8. **Debian-12 rootfs URL is dead (pre-existing M7.5 defect, verified
   404 this session — §4.3):** `bootstrap("debian-12")` fails at download
   today and M8 scopes it out rather than shipping an unverified new
   artifact; the fix (correct org `debuerreotype/docker-debian-artifacts`,
   branch `dist-arm64v8`, `rootfs.tar.xz` handling + device verify) is a
   tracked follow-up. Ubuntu 24.04 is the only supported distro in M8.
