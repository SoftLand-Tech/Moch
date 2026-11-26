#!/usr/bin/env python3
"""Verify a CI APK and its release manifest against the Android build version."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(manifest_path: Path, apk_path: Path, gradle_path: Path, commit: str) -> list[str]:
    errors: list[str] = []
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return [f"cannot read release manifest: {exc}"]
    try:
        gradle = gradle_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"cannot read Gradle version: {exc}"]

    code_match = re.search(r"\bversionCode\s+(\d+)", gradle)
    name_match = re.search(r'\bversionName\s+"([^"]+)"', gradle)
    if not code_match or not name_match:
        return ["could not read versionCode/versionName from Gradle"]
    code = code_match.group(1)
    name = name_match.group(1)

    if manifest.get("package") != "com.hermes.pocket":
        errors.append("manifest package must be com.hermes.pocket")
    if str(manifest.get("versionCode")) != code:
        errors.append(f"manifest versionCode must be {code}")
    if manifest.get("versionName") != name:
        errors.append(f"manifest versionName must be {name}")
    if manifest.get("commit") != commit:
        errors.append("manifest commit must match the site commit")

    asset = manifest.get("asset")
    if not isinstance(asset, str) or not asset or Path(asset).name != asset or asset in {".", ".."}:
        errors.append("manifest asset must be a plain file name")
    elif apk_path.name != asset:
        errors.append(f"downloaded APK name must be {asset}")

    if not apk_path.is_file():
        errors.append(f"APK not found: {apk_path}")
    else:
        size = apk_path.stat().st_size
        if int(manifest.get("size", -1)) != size:
            errors.append(f"APK size must be {size}")
        checksum = sha256(apk_path)
        if manifest.get("sha256") != checksum:
            errors.append(f"APK SHA-256 must be {checksum}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--gradle", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    errors = verify(args.manifest, args.apk, args.gradle, args.commit)
    if errors:
        for error in errors:
            print(f"APK release verification failed: {error}")
        return 1
    print("APK release verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
