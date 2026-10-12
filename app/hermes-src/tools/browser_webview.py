"""Moch WebView browser backend — the embedded Android WebView over the CDP relay.

Moch's Browser screen hosts real, visible WebViews; a Kotlin loopback relay
(``CdpRelay.kt``) proxies ``127.0.0.1:<port>/<token>/…`` to the DevTools
abstract unix socket, filters ``/json/list`` to the ACTIVE (visible) tab, and
tunnels the "browser-level" ws to that page's own socket (``Moch-Browser-Level:
false`` ⇒ the supervisor attaches sessionless). This module is the executor the
browser tools route to in that mode — the camofox pattern (``_camofox``): every
verb is raw CDP on the supervisor's persistent in-process WebSocket.

Why a backend and not ``--cdp`` passthrough: stock CDP-override mode still runs
every action through the ``agent-browser`` NODE CLI as a subprocess — Android
(targetSdk 36, ``untrusted_app``) cannot execve anything, so on-device the CLI
path is dead. The supervisor path is pure Python + one WebSocket: it IS the
on-device executor. Everything here also works on the PC (real Chromium forced
into per-page mode) which is how ``scripts/test-browser-webview.py`` verifies
it against a live browser.

Mode gate: ``MOCH_BROWSER_RELAY=1`` — set by ``moch/hermes_boot.py`` when the
Kotlin relay's state file is present. Never anywhere else.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_NO_SESSION = "No browser page. Call browser_navigate first (and keep the Moch Browser screen open)."

# BUG-105 companion: the generic _NO_SESSION tells the model to retry against
# a relay that may not exist at all. When the RELAY is down (app restarted,
# Browser screen not opened yet this session), the only fix is the user
# opening it — say so, so the agent relays a real instruction instead of
# concluding "the browser is dead".
_RELAY_DOWN_ERROR = (
    "The Moch browser relay is not running — there is no browser to drive right now. "
    "Ask the user to open the Browser screen in Moch once (drawer → Browser); the "
    "browser tools activate the moment it opens, then retry the task."
)


def is_webview_mode() -> bool:
    """True when the Moch relay is the configured browser backend."""
    return os.environ.get("MOCH_BROWSER_RELAY", "").strip() == "1"


def _supervisor(task_id: Optional[str] = None):
    """The task's live CDP supervisor, or None (caller renders a tool error)."""
    from tools.browser_supervisor import SUPERVISOR_REGISTRY

    return SUPERVISOR_REGISTRY.get(task_id or "default")


def _relay_down_error() -> Optional[str]:
    """``_RELAY_DOWN_ERROR`` when the configured relay is unreachable, else None.

    None covers "no CDP URL configured" (nothing to probe — the generic
    message is correct) and "probe succeeded" (relay up; a missing session
    then really means no live page target). One short GET, failure path only.
    """
    url = os.environ.get("BROWSER_CDP_URL", "").strip()
    if not url:
        return None
    try:
        import requests

        from agent.proxy_bypass import loopback_request_kwargs
        from tools.browser_supervisor import _http_probe_root

        version_url = _http_probe_root(url).rstrip("/") + "/json/version"
        requests.get(version_url, timeout=2, **loopback_request_kwargs(version_url))
    except Exception:  # noqa: BLE001 — an unreachable relay IS the answer
        return _RELAY_DOWN_ERROR
    return None


def _call(sup, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 15.0) -> Dict[str, Any]:
    """One CDP command via the supervisor bridge; raises RuntimeError on failure.

    Returns the RESULT object: for ``Runtime.evaluate`` that is the RemoteObject
    (``{"type","value",...}`` — read ``.get("value")`` for returnByValue data);
    for everything else the method's own result payload.
    """
    result = sup.cdp_call(method, params, timeout=timeout)
    if not isinstance(result, dict) or result.get("error"):
        raise RuntimeError(str((result or {}).get("error", f"{method} failed")))
    payload = result.get("result", {})
    if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
        return payload["result"]
    return payload if isinstance(payload, dict) else {}


# ── Observation ─────────────────────────────────────────────────────────────

