#!/usr/bin/env bash
# M9.0 fleet probes — run all six on PC and capture evidence into results/.
# Usage: ./run_all.sh
set -u
cd "$(dirname "$0")"
PY="${PY:-$HOME/.hermes/hermes-agent/venv/bin/python}"
mkdir -p results
rc=0
for p in p1_profiles_create p2_profile_scoping p3_ram p4_flock_kanban p4b_turn_serialization p4c_session_lease; do
  echo "== $p =="
  timeout 300 "$PY" "$p.py" >"/tmp/fp-$p.log" 2>&1 || rc=1
  cp "/tmp/moch-fleet-proof/$p.txt" "results/$p.txt" 2>/dev/null || rc=1
  grep -m1 "^# " "results/$p.txt" 2>/dev/null
done
exit $rc
