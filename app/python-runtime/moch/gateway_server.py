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
from typing import Any, Optional

_STATE: dict[str, Any] = {
    "started": False,
    "starting": False,
    "port": None,
    "token": None,
    "error": None,
    # BH-000047: terminal marker — the supervised boot exhausted its retry
    # schedule. start()'s wait loop and info()'s self-heal key off it so a
    # transient per-attempt error (about to be retried) is not reported as
    # final, and a late successful attempt is never hidden behind a stale one.
    "boot_gave_up": False,
}
_LOCK = threading.Lock()
_READY_TIMEOUT_S = 90.0  # first boot extracts/compiles; phone storage is slow

# BH-000047 / GitHub #101 — the boot chain used to be single-shot: a failure
# anywhere in ``_run_server`` landed in ``_STATE['error']`` and the gateway
# stayed dead for the life of the process (the Kotlin side's bootAttempted
# AtomicBoolean never retries either, so cron knocks + the RN client just saw
# a dead gateway). Bounded supervised retries with growing backoff: one
# initial try plus one retry per scheduled delay. Pure data so tests can pin
# the schedule; give-up leaves the error state exactly as before.
_BOOT_RETRY_DELAYS_S: tuple[float, ...] = (5.0, 15.0, 60.0)


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


# hermes' headless serve shim (web_server_dashboard.mount_spa under
# HERMES_SERVE_HEADLESS=1) registers its root handshake on this catch-all path.
_ROOT_SHIM_PATH = "/{full_path:path}"
# Marker attr set on the replacement endpoint so re-runs recognise their own work.
_ROOT_SHIM_MARKER = "_moch_root_shim_neutralized"


# ── BUG-121: capability notes riding prompt.submit ──────────────────────────
#
# The warming half shipped first (BUG-132): while the relay is armed but the
# tool registry has not matured, a bracketed system note tells the model the
# browser will continue automatically. BUG-121's gate-off half: with the relay
# NOT armed (MOCH_BROWSER_RELAY unset / browser_navigate missing from the
# catalog), nothing told the model the Moch Browser exists at all — it burned
# terminal calls on /system/bin/am, then improvised with curl instead of
# saying "open the Browser screen". Same channel, second note.

_MOCH_WARMING_NOTE = (
    "[SYSTEM: The in-app browser is still starting up (a minute or two after "
    "the app launches). If the user is asking you to open or browse a web "
    "page, tell them you will CONTINUE AUTOMATICALLY the moment the browser "
    "is ready — they do NOT need to resend or do anything; you will pick the "
    "task back up yourself shortly. Keep the reply to one short sentence. Do "
    "NOT use terminal curl as a replacement for browsing.]"
)

_MOCH_GATE_OFF_NOTE = (
    "[SYSTEM: The in-app Moch Browser exists on this phone but its tools are "
    "not available right now — the browser relay is not running. Tell the "
    "user to open the Browser screen in Moch once (drawer → Browser); the "
    "browser tools activate the moment it opens and the browsing task can be "
    "retried then. Do NOT use terminal curl as a replacement for browsing, "
    "and do NOT conclude the capability does not exist. Keep the reply to "
    "one short sentence.]"
)


def _moch_platform() -> bool:
    """True when this process is the embedded Moch gateway (not desktop hermes)."""
    return (
        os.environ.get("MOCH_EMBEDDED", "").strip() == "1"
        or os.environ.get("MOCH_FLEET", "").strip() == "1"
    )


def _moch_prompt_note(*, relay_armed: bool, moch_platform: bool, tools_ready: bool) -> Optional[str]:
    """Which capability note (if any) rides a prompt.submit; ``None`` = none.

    Warming: relay armed but the catalog has not matured → the auto-continue
    note. Gate off (BUG-121): Moch platform and the browser tools are absent
    from the catalog → the open-the-Browser-screen note. Tools present →
    never a note (both windows are closed).
    """
    if not tools_ready and relay_armed:
        return _MOCH_WARMING_NOTE
    if not tools_ready and moch_platform:
        return _MOCH_GATE_OFF_NOTE
    return None


