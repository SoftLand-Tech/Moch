"""Gateway boot for Moch Desktop — mirrors the phone's embedded boot, desktop-sized.

Boot chain (see app/python-runtime/moch/gateway_server.py for the Android
twin this is adapted from, and the backend investigation report for the
upstream ``hermes serve`` path this mirrors):

1. ``prepare_home`` (boot.py) — env, paths, PYTHONPATH.
2. The dashboard-serve prepare pieces (hermes_cli/main.py
   ``_dashboard_prepare_runtime`` inlined): bundled-skills seed, terminal
   config → env bridge, plugin discovery — with MCP discovery deferred
   until after bind (``start_mcp_discovery_after_bind=True``).
3. Arm the fleet runtime: the SAME in-process pieces the phone installs
   (dispatch gate, DM bridge, kanban FleetWorker + heal ticker, spawn tool)
   so the bots/fleet/crew surfaces behave identically to the phone.
4. ``HERMES_DESKTOP=1`` arms hermes' in-process cron ticker (automations),
   ``GATEWAY_MULTIPLEX_PROFILES=true`` folds every profile onto this gateway.
5. Desktop-only RPCs (``moch.desktop.*``): browser CDP arming (the system
   Chromium managed by the Tauri side) and runtime status.
6. Neutralize the headless root token handshake (BUG-120) — GET / must not
   serve the session token to any local process.
7. ``hermes_cli.web_server.start_server`` headless on 127.0.0.1:<port>;
   readiness = the ``HERMES_BACKEND_READY port=<N>`` stdout sentinel (Tauri
   parses it) and the runtime state file.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from pathlib import Path

from . import boot as _boot

_STATE: dict = {"error": None, "ready": False, "port": None}


def _log(msg: str) -> None:
    print(f"[moch-desktop] {msg}", flush=True)


# ── desktop-only RPCs ───────────────────────────────────────────────────────

_BROWSER_STATE: dict = {"url": None}
_BROWSER_LOCK = threading.Lock()


def _arm_browser(url: str | None) -> dict:
    """Point hermes' browser tools at the app-managed Chromium (or disarm).

    Flips ``BROWSER_CDP_URL`` (the stock attach override — env wins over
    config) and reuses moch.browser_gate's catalog rebroadcast so live
    sessions pick the tools up mid-process. Desktop NEVER sets
    ``MOCH_BROWSER_RELAY`` — that routes the tools into the Android WebView
    relay, which does not exist here.
    """
    url = (url or "").strip()
    with _BROWSER_LOCK:
        changed = _BROWSER_STATE["url"] != url
        _BROWSER_STATE["url"] = url or None
    if url:
        os.environ["BROWSER_CDP_URL"] = url
    else:
        os.environ.pop("BROWSER_CDP_URL", None)
        os.environ.pop("MOCH_BROWSER_RELAY", None)
    if changed:
        try:
            from moch import browser_gate

            browser_gate._broadcast_catalog_change()
        except Exception:
            traceback.print_exc()
    return {"ok": True, "url": url or None}


def _install_desktop_rpc(tg_server) -> bool:
    methods = getattr(tg_server, "_methods", None)
    if methods is None:
        return False

    def _status(rid, params):
        stamp = {}
        try:
            stamp = json.loads((_boot.hermes_src() / "VENDOR.json").read_text(encoding="utf-8"))
        except Exception:
            pass
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "ok": True,
                "home": os.environ.get("HERMES_HOME", ""),
                "workspace": os.environ.get("MOCH_WORKSPACE", ""),
                "hermesVersion": str(stamp.get("version") or "unknown"),
                "browser": _BROWSER_STATE["url"],
                "fleet": os.environ.get("MOCH_FLEET") == "1",
                "pid": os.getpid(),
            },
        }

    def _browser_cdp(rid, params):
        url = str((params or {}).get("url") or "")
        if url and "://" not in url:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": 4000, "message": "url must be an http(s) CDP endpoint"}}
        return {"jsonrpc": "2.0", "id": rid, "result": _arm_browser(url)}

    methods.setdefault("moch.desktop.status", _status)
    methods.setdefault("moch.desktop.browser_cdp", _browser_cdp)
    return True


# ── boot chain ──────────────────────────────────────────────────────────────

def _prepare_serve_runtime() -> None:
    """The ``_dashboard_prepare_runtime`` pieces that matter headless."""
    from hermes_cli.main import _sync_bundled_skills_quietly

    _sync_bundled_skills_quietly()
    try:
        from hermes_cli.config import apply_terminal_config_to_env

        apply_terminal_config_to_env()
    except Exception:
        traceback.print_exc()
    try:
        from hermes_cli.plugins import discover_plugins

        discover_plugins()
    except Exception as exc:
        print(f"⚠ Plugin discovery failed: {exc}", file=sys.stderr, flush=True)


def _install_fleet_runtime(tg_server) -> None:
    """The phone's M9 fleet runtime, verbatim (gateway_server._run_server)."""
    os.environ.setdefault("MOCH_FLEET", "1")
    try:
        from moch import fleet as _moch_fleet

        _moch_fleet.install_dispatch_gate(tg_server)
        if _moch_fleet.fleet_enabled():
            from tools import bot_mode_dm as _bot_dm
            from moch import dm_bridge as _dm_bridge
            _dm_bridge.install_dm_bridge(_bot_dm)
            _dm_bridge.install_deliver_framing(tg_server)
            from moch import rpc_fleet as _rpc_fleet
            _rpc_fleet.install(tg_server)
            from hermes_cli import kanban_db_dispatch as _kbd
            from moch import fleet_worker as _fw
            _fleet_worker = _fw.FleetWorker()
            _fw.install_reclaim_patch(_kbd)
            _fw.install_dispatch_spawn_patch(_kbd, _fleet_worker)
            from moch import kanban_dispatch as _kd
            _kd.start_heal_ticker()
            from moch import spawn_tool as _st
            _st.install()
            _log("fleet runtime installed (bots, crew board, DM bridge, spawn tool)")
    except Exception:
        traceback.print_exc()