_JS_INTERACTIVE = """
(() => {
  const out = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="textbox"], [onclick]';
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag;
    const name = (el.getAttribute('aria-label') || el.value || el.alt || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const ref = 'e' + (++i);
    el.setAttribute('data-moch-ref', ref);
    out.push({ ref, tag, type, name,
      href: tag === 'a' ? String(el.href || '') : undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  }
  return JSON.stringify({ url: location.href, title: document.title,
    scroll: Math.round((window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh)) * 100),
    elements: out });
})()
"""


def webview_snapshot(task_id: Optional[str] = None, full: bool = False) -> str:
    """Interactive-element snapshot of the visible tab (DOM-first, refs attached)."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    try:
        result = _call(sup, "Runtime.evaluate", {
            "expression": _JS_INTERACTIVE, "returnByValue": True, "awaitPromise": False,
        })
        page = json.loads(result.get("value") or "{}")
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"snapshot failed: {exc}"})
    lines: List[str] = [f"URL: {page.get('url', '')}", f"Title: {page.get('title', '')}",
                        f"Scroll: {page.get('scroll', 0)}%", ""]
    for el in page.get("elements", []):
        label = el.get("name") or el.get("placeholder") or ""
        href = f" -> {el['href']}" if el.get("href") else ""
        lines.append(f"[{el['ref']}] {el['type']}{f' {chr(34)}{label}{chr(34)}' if label else ''}{href}")
    text = "\n".join(lines)
    response: Dict[str, Any] = {"success": True, "snapshot": text}
    try:
        from tools.browser_tool_snapshot import _truncate_snapshot
        response.update(_truncate_snapshot(text, full=full) if full else {"snapshot": text})
    except Exception:  # noqa: BLE001 — truncation is an optimization
        pass
    return json.dumps(response)


# ── Navigation ──────────────────────────────────────────────────────────────

def webview_navigate(url: str, task_id: Optional[str] = None) -> str:
    """Navigate the visible tab: supervisor attach (first nav) + Page.navigate + settle."""
    sup = _supervisor(task_id)
    if sup is None:
        # First browser tool of the turn: attaching may take a moment on a cold
        # relay; get_or_start is idempotent and blocks until attach completes.
        try:
            from tools.browser_tool_cdp import _ensure_cdp_supervisor
            _ensure_cdp_supervisor(task_id or "default")
            sup = _supervisor(task_id)
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"success": False, "error": f"supervisor attach failed: {exc}"})
        if sup is None:
            # BUG-105: attach is swallowed upstream (non-fatal by design), so a
            # dead relay and a live-relay-no-page look identical. Distinguish.
            return json.dumps({"success": False, "error": _relay_down_error() or _NO_SESSION})
    try:
        _call(sup, "Page.navigate", {"url": url}, timeout=20.0)
        # Settle: wait for load in small polls instead of a fixed sleep.
        deadline = time.time() + 15.0
        while time.time() < deadline:
            probe = sup.evaluate_runtime(
                "document.readyState === 'complete' || document.readyState === 'interactive' ? "
                "location.href : ''", timeout=3.0)
            if probe.get("ok") and probe.get("result"):
                break
            time.sleep(0.4)
        title = sup.evaluate_runtime("document.title", timeout=3.0)
        final = sup.evaluate_runtime("location.href", timeout=3.0)
        return json.dumps({
            "success": True,
            "url": final.get("result") or url,
            "title": title.get("result") or "",
        })
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"navigate failed: {exc}"})


# ── Actions ─────────────────────────────────────────────────────────────────

def _normalize_ref(ref: str) -> str:
    """The bare ``eN`` id a snapshot hands out.

    BUG-125: snapshots print refs as ``[e1]`` and every sibling agentic-browser
    toolset (browser-use, Playwright MCP) has models emit ``@e1``, but the
    attribute lookup is literal — ``@e1`` never matched, and the miss was
    reported as "stale ref", which sent the model re-snapshotting into the same
    wall (observed on-device: two failed ``browser_type`` calls on a ref taken
    from a fresh snapshot, then success with the bare id). Normalize every shape
    a model plausibly produces, and never call a format miss "stale".
    """
    return (ref or "").strip().lstrip("@").strip().strip("[]").strip()


def _ref_js(ref: str, expression: str) -> str:
    """JS that resolves a data-moch-ref element; expression receives `el`."""
    ref = _normalize_ref(ref)
    safe = json.dumps(ref)
    return (
        f"(() => {{ const el = document.querySelector('[data-moch-ref=\"' + {safe} + '\"]'); "
        f"if (!el) return JSON.stringify({{ok: false, error: 'unknown ref {ref} — refs are the "
        f"bare ids the snapshot prints ([e1] → e1); re-snapshot if the page changed'}}); "
        f"return (() => {{ {expression} }})(); }})()"
    )


def _action(sup, expression: str, what: str) -> str:
    try:
        result = _call(sup, "Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": False,
        })
        payload = json.loads(result.get("value") or '{"ok": false, "error": "no result"}')
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"{what} failed: {exc}"})
    if not payload.get("ok"):
        return json.dumps({"success": False, "error": payload.get("error", f"{what} failed")})
    return json.dumps({"success": True, **{k: v for k, v in payload.items() if k != "ok"}, "action": what})


def webview_click(ref: str, task_id: Optional[str] = None) -> str:
    """Click by ref: real .click() (trusted enough for most flows; CDP touch for later)."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    js = _ref_js(ref, """
      el.scrollIntoView({block: 'center'});
      el.click();
      return JSON.stringify({ok: true, clicked: el.getAttribute('data-moch-ref')});
    """)
    return _action(sup, js, "click")


def webview_type(ref: str, text: str, task_id: Optional[str] = None) -> str:
    """Fill an input by ref: focus + native setter (React-safe) + input event."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    value = json.dumps(text)
    js = _ref_js(ref, f"""
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, {value});
      el.dispatchEvent(new Event('input', {{bubbles: true}}));
      el.dispatchEvent(new Event('change', {{bubbles: true}}));
      return JSON.stringify({{ok: true, typed: true}});
    """)
    return _action(sup, js, "type")


