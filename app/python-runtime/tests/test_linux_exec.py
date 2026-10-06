#!/usr/bin/env python3
"""M8 unit tests — guest exec under targetSdkVersion 36 (EXEC-DESIGN.md §9.1).

Local, stdlib-only, self-contained, no network, no Android: run with

    python3 app/python-runtime/tests/test_linux_exec.py

and expect exit 0 with a final line ``ALL TESTS PASSED``. Covers the pure
logic of the M8 exec chain: build_guest_launch argv shape, shim generation
(format-2 marker, runtime-resolved loader), version-stamp invalidation, the
ar-parser regression, the persistent-session builder, the
HERMES_EXEC_TRAMPOLINE / MOCH_NATIVE_LIB_DIR wiring (all three paths), the
boot-time shim repair gate, the trampoline wrap guard, and the pinned
_safe_extract predicate.

Offline bootstrap testing works against synthesized mini-.debs (real ar +
data.tar.xz structure) and synthesized rootfs tarballs served through a
patched ``linux_env._download`` — never the network.
"""

from __future__ import annotations

import atexit
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import types
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# Self-contained sys.path bootstrap: app/python-runtime (moch package) and
# app/hermes-src (vendored tools tree, for the trampoline contract).
_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_APP = _PY_RUNTIME.parent
for _p in (str(_PY_RUNTIME), str(_APP / "hermes-src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Hermetic sandbox, installed BEFORE the vendored tools tree is imported:
# its module scope loads hermes' own config (utils.py resolves it through
# $HERMES_HOME/$HOME). Pointing both at a throwaway dir keeps the test from
# reading anything outside the repo — and keeps a missing PyYAML (some
# interpreters) from ever judging the user's real config "broken".
_SANDBOX = tempfile.mkdtemp(prefix="moch-m8-test-")
atexit.register(shutil.rmtree, _SANDBOX, True)
for _var in ("HOME", "HERMES_HOME"):
    os.environ[_var] = _SANDBOX

try:
    import yaml  # noqa: F401
except ModuleNotFoundError:
    # The vendored tree imports PyYAML at module scope; the functions under
    # test never call it. A surface stub keeps the suite self-contained on
    # interpreters without PyYAML (the sandbox above makes it inert).
    _y = types.ModuleType("yaml")
    _y.YAMLError = type("YAMLError", (Exception,), {})
    _y.SafeDumper = type("SafeDumper", (), {})
    _y.SafeLoader = type("SafeLoader", (), {})
    _y.safe_load = staticmethod(lambda *a, **k: {})
    _y.load = staticmethod(lambda *a, **k: {})
    _y.safe_dump = staticmethod(lambda *a, **k: "")
    _y.dump = staticmethod(lambda *a, **k: "")
    sys.modules["yaml"] = _y

import moch.hermes_boot as hermes_boot  # noqa: E402
import moch.linux_env as le  # noqa: E402
import moch.linux_session as ls  # noqa: E402
from tools.environments.local import _apply_exec_trampoline  # noqa: E402

warnings.simplefilter("ignore")  # vendor-tree import chatter, not under test


# --------------------------------------------------------------------------
# Offline fixtures: a real-structure mini .deb and synthesized rootfs tarballs.
# --------------------------------------------------------------------------

def _ar_header(name: bytes, size: int) -> bytes:
    return (name.ljust(16) + b"0".ljust(12) + b"0".ljust(6) + b"0".ljust(6)
            + b"100644".ljust(8) + str(size).encode().ljust(10) + b"`\n")


def _make_deb(files: dict) -> bytes:
    """A minimal but structurally real .deb: ar{debian-binary, data.tar.xz}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz") as tf:
        for name, data in files.items():
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
    data_tar = buf.getvalue()
    deb = b"!<arch>\n"
    for name, body in ((b"debian-binary", b"2.0\n"), (b"data.tar.xz", data_tar)):
        deb += _ar_header(name, len(body)) + body + (b"\n" if len(body) % 2 else b"")
    return deb


def _rootfs_gz(marker_name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        ti = tarfile.TarInfo(marker_name)
        ti.size = len(content)
        tf.addfile(ti, io.BytesIO(content))
    return buf.getvalue()


_UBUNTU_URL = le.ROOTFS_URLS["ubuntu-24.04"]
_CHANGED_ROOTFS_URL = "https://example.invalid/changed-rootfs.tar.gz"


class FakeDownloads:
    """Serves the pinned URLs from fixtures; counts every download."""

    def __init__(self) -> None:
        self.debs = {
            le.PROOT_URL: _make_deb({"./data/data/com.termux/files/usr/bin/proot": b"PROOT"}),
            le.LIBTALLOC_URL: _make_deb(
                {"./data/data/com.termux/files/usr/lib/libtalloc.so.2": b"TAL"}),
            le.SHMEM_URL: _make_deb(
                {"./data/data/com.termux/files/usr/lib/libandroid-shmem.so": b"SHM"}),
        }
        self.rootfs = {
            _UBUNTU_URL: _rootfs_gz("etc/os-release", b'PRETTY_NAME="Ubuntu 24.04.4 LTS"\n'),
            _CHANGED_ROOTFS_URL: _rootfs_gz("etc/changed-marker", b"v2"),
        }
        self.urls: list[str] = []

    def __call__(self, url: str, dest: Path, chunk_mb: int = 8) -> int:
        self.urls.append(url)
        blob = self.debs.get(url) or self.rootfs.get(url)
        if blob is None:
            raise AssertionError(f"unexpected download: {url}")
        dest.write_bytes(blob)
        return len(blob)


def _android_fs():
    """Pinned test seam (§9.1.6): _prepare_home checks /system/bin/sh via
    os.path.exists — patch that one answer, everything else stays real."""
    real_exists = os.path.exists

    def fake(p):
        if p == "/system/bin/sh":
            return True
        return real_exists(p)

    return mock.patch("os.path.exists", side_effect=fake)


def _aarch64():
    return mock.patch("os.uname", return_value=SimpleNamespace(machine="aarch64"))


# --------------------------------------------------------------------------
# Test base: fresh hermes home + fake nativeLibraryDir per test.
# --------------------------------------------------------------------------

class MochLinuxExecTest(unittest.TestCase):
    def setUp(self) -> None:
        self._env_snapshot = dict(os.environ)
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.home = tmp / ".hermes"
        os.environ["HERMES_HOME"] = str(self.home)
        self.linux = self.home / "linux"
        self.native_dir = tmp / "nlib"
        self.native_dir.mkdir()
        (self.native_dir / le.LOADER_LIB_NAME).write_bytes(b"\x7fELF-fake-loader")
        os.environ["MOCH_NATIVE_LIB_DIR"] = str(self.native_dir)
        os.environ.pop("HERMES_EXEC_TRAMPOLINE", None)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_snapshot)
        self._tmp.cleanup()

    def _patched_native(self):
        return mock.patch.object(le, "_native_lib_dir", return_value=str(self.native_dir))

    def _offline_bootstrap(self, **patch_kwargs):
        fd = FakeDownloads()
        launcher = mock.patch.object(le, "_download", fd, **patch_kwargs)
        return fd, launcher

    def _stamp(self) -> dict:
        return json.loads((self.linux / le.STAMP_NAME).read_text(encoding="utf-8"))

    def _bootstrap(self):
        """bootstrap() with every external touchpoint faked."""
        fd, launcher = self._offline_bootstrap()
        with _aarch64(), launcher, self._patched_native():
            report = le.bootstrap()
        return report, fd


# --------------------------------------------------------------------------
# §9.1.1 — build_guest_launch argv shape
# --------------------------------------------------------------------------

class TestBuildGuestLaunch(MochLinuxExecTest):
    def test_argv_shape_and_env(self):
        os.environ["LD_PRELOAD"] = "/somewhere/libevil.so"  # must be popped
        argv, env = le.build_guest_launch(["/bin/bash", "--norc", "--noprofile"])
        self.assertEqual(argv[0], le.LINKER64)
        self.assertEqual(argv[1], str(self.linux / "bin" / "proot"))
        self.assertEqual(argv[2:4], ["-r", str(self.linux / "rootfs")])
        # both binds present: workspace and the system binds
        self.assertIn(f"{self.home / 'workspace'}:/workspace", argv)
        self.assertIn("/dev", argv)
        self.assertIn("/proc", argv)
        self.assertIn("-0", argv)
        self.assertIn("-w", argv)
        self.assertEqual(argv[argv.index("-w") + 1], "/root")
        # guest argv appended verbatim
        self.assertEqual(argv[-3:], ["/bin/bash", "--norc", "--noprofile"])
        # env: loader via native-lib dir, talloc libs, no LD_PRELOAD
        self.assertEqual(env["PROOT_LOADER"], str(self.native_dir / le.LOADER_LIB_NAME))
        self.assertEqual(env["LD_LIBRARY_PATH"], str(self.linux / "bin" / "lib"))
        self.assertEqual(env["PROOT_TMP_DIR"], str(self.linux / "tmp"))
        self.assertNotIn("LD_PRELOAD", env)


# --------------------------------------------------------------------------
# §9.1.2 — shim generation
# --------------------------------------------------------------------------

class TestShims(MochLinuxExecTest):
    def test_body_contract_and_modes(self):
        with self._patched_native():
            le.ensure_shims()
        for name in ("sh", "bash"):
            shim = self.linux / "bin" / name
            self.assertTrue(shim.exists(), name)
            self.assertEqual(oct(os.stat(shim).st_mode)[-3:], "755")
            lines = shim.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "#!/system/bin/sh")
            self.assertEqual(lines[1], le._SHIM_MARKER, "format marker must be line 2")
            body = "\n".join(lines)
            # loader resolved at runtime through the env var — never a baked
            # absolute nativeLibraryDir (it moves on every app update)
            self.assertIn(f'export PROOT_LOADER="$MOCH_NATIVE_LIB_DIR/{le.LOADER_LIB_NAME}"', body)
            self.assertIn(': "${MOCH_NATIVE_LIB_DIR:?moch linux:', body)
            self.assertIn('exec /system/bin/linker64 "$LD/bin/proot"', body)
            self.assertNotIn("/data/app", body)
            # v3: self-healing temp dir — proot dies at startup without it
            self.assertIn('mkdir -p "$LD/tmp"', body)

    def test_ensure_shims_creates_proot_tmp_dir(self):
        # On-device 2026-10-06: wizard-only installs never ran a
        # build_guest_launch() caller, so PROOT_TMP_DIR pointed at a
        # missing dir and proot failed with "can't create temporary
        # directory" + "can't create glue rootfs" on every command.
        self.assertFalse((self.linux / "tmp").exists())
        with self._patched_native():
            le.ensure_shims()
        self.assertTrue((self.linux / "tmp").is_dir())

    def test_v2_shim_without_mkdir_is_stale(self):
        # The exact regression: a format-2 shim body (no mkdir) must be
        # detected stale so the boot-time repair gate rewrites it.
        shim = self.linux / "bin" / "sh"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.write_text(
            "#!/system/bin/sh\n# moch-shim-format: 2\nexport PROOT_TMP_DIR=\"$LD/tmp\"\n",
            encoding="utf-8",
        )
        self.assertFalse(le.shims_current(self.linux / "bin"))
        with self._patched_native():
            le.ensure_shims()
        self.assertTrue(le.shims_current(self.linux / "bin"))
        self.assertIn('mkdir -p "$LD/tmp"', shim.read_text(encoding="utf-8"))

    def test_repoint_guest_bin_sh_to_bash(self):
        rootfs = self.linux / "rootfs"
        (rootfs / "bin").mkdir(parents=True)
        (rootfs / "usr" / "bin").mkdir(parents=True)
        (rootfs / "usr" / "bin" / "bash").write_bytes(b"")  # target exists
        (rootfs / "bin" / "sh").symlink_to("dash")          # Ubuntu default
        with self._patched_native():
            le.ensure_shims()
        self.assertTrue((rootfs / "bin" / "sh").is_symlink())
        self.assertEqual(os.readlink(rootfs / "bin" / "sh"), "/usr/bin/bash")

    def test_regenerates_on_stale_or_missing_marker_not_when_current(self):
        with self._patched_native():
            le.ensure_shims()
            shim = self.linux / "bin" / "sh"
            mtime = shim.stat().st_mtime_ns
            # current marker: cheap steady state — no rewrite
            le.ensure_shims()
            self.assertEqual(shim.stat().st_mtime_ns, mtime)
            # stale (M7.5 format-1) body: rewritten
            shim.write_text("#!/system/bin/sh\nexport PROOT_LOADER=\"$LD/libexec/proot/loader\"\n")
            le.ensure_shims()
            self.assertEqual(shim.read_text(encoding="utf-8").splitlines()[1], le._SHIM_MARKER)
            # missing entirely: recreated
            shim.unlink()
            le.ensure_shims()
            self.assertTrue(le.shims_current(self.linux / "bin"))


# --------------------------------------------------------------------------
# §9.1.3 — version-stamp logic (exact §4.3 predicate)
# --------------------------------------------------------------------------

class TestVersionStamps(MochLinuxExecTest):
    def test_fresh_install_steps_and_exact_stamp_keys(self):
        report, fd = self._bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertFalse(any("FAILED" in s for s in report["steps"]), report["steps"])
        self.assertEqual([s.split(":")[0] for s in report["steps"]],
                         ["proot", "libtalloc", "libandroid-shmem", "shims", "rootfs", "stamp"])
        self.assertEqual((self.linux / "bin" / "proot").read_bytes(), b"PROOT")
        self.assertTrue((self.linux / "rootfs" / "etc" / "os-release").exists())
        # stamp keys are EXACTLY the five — no loader_sha256 (loader ships in
        # the APK), no native_lib_dir (that path is never persisted)
        self.assertEqual(set(self._stamp()),
                         {"mechanism", "proot", "libtalloc", "shmem", "rootfs"})
        self.assertEqual(self._stamp()["mechanism"], le.STAMP_MECHANISM)
        self.assertEqual(self._stamp()["proot"], le.PROOT_URL)

    def test_steady_state_zero_downloads(self):
        self._bootstrap()
        fd2, launcher = self._offline_bootstrap()
        with _aarch64(), launcher, self._patched_native():
            report = le.bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertEqual(fd2.urls, [], "matching stamp must not re-download")

    def test_stamp_roundtrip(self):
        self._bootstrap()
        read_back = le._read_stamp(self.linux)
        self.assertEqual(read_back, {
            "mechanism": le.STAMP_MECHANISM,
            "proot": le.PROOT_URL,
            "libtalloc": le.LIBTALLOC_URL,
            "shmem": le.SHMEM_URL,
            "rootfs": le.ROOTFS_URLS["ubuntu-24.04"],
        })
        # corrupt/absent stamp reads as {} (never raises)
        (self.linux / le.STAMP_NAME).write_text("not json{", encoding="utf-8")
        self.assertEqual(le._read_stamp(self.linux), {})

    def test_absent_stamp_reprovisions_debs_keeps_rootfs(self):
        """The M7.5 → M8 upgrade path: artifacts + rootfs, no stamp."""
        self._bootstrap()
        (self.linux / le.STAMP_NAME).unlink()
        marker = self.linux / "rootfs" / "etc" / "os-release"
        marker_mtime = marker.stat().st_mtime_ns
        report, fd = self._bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertIn(le.PROOT_URL, fd.urls, "absent stamp re-provisions proot")
        self.assertIn(le.LIBTALLOC_URL, fd.urls)
        self.assertIn(le.SHMEM_URL, fd.urls)
        self.assertTrue(marker.exists(), "rootfs must be KEPT")
        self.assertEqual(marker.stat().st_mtime_ns, marker_mtime, "rootfs untouched")
        self.assertEqual(self._stamp()["mechanism"], le.STAMP_MECHANISM)

    def test_url_change_reprovisions_that_step(self):
        self._bootstrap()
        new_url = "https://example.invalid/libtalloc_9.9.9_aarch64.deb"
        fd = FakeDownloads()
        fd.debs[new_url] = fd.debs[le.LIBTALLOC_URL]
        with mock.patch.object(le, "LIBTALLOC_URL", new_url):
            with _aarch64(), mock.patch.object(le, "_download", fd), self._patched_native():
                report = le.bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertIn(new_url, fd.urls, "changed pin re-downloads libtalloc")
        self.assertNotIn(le.PROOT_URL, fd.urls, "unchanged pin stays cached")
        self.assertEqual(self._stamp()["libtalloc"], new_url)

    def test_rootfs_url_change_with_stamp_wipes_and_reextracts(self):
        self._bootstrap()
        old_marker = self.linux / "rootfs" / "etc" / "os-release"
        self.assertTrue(old_marker.exists())
        fd = FakeDownloads()
        with mock.patch.dict(le.ROOTFS_URLS, {"ubuntu-24.04": _CHANGED_ROOTFS_URL}):
            with _aarch64(), mock.patch.object(le, "_download", fd), self._patched_native():
                report = le.bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertFalse(old_marker.exists(), "old tree must be wiped, never merged over")
        self.assertTrue((self.linux / "rootfs" / "etc" / "changed-marker").exists())
        self.assertEqual(self._stamp()["rootfs"], _CHANGED_ROOTFS_URL)
        self.assertEqual(fd.urls, [_CHANGED_ROOTFS_URL], "only the rootfs re-downloads")

    def test_rootfs_url_change_without_stamp_keeps_rootfs(self):
        """No stamp (M7.5 state) + different distro URL: rootfs kept."""
        self._bootstrap()
        (self.linux / le.STAMP_NAME).unlink()
        fd = FakeDownloads()
        with mock.patch.dict(le.ROOTFS_URLS, {"ubuntu-24.04": _CHANGED_ROOTFS_URL}):
            with _aarch64(), mock.patch.object(le, "_download", fd), self._patched_native():
                report = le.bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertTrue((self.linux / "rootfs" / "etc" / "os-release").exists(),
                        "absent stamp + existing rootfs = keep")


# --------------------------------------------------------------------------
# §9.1.4 — ar-parser regression
# --------------------------------------------------------------------------

class TestArParser(MochLinuxExecTest):
    def _archive(self) -> bytes:
        m1, m2 = b"abc", b"second!"  # m1 has ODD size → 1 pad byte
        return (b"!<arch>\n"
                + _ar_header(b"member.xyz/", len(m1)) + m1 + b"\n"
                + _ar_header(b"second.txt", len(m2)) + m2)

    def test_odd_size_padding_and_member_lookup(self):
        arch = self._tmp.name and (Path(self._tmp.name) / "x.ar")
        arch.write_bytes(self._archive())
        out = arch.with_name("out.bin")
        le._ar_extract_member(arch, "second.txt", out)  # past the padded first member
        self.assertEqual(out.read_bytes(), b"second!")
        le._ar_extract_member(arch, "member.xyz", out.with_name("out2.bin"))
        self.assertEqual(out.with_name("out2.bin").read_bytes(), b"abc")

    def test_garbage_magic_rejected(self):
        arch = Path(self._tmp.name) / "g.ar"
        arch.write_bytes(b"GARBAGE!!not-an-archive")
        with self.assertRaises(ValueError):
            le._ar_extract_member(arch, "member.xyz", arch.with_name("o"))

    def test_missing_member_rejected(self):
        arch = Path(self._tmp.name) / "x.ar"
        arch.write_bytes(self._archive())
        with self.assertRaises(ValueError):
            le._ar_extract_member(arch, "nope.txt", arch.with_name("o"))

    def test_real_proot_deb_layout(self):
        """The member name actually used: data.tar.xz lookup on a real-shaped deb."""
        deb = Path(self._tmp.name) / "proot.deb"
        deb.write_bytes(FakeDownloads().debs[le.PROOT_URL])
        out = Path(self._tmp.name) / "data.tar.xz"
        le._ar_extract_member(deb, "data.tar.xz", out)
        with tarfile.open(out, "r:xz") as tf:
            names = tf.getnames()
        self.assertIn("./data/data/com.termux/files/usr/bin/proot", names)


# --------------------------------------------------------------------------
# §9.1.5 — persistent session uses the shared builder
# --------------------------------------------------------------------------

class TestLinuxSession(MochLinuxExecTest):
    def test_build_argv_shared_launch(self):
        argv, env = ls._build_argv()
        self.assertEqual(argv[0], le.LINKER64, "session must launch via linker64")
        self.assertEqual(argv[1], str(self.linux / "bin" / "proot"))
        self.assertEqual(argv[-3:], ["/bin/bash", "--norc", "--noprofile"])
        self.assertEqual(env["PROOT_LOADER"], str(self.native_dir / le.LOADER_LIB_NAME))
        self.assertEqual(env["LD_LIBRARY_PATH"], str(self.linux / "bin" / "lib"))
        # session-only extras preserved
        self.assertEqual(env["TERM"], "dumb")
        self.assertEqual(env["HOME"], "/root")
        self.assertTrue(env["PATH"].startswith("/usr/local/sbin:/usr/local/bin"))


# --------------------------------------------------------------------------
# §9.1.6 — trampoline + native-lib-dir wiring (all three paths) and
# §9.1.7 — shim repair gate (M7.5 → M8 upgrade)
# --------------------------------------------------------------------------

class TestPrepareHome(MochLinuxExecTest):
    def test_a_trampoline_set_unconditionally_even_without_guest(self):
        """(a) Android, guest NOT installed: trampoline still set — the setup
        wizard provisions mid-session in this same process (§4.5.1)."""
        self.assertFalse((self.home / "linux").exists())
        with _android_fs():
            hermes_boot._prepare_home(self.home)
        self.assertEqual(os.environ["HERMES_EXEC_TRAMPOLINE"], "/system/bin/sh")
        self.assertIn(str(self.home / "linux" / "bin"), os.environ["PATH"])

    def test_a_no_system_sh_no_trampoline(self):
        hermes_boot._prepare_home(self.home)  # desktop: /system/bin/sh absent
        self.assertNotIn("HERMES_EXEC_TRAMPOLINE", os.environ)

    def test_b_native_lib_dir_setdefault_steady_state(self):
        """(b) Guest provisioned, shims current: neither bootstrap() nor a shim
        regeneration runs — _prepare_home itself must export the native dir
        (the every-boot-after-restart contract, §4.5.2)."""
        with self._patched_native():
            le.ensure_shims()
        (self.linux / "rootfs").mkdir(parents=True, exist_ok=True)
        os.environ.pop("MOCH_NATIVE_LIB_DIR")  # java-bridge path faked below
        mtime = (self.linux / "bin" / "sh").stat().st_mtime_ns
        with _android_fs(), self._patched_native():
            hermes_boot._prepare_home(self.home)
        self.assertEqual(os.environ["MOCH_NATIVE_LIB_DIR"], str(self.native_dir))
        self.assertEqual(os.environ["HERMES_EXEC_TRAMPOLINE"], "/system/bin/sh")
        self.assertEqual((self.linux / "bin" / "sh").stat().st_mtime_ns, mtime,
                         "current shims must not be rewritten")

    def test_c_bootstrap_sets_both_after_success(self):
        """(c) fresh install → wizard → first terminal command flow: bootstrap()
        exports both vars in the same process where they were unset."""
        os.environ.pop("MOCH_NATIVE_LIB_DIR")
        report, _ = self._bootstrap()
        self.assertTrue(report["ok"], report)
        self.assertEqual(os.environ["HERMES_EXEC_TRAMPOLINE"], "/system/bin/sh")
        self.assertEqual(os.environ["MOCH_NATIVE_LIB_DIR"], str(self.native_dir))

    def test_7_repair_gate_retires_format1_shims(self):
        with self._patched_native():
            le.ensure_shims()
        (self.linux / "rootfs").mkdir(parents=True, exist_ok=True)
        old_body = ("#!/system/bin/sh\n"
                    f'LD="{self.linux}"\n'
                    'export PROOT_LOADER="$LD/libexec/proot/loader"\n'
                    'exec /system/bin/linker64 "$LD/bin/proot" /bin/bash "$@"\n')
        for name in ("sh", "bash"):
            (self.linux / "bin" / name).write_text(old_body, encoding="utf-8")
        with _android_fs(), self._patched_native():
            hermes_boot._prepare_home(self.home)
        new_body = (self.linux / "bin" / "sh").read_text(encoding="utf-8")
        self.assertEqual(new_body.splitlines()[1], le._SHIM_MARKER,
                         "boot must retire format-1 shims (their baked app-data "
                         "PROOT_LOADER is dead under untrusted_app)")
        self.assertNotIn("libexec/proot/loader", new_body)
        # steady state: current marker not rewritten at the next boot
        mtime = (self.linux / "bin" / "sh").stat().st_mtime_ns
        with _android_fs(), self._patched_native():
            hermes_boot._prepare_home(self.home)
        self.assertEqual((self.linux / "bin" / "sh").stat().st_mtime_ns, mtime)

    def test_7_missing_shims_recreated(self):
        (self.linux / "bin").mkdir(parents=True, exist_ok=True)
        (self.linux / "rootfs").mkdir(parents=True, exist_ok=True)
        with _android_fs(), self._patched_native():
            hermes_boot._prepare_home(self.home)
        self.assertTrue(le.shims_current(self.linux / "bin"))


# --------------------------------------------------------------------------
# §9.1.8 — trampoline wrap guard
# --------------------------------------------------------------------------

class TestTrampolineWrap(MochLinuxExecTest):
    def test_unset_env_is_byte_identical(self):
        argv = [str(self.linux / "bin" / "bash"), "-c", "echo hi"]
        self.assertIs(_apply_exec_trampoline(argv), argv)

    def test_wraps_shim_path(self):
        os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"
        argv = [str(self.linux / "bin" / "bash"), "-c", "echo hi"]
        self.assertEqual(_apply_exec_trampoline(argv),
                         ["/system/bin/sh", str(self.linux / "bin" / "bash"), "-c", "echo hi"])

    def test_wrap_guard_skips_system_shells(self):
        """$SHELL=/system/bin/sh corner (§4.5): never wrap a shell that is
        already under /system — it would parse its own binary as a script."""
        os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"
        argv = ["/system/bin/sh", "-lic", "cmd"]
        self.assertEqual(_apply_exec_trampoline(argv), argv)

    def test_process_registry_scope_argv_wrapped(self):
        from tools import process_registry as pr

        os.environ["HERMES_EXEC_TRAMPOLINE"] = "/system/bin/sh"
        os.environ["SHELL"] = str(self.linux / "bin" / "bash")  # spawns via shim
        (self.linux / "bin").mkdir(parents=True, exist_ok=True)
        shim = self.linux / "bin" / "bash"
        shim.write_text("#!/system/bin/sh\n", encoding="utf-8")
        os.chmod(shim, 0o755)  # _find_shell checks os.access(X_OK) on $SHELL
        session = pr.ProcessSession(
            id="x", command="c", task_id="t", owner_task_id=None, session_key="s",
            cwd=str(self.home), parent_session_id="", started_at=0.0)
        # _scope_argv reads no instance state; call it unbound with a dummy self.
        argv = pr.ProcessRegistry._scope_argv(None, session, "true", "unit", "label")
        self.assertEqual(argv[:2], ["/system/bin/sh", str(shim)])


# --------------------------------------------------------------------------
# §9.1.9 — _safe_extract pinned predicate
# --------------------------------------------------------------------------

class TestSafeExtract(MochLinuxExecTest):
    def _tar(self, members):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            for name, kind, linkname, data in members:
                ti = tarfile.TarInfo(name)
                if kind == "file":
                    ti.size = len(data)
                    tf.addfile(ti, io.BytesIO(data))
                else:
                    ti.type = tarfile.SYMTYPE if kind == "link" else tarfile.LNKTYPE
                    ti.linkname = linkname
                    tf.addfile(ti)
        buf.seek(0)
        return tarfile.open(fileobj=buf)

    def test_absolute_symlink_target_accepted(self):
        """The pinned ubuntu-base rootfs ships ~20 guest-absolute links (e.g.
        etc/alternatives/awk -> /usr/bin/mawk); a data-filter-parity
        implementation would raise here and break provisioning on-device."""
        dest = Path(self._tmp.name) / "rootfs"
        dest.mkdir()
        with self._tar([("etc/alternatives/awk", "link", "/usr/bin/mawk", b""),
                        ("bin/tool", "file", "", b"hello")]) as tf:
            le._safe_extract(tf, dest)
        self.assertEqual(os.readlink(dest / "etc/alternatives/awk"), "/usr/bin/mawk")
        self.assertEqual((dest / "bin" / "tool").read_bytes(), b"hello")

    def test_escaping_member_path_rejected(self):
        dest = Path(self._tmp.name) / "d"
        dest.mkdir()
        with self._tar([("../escape", "file", "", b"x")]) as tf:
            with self.assertRaises(ValueError):
                le._safe_extract(tf, dest)
        self.assertFalse((dest.parent / "escape").exists())

    def test_absolute_member_path_rejected(self):
        dest = Path(self._tmp.name) / "d"
        dest.mkdir()
        with self._tar([("abs", "file", "", b"x")]) as tf:  # name w/o leading ./
            tf.getmembers()[0].name = "/abs"  # force the stored absolute name
            with self.assertRaises(ValueError):
                le._safe_extract(tf, dest)

    def test_relative_link_target_escape_rejected(self):
        dest = Path(self._tmp.name) / "d"
        dest.mkdir()
        with self._tar([("link", "link", "../../outside", b"")]) as tf:
            with self.assertRaises(ValueError):
                le._safe_extract(tf, dest)
        with self._tar([("hl", "hlink", "../outside", b"")]) as tf:
            with self.assertRaises(ValueError):
                le._safe_extract(tf, dest)

    def test_normal_tree_extracted_intact(self):
        dest = Path(self._tmp.name) / "d"
        dest.mkdir()
        with self._tar([("a/b/c.txt", "file", "", b"deep"),
                        ("top.txt", "file", "", b"top"),
                        ("rel", "link", "top.txt", b"")]) as tf:
            le._safe_extract(tf, dest)
        self.assertEqual((dest / "a" / "b" / "c.txt").read_bytes(), b"deep")
        self.assertEqual((dest / "top.txt").read_bytes(), b"top")
        self.assertEqual(os.readlink(dest / "rel"), "top.txt")


# --------------------------------------------------------------------------
# §4.3 extras — architecture refusal + loader-missing hard error
# --------------------------------------------------------------------------

class TestBootstrapGuards(MochLinuxExecTest):
    def test_arch_refusal(self):
        with mock.patch("os.uname", return_value=SimpleNamespace(machine="x86_64")):
            report = le.bootstrap()
        self.assertFalse(report["ok"])
        self.assertTrue(report["error"].startswith("Moch Linux requires an arm64 device"),
                        report)
        self.assertFalse((self.linux).exists(), "nothing downloaded on refusal")

    def test_loader_missing_hard_error(self):
        os.environ["MOCH_NATIVE_LIB_DIR"] = str(self.native_dir)
        (self.native_dir / le.LOADER_LIB_NAME).unlink()
        with _aarch64():
            report = le.bootstrap()
        self.assertFalse(report["ok"])
        self.assertIn(le.LOADER_LIB_NAME, report["error"])

    def test_status_reports_loader_ok(self):
        self._bootstrap()
        st = le.status()
        self.assertTrue(st["bootstrapped"])
        self.assertTrue(st["loader_ok"])
        self.assertEqual(st["distro"], "Ubuntu 24.04.4 LTS")


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("ALL TESTS PASSED")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
