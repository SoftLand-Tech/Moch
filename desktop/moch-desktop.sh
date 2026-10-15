#!/usr/bin/env bash
# Moch Desktop — launcher (runs from the repo worktree).
cd "$(dirname "$0")"
BIN="./src-tauri/target/release/moch-desktop"
if [ ! -f "$BIN" ] || [ "./src-tauri/target/debug/moch-desktop" -nt "$BIN" ]; then
  BIN="./src-tauri/target/debug/moch-desktop"
fi
exec "$BIN" "$@"
