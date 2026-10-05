#!/usr/bin/env bash
# EAS build hook (eas-build-pre-install): ensure a CPython 3.11 exists for
# Chaquopy's buildPython. EAS images don't ship python3.11; uv installs a
# standalone one into ~/.local/share/uv/python/cpython-3.11*, where
# app/build.gradle's buildPython resolution picks it up.
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-}" != "android" ]]; then
  exit 0
fi

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo "=====> installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
echo "=====> installing CPython 3.11 via uv"
uv python install 3.11
uv python find 3.11 || true
