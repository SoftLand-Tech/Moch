#!/usr/bin/env bash
# build-android-wheels.sh — produce aarch64-android wheels for the native
# Rust Python dependencies the embedded hermes runtime needs and that
# neither PyPI nor Chaquopy prebuild:
#
#   pydantic-core==2.46.4  (required by pydantic 2.13.4 / openai SDK)
#   jiter==0.13.0          (required by openai SDK streaming)
#
# Recipe: maturin cross-build against the NDK, using Chaquopy's Android
# CPython target (Maven Central: com.chaquo.python:target) as
# PYO3_CROSS_LIB_DIR, plus a synthetic _sysconfigdata (abi3 builds only
# need version + suffix facts; suffix follows the target zip's own
#
# psutil is NOT built here — Chaquopy builds its sdist with the NDK during
# the gradle build. (Prebuilt alternative: chaquo.com/pypi-13.1/psutil/.)
#
# Output: app/wheels-android/*.whl (committed to the fork so gradle builds
# need no Rust toolchain). Re-run when bumping the pins.
#
# Requirements on this machine: rustup/cargo, Android SDK + NDK, python3.11.
# Usage: embedded/build-android-wheels.sh [abi]        (default arm64-v8a)
set -euo pipefail

ABI="${1:-arm64-v8a}"
RUST_TARGET="aarch64-linux-android"
PLAT_TAG="android_24_${ABI//-/_}"
TARGET_VER="3.11.14-0"          # Chaquopy android CPython build (cp311)
NDK="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/27.1.12297006}"
PY311="${chaquopyBuildPython:-$HOME/.local/share/uv/python/cpython-3.11.16-linux-x86_64-gnu/bin/python3.11}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app/wheels-android"
WORK="$ROOT/embedded/.wheelbuild"

[[ -d "$NDK" ]] || { echo "error: NDK not found at $NDK (set ANDROID_NDK_HOME)" >&2; exit 1; }
[[ -x "$PY311" ]] || { echo "error: python3.11 not found at $PY311" >&2; exit 1; }
command -v cargo >/dev/null || { echo "error: cargo not on PATH (install rustup)" >&2; exit 1; }

command -v rustup >/dev/null && rustup target add "$RUST_TARGET" >/dev/null

rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"
echo "==> build venv (maturin)"
"$PY311" -m venv "$WORK/venv"
"$WORK/venv/bin/pip" -q install --upgrade maturin wheel

# ---- Android CPython cross environment (Chaquopy target) -----------------------
echo "==> fetching com.chaquo.python:target:${TARGET_VER} (${ABI})"
CROSSLIB="$WORK/crosslib"
mkdir -p "$CROSSLIB"
curl -4 -fsSL --retry 3 -o "$WORK/crosslib.zip" \
  "https://repo1.maven.org/maven2/com/chaquo/python/target/${TARGET_VER}/target-${TARGET_VER}-${ABI}.zip"
unzip -oq "$WORK/crosslib.zip" -d "$CROSSLIB"
# Synthetic sysconfigdata: maturin demands one; abi3 only needs these facts.
cat > "$CROSSLIB/_sysconfigdata__linux_aarch64_android.py" <<'PYEOF'
build_time_vars = {
    "VERSION": "3.11",
    "EXT_SUFFIX": ".cpython-311.so",
    "SOABI": "cpython-311",
    "ABIFLAGS": "",
    "Py_ENABLE_SHARED": 1,
    "LIBRARY": "",
    "LDLIBRARY": "libpython3.11.so",
    "LIBPYTHON": "libpython3.11.so",
    "LIBDIR": "",
    "LIBS": "",
    "SYSLIBS": "",
    "MULTIARCH": "aarch64-linux-android",
    "py_version_short": "3.11",
    "py_version_nodot": "311",
    "CC": "clang",
    "CFLAGS": "",
    "LDSHARED": "clang -shared",
    "MACOSX_DEPLOYMENT_TARGET": "",
    "SIZEOF_VOID_P": 8,
    "WITH_PYMALLOC": 0,
}
PYEOF
ln -sf "jniLibs/${ABI}/libpython3.11.so" "$CROSSLIB/libpython3.11.so"

