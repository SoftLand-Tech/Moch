#!/usr/bin/env bash
# build-app-web.sh — export the REAL phone app (Expo / RN-web) to the static
# bundle the Tauri shell embeds: desktop/app-web.
#
# Usage: desktop/scripts/build-app-web.sh
#
# What it does:
#   1. refuses to run concurrently with another build (flock on a lock file
#      under desktop/.tmp — two metro exporters into one output dir corrupt
#      each other),
#   2. runs `npx expo export --platform web --output-dir <desktop>/app-web`
#      from the app/ checkout this worktree owns,
#   3. fails LOUDLY on any non-zero exit (set -euo pipefail + explicit trap),
#   4. prints the resulting top-level file list and total size.
#
# It never touches tauri.conf.json (the Lead owns that) or runtime-home/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
OUT_DIR="$DESKTOP_DIR/app-web"
TMP_DIR="$DESKTOP_DIR/.tmp"
LOCK_FILE="$TMP_DIR/build-app-web.lock"

mkdir -p "$TMP_DIR"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "build-app-web: FATAL: no app checkout at $APP_DIR (expected the Expo app next to desktop/)" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "build-app-web: FATAL: $APP_DIR/node_modules missing — run the app's package install first" >&2
  exit 1
fi

# One build at a time. flock -n: if another holder exists, fail fast with a
# clear message instead of corrupting a shared output dir. The lock is held
# for this script's lifetime (fd stays open) and is kernel-released on exit.
exec 3>"$LOCK_FILE"
if ! flock -n 3; then
  echo "build-app-web: REFUSED: a build is already in progress (lock held: $LOCK_FILE)." >&2
  echo "build-app-web:          The lock is advisory-flock and is released when the other build" >&2
  echo "build-app-web:          exits; if you are certain it is stale, investigate the holder." >&2
  exit 1
fi

die() {
  echo "build-app-web: FATAL: $*" >&2
  exit 1
}

echo "build-app-web: app      = $APP_DIR"
echo "build-app-web: output   = $OUT_DIR"
echo "build-app-web: exporting (expo export --platform web) …"

START_TS=$SECONDS
set +e
(
  cd "$APP_DIR"
  npx expo export --platform web --output-dir "$OUT_DIR"
)
STATUS=$?
set -e
ELAPSED=$((SECONDS - START_TS))

if [[ $STATUS -ne 0 ]]; then
  die "expo export exited non-zero ($STATUS) after ${ELAPSED}s — the bundle in $OUT_DIR may be stale or partial; fix the error above and re-run."
fi

# The export must have produced a loadable SPA: index.html + at least one JS
# bundle. NOTE: SDK 57 metro web output nests the bundles under
# _expo/static/js/web/ — search recursively, not just at the top level.
[[ -f "$OUT_DIR/index.html" ]] || die "expo export reported success but $OUT_DIR/index.html is missing."
if ! find "$OUT_DIR" -type f -name '*.js' -print -quit | grep -q .; then
  die "expo export reported success but no *.js bundle exists anywhere under $OUT_DIR."
fi

echo "build-app-web: done in ${ELAPSED}s."
echo
echo "build-app-web: top-level contents of $OUT_DIR:"
( cd "$OUT_DIR" && ls -lah . | sed 's/^/  /' )
echo
echo "build-app-web: total size: $(du -sh "$OUT_DIR" | cut -f1) ($(du -sb "$OUT_DIR" | cut -f1) bytes)"
echo "build-app-web: OK"
