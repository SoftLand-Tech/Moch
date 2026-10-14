#!/usr/bin/env bash
# Moch Desktop — release launcher (runs from the repo worktree).
cd "$(dirname "$0")"
exec ./src-tauri/target/release/moch-desktop "$@"
