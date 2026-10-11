"""Milestone 3: run hermes' serve gateway in-process, bound to loopback.

The phone app already speaks hermes' v7 JSON-RPC gateway protocol
(``/api/ws``) over a WebSocket — against the relay today. This module runs
the SAME server the relay fronts (``hermes_cli.web_server.start_server``,
headless serve mode) inside the app process on 127.0.0.1, so the RN client
connects with ``ws://127.0.0.1:<port>/api/ws?token=<token>`` and every
existing screen — chat, sessions, model/provider setup (``model.save_key``)
— works unchanged.

Auth: we mint the session token ourselves and export it as
``HERMES_DASHBOARD_SESSION_TOKEN`` BEFORE importing ``web_server`` (the
module resolves it at import time; this is exactly how the desktop shell
boots serve). Loopback bind keeps hermes' auth gate in loopback mode.

Lifecycle: ``start_server`` blocks (it drives uvicorn directly), so it runs
on a dedicated daemon thread; readiness = the TCP port accepting (uvicorn
binds only after its lifespan startup completed). stop/restart is deferred
to Milestone 6 (foreground-service lifecycle) — see MILESTONE-3.md.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import threading
import time
import traceback
from typing import Any

_STATE: dict[str, Any] = {"started": False, "starting": False, "port": None, "token": None, "error": None}
_LOCK = threading.Lock()
_READY_TIMEOUT_S = 90.0  # first boot extracts/compiles; phone storage is slow


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _port_accepts(port: int, timeout_s: float = 0.25) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _load_or_mint_token() -> str:
    """Stable per-install gateway token: `<hermes home>/.moch-gateway-token`.

    The RN client saves host+token once when pairing "This phone" and
    auto-reconnects on later launches — a per-boot token would break that
    (stable token + fixed port mirrors how the desktop shell pins its
    loopback backend). App-private storage, 0600.
    """
    from moch import hermes_boot

    token_file = hermes_boot._hermes_home() / ".moch-gateway-token"
    try:
        token = token_file.read_text(encoding="utf-8").strip()
        if token:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(token_file, 0o600)
    except OSError:
        pass
    return token


def _run_server(port: int) -> None:
    try:
        # Automations/slash commands: hermes spawns a child interpreter for
        # these; on Android that VM cannot boot (dalvik-cache permission),
        # so run the same worker logic in-process instead.
        from tui_gateway import server as _tg_server
        from moch.slash_worker_bridge import InProcessSlashWorker

        _tg_server._SlashWorker = InProcessSlashWorker

        # M9 fleet runtime (flag-gated): installs the chat-path admission gate
        # (freeze / budget / FleetTurnQueue) and swaps bot_mode_dm's subprocess
        # CLI turn for the in-process dm_bridge — only when MOCH_FLEET=1 (or
        # MOCH_EMBEDDED=1, the §6 transport-selection flag). No-op and zero
        # behavior change otherwise. Must never break boot.
        try:
            from moch import fleet as _moch_fleet
            _moch_fleet.install_dispatch_gate(_tg_server)
            if _moch_fleet.fleet_enabled():
                from tools import bot_mode_dm as _bot_dm
                from moch import dm_bridge as _dm_bridge
                _dm_bridge.install_dm_bridge(_bot_dm)
                _dm_bridge.install_deliver_framing(_tg_server)
                from moch import rpc_fleet as _rpc_fleet
                _rpc_fleet.install(_tg_server)
                # M9.1b: in-process kanban worker (FleetWorker) replaces the
                # Popen spawn; reclaim learns to ignore synthetic pids.
                from hermes_cli import kanban_db_dispatch as _kbd
                from moch import fleet_worker as _fw
                _fleet_worker = _fw.FleetWorker()
                _fw.install_reclaim_patch(_kbd)
                _fw.install_dispatch_spawn_patch(_kbd, _fleet_worker)
        except Exception:
            traceback.print_exc()

        # hermes' in-process cron ticker (scheduled automations) only arms
        # under HERMES_DESKTOP=1 — the embedded serve process is exactly the
        # desktop-shell situation (a serve backend with no external
        # gateway to tick the store). Verified: without it, jobs.json is
        # never touched and scheduled jobs never fire.
        os.environ.setdefault("HERMES_DESKTOP", "1")
        from hermes_cli.web_server import start_server

        start_server(host="127.0.0.1", port=port, open_browser=False, headless=True)
    except BaseException:  # noqa: BLE001 — thread boundary; recorded in state
        _STATE["error"] = traceback.format_exc(limit=12)


def start(port: int = 0) -> dict:
    """Boot hermes (idempotent) and the gateway; returns connection info."""
    from moch import hermes_boot

    boot = hermes_boot.boot()
    if not boot.get("ok"):
        _STATE["error"] = "hermes boot failed: " + "; ".join(boot.get("errors") or ["unknown"])
        return info()

    if not port:
        port = 9119  # stable across launches so the saved client config holds

    # Must precede the web_server import: module-level resolution.
    token = _load_or_mint_token()
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    os.environ.setdefault("HERMES_SERVE_HEADLESS", "1")

    _STATE["port"] = port
    _STATE["token"] = token

    threading.Thread(
        target=_run_server,
        args=(port,),
        name="moch-hermes-gateway",
        daemon=True,
    ).start()

    waited = 0.0
    while waited < _READY_TIMEOUT_S:
        if _STATE["error"]:
            with _LOCK:
                _STATE["starting"] = False
            return info()
        if _port_accepts(port):
            with _LOCK:
                _STATE["starting"] = False
                _STATE["started"] = True
            return info()
        time.sleep(0.25)
        waited += 0.25

    with _LOCK:
        _STATE["starting"] = False
        if _STATE["error"] is None:
            _STATE["error"] = f"gateway not ready after {_READY_TIMEOUT_S:.0f}s"
    return info()


def info() -> dict:
    """Current gateway state for the bridge. Never raises."""
    started = bool(_STATE["started"])
    port = _STATE["port"]
    return {
        "running": started or bool(_STATE["starting"]),
        "ready": started and port is not None and _port_accepts(port),
        "port": port,
        "token": _STATE["token"],
        "workspace": os.environ.get("MOCH_WORKSPACE"),
        "error": _STATE["error"],
    }


def info_json() -> str:
    """JSON snapshot for the RN bridge (JNI-simple string contract)."""
    return json.dumps(info())