# Milestone 7.5 — Moch Linux: embedded Debian/Ubuntu via proot

Status: **core modules built; blocked on on-device feasibility test.**

## What this is

A real Linux userspace (Debian 12 / Ubuntu 24.04, chosen at setup) running
inside Moch's private storage under **proot** — ptrace-based userspace
chroot, the same mechanism Termux's `proot-distro` uses. Gives the agent:
apt, compilers, servers, any language, headless Chromium. Everything stays
inside the app sandbox.

## Architecture (what's built)

```
moch/linux_env.py       Bootstrap: download proot+libtalloc (Termux repo,
                        aarch64 Android builds), extract from .deb (pure-
                        Python ar parser), download Ubuntu rootfs (~31MB),
                        extract to files/.hermes/linux/rootfs/
                        exec_in_guest(cmd) → proot … /bin/sh -c cmd

moch/linux_session.py   Persistent proot-backed /bin/bash — ONE long-running
                        process, commands via stdin/stdout pipes with sentinel
                        framing. Termux-fast: no per-command boot/ptrace setup.
                        Auto-restarts if the shell dies.

HermesBridgeModule      linuxBootstrap(distro) / linuxExec(cmd) / linuxStatus()
HermesService           ACTION_LINUX_TEST intent → bootstrap + uname probe

TS surface              linuxBootstrap / linuxExec / linuxStatus
```

## The blocker: on-device ptrace feasibility

**proot relies on ptrace** (PTRACE_TRACEME) to intercept syscalls. Android
apps run in the `untrusted_app` SELinux domain — **some ROMs/configurations
deny ptrace to apps**, others allow it (Termux proves it works on stock).

The test (phone must be plugged in via USB):

```bash
adb install -r app-release.apk
adb shell am startservice -n com.hermes.pocket/.hermes.HermesService \
  -a com.hermes.pocket.hermes.LINUX_TEST
adb logcat -s MochHermes | grep linux
```

Success = `linux exec: Linux … aarch64 GNU/Linux` from inside the guest.
Failure names the exact blocker (ptrace denied, binary format, etc.).

**Why adb-shell testing can't prove this:** `adb shell` runs as the `shell`
user in a different SELinux domain than an app. Only running proot from
inside the app process tests the real permission.

## What's blocked on the proof

| Item | Why blocked |
| --- | --- |
| Tool routing (terminal + file tools → guest) | Meaningless if proot can't run |
| Settings → LINUX ENVIRONMENT section | UI for a non-working feature |
| Setup wizard (distro → provider → basics) | Same |
| Persistent shell device-testing | Written but untested |

## Design decisions locked with user

- **Setup wizard**: user picks distro (Debian 12 / Ubuntu 24.04 / none) →
  picks LLM provider → basic settings → download progress
- **Delivery**: rootfs downloaded on first install (not bundled — APK stays
  ~113MB)
- **One persistent session** (never sleeps, boots with the app, survives
  via the M6 foreground service)
- **Everything inside** when installed: terminal + file tools + browser →
  all execute in the guest
- **Fallback**: not installed → today's native Android behavior, agent told
  "limited toolbox"
- **proot binary source**: Termux package repo (GPLv2, prebuilt aarch64,
  proven on Android)

## URLs used

| Artifact | URL |
| --- | --- |
| proot 5.1.107.96 aarch64 | `packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_5.1.107.96_aarch64.deb` |
| libtalloc 2.5.0 aarch64 | `packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb` |
| Ubuntu 24.04.4 base arm64 | `cdimage.ubuntu.com/ubuntu-base/releases/noble/release/ubuntu-base-24.04.4-base-arm64.tar.gz` |

## Commit

`d29c58e` — core modules + bridge + TS surface
