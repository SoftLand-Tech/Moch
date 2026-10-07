"""Moch Linux environment — provisioning and guest execution.

M7.5: a Debian/Ubuntu rootfs running under proot inside the app's private
storage, giving the agent a real Linux userspace (apt, compilers, servers,
browsers). This module handles:

- Bootstrap: download proot + libtalloc from the Termux package repo (GPLv2,
  prebuilt aarch64 Android binaries), extract them from .deb containers,
  then download and extract a distribution rootfs.
- Execution: run commands inside the guest via proot.

M8 (targetSdk 36, ``untrusted_app`` SELinux domain): execve() of app-data
files is denied, so the ONE exec per guest exec — proot's loader, which
proot substitutes into every tracee execve via ``$PROOT_LOADER`` — moves
into the APK's nativeLibraryDir (``apk_data_file``, exec-legal for every
appdomain). The loader ships as the jniLib ``libproot-loader.so``
(``embedded/vendor-proot-loader.sh``); nothing app-data is ever exec'd.
See ``embedded/EXEC-DESIGN.md`` §3/§4.3 for the full chain.

The guest lives at ``<home>/linux/rootfs``; the workspace is bind-mounted at
``/workspace`` inside it. Everything stays inside the app sandbox.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

TERMUX_BASE = "https://packages.termux.dev/apt/termux-main/pool/main"
PROOT_URL = f"{TERMUX_BASE}/p/proot/proot_5.1.107.96_aarch64.deb"
LIBTALLOC_URL = f"{TERMUX_BASE}/libt/libtalloc/libtalloc_2.5.0_aarch64.deb"
SHMEM_URL = f"{TERMUX_BASE}/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb"

# Android 10+ (targetSdk 29+) forbids execve() of files in app-private data
# (the reason Termux pins targetSdk 28). mmap PROT_EXEC is still allowed, so
# the guest is launched through the system linker: ``linker64 <proot>``.
LINKER64 = "/system/bin/linker64"

# The exec-able loader as shipped by the APK (§4.1). Extracted from the APK
# at install (useLegacyPackaging), labeled apk_data_file — the one app
# location execute_no_trans is granted at any targetSdk.
LOADER_LIB_NAME = "libproot-loader.so"

ROOTFS_URLS = {
    "ubuntu-24.04": "https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    # Debian 12 (bookworm) official arm64 base — debuerreumatism artifacts
    # NOTE (M8): this URL is DEAD (HTTP 404, pre-existing M7.5 defect — the
    # org is misspelled; real one: debuerreotype/docker-debian-artifacts,
    # dist-arm64v8, rootfs.tar.xz). bootstrap("debian-12") fails at download
    # by design; fix is a tracked follow-up (EXEC-DESIGN.md §4.3/§10.8).
    "debian-12": "https://github.com/debuerreumaker/docker-debian-artifacts/raw/dist-arm64/bookworm/rootfs.tar.gz",
}

# Provisioning version stamp (§4.3): written after a successful bootstrap,
# compared on every later one so pinned-URL changes re-provision instead of
# riding on bare existence checks. Keys are exactly these five.
STAMP_NAME = ".provision-stamp"
STAMP_MECHANISM = 2

# Shim format marker (§4.3): format 1 (M7.5) baked the app-data loader path
# into the shim body — dead under untrusted_app. Format 2 resolves the
# loader through $MOCH_NATIVE_LIB_DIR at runtime (never persisted —
# nativeLibraryDir re-randomizes on every app update).
# v4: the workspace AND $TMPDIR scratch dir are self-bound at their host
# paths — hermes' wrapper cds to the host workspace and reads/writes its
# env-snapshot + cwd files under $TMPDIR inside the guest; without the
# self-binds every command died at that cd (on-device 2026-10-06). v3 added
# the self-healing PROOT_TMP_DIR mkdir after proot startup failures.
# v5: proot-distro parity flags (link2symlink/sysvipc/-L/fake utsname) +
# resolv.conf seeding — apt/dpkg upgrades died on link(2) EPERM and DNS
# was unresolvable (on-device 2026-10-06, third field round).
SHIM_FORMAT = 5
_SHIM_MARKER = f"# moch-shim-format: {SHIM_FORMAT}"

# proot-distro parity on Android (proot_distro/commands/login/proot_cmd.py
# — verified against the cloned source): link(2) is denied on app storage
# (kernel/SELinux), which kills dpkg's hardlink-based atomic updates —
# --link2symlink emulates hard links; --sysvipc emulates SysV IPC; -L
# corrects lstat sizes for dpkg's symlink warnings; the fake utsname hides
# the Android "<release>-perf" kernel string from guest tooling (backslash-
# separated utsname fields, proot-distro's exact shape). All four ship in
# the pinned termux proot binary (strings-verified).
FAKE_UTSNAME = (
    "\\Linux\\localhost\\6.17.0-moch\\#1 SMP PREEMPT_DYNAMIC"
    "\\aarch64\\localdomain\\-1\\"
)
PROOT_PARITY_FLAGS = ["--link2symlink", "--sysvipc", "-L", f"--kernel-release={FAKE_UTSNAME}"]

# Cached rootfs size in MB for status(): computing it means stat()ing every
# file of a full Ubuntu rootfs — seconds of GIL-hot Python inside the shared
# app process, which starved the gateway loop and the RN JS thread when the
# Settings tab polled for it every few seconds. Periodic pollers serve this
# cache; only the install wizard's progress display (status(walk=True)) and
# a successful bootstrap()/reset() touch the real number.
_SIZE_MB_CACHE: float | None = None

# ubuntu-base ships an EMPTY /etc/resolv.conf — apt/pacman cannot resolve
# anything until it is seeded. proot-distro writes the host's resolv.conf
# at install time; Android has none to copy, so seed public resolvers.
# Only when missing/empty, to respect user edits inside the guest.
_DNS_RESOLV = "nameserver 8.8.8.8\nnameserver 1.1.1.1\n"


def ensure_guest_dns() -> None:
    """Seed the guest resolv.conf when missing/empty (idempotent, best-effort)."""
    resolv = _linux_dir() / "rootfs" / "etc" / "resolv.conf"
    try:
        if resolv.exists() and resolv.stat().st_size > 0:
            return
        resolv.parent.mkdir(parents=True, exist_ok=True)
        resolv.write_text(_DNS_RESOLV, encoding="utf-8")
    except OSError:
        pass  # non-fatal: fixable by hand inside the guest


def _linux_dir() -> Path:
    from moch import hermes_boot

    return hermes_boot._hermes_home() / "linux"


def _log(msg: str) -> None:
    print(f"[moch-linux] {msg}", file=sys.stderr, flush=True)


_NATIVE_LIB_DIR_CACHE: str | None = None


def _native_lib_dir() -> str:
    """The APK's nativeLibraryDir — where the exec-able loader lives.

    Chaquopy 17.0 route (javap-verified, EXEC-DESIGN.md §4.3): getPlatform()
    is static on com.chaquo.python.Python and returns Python$Platform;
    getApplication() exists only on the AndroidPlatform subclass the app
    started Python with, so the bridge dispatches on the runtime class.
    ``MOCH_NATIVE_LIB_DIR`` env wins when already set (unit-test seam;
    HermesRuntime escape hatch). Cached per process. ``java`` is imported
    lazily so module import stays testable on desktop CPython.
    """
    global _NATIVE_LIB_DIR_CACHE
    override = os.environ.get("MOCH_NATIVE_LIB_DIR")
    if override:
        return override
    if _NATIVE_LIB_DIR_CACHE is None:
        from java import jclass  # Chaquopy bridge; absent on desktop CPython

        python = jclass("com.chaquo.python.Python")
        context = python.getPlatform().getApplication()
        _NATIVE_LIB_DIR_CACHE = str(context.getApplicationInfo().nativeLibraryDir)
    return _NATIVE_LIB_DIR_CACHE


def loader_path() -> Path:
    """proot's loader as shipped in the APK (§4.1)."""
    return Path(_native_lib_dir()) / LOADER_LIB_NAME


