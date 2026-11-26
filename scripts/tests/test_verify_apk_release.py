#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "verify_apk_release.py"
SPEC = importlib.util.spec_from_file_location("verify_apk_release", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class VerifyApkReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="moch-apk-release-")
        self.root = Path(self.temp.name)
        self.apk = self.root / "Moch-build58-abcdef0.apk"
        self.apk.write_bytes(b"fake apk bytes")
        self.gradle = self.root / "build.gradle"
        self.gradle.write_text('defaultConfig {\n versionCode 58\n versionName "1.0.53-beta.3"\n}\n')
        self.manifest = self.root / "release-manifest.json"
        self.data = {
            "package": "com.hermes.pocket",
            "versionCode": 58,
            "versionName": "1.0.53-beta.3",
            "commit": "abcdef0123456789",
            "asset": self.apk.name,
            "size": self.apk.stat().st_size,
            "sha256": hashlib.sha256(self.apk.read_bytes()).hexdigest(),
        }
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def errors(self) -> list[str]:
        return module.verify(self.manifest, self.apk, self.gradle, self.data["commit"])

    def test_matching_release_passes(self) -> None:
        self.assertEqual(self.errors(), [])

    def test_version_drift_fails(self) -> None:
        self.data["versionName"] = "1.0.53-beta.2"
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")
        self.assertTrue(any("versionName" in error for error in self.errors()))

    def test_checksum_mismatch_fails(self) -> None:
        self.data["sha256"] = "0" * 64
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")
        self.assertTrue(any("SHA-256" in error for error in self.errors()))

    def test_asset_path_traversal_fails(self) -> None:
        self.data["asset"] = "../outside.apk"
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")
        self.assertTrue(any("plain file name" in error for error in self.errors()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
