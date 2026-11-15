"""OpenCode as the thinker (ONBOARDING-V2) — client + guest server control.

OpenCode runs *inside the Moch Linux guest* (the only place a Linux ARM64
binary can run on this phone) and listens on guest loopback. The app reaches it
through the same proot bridge the terminal uses: `linuxExec` runs a command in
the guest, so a small `curl`-based client is enough and no extra port has to be
exposed.

The chat contract is OpenCode's HTTP API (verified against 2.3.0 on the box):
  POST /api/session                     -> {data:{id}}
  POST /api/session/:id/prompt {text}   -> user message (async; stream via SSE)
  GET  /api/event                       -> SSE (session.text.delta, …)
  GET  /api/session/:id/message         -> history
  POST /api/session/:id/interrupt       -> stop
  POST /api/session/:id/permission/:rid/reply {reply: once|always|reject}
  POST /api/session/:id/model {model:{providerID,modelID}}
Auth is HTTP Basic (user `opencode`, password from OPENCODE_PASSWORD).

Everything here is intentionally thin and JSON-in/JSON-out so the RN side can
parse it without a half-ported SDK.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from typing import Any, Optional

OC_PORT = 4096
OC_USER = "opencode"


def _guest_exec(command: str, timeout_s: int = 60) -> dict:
    from moch import linux_env

    return linux_env.exec_in_guest(command, timeout_s=timeout_s)


def _curl(
    method: str,
    path: str,
    *,
    password: str,
    body: Optional[dict] = None,
    timeout_s: int = 30,
    max_time_s: int = 30,
) -> dict:
    """One HTTP call from INSIDE the guest (so 127.0.0.1 is the guest's own)."""
    url = f"http://127.0.0.1:{OC_PORT}{path}"
    parts = [
        "curl", "-sS", "--max-time", str(max_time_s),
        "-u", f"{OC_USER}:{password}",
        "-H", "Content-Type: application/json",
        "-X", method,
    ]
    if body is not None:
        parts += ["--data-binary", json.dumps(body)]
    parts.append(url)
    cmd = " ".join(shlex.quote(p) for p in parts)
    # curl exit 22 = HTTP >=400; keep the body for the typed error.
    cmd += " -w '\\n%{http_code}'"
    out = _guest_exec(cmd, timeout_s=timeout_s)
    stdout = (out.get("stdout") or "").rstrip("\n")
    stderr = out.get("stderr") or ""
    code = 0
    payload = stdout
    if "\n" in stdout:
        payload, _, last = stdout.rpartition("\n")
        try:
            code = int(last.strip())
        except ValueError:
            code = 0
    try:
        data = json.loads(payload) if payload.strip() else None
    except json.JSONDecodeError:
        data = payload
    return {"ok": 200 <= code < 300, "status": code, "data": data, "stderr": stderr}


def _guest_alive(password: str) -> bool:
    info = _curl("GET", "/api/info", password=password, timeout_s=10, max_time_s=10)
    return bool(info.get("ok"))


def ensure_server(password: str) -> dict:
    """Start the guest server if it is not answering; idempotent."""
    if _guest_alive(password):
        return {"ok": True, "started": False}
    # Double-check the binary exists so the error is honest rather than a
    # silent 30 s wait.
    which = _guest_exec("command -v opencode || true", timeout_s=15)
    if not (which.get("stdout") or "").strip():
        return {"ok": False, "error": "OpenCode is not installed in the Linux guest — install it in Onboarding → Environment."}
    start = _guest_exec(
        "sh -lc " + shlex.quote(
            f'cd /root && OPENCODE_PASSWORD={shlex.quote(password)} nohup opencode serve '
            f'--hostname 127.0.0.1 --port {OC_PORT} >/root/opencode.log 2>&1 & echo $!'
        ),
        timeout_s=20,
    )
    if not start.get("ok") and "nohup" not in (start.get("stderr") or ""):
        return {"ok": False, "error": (start.get("stderr") or start.get("error") or "could not start opencode").strip()}
    deadline = time.time() + 45
    while time.time() < deadline:
        if _guest_alive(password):
            return {"ok": True, "started": True, "pid": (start.get("stdout") or "").strip()}
        time.sleep(1.5)
    tail = _guest_exec("tail -20 /root/opencode.log 2>/dev/null || true", timeout_s=15)
    return {"ok": False, "error": "OpenCode did not answer on 127.0.0.1:%d" % OC_PORT,
            "log": (tail.get("stdout") or "")[-1500:]}


def stop_server() -> dict:
    out = _guest_exec('pkill -f "opencode serve" >/dev/null 2>&1 || true', timeout_s=20)
    return {"ok": True, "detail": (out.get("stdout") or "").strip()}


def install_opencode() -> dict:
    """Install the official Linux ARM64 build in the guest (one static binary)."""
    cmd = (
        "set -e; mkdir -p /usr/local/bin; "
        "curl -fsSL https://opencode.ai/update/api/latest/cli/opencode/opencode-linux-arm64.tar.gz "
        "-o /tmp/opencode.tgz; "
        "tar xzf /tmp/opencode.tgz -C /usr/local/bin opencode; "
        "chmod +x /usr/local/bin/opencode; opencode --version"
    )
    out = _guest_exec(cmd, timeout_s=240)
    return {
        "ok": bool(out.get("ok")),
        "version": (out.get("stdout") or "").strip().splitlines()[-1] if out.get("stdout") else "",
        "stderr": (out.get("stderr") or "")[-800:],
    }


# ── chat surface ─────────────────────────────────────────────────────────────


def create_session(password: str, title: str) -> dict:
    return _curl("POST", "/api/session", password=password, body={"title": title}, max_time_s=30)


def send_prompt(password: str, session_id: str, text: str, *, directory: str = "") -> dict:
    body: dict[str, Any] = {"text": text}
    path = f"/api/session/{session_id}/prompt"
    if directory:
        path += "?directory=" + _q(directory)
    return _curl("POST", path, password=password, body=body, max_time_s=120)


def interrupt(password: str, session_id: str) -> dict:
    return _curl("POST", f"/api/session/{session_id}/interrupt", password=password, max_time_s=30)


def reply_permission(password: str, session_id: str, request_id: str, reply: str) -> dict:
    if reply not in ("once", "always", "reject"):
        return {"ok": False, "status": 400, "data": {"error": "reply must be once|always|reject"}}
    return _curl(
        "POST",
        f"/api/session/{session_id}/permission/{request_id}/reply",
        password=password,
        body={"reply": reply},
        max_time_s=30,
    )


def history(password: str, session_id: str) -> dict:
    return _curl("GET", f"/api/session/{session_id}/message", password=password, max_time_s=60)


def models(password: str) -> dict:
    return _curl("GET", "/api/model", password=password, max_time_s=60)


def pending_permissions(password: str) -> dict:
    return _curl("GET", "/api/permission/request", password=password, max_time_s=30)


def default_model(password: str) -> dict:
    return _curl("GET", "/api/model/default", password=password, max_time_s=30)


def switch_model(password: str, session_id: str, provider_id: str, model_id: str) -> dict:
    return _curl(
        "POST",
        f"/api/session/{session_id}/model",
        password=password,
        body={"model": {"providerID": provider_id, "modelID": model_id}},
        max_time_s=30,
    )


def _q(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


# ── RPC layer (moch.opencode.*) ─────────────────────────────────────────────


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _err(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _password(params) -> str:
    return str(params.get("password") or os.environ.get("MOCH_OPENCODE_PASSWORD") or "").strip()


_REGISTERED = False


def install(tg_server) -> bool:
    """Register `moch.opencode.*` on the embedded gateway (flag-free, local only)."""
    global _REGISTERED
    if _REGISTERED:
        return True
    methods = getattr(tg_server, "_methods", None)
    if methods is None:
        return False

    def oc_install(rid, params):
        return _ok(rid, install_opencode())

    def oc_ensure(rid, params):
        pw = _password(params)
        if not pw:
            return _err(rid, 4061, "password required")
        return _ok(rid, ensure_server(pw))

    def oc_stop(rid, params):
        return _ok(rid, stop_server())

    def oc_status(rid, params):
        pw = _password(params)
        return _ok(rid, {"alive": bool(pw) and _guest_alive(pw), "port": OC_PORT})

    def oc_session_create(rid, params):
        pw = _password(params)
        if not pw:
            return _err(rid, 4061, "password required")
        return _ok(rid, create_session(pw, str(params.get("title") or "Moch")))

    def oc_prompt(rid, params):
        pw = _password(params)
        sid = str(params.get("session_id") or "")
        text = str(params.get("text") or "")
        if not pw or not sid or not text:
            return _err(rid, 4061, "password, session_id and text required")
        return _ok(rid, send_prompt(pw, sid, text, directory=str(params.get("directory") or "")))

    def oc_interrupt(rid, params):
        return _ok(rid, interrupt(_password(params), str(params.get("session_id") or "")))

    def oc_history(rid, params):
        return _ok(rid, history(_password(params), str(params.get("session_id") or "")))

    def oc_models(rid, params):
        return _ok(rid, models(_password(params)))

    def oc_permission(rid, params):
        return _ok(rid, reply_permission(
            _password(params),
            str(params.get("session_id") or ""),
            str(params.get("request_id") or ""),
            str(params.get("reply") or "once"),
        ))

    for name, fn in {
        "moch.opencode.install": oc_install,
        "moch.opencode.ensure": oc_ensure,
        "moch.opencode.stop": oc_stop,
        "moch.opencode.status": oc_status,
        "moch.opencode.session": oc_session_create,
        "moch.opencode.prompt": oc_prompt,
        "moch.opencode.interrupt": oc_interrupt,
        "moch.opencode.history": oc_history,
        "moch.opencode.models": oc_models,
        "moch.opencode.permissions": lambda rid, params: _ok(rid, pending_permissions(_password(params))),
        "moch.opencode.permission": oc_permission,
    }.items():
        methods.setdefault(name, fn)
    _REGISTERED = True
    return True