def build_guest_launch(guest_argv: list[str]) -> tuple[list[str], dict]:
    """The ONE argv/env shape for entering the guest (§4.3):

    - ``/system/bin/linker64`` execs a system file (legal), then mmaps the
      app-data proot ELF PROT_EXEC (legal — never execve'd);
    - ``PROOT_LOADER`` points at the native-lib loader, so every execve the
      ptraced tracee performs (bash → node → children, shebangs, every exec
      variant, raw syscalls) lands on an apk_data_file;
    - ``LD_PRELOAD`` popped (proot-distro parity; Moch never sets it).

    Used by exec_in_guest and the persistent session; the PATH shims carry
    the same shape inline.
    """
    linux_dir = _linux_dir()
    proot = linux_dir / "bin" / "proot"
    rootfs = linux_dir / "rootfs"
    from moch import hermes_boot

    workspace = hermes_boot._hermes_home() / "workspace"
    tmp_dir = linux_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    # hermes' session machinery ($TMPDIR = <home>/cache/scratch, set by
    # hermes_boot before anything imports) writes the env snapshot and cwd
    # files from INSIDE the guest and reads them back host-side — same
    # self-bind treatment as the workspace so both sides see one path.
    scratch = os.environ.get("TMPDIR") or str(hermes_boot._hermes_home() / "cache" / "scratch")
    Path(scratch).mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(linux_dir / "bin" / "lib")
    env["PROOT_LOADER"] = str(loader_path())
    env["PROOT_TMP_DIR"] = str(tmp_dir)
    env.pop("LD_PRELOAD", None)
    argv = [
        LINKER64,
        str(proot),
        "-r", str(rootfs),
        "-b", f"{workspace}:/workspace",
        # Self-bind at the host path (same shape as -b /dev): hermes' command
        # wrapper runs `cd <host workspace>` INSIDE the guest before every
        # payload — without this bind the cd fails and every command dies
        # (on-device 2026-10-06: "cd: …/workspace: No such file or directory").
        # With it, host and guest spell the workspace identically, so hermes'
        # pwd-based cwd tracking stays consistent across the boundary.
        "-b", f"{workspace}:{workspace}",
        "-b", f"{scratch}:{scratch}",
        "-b", "/dev",
        "-b", "/proc",
        "-0",
        *PROOT_PARITY_FLAGS,
        "-w", "/root",
        *guest_argv,
    ]
    return argv, env


