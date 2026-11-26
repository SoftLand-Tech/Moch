#!/usr/bin/env python3
"""Verify a CI APK and its release manifest against the Android build version."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_aapt2() -> Path | None:
    found = shutil.which("aapt2")
    if found:
        return Path(found)
    roots = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), str(Path.home() / "Android" / "Sdk")]
    candidates: list[Path] = []
    for root in roots:
        if not root:
            continue
        candidates.extend((Path(root) / "build-tools").glob("*/aapt2"))
    return max(candidates, default=None)


def inspect_apk(apk_path: Path, aapt2_path: Path | None) -> tuple[str, str, str, list[str]]:
    errors: list[str] = []
    package = code = name = ""
    if aapt2_path is None:
        aapt2_path = find_aapt2()
    if aapt2_path is None or not aapt2_path.is_file():
        return package, code, name, ["aapt2 is required to inspect APK metadata"]
    try:
        result = subprocess.run(
            [str(aapt2_path), "dump", "badging", str(apk_path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return package, code, name, [f"could not run aapt2: {exc}"]
    if result.returncode != 0:
        return package, code, name, ["aapt2 could not parse the APK"]
    match = re.search(
        r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",
        result.stdout,
        re.MULTILINE,
    )
    if not match:
        errors.append("aapt2 did not return package/version metadata")
    else:
        package, code, name = match.groups()
    return package, code, name, errors


def verify(
    manifest_path: Path,
    apk_path: Path,
    gradle_path: Path,
    commit: str,
    *,
    aapt2_path: Path | None = None,
) -> list[str]:
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
    appid_match = re.search(r'\bapplicationId\s+["\']([^"\']+)["\']', gradle)
    if not code_match or not name_match or not appid_match:
        return ["could not read applicationId/versionCode/versionName from Gradle"]
    code = code_match.group(1)
    name = name_match.group(1)
    application_id = appid_match.group(1)

    if manifest.get("package") != application_id:
        errors.append(f"manifest package must be {application_id}")
    if str(manifest.get("versionCode")) != code:
        errors.append(f"manifest versionCode must be {code}")
    if manifest.get("versionName") != name:
        errors.append(f"manifest versionName must be {name}")
    if manifest.get("commit") != commit:
        errors.append("manifest commit must match the site commit")

    asset = manifest.get("asset")
    if not isinstance(asset, str) or not asset or Path(asset).name != asset or asset in {".", ".."}:
        errors.append("manifest asset must be a plain file name")
    elif not asset.lower().endswith(".apk"):
        errors.append("manifest asset must end in .apk")
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
        try:
            with zipfile.ZipFile(apk_path) as archive:
                names = set(archive.namelist())
                if "AndroidManifest.xml" not in names:
                    errors.append("APK is missing AndroidManifest.xml")
                v1_signed = any(name.startswith("META-INF/") and name.upper().endswith((".RSA", ".DSA", ".EC")) for name in names)
                with apk_path.open("rb") as handle:
                    handle.seek(max(0, archive.start_dir - 1024 * 1024))
                    signing_block = handle.read(archive.start_dir - max(0, archive.start_dir - 1024 * 1024))
                if not v1_signed and b"APK Sig Block 42" not in signing_block:
                    errors.append("APK is missing a v1/v2/v3 signature block")
        except (OSError, zipfile.BadZipFile) as exc:
            errors.append(f"APK is not a valid ZIP package: {exc}")
        package, apk_code, apk_name, apk_errors = inspect_apk(apk_path, aapt2_path)
        errors.extend(apk_errors)
        if package and package != application_id:
            errors.append(f"APK applicationId must be {application_id}")
        if apk_code and apk_code != code:
            errors.append(f"APK versionCode must be {code}")
        if apk_name and apk_name != name:
            errors.append(f"APK versionName must be {name}")
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