def webview_scroll(direction: str, task_id: Optional[str] = None) -> str:
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    dx, dy = (0, -600) if direction == "up" else (0, 600)
    js = f"window.scrollBy({dx}, {dy}); JSON.stringify({{ok: true}})"
    return _action(sup, js, "scroll")


def webview_back(task_id: Optional[str] = None) -> str:
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    js = "history.back(); JSON.stringify({ok: true})"
    result = _action(sup, js, "back")
    if '"success": false' in result and "navigated or closed" in result:
        # history.back() navigated: the eval context died mid-call, which IS
        # the success case (same in browser-level mode).
        return json.dumps({"success": True, "action": "back", "note": "page navigated"})
    return result


def webview_press(key: str, task_id: Optional[str] = None) -> str:
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    js = (
        "document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', "
        f"{{key: {json.dumps(key)}, bubbles: true}})); JSON.stringify({{ok: true}})"
    )
    return _action(sup, js, "press")


# ── Tabs ────────────────────────────────────────────────────────────────────
#
# Endpoint reality this section is written against (CdpRelay.kt):
#   - GET /json/list        → the relay filters it to the ACTIVE tab only (at
#     most ONE page advertised; plain desktop DevTools returns every page).
#   - /json/new, /json/close, /json/activate → the relay 405s all of them
#     ("tab lifecycle is native-owned in Moch"): the RN Browser screen owns the
#     tab strip, and closing/creating WebView targets behind its back would
#     desync it. Plain DevTools serves them (PUT since Chrome ≥63).
#   - Target.* over the supervisor socket → the WebView page socket rejects the
#     Target domain (browser_supervisor._attach_initial_page skips it for
#     exactly this reason), so CDP tab verbs are a desktop-only fallback.
# The tools below therefore prefer the classic HTTP endpoints (the relay is an
# HTTP proxy), fall back to Target.*, and fail with an honest, actionable error
# when the backend owns neither path.