def _shim_body(linux_dir: Path) -> str:
    return f"""#!/system/bin/sh
{_SHIM_MARKER}
# Moch Linux shim — routes shell commands into the distro guest.
# Launched as /system/bin/sh <this file> (HERMES_EXEC_TRAMPOLINE): the
# kernel never execves the script itself (EACCES on app_data_file at
# targetSdk 29+). No absolute native-library-dir path may appear here —
# it moves on every app update, so it is resolved at runtime via
# $MOCH_NATIVE_LIB_DIR (exported by every Moch launcher).
: "${{MOCH_NATIVE_LIB_DIR:?moch linux: MOCH_NATIVE_LIB_DIR unset (internal launcher bug — reinstall Moch or report)}}"
LD="{linux_dir}"
export LD_LIBRARY_PATH="$LD/bin/lib"
export PROOT_LOADER="$MOCH_NATIVE_LIB_DIR/{LOADER_LIB_NAME}"
export PROOT_TMP_DIR="$LD/tmp"
mkdir -p "$LD/tmp"
[ -s "$LD/rootfs/etc/resolv.conf" ] || printf 'nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n' > "$LD/rootfs/etc/resolv.conf"
WS="${{MOCH_WORKSPACE:-$LD/../workspace}}"
SC="${{TMPDIR:-$LD/../cache/scratch}}"
exec /system/bin/linker64 "$LD/bin/proot" -r "$LD/rootfs" \\
  -b "$WS:/workspace" -b "$WS:$WS" -b "$SC:$SC" -b /dev -b /proc -0 \\
  --link2symlink --sysvipc -L --kernel-release='{FAKE_UTSNAME}' \\
  -w /root /bin/bash "$@"
"""


