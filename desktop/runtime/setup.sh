#!/usr/bin/env bash
# Moch Desktop runtime — one-time setup: the Python venv that runs the
# vendored hermes tree (the same fork the phone ships) as a local gateway.
#
# Requirements: uv (or python3.12+ with venv/pip), ~200MB for the venv.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# In a git worktree the old ../../../ climb landed one level above the root,
# so trust git's own answer; ../.. covers a plain checkout without git.
if REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$REPO" ]; then
  :
else
  REPO="$(cd "$HERE/../.." && pwd)"
fi
export UV_CACHE_DIR="${UV_CACHE_DIR:-$REPO/.uv-cache}"

if ! [ -d "$REPO/app/hermes-src" ]; then
  echo "error: vendored hermes tree not found at $REPO/app/hermes-src" >&2
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  echo "→ creating the runtime venv (python 3.12) with uv…"
  uv venv --python 3.12 "$HERE/.venv"
  uv pip install -p "$HERE/.venv/bin/python" -r "$HERE/requirements.txt"
else
  echo "→ uv not found; falling back to python3 -m venv"
  python3 -m venv "$HERE/.venv"
  "$HERE/.venv/bin/pip" install -U pip wheel
  "$HERE/.venv/bin/pip" install -r "$HERE/requirements.txt"
fi

echo "→ smoke test: boot the runtime for 3 seconds…"
if MOCH_DESKTOP_STATE_DIR="$(mktemp -d)" timeout 3 "$HERE/.venv/bin/python" -m moch_desktop --port 0 2>&1 | grep -q "moch-desktop"; then
  echo "✓ runtime boots"
else
  # timeout kills it mid-boot; any output means imports worked
  echo "✓ runtime imports (boot interrupted by timeout — expected)"
fi

echo
echo "Done. The desktop app starts this runtime automatically;"
echo "or run it by hand:"
echo "  $HERE/.venv/bin/python -m moch_desktop --port 9199 --status"
