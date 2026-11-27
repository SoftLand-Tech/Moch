"""OpenCode as the thinker (ONBOARDING-V2) — client + guest server control.

OpenCode runs *inside the Moch Linux guest* (the only place a Linux ARM64
binary can run on this phone) and listens on guest loopback. proot shares the
phone's network namespace, so the embedded interpreter reaches it directly
over ITS OWN loopback with urllib — no guest curl/wget/apt needed, ever.

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

import base64
import json
import os
import shlex
import threading
import time
import urllib.request
import urllib.error
from typing import Any, Optional

OC_PORT = 4096
OC_USER = "opencode"

# Launch hygiene (device report): ensure_server used to type a fresh
# `opencode serve` line — password included — into the user's visible
# terminal on EVERY call, even while a launch was already in flight. The
# Terminal screen filled with repeated commands and job numbers. Serialize
# launches and give a just-typed launch time to come up before typing another.
_LAUNCH_COOLDOWN_S = 15.0
_launch_lock = threading.Lock()
_last_launch_at = 0.0


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
    headers: Optional[dict[str, str]] = None,
) -> dict:
    """One HTTP call to the guest server, made IN THIS PROCESS (urllib).

    The embedded interpreter shares the phone's loopback with the proot guest,
    so 127.0.0.1 reaches the guest's `opencode serve` directly. This used to
    shell `curl` inside the guest — a fresh rootfs has no curl, and the call
    never needed the guest shell at all.
    """
    url = f"http://127.0.0.1:{OC_PORT}{path}"
    payload = json.dumps(body).encode() if body is not None else None
    creds = base64.b64encode(f"{OC_USER}:{password}".encode()).decode()
    req_headers = {"Authorization": f"Basic {creds}", "Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers=req_headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as res:
            code = res.status
            raw = res.read()
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            raw = e.read()
        except Exception:
            raw = b""
    except Exception as e:
        return {"ok": False, "status": 0, "data": None, "stderr": f"{type(e).__name__}: {e}"}
    try:
        data = json.loads(raw.decode() or "null") if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        data = raw.decode(errors="replace") if raw else None
    return {"ok": 200 <= code < 300, "status": code, "data": data, "stderr": ""}


def _guest_alive(password: str) -> bool:
    info = _curl("GET", "/api/info", password=password, timeout_s=10)
    return bool(info.get("ok"))


def _start_browser_stack() -> dict:
    """BUG-148: lazily start the host-side browser MCP adapter and seed the
    guest's opencode.json with the moch-browser entry. Best-effort — an oc
    chat must keep working when the relay is down, the guest lacks the
    config dir, or anything here throws. Lives on the ensure path because
    that is ONLY invoked from oc surfaces (turn runner, drawer list, model
    sheet): hermes-only users never start the adapter thread.
    """
    try:
        from moch import oc_browser_mcp

        started = oc_browser_mcp.ensure_started()
        if started.get("ok") and started.get("port"):
            started["seed"] = oc_browser_mcp.seed_opencode_config(int(started["port"]))
        return {"browser_mcp": started}
    except Exception as e:  # noqa: BLE001 — never break the oc ensure for this
        return {"browser_mcp": {"ok": False, "error": f"{type(e).__name__}: {e}"}}


def _type_hidden_launch(password: str) -> bool:
    """Type the guest launch into the user's PTY without leaving it visible.

    Echo is disabled before the command line, the shell's own stderr is muted
    while it prints the background job line, and both are restored after. The
    command starts with a space and HISTCONTROL=ignorespace keeps the secret
    out of bash history. Returns False only when the launch line itself could
    not be written (the restore still runs).
    """
    from moch import terminal as mterm

    def _write(text: str) -> bool:
        try:
            return bool(mterm.write(base64.b64encode(text.encode()).decode("ascii")).get("ok"))
        except Exception:  # noqa: BLE001 — the caller reports the failure
            return False

    try:
        if not _write(" export HISTCONTROL=ignorespace; stty -echo\n"):
            return False
        time.sleep(0.2)
        cmd = (
            " exec 2>/dev/null; cd /workspace && "
            f"export OPENCODE_PASSWORD={shlex.quote(password)} && "
            f"opencode serve --hostname 127.0.0.1 --port {OC_PORT} "
            ">/root/opencode.log 2>&1 & exec 2>&1\n"
        )
        wrote = _write(cmd)
        time.sleep(0.2)
        return wrote
    finally:
        # Never leave the user's shell with echo disabled.
        _write(" stty echo\n")


def ensure_server(password: str, launch: bool = True) -> dict:
    """Start the guest server if it is not answering; idempotent.

    launch=False: HEALTH-WAIT ONLY — the RN side has already typed the
    launch line into the terminal session through the bridge (the one
    launch context proven on-device to keep the server alive; every
    python-thread launch — the mterm injection below, the pty variants,
    and the old `guestRun` nohup launch that onboarding used to call
    directly — futex-aborts ~30 s in). Killing the terminal session kills
    the server; this idempotent check re-launches on the next call.
    """
    if _guest_alive(password):
        return {"ok": True, "started": False, **_start_browser_stack()}
    # Double-check the binary exists so the error is honest rather than a
    # silent 30 s wait.
    which = _guest_exec("command -v opencode || true", timeout_s=15)
    if not (which.get("stdout") or "").strip():
        return {"ok": False, "error": "OpenCode is not installed in the Linux guest — switch to OpenCode in Settings to install it."}
    if launch:
        # BUG-148: start the adapter + seed the oc MCP config BEFORE typing
        # the launch line — opencode reads its config at startup, so a seed
        # typed first is picked up by THIS boot. (The health-wait-only path
        # below seeds after the fact instead: the RN side typed the launch
        # already, so that config lands on the next boot — one boot of lag
        # on a cold first oc use, no clobber risk.)
        _browser = _start_browser_stack()
        from moch import terminal as mterm

        global _last_launch_at
        with _launch_lock:
            if not mterm.is_running():
                boot = mterm.start()
                if not boot.get("ok"):
                    return {"ok": False, "error": (boot.get("error") or "the terminal session could not start").strip()}
            now = time.monotonic()
            if now - _last_launch_at < _LAUNCH_COOLDOWN_S:
                # A launch was typed moments ago — let it come up instead of
                # stacking another command (and another server) on top.
                print("[moch-opencode] launch cooldown — waiting for the in-flight server start", flush=True)
            else:
                _last_launch_at = now
                if not _type_hidden_launch(password):
                    return {"ok": False, "error": "could not type the launch command into the terminal"}
    else:
        _browser = {}
    deadline = time.time() + 45
    while time.time() < deadline:
        if _guest_alive(password):
            if not _browser:
                _browser = _start_browser_stack()
            return {"ok": True, "started": True, **_browser}
        time.sleep(1.5)
    tail = _guest_exec("tail -20 /root/opencode.log 2>/dev/null || true", timeout_s=15)
    return {"ok": False, "error": "OpenCode did not answer on 127.0.0.1:%d" % OC_PORT,
            "log": (tail.get("stdout") or "")[-1500:]}


def stop_server() -> dict:
    out = _guest_exec("pkill -f '[o]pencode serve' >/dev/null 2>&1 || true", timeout_s=20)
    # The terminal session belongs to the user — never touched here.
    return {"ok": True, "detail": (out.get("stdout") or "").strip()}


def install_opencode() -> dict:
    """The install happens phone-side now (RN downloads the tarball straight
    into the rootfs — a fresh guest has no curl). This RPC stays registered
    only to say so honestly instead of failing in the guest."""
    return {
        "ok": False,
        "error": "Install OpenCode from the app (Settings or Onboarding → Thinker) — the download runs on the phone, not in the guest.",
    }


# ── chat surface ─────────────────────────────────────────────────────────────


def _location_headers(directory: str) -> dict[str, str]:
    # Legacy servers read ?directory=; newer servers select the request
    # location from x-opencode-directory. Sending both is backward-compatible.
    from urllib.parse import quote
    return {"X-Opencode-Directory": quote(directory, safe="")}


def _with_directory(path: str, directory: str) -> str:
    if not directory:
        return path
    value = _q(directory)
    return path + "?directory=" + value + "&location%5Bdirectory%5D=" + value


def create_session(password: str, title: str, directory: str = "") -> dict:
    body: dict[str, Any] = {"title": title}
    if directory:
        body["location"] = {"directory": directory}
    res = _curl("POST", "/api/session", password=password, body=body, timeout_s=30)
    if directory and not res.get("ok") and res.get("status") in (400, 422):
        return _curl(
            "POST", _with_directory("/api/session", directory), password=password,
            body={"title": title}, timeout_s=30,
            headers=_location_headers(directory),
        )
    return res


def send_prompt(password: str, session_id: str, text: str, *, directory: str = "") -> dict:
    body: dict[str, Any] = {"text": text}
    return _curl(
        "POST", _with_directory(f"/api/session/{session_id}/prompt", directory),
        password=password, body=body, timeout_s=120,
        headers=_location_headers(directory) if directory else None,
    )


def interrupt(password: str, session_id: str) -> dict:
    return _curl("POST", f"/api/session/{session_id}/interrupt", password=password, timeout_s=30)


def reply_permission(password: str, session_id: str, request_id: str, reply: str) -> dict:
    if reply not in ("once", "always", "reject"):
        return {"ok": False, "status": 400, "data": {"error": "reply must be once|always|reject"}}
    return _curl(
        "POST",
        f"/api/session/{session_id}/permission/{request_id}/reply",
        password=password,
        body={"reply": reply},
        timeout_s=30,
    )


def history(password: str, session_id: str) -> dict:
    return _curl("GET", f"/api/session/{session_id}/message", password=password, timeout_s=60)


def models(password: str) -> dict:
    return _curl("GET", "/api/model", password=password, timeout_s=60)


def pending_permissions(password: str) -> dict:
    return _curl("GET", "/api/permission/request", password=password, timeout_s=30)


def default_model(password: str) -> dict:
    return _curl("GET", "/api/model/default", password=password, timeout_s=30)


def switch_model(password: str, session_id: str, provider_id: str, model_id: str) -> dict:
    return _curl(
        "POST",
        f"/api/session/{session_id}/model",
        password=password,
        body={"model": {"providerID": provider_id, "modelID": model_id}},
        timeout_s=30,
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
        launch = params.get("launch", True)
        return _ok(rid, ensure_server(pw, launch=bool(launch)))

    def oc_stop(rid, params):
        return _ok(rid, stop_server())

    def oc_status(rid, params):
        pw = _password(params)
        return _ok(rid, {"alive": bool(pw) and _guest_alive(pw), "port": OC_PORT})

    def oc_session_create(rid, params):
        pw = _password(params)
        if not pw:
            return _err(rid, 4061, "password required")
        # BUG-149: optional project cwd — forwarded as the query param the
        # oc server expects (see create_session).
        return _ok(rid, create_session(
            pw,
            str(params.get("title") or "Moch"),
            directory=str(params.get("directory") or ""),
        ))

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