def _neutralize_root_token_handshake(application: Any) -> bool:
    """BUG-120 / GitHub #67 — stop the loopback root from serving the session token.

    Under ``HERMES_SERVE_HEADLESS=1`` (set below, before the web_server import)
    hermes' SPA mount answers unauthenticated ``GET /`` with an HTML page
    embedding ``window.__HERMES_SESSION_TOKEN__=<the live gateway token>`` — a
    desktop-Electron handshake (upstream #94227/#95575). No Moch consumer needs
    it: the RN client gets the token over the JNI bridge
    (``HermesBridge.getGateway``) and authenticates REST/WS via
    ``X-Hermes-Session-Token`` / ``?token=``, never via HTTP-GET /. But this
    gateway binds plain loopback TCP (127.0.0.1:9119), which every app on the
    phone can reach — so that page handed the full hermes API to any
    co-installed app (same threat model the browser relay is token-gated
    against, FEATURE-BROWSER.md §Safety).

    Fix = surgical route-table swap from the Moch side (hermes-src stays
    pristine — the boot-time-patch convention of ``_tg_server._SlashWorker``
    and the dispatch wrapper below): remove the shim's catch-all GET route and
    re-register the same path with an endpoint that ALWAYS returns the shim's
    own no-token 404 JSON, so ``/`` answers exactly what every other unmatched
    path answers. /api/* routes, public paths and the WS ``?token=`` handshake
    are untouched — we do NOT set ``app.state.auth_required`` (gated mode
    rejects the legacy ``?token=`` the RN client still uses).

    Idempotent: on an already-neutralized app it only strips stray duplicate
    shims and never registers a second replacement. Returns True when no
    token-serving catch-all remains, False when the upstream shape changed
    (warned, never raised — boot must not die here).
    """
    try:
        routes = application.router.routes
        matching = [
            r for r in routes
            if getattr(r, "path", None) == _ROOT_SHIM_PATH
            and "GET" in (getattr(r, "methods", None) or ())
        ]

        def _ours(route: Any) -> bool:
            return bool(getattr(getattr(route, "endpoint", None), _ROOT_SHIM_MARKER, False))

        if any(_ours(r) for r in matching):
            # Second run (or a double mount_spa): keep OUR replacement, drop
            # any duplicate upstream shims, register nothing new.
            routes[:] = [r for r in routes if r not in matching or _ours(r)]
            return True
        if not matching:
            print(
                f"[moch] WARNING BUG-120: headless root shim route {_ROOT_SHIM_PATH} not found "
                "— GET / NOT neutralized (upstream web_server_dashboard changed shape?)",
                flush=True,
            )
            return False
        routes[:] = [r for r in routes if r not in matching]

        from fastapi.responses import JSONResponse

        try:  # keep the 404 body identical to the shim's non-root reply
            from hermes_cli.web_server_dashboard import _HEADLESS_MSG
        except Exception:
            _HEADLESS_MSG = "Headless backend (hermes serve): web UI disabled."

        async def _moch_no_frontend(full_path: str):  # same signature as the shim
            return JSONResponse({"error": _HEADLESS_MSG}, status_code=404)

        setattr(_moch_no_frontend, _ROOT_SHIM_MARKER, True)
        application.get(_ROOT_SHIM_PATH)(_moch_no_frontend)
        print("[moch] BUG-120: root token handshake neutralized — GET / no longer serves the session token", flush=True)
        return True
    except Exception:
        print("[moch] WARNING BUG-120: root token handshake neutralization failed:", flush=True)
        traceback.print_exc()
        return False


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
            """Armed but not yet usable — the window the user must be told about.

            (The prompt-riding decision now lives in the module-level
            ``_moch_prompt_note`` so it is unit-testable; this predicate stays
            for readers of the warm-up loop below.)"""
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
        # established out-of-band pattern) while the warming window is live,
        # and (BUG-121, gate-off half) also when the platform is Moch but the
        # browser tools are absent from the catalog outright.
        def _moch_note_dispatch(req, transport=None):
            try:
                if isinstance(req, dict) and req.get("method") == "prompt.submit":
                    params = req.get("params") or {}
                    text = str(params.get("text") or "")
                    # The catalog probe can force a fresh (memoized) build —
                    # run it at most once per call, and only when a note is
                    # even possible (desktop hermes never pays for this).
                    relay_armed = os.environ.get("MOCH_BROWSER_RELAY", "") == "1"
                    if text and not text.startswith("[") and (relay_armed or _moch_platform()):
                        tools_ready = None

                        def _tools_ready() -> bool:
                            nonlocal tools_ready
                            if tools_ready is None:
                                tools_ready = _browser_tools_ready()
                            return tools_ready

                        note = _moch_prompt_note(
                            relay_armed=relay_armed,
                            moch_platform=_moch_platform(),
                            tools_ready=_tools_ready(),
                        )
                        if note is not None:
                            warming = note is _MOCH_WARMING_NOTE
                            _sid = str(params.get("session_id") or "")
                            if warming and _sid:
                                _warm_waiters.add(_sid)
                            params["text"] = note + "\n\n" + text
                            # Surface the wait: the app already renders attention
                            # notices for sessions (toasts + the hermes-alerts
                            # knock), so the gap between this turn and the
                            # auto-continue is not a silent dead end.
                            if warming:
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

        from hermes_cli.web_server import app as _web_app, start_server

        # BUG-120/#67: strip the headless root shim's token page BEFORE the
        # first request can arrive (never raises; see the neutralizer).
        _neutralize_root_token_handshake(_web_app)

        start_server(host="127.0.0.1", port=port, open_browser=False, headless=True)
    except BaseException:  # noqa: BLE001 — thread boundary; recorded in state
        _STATE["error"] = traceback.format_exc(limit=12)


