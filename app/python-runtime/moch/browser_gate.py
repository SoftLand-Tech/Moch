"""Live browser-relay gate — the running agent learns about the Moch Browser.

`hermes_boot._prepare_home` sets BROWSER_CDP_URL at BOOT from relay.json, but
the relay only starts when the user first opens the Browser screen — which is
AFTER boot. This module is the runtime half: Kotlin (`BrowserRelayModule`)
calls `activate(port, token)` the moment the relay is up, and the running
process flips the same env gates the boot path would have set, then clears the
registry's check_fn TTL cache so the browser tools appear on the next schema
build — no restart needed, in either open order.

Deactivation is deliberate absence: when the Browser screen closes we leave
the gate on (cookies/session keep the relay cheap to resume) — tools failing
while no tab is live return structured "no page targets" errors, which is the
documented v1 behavior.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

_STATE: dict[str, Any] = {"active": False, "url": None, "port": 0, "activated_at": None}
_LOCK = threading.Lock()


def activate(port: int, token: str) -> dict:
    """Point the running process's browser tools at the live relay (idempotent)."""
    url = f"http://127.0.0.1:{int(port)}/{str(token).strip()}"
    with _LOCK:
        os.environ["BROWSER_CDP_URL"] = url
        os.environ["MOCH_BROWSER_RELAY"] = "1"
        changed = _STATE.get("url") != url
        _STATE.update(active=True, url=url, port=int(port), activated_at=bool(changed))
    # The registry TTL-caches check_fn results process-wide; a stale False from
    # before the relay existed would keep the tools hidden for up to 30s. Clear
    # so the next schema build (next message / new chat) sees the gate immediately.
    #
    # BUG-107: clearing ONLY the check_fn verdicts is not enough. ``model_tools``
    # memoizes the fully ASSEMBLED tool list per (enabled, disabled,
    # skip_tool_search) key in ``_tool_defs_cache``, and the browser verdict is
    # baked into that list — so a session whose list was assembled before the
    # relay started kept replaying the browser-less catalog for the rest of the
    # process (device: gate active 18:02:17, a chat created 18:03:18 still
    # resolved 8 tools with no browser_*). ``tools/mcp_tool_agent.py``'s
    # ``reprobe_tool_availability()`` pairs exactly these two clears for the same
    # reason when MCP servers appear mid-session.
    try:
        from tools.registry import invalidate_check_fn_cache

        invalidate_check_fn_cache()
    except Exception:  # noqa: BLE001 — cache shape drift must never break the gate
        logger.debug("check_fn cache clear failed", exc_info=True)
    try:
        from model_tools import _clear_tool_defs_cache

        _clear_tool_defs_cache()
    except Exception:  # noqa: BLE001 — cache shape drift must never break the gate
        logger.debug("tool-defs cache clear failed", exc_info=True)
    # BUG-132 (cause 4): arming must also reach LIVE sessions. agent.tools is
    # snapshotted once at build (agent_init._load_tools) and nothing refreshes
    # it on a gate flip — the between-turns refresh is MCP-gated and a default
    # phone install has zero MCP servers, so a session built pre-arm improvised
    # with curl for its whole life. Append-only refresh (preserve_prefix=True,
    # no enabled_override — the gate changed no toolsets), mirroring
    # methods_tools._refresh_session_agent.
    try:
        import contextlib

        from tui_gateway.server import _emit, _session_info, _sessions, _sessions_lock
        from tools.mcp_tool_agent import refresh_agent_mcp_tools

        with _sessions_lock:
            live = [
                (sid, sess)
                for sid, sess in list(_sessions.items())
                if sess.get("agent") is not None
            ]
        for sid, sess in live:
            agent = sess["agent"]
            try:
                refresh_agent_mcp_tools(agent, quiet_mode=True, preserve_prefix=True)
            except Exception:
                logger.debug("gate live-refresh failed sid=%s", sid, exc_info=True)
            with contextlib.suppress(Exception):
                _emit("session.info", sid, _session_info(agent, sess))
        if live:
            logger.info("gate live-refresh: %d session(s)", len(live))
    except Exception:
        logger.debug("gate live-session refresh skipped (gateway not up)", exc_info=True)
    logger.info("Moch browser gate active: %s", url)
    return status()


def status() -> dict:
    with _LOCK:
        return dict(_STATE)


def is_active() -> bool:
    with _LOCK:
        return bool(_STATE.get("active"))
