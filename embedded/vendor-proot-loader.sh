#!/usr/bin/env bash
# vendor-proot-loader.sh — ship proot's loader as an APK native library (M8).
#
# Under targetSdkVersion 36 (untrusted_app SELinux domain) the ONE file the
# kernel must execve per guest exec is proot's loader (proot rewrites every
# guest execve syscall to it via $PROOT_LOADER). App-data files are never
# execve-able there, but files under the APK's nativeLibraryDir are
# (apk_data_file: execute_no_trans is granted to every appdomain) — so the
# loader rides the APK as a jniLib with legacy extraction. See
# embedded/EXEC-DESIGN.md §4.1 (the fix) and §1 (the root cause).
#
# Source: the loader inside the exact proot .deb Moch already pins
# (moch/linux_env.py PROOT_URL, termux-main repo). The binary is UNMODIFIED.
#
# License (GPLv2): proot is STMicroelectronics' GPLv2 work; Moch
# redistributes this unmodified, separately-built binary. License text:
# embedded/licenses/proot-COPYING. Corresponding source offer:
# https://github.com/termux/proot @ v5.1.107.96 (the tag this .deb was
# built from). Aggregation only — Moch links nothing against proot.
#
# Output: app/android/app/src/main/jniLibs/arm64-v8a/libproot-loader.so
# (committed; this script is the documented regeneration path).
#
# Usage: embedded/vendor-proot-loader.sh        (needs curl, ar, tar, xz)
set -euo pipefail

TERMUX_BASE="https://packages.termux.dev/apt/termux-main/pool/main"
DEB_URL="${TERMUX_BASE}/p/proot/proot_5.1.107.96_aarch64.deb"
LOADER_SHA256="cbdef0e652c2b78af25d867e1719fdebbb0915e25aae2dd35b3b5c1835f6b551"
LOADER_SIZE=18136

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/app/android/app/src/main/jniLibs/arm64-v8a/libproot-loader.so"
MEMBER="./data/data/com.termux/files/usr/libexec/proot/loader"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading $DEB_URL …"
curl -fL --retry 3 -o "$TMP/proot.deb" "$DEB_URL"

echo "extracting data.tar.xz + loader member …"
ar x "$TMP/proot.deb" --output "$TMP"          # debian-binary control.tar.xz data.tar.xz
# tar member names carry the leading ./ (verified: `tar -tJf data.tar.xz`)
tar -xJf "$TMP/data.tar.xz" -C "$TMP" "$MEMBER"

LOADER="$TMP/${MEMBER#./}"
echo "verifying sha256 …"
GOT="$(sha256sum "$LOADER" | cut -d' ' -f1)"
[[ "$GOT" == "$LOADER_SHA256" ]] || {
  echo "error: loader sha256 mismatch" >&2
  echo "  expected $LOADER_SHA256" >&2
  echo "  got      $GOT" >&2
  echo "  (pin bumped in moch/linux_env.py? update LOADER_SHA256 here too)" >&2
  exit 1
}
SIZE="$(stat -c '%s' "$LOADER")"
[[ "$SIZE" == "$LOADER_SIZE" ]] || { echo "error: loader size $SIZE != $LOADER_SIZE" >&2; exit 1; }

mkdir -p "$(dirname "$DST")"
cp "$LOADER" "$DST"
chmod 0644 "$DST"
echo "ok: $DST ($SIZE bytes, sha256 $GOT)"
