#!/usr/bin/env bash
# vendor-hermes.sh — sync the hermes-agent runtime subset into app/hermes-src/.
#
# Vendored set = the import closure of `import run_agent` (the agent runtime
# entry module), verified by census against the reference install. Re-run after
# updating the source checkout; the tree is replaced wholesale so `git diff`
# in the fork shows exactly what changed upstream.
#
# Usage: embedded/vendor-hermes.sh [path-to-hermes-agent-checkout]
#        (default: ~/.hermes/hermes-agent)
set -euo pipefail

SRC="${1:-$HOME/.hermes/hermes-agent}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/app/hermes-src"

[[ -f "$SRC/run_agent.py" ]] || { echo "error: $SRC is not a hermes-agent checkout (no run_agent.py)" >&2; exit 1; }
PKGS=(agent cron gateway hermes_cli plugins providers tui_gateway tools)

MODS=(cli.py hermes_bootstrap.py hermes_constants.py hermes_logging.py hermes_startup_watchdog.py hermes_state.py hermes_time.py model_tools.py registration_lifecycle.py run_agent.py toolsets.py utils.py)

rm -rf "$DST"
mkdir -p "$DST"

# Caches/tests never ship; web_dist is the dashboard SPA the phone never
# serves (verified absent from the import closure — see MILESTONE-2.md).
RSYNC_FILTERS=(
  --filter='- */__pycache__/'
  --filter='- *.pyc'
  --filter='- *.pyo'
  --filter='- tests/'
  --filter='- node_modules/'
  --filter='- .git/'
  --filter='- .pytest_cache/'
  --filter='- .ruff_cache/'
  --filter='- web_dist/'
)

for pkg in "${PKGS[@]}"; do
  [[ -d "$SRC/$pkg" ]] || { echo "error: package $pkg missing in $SRC" >&2; exit 1; }
  rsync -a "${RSYNC_FILTERS[@]}" "$SRC/$pkg" "$DST/"
done

for mod in "${MODS[@]}"; do
  [[ -f "$SRC/$mod" ]] || { echo "error: module $mod missing in $SRC" >&2; exit 1; }
  rsync -a "${RSYNC_FILTERS[@]}" "$SRC/$mod" "$DST/"
done

# hermes_state_* compatibility shims (flat root modules).
rsync -a "${RSYNC_FILTERS[@]}" --include='hermes_state_*.py' --exclude='*' "$SRC/" "$DST/"

VERSION="$(python3 -c "import tomllib,pathlib;print(tomllib.loads(pathlib.Path('$SRC/pyproject.toml').read_text())['project']['version'])")"
COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"

python3 - "$DST/VENDOR.json" "$VERSION" "$COMMIT" "$SRC" <<'EOF'
import json, sys, datetime
path, version, commit, src = sys.argv[1:]
json.dump(
    {
        "name": "hermes-agent",
        "version": version,
        "commit": commit,
        "source": src,
        "synced": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    },
    open(path, "w"),
    indent=2,
)
    # trailing newline
open(path, "a").write("\n")
EOF

FILES="$(find "$DST" -type f ! -name VENDOR.json | wc -l)"
BYTES="$(du -sh --exclude=VENDOR.json "$DST" | cut -f1)"
echo "vendored hermes-agent $VERSION ($COMMIT): $FILES files, $BYTES -> $DST"
