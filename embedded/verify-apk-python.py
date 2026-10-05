#!/usr/bin/env python3
"""Verify every requirements-embedded.txt pin ships inside a built APK.

Usage: python3 embedded/verify-apk-python.py [path-to-apk]
Exits non-zero and names every missing package. Run after every
assembleRelease that touched the pip environment — a partially-synced
Chaquopy pip env once shipped an APK without fastapi (2026-10-05).
"""
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APK = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "app/android/app/build/outputs/apk/release/app-release.apk")

# module name -> dist name normalization (PEP 503)
def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()

pins: dict[str, str] = {}  # normalized dist -> version
req = (ROOT / "app/python-runtime/requirements-embedded.txt").read_text()
for line in req.splitlines():
    line = line.split("#")[0].strip()
    m = re.match(r"^([A-Za-z0-9_.-]+)==([0-9][A-Za-z0-9.*+!-]*)$", line)
    if m:
        pins[norm(m.group(1))] = m.group(2)

z = zipfile.ZipFile(APK)
all_names: list[str] = []
for imy in ["requirements-common.imy", "requirements-arm64-v8a.imy", "app.imy"]:
    try:
        inner = zipfile.ZipFile(io.BytesIO(z.read("assets/chaquopy/" + imy)))
        all_names += [n for n in inner.namelist()]
    except KeyError:
        pass

found: dict[str, str] = {}
for n in all_names:
    m = re.match(r"^([A-Za-z0-9_.-]+)-([0-9][^/]*)\.dist-info/?$", n)
    if m:
        found[norm(m.group(1))] = m.group(2)
    # sdist-installed packages may ship no dist-info; fall back to module dirs
    m2 = re.match(r"^([A-Za-z0-9_]+)/__init__\.(py|pyc)$", n)
    if m2:
        found.setdefault(norm(m2.group(1)), "module-only")

missing = []
for dist, ver in sorted(pins.items()):
    got = found.get(dist)
    if got is None:
        # try import-name mapping for known mismatches
        alias = {"ruamel-yaml": "ruamel", "pillow": "PIL"}.get(dist)
        got = found.get(alias) if alias else None
    if got is None:
        missing.append(f"{dist}=={ver} — ABSENT")
    elif got not in (ver, "module-only") and not got.startswith(ver):
        missing.append(f"{dist}=={ver} — FOUND {got}")

print(f"{len(pins)} pins checked against {APK.name}")
if missing:
    for m in missing:
        print("✗", m)
    sys.exit(1)
print("ALL PYTHON DEPENDENCIES PRESENT")
