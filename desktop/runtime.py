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
import shutil
import signal
import subprocess
import sys
import time
import urllib.request


def _on_sigterm(_signum, _frame):
    # The Rust supervisor SIGTERMs us on exit — leave quietly instead of
    # unwinding with a traceback. Take the agent browser with us.
    _stop_browser()
    sys.exit(0)


signal.signal(signal.SIGTERM, _on_sigterm)

FORK = os.environ.get("MOCH_FORK_SRC", "")
RUNTIME_PKGS = os.environ.get("MOCH_RUNTIME_PKGS", "")
for p in (FORK, RUNTIME_PKGS):
    if p and p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("MOCH_FLEET", "1")
os.environ.setdefault("HERMES_DESKTOP", "1")

# Agent browser: a Moch-owned Chromium with a CDP debug port, spawned
# before the gateway so the tool-catalog memo (model_tools.py:278-285)
# sees BROWSER_CDP_URL. The agent tool layer does NOT auto-discover CDP —
# it reads exactly this env var (tools/browser_tool_cdp.py:51-60).
_browser_proc = None


def _stop_browser():
    global _browser_proc
    if _browser_proc is not None:
        try:
            _browser_proc.terminate()
            _browser_proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                _browser_proc.kill()
            except Exception:  # noqa: BLE001
                pass
        _browser_proc = None


def _spawn_browser():
    """Spawn chromium with --remote-debugging-port and publish BROWSER_CDP_URL.

    Same flag set the repo's own launcher uses (hermes_cli/browser_connect.py:
    764-766); readiness = 2xx from GET /json/version (:777-800). A Moch-owned
    --user-data-dir is mandatory: Chromium >=136 refuses CDP on the default
    profile (:315-317) and a same-profile singleton silently absorbs the
    launch (:898-904). Returns the listening port or None."""
    global _browser_proc
    if os.environ.get("MOCH_BROWSER", "1") != "1":
        return None
    exe = None
    for name in ("chromium", "chromium-browser", "google-chrome",
                 "google-chrome-stable"):
        exe = shutil.which(name)
        if exe:
            break
    if not exe:
        print("agent browser: no chromium/chrome on PATH — skipping",
              file=sys.stderr, flush=True)
        return None
    home = os.environ.get("HERMES_HOME", "")
    profile = os.path.join(home, "browser", "chrome-profile")
    os.makedirs(profile, exist_ok=True)
    preferred = int(os.environ.get("MOCH_BROWSER_PORT", "9222"))
    for port in range(preferred, preferred + 10):
        try:
            _browser_proc = subprocess.Popen(
                [exe,
                 f"--remote-debugging-port={port}",
                 f"--user-data-dir={profile}",
                 "--no-first-run",
                 "--no-default-browser-check"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True)
        except Exception as e:  # noqa: BLE001
            print(f"agent browser spawn failed: {e}", file=sys.stderr,
                  flush=True)
            return None
        url = f"http://127.0.0.1:{port}/json/version"
        for _ in range(30):  # 15s readiness window
            time.sleep(0.5)
            if _browser_proc.poll() is not None:
                break  # died/singleton-absorbed — try the next port
            try:
                with urllib.request.urlopen(url, timeout=1) as r:  # noqa: S310
                    if 200 <= r.status < 300:
                        os.environ["BROWSER_CDP_URL"] = (
                            f"http://127.0.0.1:{port}")
                        # loopback probes must not ride a system proxy
                        os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
                        print(f"agent browser: {exe} ready on :{port}",
                              flush=True)
                        return port
            except Exception:  # noqa: BLE001
                continue
        _stop_browser()  # never came up on this port — try the next one
    print("agent browser: no free debug port "
          f"({preferred}..{preferred + 9})", file=sys.stderr, flush=True)
    return None


from moch import gateway_server  # noqa: E402

PORT = int(os.environ.get("MOCH_GATEWAY_PORT", "9118"))

BROWSER_PORT = _spawn_browser()

info = gateway_server.start(port=PORT)
if BROWSER_PORT:
    info = dict(info)
    info["browser_port"] = BROWSER_PORT
print("MOCH_GATEWAY_INFO " + json.dumps(info), flush=True)

# File-based handshake for the Rust shell — immune to pipe buffering.
# chmod 0600 immediately after writing: the file carries the live session
# token, and a umask-default 0644 exposes it to every local user.
info_path = os.path.join(os.environ.get("HERMES_HOME", ""), ".moch-gateway.json")
try:
    with open(info_path, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.chmod(info_path, 0o600)
except Exception as e:  # noqa: BLE001
    print(f"gateway info file write failed: {e}", file=sys.stderr, flush=True)

# Keep the process alive; the gateway runs on a daemon thread and its own
# supervisor retries transient boot failures inside start().
while True:
    time.sleep(60)
