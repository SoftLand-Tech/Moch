#!/usr/bin/env python3
"""E2E proof: the vendored Moch engine drives a real browser through the mock
WebView relay (per-page mode), then the same stack through the STOCK browser
endpoint (regression). Uses the app's own venv (every hermes dep pinned).

  Proof A (per-page / WebView mode): MOCH_BROWSER_RELAY=1 + BROWSER_CDP_URL ->
  supervisor attaches SESSIONLESS through the mock relay -> navigate, snapshot
  with refs, click by ref (state changes), type by ref, eval, back, screenshot.

  Proof B (stock): BROWSER_CDP_URL -> http://127.0.0.1:9777/<token> == stock
  browser-level attach; supervisor picks Target.getTargets path; navigate+eval
  still work (regression guard for the Moch-Browser-Level probe).
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

VENV = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python")
HERMES_SRC = os.path.expanduser("~/ai/learning/Moch/worktrees/browser-feature/app/hermes-src")
PROOF = "/tmp/moch-proof"


def wait_port(port: int, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.3)
    return False


def set_active(url: str | None):
    c = socket.create_connection(("127.0.0.1", 9335), timeout=5)
    c.sendall((url or "").encode())
    c.recv(16)
    c.close()


def launch_relay():
    """Attach to the ALREADY-RUNNING mock relay (started separately); read its token."""
    import pathlib
    assert wait_port(9334), "mock relay not up on 9334"
    log = pathlib.Path("/tmp/moch-proof/relay.log").read_text()
    for line in log.splitlines():
        if line.startswith("MOCK_RELAY_READY"):
            return None, line.strip().split("token=")[1]
    raise SystemExit("no MOCK_RELAY_READY line in relay.log")


def run_proof(name: str, env_extra: dict, expect_pagesock: bool):
    print(f"\n=== {name} ===")
    env = dict(os.environ)
    env["PYTHONPATH"] = HERMES_SRC
    env["HERMES_HOME"] = "/tmp/moch-proof/home"
    env["HOME"] = "/tmp/moch-proof/home"  # keep hermes far away from the real one
    env.setdefault("PATH", os.environ["PATH"])
    env.update(env_extra)
    os.makedirs("/tmp/moch-proof/home", exist_ok=True)

    script = r'''
import json, os, sys, time
sys.path.insert(0, os.environ["HERMES_SRC"] if "HERMES_SRC" in os.environ else "/home/mamoun/ai/learning/Moch/worktrees/browser-feature/app/hermes-src")
from tools.browser_supervisor import SUPERVISOR_REGISTRY
from tools.browser_webview import webview_navigate, webview_snapshot, webview_click, webview_type, webview_eval, webview_back, webview_screenshot

URL = "http://127.0.0.1:8088/index.html"

from tools.browser_tool_cdp import _resolve_cdp_override
cdp_ws = _resolve_cdp_override(os.environ["CDP"])
print("resolved cdp ws:", cdp_ws[:80])
sup = SUPERVISOR_REGISTRY.get_or_start(task_id="default", cdp_url=cdp_ws)
print("supervisor active:", sup.snapshot().active)
assert sup.snapshot().active, "supervisor did not attach"

r = json.loads(webview_navigate(URL))
print("navigate:", r)
assert r.get("success"), r
assert r.get("title") == "Moch Proof Page", r

time.sleep(0.3)
snap = json.loads(webview_snapshot())
print("snapshot ok:", snap.get("success"))
assert snap.get("success"), snap
text = snap.get("snapshot", "")
print(text[:400])
assert "[e" in text and "Press me" in text, "no refs in snapshot"

# click the button by ref
import re
m = re.search(r"\[(e\d+)\] button [\"â€œ]Press me[\"â€\u201d]", text)
assert m, "button ref not found"
btn = m.group(1)
c = json.loads(webview_click(btn))
print("click:", c)
assert c.get("success"), c

time.sleep(0.2)
val = json.loads(webview_eval("document.getElementById('count').textContent"))
print("after click:", val)
assert val.get("success") and "Clicked 1" in str(val.get("result")), val

# type by ref
m2 = re.search(r"\[(e\d+)\] text", text)
assert m2, "input ref not found"
box = m2.group(1)
t = json.loads(webview_type(box, "hello from the proof"))
print("type:", t)
assert t.get("success"), t
val2 = json.loads(webview_eval("document.getElementById('box').value"))
assert str(val2.get("result")) == "hello from the proof", val2

# back (to about:blank) then screenshot the proof page again
b = json.loads(webview_back())
print("back:", b)
n = json.loads(webview_navigate(URL))
print("renavigate:", n.get("url"))
s = json.loads(webview_screenshot())
print("screenshot:", s)
assert s.get("success") and s.get("path", "").endswith(".png"), s
import pathlib
assert pathlib.Path(s["path"]).stat().st_size > 1000, "screenshot too small"
print("PROOF_OK")
'''
    env["CDP"] = env_extra["BROWSER_CDP_URL"]
    result = subprocess.run([VENV, "-c", script], env=env, capture_output=True, text=True, timeout=180)
    print(result.stdout[-4000:])
    if result.returncode != 0:
        print(result.stderr[-4000:])
        raise SystemExit(f"{name} FAILED")
    assert "PROOF_OK" in result.stdout


def main():
    assert wait_port(9777), "chromium devtools port not up"
    relay_proc, token = launch_relay()
    try:
        # Proof A — per-page (WebView) mode through the mock relay
        set_active("http://127.0.0.1:8088/index.html")
        run_proof(
            "PROOF A: per-page (WebView) attach via mock relay",
            {
                "BROWSER_CDP_URL": f"http://127.0.0.1:9334/{token}",
                "MOCH_BROWSER_RELAY": "1",
            },
            expect_pagesock=True,
        )
    finally:
        pass  # relay runs independently; left up for iteration

    # Proof B — stock browser-level attach straight at Chromium (regression)
    ver = json.loads(urllib.request.urlopen("http://127.0.0.1:9777/json/version").read())
    ws = ver["webSocketDebuggerUrl"]
    run_proof(
        "PROOF B: stock browser-level attach (regression)",
        {"BROWSER_CDP_URL": ws},
        expect_pagesock=False,
    )
    print("\nALL PROOFS PASSED")


if __name__ == "__main__":
    main()