def _normalize_tab_id(tab_id: Any) -> str:
    """The bare target id a model should pass (``' "ABC123" '`` → ``ABC123``).

    Same spirit as ``_normalize_ref``: models quote ids and pad them with
    whitespace often enough that every plausible shape normalizes, and a format
    miss is never reported as "unknown tab".
    """
    text = str(tab_id or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text


def _coerce_index(value: Any) -> Optional[int]:
    """``value`` as a tab index when it plausibly is one (int, or a clean integer
    string); None otherwise. Bools are ints in Python but never a tab index."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    text = str(value or "").strip()
    if text and text.lstrip("+-").isdigit():
        try:
            return int(text)
        except ValueError:  # pragma: no cover — isdigit() guards this
            return None
    return None


def _resolve_tab(tabs: List[Dict[str, Any]], *, tab_id: Any = None, index: Any = None,
                 active_id: Optional[str] = None, require_choice: bool = False) -> tuple:
    """Pick the tab a close/switch call means, from ``browser_tab_list`` output.

    Resolution order: explicit id → explicit index (int or integer string) → a
    non-matching id retried as an index (models paste positions into ``tab_id``)
    → the active tab. Returns ``(tab, None)`` or ``(None, error)``; with
    ``require_choice`` (switch) the active-tab default is rejected so a switch
    can never silently succeed as a no-op.
    """
    if tab_id is not None and index is not None:
        return None, "pass either tab_id or index, not both"
    wanted = _normalize_tab_id(tab_id)
    if wanted:
        for tab in tabs:
            if tab.get("id") == wanted:
                return tab, None
    idx = _coerce_index(index) if index is not None else (_coerce_index(wanted) if wanted else None)
    if idx is not None:
        if not -len(tabs) <= idx < len(tabs):
            return None, f"index {idx} is out of range (0..{len(tabs) - 1} for {len(tabs)} open tab(s))"
        return tabs[idx], None
    if wanted:
        known = ", ".join(str(t.get("id", "?")) for t in tabs)
        return None, f"unknown tab id '{wanted}' — open tabs: {known}"
    if require_choice:
        return None, "tab_id or index is required (browser_tab_list shows the open tabs)"
    for tab in tabs:
        if tab.get("id") == active_id:
            return tab, None
    return (tabs[0], None) if tabs else (None, "no open tabs")


def _relay_http_root() -> str:
    """``http://127.0.0.1:<port>/<token>`` (or the plain DevTools root) from the
    configured CDP endpoint, ``""`` when none is configured."""
    from tools.browser_supervisor import _http_probe_root

    return _http_probe_root(os.environ.get("BROWSER_CDP_URL", "").strip()).rstrip("/")


def _relay_http(path: str, *, verb: str = "GET", timeout: float = 5.0):
    """One ``/json`` HTTP request against the configured endpoint; the
    ``requests`` response. Raises on transport errors and when no endpoint is
    configured — callers shape the error, like ``_relay_down_error`` does."""
    import requests

    from agent.proxy_bypass import loopback_request_kwargs

    root = _relay_http_root()
    if not root:
        raise RuntimeError("no browser endpoint configured (BROWSER_CDP_URL is unset)")
    url = f"{root}{path}"
    return requests.request(verb, url, timeout=timeout, **loopback_request_kwargs(url))


_NATIVE_OWNED_MARKER = "native-owned"  # the relay's 405 body for /json/new|close|activate


def _relay_lifecycle(path: str):
    """PUT-then-GET on a mutating ``/json`` endpoint: Chrome ≥63 demands PUT on
    ``/json/new`` while older builds accept GET only. The Moch relay 405s both
    verbs with the same body, so the retry is skipped when that marker is
    present and the relay's own reason surfaces verbatim."""
    response = _relay_http(path, verb="PUT")
    if response.status_code != 405 or _NATIVE_OWNED_MARKER in (response.text or ""):
        return response
    return _relay_http(path, verb="GET")


def _describe_http(response) -> str:
    return f"HTTP {response.status_code}: {(response.text or '').strip()[:160]}"


def _relay_filters_tabs() -> bool:
    """True when the endpoint is the Moch relay (its ``/json/list`` advertises
    only the ACTIVE tab). Best-effort — False on any probe failure."""
    try:
        response = _relay_http("/json/version")
        response.raise_for_status()
        return (response.json() or {}).get("Moch-Browser-Level") is False
    except Exception:  # noqa: BLE001 — the filter note is an optimization
        return False


_TAB_BACKEND_NOTE = (
    "The Moch relay advertises only the ACTIVE tab and deliberately 405s /json/new|close|activate "
    "(tab lifecycle is owned by the app's Browser screen), and the WebView page socket rejects "
    "Target.* — so only the active tab is visible and tab lifecycle needs app-side support. Use "
    "browser_navigate in the current tab, or ask the user to open/close/switch tabs in the Browser screen."
)


def _tab_unavailable_error(what: str, attempts: List[str]) -> str:
    """Honest composite error once every tab-lifecycle path has failed."""
    return (
        f"{what} failed on every available path — " + "; ".join(attempts) +
        ". Tab lifecycle needs the app side: use browser_navigate in the current tab, or ask the "
        "user to open/close/switch tabs in the Moch Browser screen."
    )


def _webview_tab_targets(task_id: Optional[str] = None) -> Dict[str, Any]:
    """Enumerate open page tabs (``{id, title, url}``) + the active tab's id.

    ``/json/list`` is authoritative for the ACTIVE tab (the relay filters it to
    exactly that); ``Target.getTargets`` over the supervisor socket, when the
    endpoint speaks it (desktop DevTools), widens the list to every open page —
    the WebView page socket rejects ``Target.*``, so on device the active tab is
    all that is visible. Raises RuntimeError when no path yields a tab list.
    """
    listed, list_error = [], None
    try:
        response = _relay_http("/json/list")
        response.raise_for_status()
        listed = [t for t in (response.json() or []) if isinstance(t, dict) and t.get("type", "page") == "page"]
    except Exception as exc:  # noqa: BLE001 — the Target.* fallback may still enumerate
        list_error = exc

    gathered, cdp_error = [], None
    sup = _supervisor(task_id)
    if sup is not None:
        try:
            infos = _call(sup, "Target.getTargets", timeout=8.0).get("targetInfos") or []
            gathered = [t for t in infos if isinstance(t, dict) and t.get("type") == "page"]
        except Exception as exc:  # noqa: BLE001 — the HTTP list alone is still usable
            cdp_error = exc

    if not listed and not gathered:
        if list_error is not None:
            detail = f"; Target.getTargets: {cdp_error}" if cdp_error is not None else ""
            raise RuntimeError(f"listing tabs failed: {list_error}{detail}")
        raise RuntimeError("no open page tabs (open the Moch Browser screen, or navigate first)")

    tabs: List[Dict[str, Any]] = []
    seen = set()
    for raw in listed + gathered:
        tab_id = str(raw.get("id") or raw.get("targetId") or "").strip()
        if not tab_id or tab_id in seen:
            continue
        seen.add(tab_id)
        tabs.append({"id": tab_id, "title": str(raw.get("title") or ""), "url": str(raw.get("url") or "")})
    active_id = str(listed[0].get("id") or "").strip() if listed else None
    note = _TAB_BACKEND_NOTE if _relay_filters_tabs() and (cdp_error is not None or sup is None) else None
    return {"tabs": tabs, "active_id": active_id, "note": note}


def _http_tab_op(path: str) -> tuple:
    """``(ok, detail)`` for one /json lifecycle call over HTTP."""
    try:
        response = _relay_lifecycle(path)
    except Exception as exc:  # noqa: BLE001 — a dead transport is an answer
        return False, str(exc)
    if response.status_code == 200:
        return True, ""
    return False, _describe_http(response)


def _cdp_tab_op(sup, method: str, params: Dict[str, Any]) -> tuple:
    """``(ok, detail)`` for one Target.* fallback command via the supervisor."""
    try:
        _call(sup, method, params, timeout=10.0)
        return True, ""
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _activate_tab(tab_id: str, task_id: Optional[str] = None) -> tuple:
    """Make ``tab_id`` the active tab: /json/activate (HTTP) then Target.activateTarget."""
    ok, detail = _http_tab_op(f"/json/activate/{tab_id}")
    if ok:
        return True, ""
    sup = _supervisor(task_id)
    if sup is not None:
        cdp_ok, cdp_detail = _cdp_tab_op(sup, "Target.activateTarget", {"targetId": tab_id})
        if cdp_ok:
            return True, ""
        detail += f"; Target.activateTarget: {cdp_detail}"
    return False, detail


def _focus_supervisor_origin(sup, url: str) -> None:
    """Best-effort ``focus_page`` onto ``url``'s origin: endpoints whose
    ``/devtools/browser`` does not re-resolve to the active page (plain desktop
    DevTools attaches the FIRST target) need the hint. Skipped when the URL has
    no origin to match (about:blank)."""
    if not url:
        return
    try:
        from agent.vault_store import normalize_origin

        sup.focus_page(normalize_origin(url))
    except Exception:  # noqa: BLE001 — a missed focus only snapshots the old tab
        pass


def _resync_supervisor(task_id: Optional[str], *, prefer_url: str = "") -> None:
    """Restart the task's supervisor so a fresh ``/devtools/browser`` connect
    re-resolves to the NOW-active page — the relay pins the page per CONNECT
    ("a later tab switch means a new supervisor connect"), so an activation only
    reaches later tools after a reconnect. No-op when nothing is attached."""
    from tools.browser_supervisor import SUPERVISOR_REGISTRY

    key = task_id or "default"
    sup = SUPERVISOR_REGISTRY.get(key)
    if sup is None:
        return
    cdp_url = sup.cdp_url
    SUPERVISOR_REGISTRY.stop(key)
    sup = SUPERVISOR_REGISTRY.get_or_start(task_id=key, cdp_url=cdp_url)
    _focus_supervisor_origin(sup, prefer_url)


def _ensure_or_resync_supervisor(task_id: Optional[str], *, prefer_url: str = "") -> None:
    """Attach a supervisor when none exists (first browser tool of the turn —
    same dance as ``webview_navigate``), else reconnect to the active page."""
    if _supervisor(task_id) is None:
        from tools.browser_tool_cdp import _ensure_cdp_supervisor

        _ensure_cdp_supervisor(task_id or "default")
        sup = _supervisor(task_id)
        if sup is not None:
            _focus_supervisor_origin(sup, prefer_url)
        return
    _resync_supervisor(task_id, prefer_url=prefer_url)


def _poll_tabs_after_close(closed_id: str, timeout: float = 4.0) -> Optional[List[Dict[str, Any]]]:
    """Fresh /json/list page entries once ``closed_id`` is gone — DevTools closes
    targets asynchronously, so the id lingers in an immediate re-list. None on
    timeout or transport failure; the caller falls back to the pre-close list."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            response = _relay_http("/json/list")
            response.raise_for_status()
            entries = [t for t in (response.json() or []) if isinstance(t, dict) and t.get("type", "page") == "page"]
            if all(str(t.get("id") or t.get("targetId") or "").strip() != closed_id for t in entries):
                return [
                    {"id": str(t.get("id") or t.get("targetId") or "").strip(),
                     "title": str(t.get("title") or ""), "url": str(t.get("url") or "")}
                    for t in entries
                ]
        except Exception:  # noqa: BLE001 — transient; keep polling to the deadline
            pass
        time.sleep(0.3)
    return None


def _poll_new_tab(new_id: str, url: str, task_id: Optional[str], timeout: float = 5.0) -> Dict[str, Any]:
    """Best-effort readback of a freshly created tab: DevTools fills the target's
    url/title asynchronously, so wait (bounded) for the URL to leave about:blank
    and a title to arrive. Returns the freshest entry seen (or id+requested url)."""
    tab = {"id": new_id, "title": "", "url": url}
    if url.rstrip("/") == "about:blank":
        return tab
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            entry = next((t for t in _webview_tab_targets(task_id)["tabs"] if t["id"] == new_id), None)
            if entry is not None:
                tab = entry
                if entry.get("url") not in ("", "about:blank") and entry.get("title"):
                    break
        except Exception:  # noqa: BLE001 — readback is an optimization
            break
        time.sleep(0.4)
    return tab


def webview_tab_list(task_id: Optional[str] = None) -> str:
    """Open tabs as ``[{id, title, url, active}]`` — the active tab is marked."""
    try:
        data = _webview_tab_targets(task_id)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": _relay_down_error() or f"tab list failed: {exc}"})
    tabs = [{**tab, "active": tab["id"] == data["active_id"]} for tab in data["tabs"]]
    response: Dict[str, Any] = {"success": True, "tabs": tabs, "count": len(tabs)}
    if data["note"]:
        response["note"] = data["note"]
    return json.dumps(response)


def webview_tab_create(url: str, task_id: Optional[str] = None) -> str:
    """Open a NEW tab at ``url`` (HTTP /json/new, Target.createTarget fallback)
    and make it the active tab."""
    import urllib.parse

    url = (url or "").strip()
    if not url:
        return json.dumps({"success": False, "error": "url is required (e.g. 'https://example.com')"})
    quoted = urllib.parse.quote(url, safe=":/?&=%#")
    attempts: List[str] = []
    new_id = ""
    try:
        response = _relay_lifecycle(f"/json/new?{quoted}")
        if response.status_code == 200:
            payload = response.json() or {}
            new_id = str(payload.get("id") or payload.get("targetId") or "").strip()
        else:
            attempts.append(f"/json/new: {_describe_http(response)}")
    except Exception as exc:  # noqa: BLE001 — the Target.* fallback gets its turn
        attempts.append(f"/json/new: {exc}")
    if not new_id:
        sup = _supervisor(task_id)
        if sup is None:
            attempts.append("Target.createTarget: no attached browser page")
        else:
            try:
                created = _call(sup, "Target.createTarget", {"url": url}, timeout=15.0)
                new_id = str((created or {}).get("targetId") or "").strip()
                if not new_id:
                    attempts.append("Target.createTarget: no targetId in the result")
            except Exception as exc:  # noqa: BLE001
                attempts.append(f"Target.createTarget: {exc}")
    if not new_id:
        return json.dumps({"success": False, "error": _tab_unavailable_error("opening a new tab", attempts)})
    _activate_tab(new_id, task_id)  # best effort — some backends open tabs foregrounded
    try:
        _ensure_or_resync_supervisor(task_id, prefer_url=url)
    except Exception as exc:  # noqa: BLE001 — the tab exists; attach trouble becomes a note
        return json.dumps({"success": True, "tab": {"id": new_id, "title": "", "url": url}, "url": url,
                           "note": f"tab opened, but re-attaching the browser to it failed: {exc}"})
    tab = _poll_new_tab(new_id, url, task_id)
    return json.dumps({"success": True, "tab": tab, "url": tab.get("url") or url, "title": tab.get("title", "")})


def webview_tab_close(tab_id: Optional[str] = None, task_id: Optional[str] = None) -> str:
    """Close the given tab (or the active one). NEVER the last remaining tab."""
    try:
        data = _webview_tab_targets(task_id)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": _relay_down_error() or f"tab close failed: {exc}"})
    tab, error = _resolve_tab(data["tabs"], tab_id=tab_id, active_id=data["active_id"])
    if error is not None:
        return json.dumps({"success": False, "error": f"tab close failed: {error}"})
    if len(data["tabs"]) <= 1:
        return json.dumps({
            "success": False,
            "error": "refusing to close the last remaining tab — the browser must always keep one "
                     "tab open; navigate it elsewhere with browser_navigate instead",
        })
    closed_active = tab["id"] == data["active_id"]
    ok, detail = _http_tab_op(f"/json/close/{tab['id']}")
    if not ok:
        sup = _supervisor(task_id)
        if sup is None:
            cdp_ok, cdp_detail = False, "no attached browser page"
        else:
            cdp_ok, cdp_detail = _cdp_tab_op(sup, "Target.closeTarget", {"targetId": tab["id"]})
        if not cdp_ok:
            return json.dumps({"success": False, "error": _tab_unavailable_error(
                f"closing tab {tab['id']}", [f"/json/close: {detail}", f"Target.closeTarget: {cdp_detail}"])})
    remaining = _poll_tabs_after_close(tab["id"])
    if remaining is None:
        remaining = [t for t in data["tabs"] if t["id"] != tab["id"]]
    if closed_active and remaining:
        survivor = next((t for t in remaining if t["id"] != tab["id"]), None)
        if survivor is not None:
            _activate_tab(survivor["id"], task_id)  # best effort — never leave nothing active
            try:
                _resync_supervisor(task_id, prefer_url=survivor.get("url") or "")
            except Exception:  # noqa: BLE001 — the close worked; the next tool re-attaches
                pass
    return json.dumps({"success": True, "closed": tab["id"], "tabs_remaining": len(remaining)})


def _same_page(a: str, b: str) -> bool:
    """Origin-level match of two page URLs (paths drift through redirects)."""
    from urllib.parse import urlsplit

    pa, pb = urlsplit(a or ""), urlsplit(b or "")
    return bool(pa.netloc) and (pa.scheme, pa.netloc) == (pb.scheme, pb.netloc)


def webview_tab_switch(tab_id: Optional[str] = None, index: Any = None, task_id: Optional[str] = None) -> str:
    """Activate the tab named by ``tab_id`` or 0-based ``index`` and snapshot it,
    so the model sees the page it switched to."""
    try:
        data = _webview_tab_targets(task_id)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": _relay_down_error() or f"tab switch failed: {exc}"})
    tab, error = _resolve_tab(data["tabs"], tab_id=tab_id, index=index,
                              active_id=data["active_id"], require_choice=True)
    if error is not None:
        return json.dumps({"success": False, "error": f"tab switch failed: {error}"})
    ok, detail = _activate_tab(tab["id"], task_id)
    if not ok:
        return json.dumps({"success": False,
                           "error": _tab_unavailable_error(f"activating tab {tab['id']}", [detail])})
    response: Dict[str, Any] = {"success": True, "tab": tab}
    try:
        _ensure_or_resync_supervisor(task_id, prefer_url=tab.get("url") or "")
    except Exception as exc:  # noqa: BLE001 — activation worked; say what is missing
        response["note"] = f"tab activated, but re-attaching the browser to it failed: {exc}"
        return json.dumps(response)
    snapshot = json.loads(webview_snapshot(task_id))
    if snapshot.get("success"):
        response["snapshot"] = snapshot.get("snapshot", "")
        snap_url = next((line[5:].strip() for line in str(snapshot.get("snapshot") or "").splitlines()
                         if line.startswith("URL: ")), "")
        if snap_url and tab.get("url") and not _same_page(snap_url, tab["url"]):
            # The attachment kept the previous tab (e.g. an origin-less URL like
            # about:blank cannot be focused on plain desktop DevTools).
            response["note"] = f"snapshot shows {snap_url} — the browser attachment may still be on the previous tab; retry browser_snapshot in a moment"
    else:
        response["note"] = f"tab activated, but snapshotting it failed: {snapshot.get('error', 'unknown error')}"
    return json.dumps(response)


def webview_console(clear: bool = False, task_id: Optional[str] = None) -> str:
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    js = "JSON.stringify({ok: true, note: 'console capture requires Runtime.consoleAPI calls; use browser_eval for page state'})"
    return _action(sup, js, "console")


def webview_screenshot(task_id: Optional[str] = None) -> str:
    """Page.captureScreenshot → file in the agent-visible workspace."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    try:
        result = _call(sup, "Page.captureScreenshot", {"format": "png"}, timeout=20.0)
        data = result.get("data")
        if not data:
            return json.dumps({"success": False, "error": "no screenshot data"})
        from hermes_constants import get_hermes_home
        shots = get_hermes_home() / "workspace" / "browser-screenshots"
        shots.mkdir(parents=True, exist_ok=True)
        path = shots / f"webview-{int(time.time())}.png"
        path.write_bytes(base64.b64decode(data))
        return json.dumps({"success": True, "path": str(path)})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"screenshot failed: {exc}"})