def _boot_retry_delay_s(failed_attempt: int) -> float | None:
    """Delay to sleep before the retry that follows ``failed_attempt`` (1-based),
    or None when the retry schedule is exhausted — the supervisor gives up.
    Pure: tests pin the schedule without a server."""
    if failed_attempt < 1:
        return None
    idx = failed_attempt - 1
    if idx >= len(_BOOT_RETRY_DELAYS_S):
        return None
    return _BOOT_RETRY_DELAYS_S[idx]


def _supervised_server_boot(port: int) -> None:
    """Run ``_run_server`` with bounded supervised retries (BH-000047 / GH #101).

    ``_run_server`` blocks while the server serves and records a failure into
    ``_STATE['error']`` when it dies — so returning from it means "this attempt
    is over". Each failure is logged with its attempt number, per-attempt state
    is reset (error cleared — the gateway is honestly "booting" again, not
    dead), and the next attempt runs after the scheduled backoff. After the
    last scheduled retry the final error stays set, exactly the pre-fix
    give-up state. A clean error-free return (e.g. process shutdown asked the
    server to stop) is not retried.
    """
    total = 1 + len(_BOOT_RETRY_DELAYS_S)
    attempt = 1
    while True:
        _run_server(port)
        error = _STATE.get("error")
        if error is None:
            return
        delay = _boot_retry_delay_s(attempt)
        if delay is None:
            with _LOCK:
                _STATE["boot_gave_up"] = True
            print(
                f"[moch] gateway boot gave up after attempt {attempt}/{total} — "
                "error recorded in gateway state",
                flush=True,
            )
            return
        tail = error.strip().splitlines()[-1] if error.strip() else "unknown error"
        print(
            f"[moch] gateway boot attempt {attempt}/{total} failed: {tail} — "
            f"retrying in {delay:.0f}s",
            flush=True,
        )
        with _LOCK:
            # Reset between attempts: info() reports an honest "booting"
            # (running=true, no stale error) across the backoff window.
            _STATE["error"] = None
        time.sleep(delay)
        attempt += 1


def start(port: int = 0) -> dict:
    """Boot hermes (idempotent) and the gateway; returns connection info."""
    # BH-000048 / GitHub #102: arm the boot state BEFORE any boot work — the
    # RN client polls getGateway from the moment the process starts, and
    # ``starting`` was never set True, so info_json reported running=false
    # through the whole (slow) cold boot. A re-start also clears any stale
    # terminal error/gave-up marker so the fresh attempt is judged on its own.
    with _LOCK:
        _STATE["starting"] = True
        _STATE["error"] = None
        _STATE["boot_gave_up"] = False

    from moch import hermes_boot

    boot = hermes_boot.boot()
    if not boot.get("ok"):
        _STATE["error"] = "hermes boot failed: " + "; ".join(boot.get("errors") or ["unknown"])
        with _LOCK:
            _STATE["starting"] = False
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
        target=_supervised_server_boot,
        args=(port,),
        name="moch-hermes-gateway",
        daemon=True,
    ).start()

    waited = 0.0
    while waited < _READY_TIMEOUT_S:
        # Only a TERMINAL error ends the wait early: a per-attempt failure is
        # about to be retried by the supervisor (BH-000047), and returning it
        # as final would re-introduce the single-shot behavior.
        if _STATE["error"] and _STATE.get("boot_gave_up"):
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


def _running_payload(state: dict) -> dict:
    """Pure view of a gateway boot-state dict → the derived getGateway fields
    (BH-000048 / GitHub #102, extracted for tests).

    ``running`` is honest: true while starting OR started, but never once an
    error is recorded (a failed/booting-out gateway must not look alive).
    ``ready`` here is the port-independent half; info() adds the live accept
    probe and the workspace env read.
    """
    started = bool(state.get("started"))
    starting = bool(state.get("starting"))
    error = state.get("error")
    return {
        "running": (started or starting) and error is None,
        "ready": started and state.get("port") is not None,
        "port": state.get("port"),
        "token": state.get("token"),
        "error": error,
    }


def info() -> dict:
    """Current gateway state for the bridge. Never raises."""
    port = _STATE["port"]
    port_up = port is not None and _port_accepts(port)
    if port_up and not _STATE["started"] and not _STATE.get("boot_gave_up"):
        # A supervised attempt came up AFTER start() stopped waiting (the
        # retry schedule can outlast the ready timeout): a listening port is
        # the ground truth, so heal the stale timeout error instead of
        # reporting a dead gateway that is actually serving (BH-000047).
        with _LOCK:
            _STATE["started"] = True
            _STATE["error"] = None
    payload = _running_payload(_STATE)
    payload["ready"] = bool(_STATE["started"]) and port_up
    payload["workspace"] = os.environ.get("MOCH_WORKSPACE")
    return payload


def info_json() -> str:
    """JSON snapshot for the RN bridge (JNI-simple string contract)."""
    return json.dumps(info())