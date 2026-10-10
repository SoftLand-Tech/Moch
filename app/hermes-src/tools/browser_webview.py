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


def is_webview_mode() -> bool:
    """True when the Moch relay is the configured browser backend."""
    return os.environ.get("MOCH_BROWSER_RELAY", "").strip() == "1"


def _supervisor(task_id: Optional[str] = None):
    """The task's live CDP supervisor, or None (caller renders a tool error)."""
    from tools.browser_supervisor import SUPERVISOR_REGISTRY

    return SUPERVISOR_REGISTRY.get(task_id or "default")


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
            return json.dumps({"success": False, "error": _NO_SESSION})
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

def _ref_js(ref: str, expression: str) -> str:
    """JS that resolves a data-moch-ref element; expression receives `el`."""
    safe = json.dumps(ref)
    return (
        f"(() => {{ const el = document.querySelector('[data-moch-ref=\"' + {safe} + '\"]'); "
        f"if (!el) return JSON.stringify({{ok: false, error: 'stale ref {ref} — re-snapshot'}}); "
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