# ---- Rust wheels via maturin ---------------------------------------------------
build_rust () {  # build_rust <dist> <version>
  local dist="$1" ver="$2"
  echo "==> building $dist==$ver (maturin, $RUST_TARGET)"
  mkdir -p "$WORK/sdist"
  "$WORK/venv/bin/pip" -q download --no-deps --no-binary :all: -d "$WORK/sdist" "${dist}==${ver}"
  local src
  src="$(find "$WORK/sdist" -maxdepth 1 \( -name "${dist//-/_}-${ver}.tar.gz" -o -name "${dist}-${ver}.tar.gz" \) -print -quit)"
  [[ -n "$src" ]] || { echo "error: sdist for $dist==$ver not found" >&2; exit 1; }
  rm -rf "$WORK/pkg"; mkdir -p "$WORK/pkg"
  tar -xf "$src" -C "$WORK/pkg" --strip-components=1
  # Pin the NDK linker: without this cargo links aarch64 objects with the
  # host `cc`/`ld` and fails with "file in wrong format".
  NDK_CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${RUST_TARGET}24-clang"
  [[ -x "$NDK_CC" ]] || { echo "error: NDK clang not found at $NDK_CC" >&2; exit 1; }
  mkdir -p "$WORK/pkg/.cargo"
  printf '[target.%s]\nlinker = "%s"\n' "$RUST_TARGET" "$NDK_CC" > "$WORK/pkg/.cargo/config.toml"
  ( cd "$WORK/pkg" && ANDROID_NDK_HOME="$NDK" PYO3_CROSS_PYTHON_VERSION=3.11 \
      PYO3_CROSS_LIB_DIR="$CROSSLIB" "$WORK/venv/bin/maturin" build \
      --release --target "$RUST_TARGET" -i "$PY311" --out "$OUT" --frozen ||
    ANDROID_NDK_HOME="$NDK" PYO3_CROSS_PYTHON_VERSION=3.11 \
      PYO3_CROSS_LIB_DIR="$CROSSLIB" "$WORK/venv/bin/maturin" build \
      --release --target "$RUST_TARGET" -i "$PY311" --out "$OUT" )
}

build_rust pydantic-core 2.46.4
build_rust jiter 0.13.0
build_rust rpds-py 0.30.0

# ---- Normalize tags to the Chaquopy android platform tag -----------------------
# maturin emits linux_aarch64 wheels for android targets; Chaquopy's pip
# accepts android_<api>_<abi>. Rewrite filename + WHEEL metadata.
echo "==> normalizing wheel platform tags to ${PLAT_TAG}"
"$PY311" - "$OUT" "$PLAT_TAG" <<'PYEOF'
import re, sys, zipfile, pathlib

out, plat = pathlib.Path(sys.argv[1]), sys.argv[2]
android_re = re.compile(r"android_\d+_[a-z0-9_]+")

for whl in sorted(out.glob("*.whl")):
    parts = whl.stem.split("-")
    if len(parts) != 5:
        continue
    pkg, ver, pytag, abitag, plats = parts
    fixed = []
    for p in plats.split("."):
        if android_re.match(p):
            fixed.append(plat)
        elif p in ("linux_aarch64", "manylinux2014_aarch64", "manylinux_2_17_aarch64"):
            fixed.append(plat)
        else:
            sys.exit(f"error: {whl.name}: unexpected platform tag {p}")
    new_name = "-".join([pkg, ver, pytag, abitag, ".".join(dict.fromkeys(fixed))]) + ".whl"
    tmp = whl.with_suffix(".tmp")
    with zipfile.ZipFile(whl) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.endswith(".dist-info/WHEEL"):
                text = re.sub(r"^Tag: .*$", f"Tag: {pytag}-{abitag}-{plat}",
                              data.decode(), flags=re.M)
                data = text.encode()
            zout.writestr(item, data)
    if new_name != whl.name:
        tmp.rename(out / new_name)
        whl.unlink()
    else:
        tmp.rename(whl)
    print(f"   {new_name}")
PYEOF

echo "==> wheels in $OUT:"
ls -la "$OUT"