def _shim_current(shim: Path) -> bool:
    try:
        with shim.open("r", encoding="utf-8") as f:
            shebang = f.readline().rstrip("\n")
            marker = f.readline().rstrip("\n")
    except OSError:
        return False
    return shebang == "#!/system/bin/sh" and marker == _SHIM_MARKER


def shims_current(bin_dir: Path) -> bool:
    """True when both shims exist and carry the current format marker (cheap
    two-line read). hermes_boot's boot-time repair gate calls this so
    format-1 (M7.5) shims — whose baked app-data PROOT_LOADER is denied
    under untrusted_app — are retired on the first post-update boot without
    any wizard interaction (EXEC-DESIGN.md §4.5.3)."""
    return _shim_current(bin_dir / "sh") and _shim_current(bin_dir / "bash")


def ensure_shims() -> None:
    """PATH shims: hermes resolves `sh`/`bash` through PATH, so thin wrappers
    ahead of the system paths route every terminal command into the guest
    with zero hermes internals patched. Idempotent; regenerates only when
    the on-disk format marker is absent or stale (steady state stays a cheap
    read)."""
    linux_dir = _linux_dir()
    bin_dir = linux_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    # proot writes its glue/temp files here; bootstrap() and the shim path
    # never go through build_guest_launch(), so create it unconditionally
    # (idempotent) — a missing dir killed proot at startup on-device.
    (linux_dir / "tmp").mkdir(parents=True, exist_ok=True)
    # Every Moch launcher exports this; setdefault here covers wizard-time
    # provisioning (the same live process keeps running afterwards).
    os.environ.setdefault("MOCH_NATIVE_LIB_DIR", _native_lib_dir())
    if not shims_current(bin_dir):
        body = _shim_body(linux_dir)
        for name in ("sh", "bash"):
            shim = bin_dir / name
            shim.write_text(body, encoding="utf-8")
            os.chmod(shim, 0o755)
    # Guest /bin/sh is dash by default (Ubuntu); hermes' command wrapper
    # uses bash-only `builtin`. Point /bin/sh at bash so every invocation
    # is bash-compatible — fixes the foreground-mode "builtin: not found".
    # Runs every call (idempotent): a re-provisioned rootfs reverts it.
    guest_sh = linux_dir / "rootfs" / "bin" / "sh"
    guest_bash = linux_dir / "rootfs" / "usr" / "bin" / "bash"
    if guest_bash.exists() and (guest_sh.is_symlink() and "dash" in str(guest_sh.resolve())):
        guest_sh.unlink()
        guest_sh.symlink_to("/usr/bin/bash")


def _ar_extract_member(ar_path: Path, member_name: str, dest: Path) -> None:
    """Extract a single member from a Unix ar archive (.deb = ar + tar)."""
    data = ar_path.read_bytes()
    if data[:8] != b"!<arch>\n":
        raise ValueError(f"not an ar archive: {ar_path}")
    off = 8
    while off + 60 <= len(data):
        header = data[off : off + 60]
        name = header[0:16].decode("ascii", "replace").rstrip()
        size = int(header[48:58].decode("ascii", "replace").strip())
        body = data[off + 60 : off + 60 + size]
        if name.rstrip("/") == member_name or name == member_name:
            dest.write_bytes(body)
            return
        # ar members are 2-byte aligned
        off += 60 + size + (size % 2)
    raise ValueError(f"member {member_name!r} not found in {ar_path}")


