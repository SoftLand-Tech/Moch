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

        # BUG-109: ARM the fleet runtime for the embedded install. Every moch/
        # fleet module (fleet.py, fleet_worker.py, dm_bridge.py) and the install
        # block below gate on MOCH_FLEET=1 / MOCH_EMBEDDED=1, and NOTHING in the
        # app ever set either one — so on device the M9.2/M9.4 UI shipped over a
        # runtime that was never installed: `moch.fleet.status`,
        # `moch.fleet.freeze`, `moch.kanban.tasks`, `moch.runs.timeline` and
        # `moch.profiles.delete` all answered -32601 "unknown method", the Crew
        # board pinned a raw "run hermes update" banner, Freeze was a silent
        # no-op and bots could not be deleted (verified on 1.0.15-browser).
        #
        # This process IS the embedded gateway (on-device Chaquopy), so it sets
        # the flag itself — the "set by the embedded gateway boot on
        # fleet-capable installs" contract fleet.py documents. `setdefault` keeps
        # an explicit operator/desktop override authoritative, and the emission
        # stays ahead of the install block so the flag sees it.
        #
        # Fail-safe by construction: the M9.1a admission gate is a no-op for
        # ordinary chat (nothing frozen; budget limits default to 0 = unlimited
        # in fleet.BudgetLedger.check), and the whole install is try/except'd.
        os.environ.setdefault("MOCH_FLEET", "1")

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
                # BUG-138: nothing in this process dispatches (upstream's
                # dispatcher watcher is a messaging-gateway mixin) — arm the
                # poke+heal ticker so app-created tasks run and stale claims
                # reclaim. Idempotent, flag-gated, daemon.
                from moch import kanban_dispatch as _kd
                _kd.start_heal_ticker()
                # BUG-137 (M9.1a stage 3): register the spawn_bot tool onto
                # the delegation toolset — bots can finally create their own
                # helpers. Boot-time (pre-start_server) so every session's
                # tool snapshot includes it; flag-gated, idempotent.
                from moch import spawn_tool as _st
                _st.install()
        except Exception:
            traceback.print_exc()

        # hermes' in-process cron ticker (scheduled automations) only arms
        # under HERMES_DESKTOP=1 — the embedded serve process is exactly the
        # desktop-shell situation (a serve backend with no external
        # gateway to tick the store). Verified: without it, jobs.json is
        # never touched and scheduled jobs never fire.
        os.environ.setdefault("HERMES_DESKTOP", "1")
        # BUG-132 belt-and-braces: the native relay start (AgentBrowserHost)
        # races this boot — if it landed after hermes_boot's arm check, the
        # gateway would serve sessions an un-armed (browser-less) catalog for
        # the whole process. Re-check the pid-gated relay.json one last time
        # before the first request can arrive.
        try:
            from pathlib import Path as _Path

            from moch.hermes_boot import _arm_browser_gate_from_relay_file

            _arm_browser_gate_from_relay_file(_Path(os.environ["HERMES_HOME"]))
        except Exception:
            pass

        # BUG-132 (warm-up window): the first minutes after a cold boot resolve
        # a MINIMAL kit (device-measured: 6 tools at T+60s vs 21 with all ten
        # browser_* at T+5min, same build) — the tool registry matures late.
        # Sessions built in the window snapshot the cold kit. Re-arm on a
        # schedule: browser_gate.activate clears both caches AND walks the live
        # sessions (refresh_agent_mcp_tools, append-only), so an early chat is
        # healed in place and new chats compute the warm catalog.
        def _warm_rearm() -> None:
            try:
                import json as _json
                from pathlib import Path as _P

                relay = _json.loads(
                    (_P(os.environ["HERMES_HOME"]) / "browser" / "relay.json").read_text(encoding="utf-8")
                )
                if int(relay.get("pid") or 0) == os.getpid() and int(relay.get("port") or 0) > 0:
                    from moch import browser_gate as _bg

                    _bg.activate(int(relay["port"]), str(relay.get("token") or ""))
            except Exception:
                pass

        _warm_waiters = set()

        def _browser_tools_ready() -> bool:
            """True when browser_navigate resolves in a FRESH catalog build."""
            try:
                import model_tools

                defs = model_tools.get_tool_definitions(None, None, quiet_mode=True) or []
                return any(d.get("function", {}).get("name") == "browser_navigate" for d in defs)
            except Exception:
                return False

        def _browser_warming() -> bool:
            """Armed but not yet usable — the window the user must be told about."""
            return os.environ.get("MOCH_BROWSER_RELAY", "") == "1" and not _browser_tools_ready()

        def _prewarm_browser() -> None:
            # Poll gently: each pass clears the memo (forcing a fresh, WARM
            # recompute once the registry matures) and the lazy installs the
            # probes trigger ARE the warm-up. On first readiness, run the full
            # activate so open chats are refreshed in place.
            import time as _time

            for _ in range(60):  # ~15 min cap
                if _browser_tools_ready():
                    _warm_rearm()
                    print("[moch] browser toolset warm", flush=True)
                    # Auto-continue: every session that asked during the window
                    # gets ONE short continuation turn — the user's original
                    # request is already in the agent's context, so this is a
                    # single cheap prompt, submitted through the same queue the
                    # app uses (safe if a turn is still running).
                    for _sid in list(_warm_waiters):
                        _warm_waiters.discard(_sid)
                        try:
                            _note_upstream(
                                {
                                    "jsonrpc": "2.0",
                                    "id": "moch-warm-" + _sid,
                                    "method": "prompt.submit",
                                    "params": {
                                        "session_id": _sid,
                                        "text": "[SYSTEM: The in-app browser is now ready. Carry out the user's earlier browser request now.]",
                                    },
                                }
                            )
                        except Exception:
                            pass
                    return
                try:
                    from model_tools import _clear_tool_defs_cache as _clr

                    _clr()
                except Exception:
                    pass
                _time.sleep(15)

        def _import_prewarm() -> None:
            # First-import cost at boot, not mid-request (Tier A bundle).
            for _mod in ("edge_tts", "PIL.Image", "aiohttp"):
                try:
                    __import__(_mod)
                except Exception:
                    pass

        threading.Thread(target=_import_prewarm, name="moch-import-prewarm", daemon=True).start()
        _prewarm = threading.Thread(target=_prewarm_browser, name="moch-browser-prewarm", daemon=True)
        _prewarm.start()

        # While warming, MOCHI tells the user — no silent curl fallback, no
        # "Moch looks down". A bracketed system note rides the prompt (the
        # established out-of-band pattern) only while the window is live.
        def _moch_note_dispatch(req, transport=None):
            try:
                if isinstance(req, dict) and req.get("method") == "prompt.submit" and _browser_warming():
                    params = req.get("params") or {}
                    text = str(params.get("text") or "")
                    if text and not text.startswith("["):
                        _sid = str(params.get("session_id") or "")
                        if _sid:
                            _warm_waiters.add(_sid)
                        params["text"] = (
                            "[SYSTEM: The in-app browser is still starting up (a minute or two after "
                            "the app launches). If the user is asking you to open or browse a web "
                            "page, tell them you will CONTINUE AUTOMATICALLY the moment the browser "
                            "is ready — they do NOT need to resend or do anything; you will pick the "
                            "task back up yourself shortly. Keep the reply to one short sentence. Do "
                            "NOT use terminal curl as a replacement for browsing.]\n\n"
                        ) + text
                        # Surface the wait: the app already renders attention
                        # notices for sessions (toasts + the hermes-alerts
                        # knock), so the gap between this turn and the
                        # auto-continue is not a silent dead end.
                        try:
                            _notice_sid = str(params.get("session_id") or "")
                            if _notice_sid:
                                _tg_server._emit(
                                    "status.update",
                                    _notice_sid,
                                    {
                                        "busy": True,
                                        "waiting_for": "browser",
                                        "note": "Warming up the browser — Moch will continue automatically",
                                    },
                                )
                        except Exception:
                            pass
            except Exception:
                pass
            return _note_upstream(req, transport)

        if not getattr(_tg_server, "_moch_note_installed", False):
            # Capture BEFORE replacing (the fleet-gate pattern): calling
            # _tg_server.dispatch from inside the wrapper would recurse into
            # itself — the "Send failed / internal error" on-device.
            _note_upstream = _tg_server.dispatch
            _tg_server.dispatch = _moch_note_dispatch
            _tg_server._moch_note_installed = True

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