def _neutralize_root_token_handshake(application) -> None:
    """BUG-120: headless GET / serves window.__HERMES_SESSION_TOKEN__ — strip it.

    Verbatim from moch/gateway_server.py (the phone's fix); loopback TCP is
    reachable by every local process, so the handshake page must not exist.
    """
    shim_path = "/{full_path:path}"
    marker = "_moch_root_shim_neutralized"
    try:
        routes = application.router.routes
        matching = [
            r for r in routes
            if getattr(r, "path", None) == shim_path
            and "GET" in (getattr(r, "methods", None) or ())
        ]

        def _ours(route) -> bool:
            return bool(getattr(getattr(route, "endpoint", None), marker, False))

        if any(_ours(r) for r in matching):
            routes[:] = [r for r in routes if r not in matching or _ours(r)]
            return
        if not matching:
            return
        routes[:] = [r for r in routes if r not in matching]

        from fastapi.responses import JSONResponse

        try:
            from hermes_cli.web_server_dashboard import _HEADLESS_MSG
        except Exception:
            _HEADLESS_MSG = "Headless backend (hermes serve): web UI disabled."

        async def _no_frontend(full_path: str):
            return JSONResponse({"error": _HEADLESS_MSG}, status_code=404)

        setattr(_no_frontend, marker, True)
        application.get(shim_path)(_no_frontend)
        _log("root token handshake neutralized (BUG-120)")
    except Exception:
        traceback.print_exc()


def _run_server(port: int) -> None:
    try:
        from tui_gateway import server as _tg_server

        _prepare_serve_runtime()
        _install_fleet_runtime(_tg_server)
        _install_desktop_rpc(_tg_server)

        # Automations: the in-process cron ticker; MCP discovery defers until
        # after bind (HERMES_DESKTOP=1) so its SDK import never delays READY.
        os.environ.setdefault("HERMES_DESKTOP", "1")
        # One gateway serves every profile (bots) on this install.
        os.environ.setdefault("GATEWAY_MULTIPLEX_PROFILES", "true")

        # Import AFTER env is final: web_server resolves the session token at
        # import time (set by start() before this runs).
        from hermes_cli import web_server as _ws
        from hermes_cli.web_server import start_server

        _neutralize_root_token_handshake(_ws.app)

        _log(f"gateway serving on ws://127.0.0.1:{port}/api/ws")
        _STATE["port"] = port
        start_server(
            host="127.0.0.1",
            port=port,
            open_browser=False,
            headless=True,
            start_mcp_discovery_after_bind=True,
        )
    except BaseException:  # noqa: BLE001 — thread boundary
        _STATE["error"] = traceback.format_exc(limit=12)
        _log("gateway died:\n" + _STATE["error"])


def start(port: int) -> dict:
    """Prepare env, mint the token, and run the gateway (blocks)."""
    facts = _boot.prepare_home(_boot.default_home())
    _log(f"home={facts['home']} workspace={facts['workspace']}")

    token = _boot.load_or_mint_token(_boot.default_home())
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    os.environ.setdefault("HERMES_SERVE_HEADLESS", "1")
    _boot.write_runtime_state(port, token)

    import run_agent  # noqa: F401 — the real hermes tree (validates the import closure)

    _run_server(port)
    if _STATE["error"]:
        print(_STATE["error"], file=sys.stderr, flush=True)
        raise SystemExit(1)
    return {"port": port, "token": token}