def _check_member(dest: Path, member: tarfile.TarInfo) -> None:
    """Traversal predicate for archive extraction, pinned in EXEC-DESIGN.md
    §4.3 (Play's unsafe-unzipping scanner motivated it; Python 3.11 has no
    filter="data" default — and data-filter parity would BREAK provisioning:
    the pinned ubuntu-base tarball legitimately contains ~20 absolute-target
    symlinks, e.g. ``etc/alternatives/awk -> /usr/bin/mawk``). Rules:

    - member paths must be relative and normalize inside ``dest``;
    - RELATIVE symlink/hardlink targets must resolve inside ``dest``;
    - ABSOLUTE symlink targets are allowed verbatim — they are guest paths,
      inert on the host until proot resolves them inside the guest.
    """
    name = member.name
    if name.startswith("/"):
        raise ValueError(f"unsafe member path (absolute): {name!r}")
    dest_r = dest.resolve()
    resolved = (dest / name).resolve()
    if resolved != dest_r and dest_r not in resolved.parents:
        raise ValueError(f"unsafe member path (escapes dest): {name!r}")
    if member.issym() or member.islnk():
        target = member.linkname
        if target.startswith("/"):
            return  # guest-absolute link target — allowed (see docstring)
        # symlinks resolve their target against the link's directory;
        # hardlinks name another archive member (archive-root-relative).
        base = (dest / name).parent if member.issym() else dest
        target_r = (base / target).resolve()
        if target_r != dest_r and dest_r not in target_r.parents:
            raise ValueError(f"unsafe link target {target!r} on member {name!r}")


def _safe_extract(tf: tarfile.TarFile, dest: Path) -> None:
    """Extract an open tarfile into dest under the §4.3 predicate — every
    member is checked BEFORE anything is written. tarfile's own filtering is
    disabled (fully_trusted): Python 3.12+/3.14 default to the "data" filter,
    which rejects the absolute-target symlinks every distro rootfs carries —
    _check_member above is the one predicate that applies."""
    members = tf.getmembers()
    for member in members:
        _check_member(dest, member)
    try:
        tf.extractall(dest, members=members, filter="fully_trusted")
    except TypeError:  # Python < 3.11.4: no filter kwarg, no default filter
        tf.extractall(dest, members=members)


def _deb_extract_file(deb: Path, td: Path, path_suffix: str) -> Path:
    """Extract a Termux .deb fully into ``td/deb`` (traversal-checked) and
    return the host path of the single file whose archive path ends with
    ``path_suffix``. The M7.5 selective-member loop is gone: one extraction
    path, guarded by _safe_extract, for debs and rootfs alike."""
    data_tar = td / "data.tar.xz"
    _ar_extract_member(deb, "data.tar.xz", data_tar)
    root = td / "deb"
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(data_tar, "r:xz") as tf:
        _safe_extract(tf, root)
    hits = sorted(p for p in root.rglob("*") if p.is_file() and str(p).endswith(path_suffix))
    if not hits:
        raise FileNotFoundError(f"{path_suffix!r} not found in {deb.name}")
    return hits[0]


