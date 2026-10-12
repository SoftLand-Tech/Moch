#!/usr/bin/env python3
"""BH-000050 + C-07 regression tests — rootfs URLs and download pinning.

GitHub #103 (BH-000050): the Debian rootfs URL misspelled the artifact org
('debuerreumaker') and 404'd — bootstrap("debian-12") could never download.
The URL is now the verified debuerreotype dist-arm64v8 bookworm artifact, and
the extractor accepts any tar compression (``r:*``), not just gzip.

GitHub #97 (C-07): no downloaded bootstrap artifact was checksum-verified.
Every artifact URL now carries a pinned sha256 in ``linux_env._SHA256_PINS``
and ``_download`` FAILS CLOSED — unpinned URLs are refused before a byte hits
disk; a mismatched download is deleted and refused.

Local, stdlib-only, self-contained, no network (downloads are faked at the
urllib seam): run with

    python3 app/python-runtime/tests/test_linux_pins.py

and expect exit 0 with ``OK``. Mirrors test_gateway_boot_gate.py conventions.
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import tarfile
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import moch.linux_env as le  # noqa: E402

_BOOTSTRAP_URLS = [
    le.PROOT_URL,
    le.LIBTALLOC_URL,
    le.SHMEM_URL,
    *le.ROOTFS_URLS.values(),
]


class RootfsUrlTests(unittest.TestCase):
    """#103 — every ROOTFS_URLS entry is spelled for an org that exists."""

    def test_no_misspelled_org_anywhere(self):
        """The regression family: 'debuerreumaker' must never come back, in
        any URL the bootstrap touches (rootfs or termux packages)."""
        for url in _BOOTSTRAP_URLS:
            self.assertNotIn("debuerreumaker", url, url)
            self.assertNotIn("debuerreumat", url, url)

    def test_ubuntu_rootfs_is_the_official_cdimage_artifact(self):
        parsed = urllib.parse.urlparse(le.ROOTFS_URLS["ubuntu-24.04"])
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "cdimage.ubuntu.com")
        self.assertIn("ubuntu-base", parsed.path)

    def test_debian_rootfs_is_debuerreotype_dist_arm64v8_bookworm(self):
        url = le.ROOTFS_URLS["debian-12"]
        parsed = urllib.parse.urlparse(url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "github.com")
        parts = [p for p in parsed.path.split("/") if p]
        # /<org>/<repo>/raw/<branch>/<artifact path…>
        self.assertEqual(parts[0], "debuerreotype", "org must be debuerreotype")
        self.assertEqual(parts[1], "docker-debian-artifacts")
        self.assertEqual(parts[2], "raw")
        self.assertEqual(parts[3], "dist-arm64v8")
        self.assertIn("bookworm", parsed.path)
        self.assertTrue(url.endswith((".tar.gz", ".tar.xz")), url)


class PinTableTests(unittest.TestCase):
    """#97 — every bootstrap URL has a pin, every pin names a bootstrap URL."""

    def test_every_bootstrap_url_has_a_wellformed_pin(self):
        for url in _BOOTSTRAP_URLS:
            self.assertIn(url, le._SHA256_PINS, f"unpinned bootstrap URL: {url}")
            pin = le._SHA256_PINS[url]
            self.assertRegex(pin, r"^[0-9a-f]{64}$", f"malformed pin for {url}: {pin!r}")

    def test_pin_table_has_no_stray_entries(self):
        self.assertEqual(set(le._SHA256_PINS), set(_BOOTSTRAP_URLS))


class _FakeResp:
    """urllib response stand-in serving a fixed blob in chunks."""

    def __init__(self, blob: bytes) -> None:
        self._blob = blob
        self._off = 0

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            chunk, self._off = self._blob[self._off:], len(self._blob)
        else:
            chunk = self._blob[self._off : self._off + n]
            self._off += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FailClosedDownloadTests(unittest.TestCase):
    """#97 — the download gate itself, at the urllib seam (no network)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self._tmp.name) / "artifact.deb"
        self._pins = dict(le._SHA256_PINS)

    def tearDown(self) -> None:
        le._SHA256_PINS.clear()
        le._SHA256_PINS.update(self._pins)
        self._tmp.cleanup()

    def _serve(self, blob: bytes):
        return mock.patch.object(le.urllib.request, "urlopen", return_value=_FakeResp(blob))

    def test_unpinned_url_is_refused_before_any_download(self):
        def _must_not_touch_net(*a, **k):  # pragma: no cover — assertion guard
            raise AssertionError("unpinned download attempted network I/O")

        evil = "https://evil.example.example/p/proot_9.9.9_aarch64.deb"
        self.assertNotIn(evil, le._SHA256_PINS)
        with mock.patch.object(le.urllib.request, "urlopen", _must_not_touch_net):
            with self.assertRaisesRegex(ValueError, "no pinned sha256"):
                le._download(evil, self.dest)
        self.assertFalse(self.dest.exists(), "refused download must not leave a file")

    def test_sha256_mismatch_refuses_and_deletes(self):
        blob = b"tampered proot bytes"
        assert hashlib.sha256(blob).hexdigest() != le._SHA256_PINS[le.PROOT_URL]
        with self._serve(blob):
            with self.assertRaisesRegex(ValueError, "sha256 mismatch"):
                le._download(le.PROOT_URL, self.dest)
        self.assertFalse(self.dest.exists(), "mismatched artifact must be deleted")

    def test_matching_pin_downloads_and_passes(self):
        blob = b"legitimate proot bytes"
        le._SHA256_PINS[le.PROOT_URL] = hashlib.sha256(blob).hexdigest()
        with self._serve(blob):
            written = le._download(le.PROOT_URL, self.dest)
        self.assertEqual(written, len(blob))
        self.assertEqual(self.dest.read_bytes(), blob)


class ExtractRootfsTests(unittest.TestCase):
    """#103 — the extractor accepts xz, not just gzip."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def _tarball(mode: str, marker_name: str, content: bytes) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode=mode) as tf:
            ti = tarfile.TarInfo(marker_name)
            ti.size = len(content)
            tf.addfile(ti, io.BytesIO(content))
        return buf.getvalue()

    def _extract(self, mode: str):
        blob = self._tarball(mode, "etc/os-release", b'PRETTY_NAME="Moch Test"\n')
        tarball = self.tmp / f"rootfs.tar{'.xz' if mode.endswith('xz') else '.gz'}"
        tarball.write_bytes(blob)
        dest = self.tmp / "rootfs"
        dest.mkdir()
        le._extract_rootfs(tarball, dest)
        self.assertEqual(
            (dest / "etc" / "os-release").read_bytes(),
            b'PRETTY_NAME="Moch Test"\n',
        )

    def test_extracts_gzip_rootfs(self):
        self._extract("w:gz")

    def test_extracts_xz_rootfs(self):
        """The Debian artifact family ships .tar.xz — the old ``r:gz`` open
        hard-failed here before GH #103."""
        self._extract("w:xz")


if __name__ == "__main__":
    unittest.main(verbosity=2)
