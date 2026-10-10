import json, os, sys, time
sys.path.insert(0, "/home/mamoun/ai/learning/Moch/worktrees/browser-feature/app/hermes-src")
os.environ["HERMES_HOME"] = "/tmp/moch-proof/home"
log = open("/tmp/moch-proof/relay.log").read()
token = [l for l in log.splitlines() if l.startswith("MOCK_RELAY_READY")][0].split("token=")[1]

from tools.browser_supervisor import SUPERVISOR_REGISTRY
from tools.browser_tool_cdp import _resolve_cdp_override

cdp = _resolve_cdp_override(f"http://127.0.0.1:9334/{token}")
print("cdp:", cdp)
sup = SUPERVISOR_REGISTRY.get_or_start(task_id="dbg", cdp_url=cdp)
print("active:", sup.snapshot().active)

r = sup.evaluate_runtime("location.href + ' | ' + document.title")
print("href probe:", r)

from tools.browser_webview import _JS_INTERACTIVE, _call
try:
    res = _call(sup, "Runtime.evaluate", {"expression": _JS_INTERACTIVE, "returnByValue": True})
    print("iife result keys:", list(res.keys()))
    print("iife result:", str(res.get("result"))[:200])
    print("iife value:", str(res.get("value"))[:200])
except Exception as e:
    print("iife failed:", e)