def _download(url: str, dest: Path, chunk_mb: int = 8) -> int:
    """Stream a file to dest; returns bytes written. Logs progress."""
    _log(f"downloading {url.split('/')[-1]} …")
    req = urllib.request.Request(url, headers={"User-Agent": "Moch/1.0"})
    total = 0
    with urllib.request.urlopen(req, timeout=120) as resp, dest.open("wb") as f:
        while True:
            chunk = resp.read(chunk_mb * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            _log(f"  {total / 1e6:.1f} MB")
    return total


def _stamp_path(linux_dir: Path) -> Path:
    return linux_dir / STAMP_NAME


def _read_stamp(linux_dir: Path) -> dict:
    try:
        data = json.loads(_stamp_path(linux_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_stamp(linux_dir: Path, distro: str) -> None:
    stamp = {
        "mechanism": STAMP_MECHANISM,
        "proot": PROOT_URL,
        "libtalloc": LIBTALLOC_URL,
        "shmem": SHMEM_URL,
        "rootfs": ROOTFS_URLS[distro],
    }
    _stamp_path(linux_dir).write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")


def bootstrap(distro: str = "ubuntu-24.04") -> dict:
    """Download proot + libtalloc + rootfs and lay out the guest tree.

    Re-provisioning is driven by the version stamp (§4.3): proot/libtalloc/
    shmem re-run when the stamp is absent or their URL differs; the rootfs
    re-runs only when a stamp EXISTS and its rootfs URL differs (wiped
    first — never merged over). An absent stamp with an existing rootfs
    keeps it: the M7.5 → M8 upgrade path.
    """
    # Setup wizard's "Continue without Linux" sends distro="skip" — not a
    # ROOTFS_URLS key, so falling through died with a KeyError the UI showed
    # as "the install failed". A skip is a successful no-op, not a failure.
    if distro == "skip":
        return {"ok": True, "skipped": True, "steps": ["Skipped — no Linux guest installed"]}

    machine = os.uname().machine
    if machine != "aarch64":
        # Pinned artifacts are aarch64-only; no loader jniLib exists for
        # anything else (EXEC-DESIGN.md §5).
        return {"ok": False, "error": f"Moch Linux requires an arm64 device (got {machine})"}

    linux_dir = _linux_dir()
    bin_dir = linux_dir / "bin"
    rootfs = linux_dir / "rootfs"
    bin_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {"ok": False, "steps": []}

    # The loader must exist as an extracted native lib before anything runs:
    # without it every guest exec dies EACCES at targetSdk 29+.
    try:
        os.environ.setdefault("MOCH_NATIVE_LIB_DIR", _native_lib_dir())
        loader = loader_path()
    except Exception as exc:  # noqa: BLE001 — java bridge unavailable
        return {"ok": False, "error": f"cannot resolve nativeLibraryDir: {type(exc).__name__}: {exc}"}
    if not loader.exists():
        _log(f"{loader} missing — app built without {LOADER_LIB_NAME} (rebuild with embedded/vendor-proot-loader.sh output committed)")
        return {"ok": False, "error": f"app built without {LOADER_LIB_NAME} — rebuild with the jniLib present"}

    def step(name: str, fn) -> None:
        try:
            fn()
            report["steps"].append(f"{name}: ok")
        except Exception as exc:  # noqa: BLE001
            report["steps"].append(f"{name}: FAILED {type(exc).__name__}: {exc}")
            raise

    stamp = _read_stamp(linux_dir)

    # proot only: the app-data loader/loader32 of M7.5 are dead under
    # untrusted_app (the loader now ships in the APK; 32-bit guests are
    # unsupported, EXEC-DESIGN.md §5).
    if not (bin_dir / "proot").exists() or stamp.get("proot") != PROOT_URL:
        def _proot():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                deb = td / "proot.deb"
                _download(PROOT_URL, deb)
                src = _deb_extract_file(deb, td, "usr/bin/proot")
                dst = bin_dir / "proot"
                dst.write_bytes(src.read_bytes())
                os.chmod(dst, 0o755)
        step("proot", _proot)

    if not any((bin_dir / "lib").glob("libtalloc.so*")) or stamp.get("libtalloc") != LIBTALLOC_URL:
        def _talloc():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                deb = td / "libtalloc.deb"
                _download(LIBTALLOC_URL, deb)
                src = _deb_extract_file(deb, td, "libtalloc.so.2")
                (bin_dir / "lib").mkdir(exist_ok=True)
                (bin_dir / "lib" / "libtalloc.so.2").write_bytes(src.read_bytes())
        step("libtalloc", _talloc)

    if not (bin_dir / "lib" / "libandroid-shmem.so").exists() or stamp.get("shmem") != SHMEM_URL:
        def _shmem():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                deb = td / "shmem.deb"
                _download(SHMEM_URL, deb)
                src = _deb_extract_file(deb, td, "libandroid-shmem.so")
                (bin_dir / "lib").mkdir(exist_ok=True)
                (bin_dir / "lib" / "libandroid-shmem.so").write_bytes(src.read_bytes())
        step("libandroid-shmem", _shmem)

    # Permissions pass: earlier partial runs could leave files non-executable
    # (Python's write_bytes defaults to 0600) — force exec bits on every
    # binary the guest launch needs.
    proot_bin = bin_dir / "proot"
    if proot_bin.exists():
        os.chmod(proot_bin, 0o755)

    step("shims", ensure_shims)

    # Rootfs: wipe-and-re-extract ONLY on a pin change with a stamp present;
    # fresh installs extract; everything else keeps the existing tree.
    rootfs_url = ROOTFS_URLS[distro]
    if stamp and stamp.get("rootfs") != rootfs_url and rootfs.exists():
        _log(f"rootfs pin changed ({stamp.get('rootfs')} → {rootfs_url}) — wiping old rootfs")
        shutil.rmtree(rootfs, ignore_errors=True)
    if not rootfs.exists():
        def _rootfs():
            with tempfile.TemporaryDirectory(dir=linux_dir) as td:
                td = Path(td)
                tarball = td / "rootfs.tar.gz"
                _download(rootfs_url, tarball)
                rootfs.mkdir(parents=True, exist_ok=True)
                _log("extracting rootfs (this takes a few minutes)…")
                with tarfile.open(tarball, "r:gz") as tf:
                    _safe_extract(tf, rootfs)
        step("rootfs", _rootfs)

    step("dns", ensure_guest_dns)
    step("stamp", lambda: _write_stamp(linux_dir, distro))

    report["ok"] = True
    # The rootfs changed under whatever cache status() holds — refresh it so
    # the periodic Settings poll reports the new install immediately instead
    # of serving a pre-bootstrap snapshot until the next app launch.
    global _SIZE_MB_CACHE
    _SIZE_MB_CACHE = _rootfs_size_mb(rootfs)
    # Mid-session provisioning (setup wizard, same live process): the agent's
    # shell execs must go through /system/bin/sh from the very next command —
    # hermes_boot._prepare_home ran before the guest existed (§4.5.1).
    os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"
    return report


def exec_in_guest(command: str, timeout_s: int = 30) -> dict:
    """Run a command inside the guest via proot. Returns stdout/stderr/exit."""
    linux_dir = _linux_dir()
    if not (linux_dir / "bin" / "proot").exists() or not (linux_dir / "rootfs").exists():
        return {"ok": False, "error": "guest not bootstrapped"}
    try:
        argv, env = build_guest_launch(["/bin/sh", "-c", command])
    except Exception as exc:  # noqa: BLE001 — e.g. java bridge unavailable
        return {"ok": False, "error": f"guest launch unavailable: {type(exc).__name__}: {exc}"}
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_s, env=env)
        return {"ok": proc.returncode == 0, "exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _rootfs_size_mb(rootfs: Path) -> float:
    """Full walk of the rootfs — expensive (stat() per file); cache callers."""
    if not rootfs.exists():
        return 0.0
    return round(sum(f.stat().st_size for f in rootfs.rglob("*") if f.is_file()) / 1e6, 1)


def status(walk: bool = False) -> dict:
    """Guest state for the bridge.

    size_mb is served from a process-wide cache unless walk=True: the walk
    stat()s every file of the rootfs (seconds under the shared GIL), so
    periodic pollers must take the cached number. Only the install wizard's
    live progress display passes walk=True.
    """
    global _SIZE_MB_CACHE
    linux_dir = _linux_dir()
    proot = linux_dir / "bin" / "proot"
    rootfs = linux_dir / "rootfs"
    distro = None
    os_release = rootfs / "etc" / "os-release"
    if os_release.exists():
        try:
            for line in os_release.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("PRETTY_NAME="):
                    distro = line.split("=", 1)[1].strip().strip('"')
                    break
        except OSError:
            pass
    try:
        loader_ok = loader_path().exists()
    except Exception:  # noqa: BLE001 — java bridge not ready (early probe)
        loader_ok = False
    if walk or _SIZE_MB_CACHE is None:
        # Store even the rootfs-missing result (0.0): bootstrap() refreshes
        # the cache when it creates the tree, and reset() invalidates it.
        _SIZE_MB_CACHE = _rootfs_size_mb(rootfs)
    return {
        "bootstrapped": proot.exists() and rootfs.exists(),
        "rootfs_exists": rootfs.exists(),
        "distro": distro,
        "loader_ok": loader_ok,
        "size_mb": _SIZE_MB_CACHE,
    }


def reset() -> dict:
    """Remove the whole guest tree (Settings → Reset)."""
    global _SIZE_MB_CACHE
    # Invalidate first: even a failed reset may have deleted part of the tree,
    # and a stale cached size must never outlive the guest it described.
    _SIZE_MB_CACHE = None
    linux_dir = _linux_dir()
    try:
        if linux_dir.exists():
            shutil.rmtree(linux_dir, ignore_errors=False)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
