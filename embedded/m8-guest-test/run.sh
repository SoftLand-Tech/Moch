#!/bin/bash
# M8 on-device guest exec matrix — embedded/EXEC-DESIGN.md §9.2.
#
# Run INSIDE the guest (see embedded/MILESTONE-8.md for how to get this dir
# onto the phone and invoke it):
#     bash /workspace/m8-guest-test/run.sh
#
# Prerequisites (install inside the guest first — ubuntu-base ships none of
# them, not even a compiler):
#     apt-get update && apt-get install -y nodejs php-cli git build-essential
#
# Every check prints "<name>: OK". A failure prints FAIL with the last error
# line and the script exits nonzero at the end. Any "Permission denied" is a
# failure of the M8 design — re-run with PROOT_VERBOSE=9 for triage.
#
# npm install runs only "network permitting" (§9.2) and may print SKIP
# without failing the matrix.

set -u
cd "$(dirname "$0")"

PASS=0 FAIL=0 SKIP=0

ok()   { echo "$1: OK"; PASS=$((PASS + 1)); }
fail() { echo "$1: FAIL ${2:-}"; FAIL=$((FAIL + 1)); }
skip() { echo "$1: SKIP ${2:-}"; SKIP=$((SKIP + 1)); }

check() { # check <name> <command...>
  local name="$1"; shift
  local out
  out="$("$@" 2>&1)"
  if [ $? -eq 0 ]; then ok "$name"; else fail "$name" "$(printf '%s' "$out" | tail -1)"; fi
}

# --- prerequisites --------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1; }
missing=""
for t in node python3 php git cc; do
  need "$t" || missing="$missing $t"
done
if [ -n "$missing" ]; then
  echo "PREREQ MISSING:$missing"
  echo "run inside the guest: apt-get update && apt-get install -y nodejs php-cli git build-essential"
  exit 2
fi

# --- shells ---------------------------------------------------------------
check "bin-sh"    /bin/sh -c 'echo sh-alive'
check "bin-bash"  /bin/bash -c 'echo bash-alive'

# --- /usr/bin/env (an ELF exec + PATH lookup of its own) -------------------
check "env-version" env --version
check "env-python3" env python3 env_shebang.py

# --- interpreters ----------------------------------------------------------
check "node"    node hello.js
check "python3" python3 hello.py
check "php"     php hello.php
check "git"     git --version

# --- shebang scripts -------------------------------------------------------
check "shebang-sh"    ./shebang.sh
check "shebang-env"   ./env_shebang.py

# argument AFTER the interpreter name on the shebang line: /bin/sed receives
# '1d' as $1 and deletes its own shebang line, printing only the payload. If
# the argument were dropped, sed would parse the file as its program and die
# on the payload line ("unknown command") instead of printing it.
sed_script="$(mktemp /tmp/m8-sed-XXXX.sh)"
{
  echo '#!/bin/sed 1d'
  echo 'shebang-with-arg OK'
} > "$sed_script"
chmod +x "$sed_script"
out="$("$sed_script" 2>&1)"
[ "$out" = "shebang-with-arg OK" ] && ok "shebang-with-arg" || fail "shebang-with-arg" "got '$out'"
rm -f "$sed_script"

# relative-path execution from /workspace (the bind mount), not from here
check "relative-from-workspace" bash -c 'cd /workspace && ./m8-guest-test/shebang.sh'

# --- child-process chains (bash -> node -> python -> php) -------------------
check "chain-node-python" node -e 'const {execSync} = require("child_process"); execSync("python3 hello.py", {stdio: "inherit"})'
check "chain-python-php" python3 -c 'import subprocess; subprocess.run(["php", "hello.php"], check=True)'
check "backgrounded-wait" bash -c 'node hello.js >/dev/null & python3 hello.py >/dev/null & wait'

# --- exec-variant matrix (compiled in-guest with cc) -------------------------
if cc -O2 -o /tmp/m8-exec_matrix exec_matrix.c 2>/tmp/m8-cc.log; then
  out="$(/tmp/m8-exec_matrix 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    ok "exec-matrix"
    printf '%s\n' "$out" | sed 's/^/    /'
  else
    fail "exec-matrix" "$(printf '%s\n' "$out" | tail -1)"
  fi
else
  fail "exec-matrix-compile" "$(tail -1 /tmp/m8-cc.log)"
fi
rm -f /tmp/m8-exec_matrix /tmp/m8-cc.log

# --- npm (network permitting) ------------------------------------------------
if need npm; then
  scratch="$(mktemp -d /tmp/m8-npm-XXXX)"
  if (cd "$scratch" && timeout 120 npm install --no-audit --no-fund left-pad >/dev/null 2>&1); then
    cat > "$scratch/package.json" <<'EOF'
{"scripts": {"hi": "node -e \"console.log('npm-run OK')\""}}
EOF
    if (cd "$scratch" && timeout 60 npm run --silent hi); then
      ok "npm-install-run"
    else
      fail "npm-run" "npm install ok but npm run failed"
    fi
  else
    skip "npm-install-run" "(no network — permitted per §9.2)"
  fi
  rm -rf "$scratch"
else
  skip "npm-install-run" "(npm not installed)"
fi

# --- summary -----------------------------------------------------------------
echo "----"
echo "m8-guest-test: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
if [ "$FAIL" -eq 0 ]; then
  echo "m8-guest-test: ALL OK"
  exit 0
fi
exit 1
