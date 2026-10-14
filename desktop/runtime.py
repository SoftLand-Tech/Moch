"""Moch Desktop runtime runner.

Runs the SAME embedded gateway the phone app runs
(app/python-runtime/moch/gateway_server.py) as a supervised child process:

  - MOCH_FLEET=1 (BUG-109: without it moch.fleet.status / moch.kanban.tasks /
    moch.profiles.delete answer "unknown method" — the bots/crew surface
    literally does not install)
  - in-process slash worker, fleet admission gate, dm bridge
  - HERMES_DESKTOP=1 (cron ticker for automations)
  - headless serve via hermes_cli.web_server (no cli.py interactive checks,
    so a fresh provider-less home still boots — setup happens over RPC)

Emits one machine-readable line for the Rust shell:
  MOCH_GATEWAY_INFO {"port": ..., "token": ..., ...}
then blocks forever (the gateway runs on a daemon thread).
"""
import json
import os
import sys
import time

FORK = os.environ.get("MOCH_FORK_SRC", "")
RUNTIME_PKGS = os.environ.get("MOCH_RUNTIME_PKGS", "")
for p in (FORK, RUNTIME_PKGS):
    if p and p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("MOCH_FLEET", "1")
os.environ.setdefault("HERMES_DESKTOP", "1")

from moch import gateway_server  # noqa: E402

PORT = int(os.environ.get("MOCH_GATEWAY_PORT", "9118"))

info = gateway_server.start(port=PORT)
print("MOCH_GATEWAY_INFO " + json.dumps(info), flush=True)

# File-based handshake for the Rust shell — immune to pipe buffering.
try:
    with open(os.path.join(os.environ.get("HERMES_HOME", ""), ".moch-gateway.json"), "w", encoding="utf-8") as f:
        json.dump(info, f)
except Exception as e:  # noqa: BLE001
    print(f"gateway info file write failed: {e}", file=sys.stderr, flush=True)

# Keep the process alive; the gateway runs on a daemon thread and its own
# supervisor retries transient boot failures inside start().
while True:
    time.sleep(60)