def webview_eval(expression: str, task_id: Optional[str] = None) -> str:
    """JS eval through the supervisor's own bridge (fast path already exists)."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    result = sup.evaluate_runtime(expression)
    if not result.get("ok"):
        return json.dumps({"success": False, "error": result.get("error", "eval failed")})
    return json.dumps({"success": True, "result": result.get("result")})

def webview_get_images(task_id: Optional[str] = None) -> str:
    """Visible images of the current tab (src + alt + dimensions)."""
    sup = _supervisor(task_id)
    if sup is None:
        return json.dumps({"success": False, "error": _NO_SESSION})
    js = (
        "JSON.stringify(Array.from(document.querySelectorAll('img'))"
        ".filter(i => i.getBoundingClientRect().width > 20)"
        ".slice(0, 40)"
        ".map(i => ({src: i.currentSrc || i.src, alt: i.alt || '',"
        " w: Math.round(i.getBoundingClientRect().width),"
        " h: Math.round(i.getBoundingClientRect().height)})))"
    )
    try:
        result = _call(sup, "Runtime.evaluate", {"expression": js, "returnByValue": True})
        images = json.loads(result.get("value") or "[]")
        return json.dumps({"success": True, "images": images})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"get_images failed: {exc}"})


def webview_vision(question: str, annotate: bool = False, task_id: Optional[str] = None) -> str:
    """Screenshot the visible tab into the workspace; the model verifies it with vision_analyze."""
    shot = json.loads(webview_screenshot(task_id))
    if not shot.get("success"):
        return json.dumps(shot)
    note = "Set-of-Mark annotation is not implemented in webview mode yet; refs come from browser_snapshot." if annotate else ""
    return json.dumps({
        "success": True,
        "path": shot["path"],
        "question": question,
        "hint": "Open the PNG with the vision tool to reason about it." + (f" {note}" if note else ""),
    })
