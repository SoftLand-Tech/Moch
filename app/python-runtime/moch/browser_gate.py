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
    try:
        from tools.registry import _check_fn_cache, _check_fn_cache_lock

        with _check_fn_cache_lock:
            _check_fn_cache.clear()
    except Exception:  # noqa: BLE001 — cache shape drift must never break the gate
        logger.debug("check_fn cache clear failed", exc_info=True)
    logger.info("Moch browser gate active: %s", url)
    return status()


def status() -> dict:
    with _LOCK:
        return dict(_STATE)


def is_active() -> bool:
    with _LOCK:
        return bool(_STATE.get("active"))
