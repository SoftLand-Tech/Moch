"""Host-side MCP adapter fronting the Moch browser CDP relay (BUG-148).

OpenCode (running INSIDE the proot guest) cannot read
``$HERMES_HOME/browser/relay.json`` — guest binds are workspace/scratch/dev/
proc only (linux_env.py), so the relay token must never reach the guest.
But the guest shares the phone's network namespace: it CAN dial phone
loopback. This adapter splits exactly along that line:

  opencode (guest) --HTTP-MCP--> THIS FILE (phone) --token'd CDP--> CdpRelay

It is a minimal MCP server (streamable-HTTP shape: JSON-RPC over POST,
plain application/json responses — the spec's "server MAY reply without
SSE" mode; stdlib http.server only, no new deps) exposing five browser
tools that map onto the same relay calls hermes' own
``tools/browser_webview.py`` makes: ``/json/list`` (active-tab filtered),
``/json/moch-tabs`` semantics via ``/json/list``, the PUT-then-GET
lifecycle dance on ``/json/new``, and CDP ``Runtime.evaluate`` /
``Page.navigate`` over a per-call ``/devtools/page/<id>`` WebSocket.

The token is read HOST-side (env override ``BROWSER_CDP_URL``, else the
pid-gated relay.json — the same gate hermes_boot.py uses, so a stale
file reads as "relay down" rather than a dead endpoint) and never
crosses into the guest.

Lifecycle: ``ensure_started()`` is called from ``opencode_server``'s
ensure path — i.e. only when OpenCode mode is actually used. Hermes-only
users never pay for it (the thread + loopback socket only exist after a
first oc use). The chosen port is logged AND returned so the caller can
seed ``~/.config/opencode/opencode.json`` (guest) with an ``mcp`` entry
of opencode's documented ``remote`` shape pointing here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import socket
import struct
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

MCP_SERVER_NAME = "moch-browser"
MCP_SERVER_VERSION = "1.0.0"
_DEFAULT_PROTOCOL_VERSION = "2025-03-26"
_SNAPSHOT_CHARS = 4000
_NAV_WAIT_S = 8.0
# Preferred loopback port for the adapter. A surviving guest `opencode serve`
# keeps the URL from the config seeded on an earlier app run; an ephemeral
# port would leave that URL dead until the guest restarts (BUG-148 P2). 9336
# is unused in this repo (gateway=9119, CDP relay prefers 9334, opencode
# serve=4096). If it is taken, ensure_started() falls back to port 0.
_PREFERRED_PORT = 9336
# The seed path inside the guest. opencode reads it at startup (~/.config
# under its HOME=/root); see seed_opencode_config for the write mechanics.
OC_CONFIG_PATH = "/root/.config/opencode/opencode.json"

_RELAY_DOWN_TEXT = (
    "The Moch browser relay is not running — there is no browser to drive "
    "right now. Ask the user to open the Browser screen in Moch once "
    "(drawer → Browser), then retry."
)


class RelayError(RuntimeError):
    """A relay transport failure — tools surface it as an MCP isError."""


# ── relay endpoint (HOST side; the token never leaves this process) ─────────


def _hermes_home() -> str:
    # Mirror of hermes_boot._hermes_home / CdpRelay.hermesHomeDir(): env
    # override, else HOME/.hermes (Chaquopy HOME == app filesDir).
    return os.environ.get("HERMES_HOME") or os.path.join(
        os.environ.get("HOME") or "", ".hermes")


def relay_endpoint() -> Optional[str]:
    """``http://127.0.0.1:<port>/<token>`` for a LIVE relay, else None.

    Order: an externally-set BROWSER_CDP_URL wins (manual PC runs, the same
    override hermes_boot respects); otherwise relay.json, armed ONLY when its
    `pid` is THIS process — the relay is in-process (CdpRelay shares the app
    pid), so a stale pid means the relay is down right now (BUG-105's gate,
    reused verbatim). None is an honest "no browser", never a guess.
    """
    env = os.environ.get("BROWSER_CDP_URL", "").strip()
    if env:
        return env.rstrip("/")
    try:
        path = os.path.join(_hermes_home(), "browser", "relay.json")
        with open(path, "r", encoding="utf-8") as fh:
            relay = json.load(fh)
        port, token = int(relay.get("port") or 0), str(relay.get("token") or "")
        pid = int(relay.get("pid") or 0)
        if port > 0 and token and pid == os.getpid():
            return f"http://127.0.0.1:{port}/{token}"
    except Exception:  # noqa: BLE001 — absent/unreadable state file = relay down
        pass
    return None


# Test seam: the tools resolve the relay through this indirection so a fake
# relay can be injected without touching env/files.
_RELAY_ENDPOINT_FN: Callable[[], Optional[str]] = relay_endpoint


# ── relay HTTP (the /json/* surface, same verbs browser_webview uses) ───────


def _relay_http(root: str, path: str, *, verb: str = "GET",
                timeout: float = 10.0) -> tuple[int, str]:
    """One token-prefixed HTTP call; returns (status, body). Raises
    RelayError on transport failure — callers shape the tool error."""
    url = f"{root}{path}"
    req = urllib.request.Request(url, method=verb)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — body is best-effort
            body = ""
        return e.code, body
    except Exception as e:  # noqa: BLE001
        raise RelayError(f"{type(e).__name__}: {e}") from e


def _relay_lifecycle(root: str, path: str) -> tuple[int, str]:
    """PUT-then-GET on /json/new|close|activate — browser_webview.py's
    dance (Chrome ≥63 wants PUT; older builds GET; the relay accepts both)."""
    status, body = _relay_http(root, path, verb="PUT")
    if status != 405:
        return status, body
    return _relay_http(root, path, verb="GET")


def _active_page(root: str) -> Optional[dict]:
    """The ACTIVE page target from /json/list (the relay advertises at most
    one) — exactly the attach source webview tools use."""
    status, body = _relay_http(root, "/json/list")
    if status != 200:
        raise RelayError(f"/json/list returned HTTP {status}")
    try:
        pages = json.loads(body)
    except json.JSONDecodeError as e:
        raise RelayError(f"/json/list returned non-JSON: {e}") from e
    for p in pages if isinstance(pages, list) else []:
        if isinstance(p, dict) and p.get("id"):
            return p
    return None


def _ws_url_for(root: str, target_id: str) -> str:
    ws = "ws" + root[4:]  # http://…/<token> → ws://…/<token>
    return f"{ws}/devtools/page/{urllib.parse.quote(target_id, safe='')}"


# ── minimal CDP-over-WebSocket client (stdlib only) ─────────────────────────

_WS_ACCEPT_GUID = "258EAFA9-E714-47DA-95CA-C5AB0DC85B11"


def _ws_accept_expected(key: str) -> str:
    """RFC 6455 accept value: base64(sha1(client key + magic GUID))."""
    return base64.b64encode(hashlib.sha1(
        (key + _WS_ACCEPT_GUID).encode("ascii")).digest()).decode("ascii")


def _ws_accept_header(head: bytes) -> Optional[str]:
    """The handshake response's Sec-WebSocket-Accept (header name any case)."""
    for line in head.split(b"\r\n"):
        name, sep, value = line.partition(b":")
        if sep and name.strip().lower() == b"sec-websocket-accept":
            return value.strip().decode("latin-1", errors="replace")
    return None


def _ws_accept_matches(head: bytes, key: str) -> bool:
    """Pure check: an exact accept match, or False when absent/mismatched.

    Never raises — the handshake uses this only to decide whether to log.
    """
    received = _ws_accept_header(head)
    return received is not None and received == _ws_accept_expected(key)


class CdpWebSocket:
    """A blocking, one-command-at-a-time CDP client over a raw WebSocket.

    Enough of RFC 6455 for the relay's tunnel: upgrade handshake, masked
    client text frames, unmasked server frames (fragmentation assembled),
    auto-pong. CDP events are skipped; only the matching id's response is
    returned.
    """

    def __init__(self, url: str, timeout: float = 10.0):
        self._timeout = timeout
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._sock.settimeout(timeout)
        self._buf = b""
        self._next_id = 0
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode("ascii"))
        head = self._read_until(b"\r\n\r\n")
        first = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101" not in f" {first} ":
            self.close()
            raise RelayError(f"websocket upgrade refused: {first}")
        # Tolerant accept check: a 101 is proof the upgrade reached the
        # DevTools target. The relay is pid-gated + token-gated loopback and
        # the accept value is not used after the handshake, so a mismatch (or
        # an absent header) is a WARNING, not a failure. Strict RFC
        # verification false-positived on-device — the Kotlin tunnel re-cased
        # the upgrade headers — and broke every browser tool.
        if not _ws_accept_matches(head, key):
            logger.warning(
                "websocket accept mismatch (continuing): received=%r expected=%r "
                "head=%r",
                _ws_accept_header(head), _ws_accept_expected(key),
                head[:300].decode("latin-1", errors="replace"),
            )

    # ── framing ──
    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RelayError("connection closed during handshake/read")
            self._buf += chunk
        out, _, self._buf = self._buf.partition(marker)
        return out + marker

    def _read_frame(self) -> tuple[bool, int, bytes]:
        while len(self._buf) < 2:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RelayError("connection closed mid-frame")
            self._buf += chunk
        b1, b2 = self._buf[0], self._buf[1]
        fin, opcode = bool(b1 & 0x80), b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        need = 2
        if length == 126:
            need = 4
        elif length == 127:
            need = 10
        while len(self._buf) < need:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RelayError("connection closed mid-frame")
            self._buf += chunk
        if length == 126:
            length = struct.unpack(">H", self._buf[2:4])[0]
        elif length == 127:
            length = struct.unpack(">Q", self._buf[2:10])[0]
        mask = b""
        if masked:
            while len(self._buf) < need + 4:
                chunk = self._sock.recv(4096)
                if not chunk:
                    raise RelayError("connection closed mid-frame")
                self._buf += chunk
            mask = self._buf[need:need + 4]
            need += 4
        end = need + length
        while len(self._buf) < end:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RelayError("connection closed mid-frame")
            self._buf += chunk
        payload, self._buf = self._buf[need:end], self._buf[end:]
        if masked and mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, opcode, payload

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self._sock.sendall(bytes(header) + bytes(
            b ^ mask[i % 4] for i, b in enumerate(payload)))

    # ── CDP ──
    def call(self, method: str, params: Optional[dict] = None) -> dict:
        self._next_id += 1
        mid = self._next_id
        self._send_frame(0x1, json.dumps(
            {"id": mid, "method": method, "params": params or {}}).encode("utf-8"))
        assembled = b""
        assembled_op = 0
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:  # ping → pong (the relay tunnels upstream pings)
                self._send_frame(0xA, payload)
                continue
            if opcode == 0x8:  # close
                raise RelayError("page websocket closed by relay")
            if opcode in (0x1, 0x2, 0x0):
                if opcode != 0x0 and fin:
                    msg = payload
                else:
                    if opcode != 0x0:
                        assembled, assembled_op = b"", opcode
                    assembled += payload
                    if not fin:
                        continue
                    msg = assembled
                try:
                    data = json.loads(msg.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue  # not CDP-shaped; skip like any consumer would
                if isinstance(data, dict) and data.get("id") == mid:
                    if "error" in data:
                        raise RelayError(
                            f"{method} failed: {json.dumps(data['error'])[:200]}")
                    return data.get("result") or {}

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        """Runtime.evaluate with returnByValue; unwraps the RemoteObject."""
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        details = result.get("exceptionDetails")
        if details:
            text = json.dumps(details.get("exception", {}) or details)[:200]
            raise RelayError(f"page evaluation failed: {text}")
        obj = result.get("result") or {}
        return obj.get("value")

    def close(self) -> None:
        try:
            self._sock.close()
        except Exception:  # noqa: BLE001 — close is best-effort
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


# ── the five tools ───────────────────────────────────────────────────────────


def _js_literal(value: Any) -> str:
    """Embed a python value in a JS snippet as a literal (JSON is valid JS)."""
    return json.dumps(value, ensure_ascii=False)


def _open_ws(root: str) -> tuple[CdpWebSocket, dict]:
    page = _active_page(root)
    if page is None:
        raise RelayError("no open tab")
    return CdpWebSocket(_ws_url_for(root, str(page["id"]))), page


def _settle_page(ws: CdpWebSocket) -> None:
    """Bounded wait for document.readyState === complete (best effort)."""
    deadline = time.time() + _NAV_WAIT_S
    while time.time() < deadline:
        try:
            state = ws.evaluate("document.readyState")
        except RelayError:
            return  # navigation tears down the old JS world — that's fine
        if state == "complete":
            return
        time.sleep(0.4)


def tool_navigate(url: str) -> tuple[str, bool]:
    """Open `url`: the active tab when one exists, else /json/new (the
    RN-round-trip lifecycle, PUT-then-GET like browser_webview)."""
    if not isinstance(url, str) or not url.strip():
        return "url is required", True
    root = _RELAY_ENDPOINT_FN()
    if not root:
        return _RELAY_DOWN_TEXT, True
    try:
        page = _active_page(root)
        if page is None:
            status, body = _relay_lifecycle(
                root, "/json/new?url=" + urllib.parse.quote(url.strip(), safe=""))
            if status >= 400:
                return f"opening a tab failed (HTTP {status}): {body.strip()[:160]}", True
            # BUG-136's resolve step: /json/new's ack precedes the target's
            # appearance — re-list to find the page the RN owner created.
            page = _active_page(root)
            if page is None:
                return "the tab was requested but the relay lists no page target yet", True
        with CdpWebSocket(_ws_url_for(root, str(page["id"]))) as ws:
            ws.call("Page.enable")
            ws.call("Page.navigate", {"url": url.strip()})
            _settle_page(ws)
            info = ws.evaluate(
                "({title: document.title, url: location.href})") or {}
            return f"Navigated to {info.get('url') or url.strip()}" + (
                f" — “{info.get('title')}”" if info.get("title") else ""), False
    except RelayError as e:
        return f"navigate failed: {e}", True


def tool_snapshot() -> tuple[str, bool]:
    """Text snapshot of the active tab (title, URL, visible text)."""
    root = _RELAY_ENDPOINT_FN()
    if not root:
        return _RELAY_DOWN_TEXT, True
    try:
        with _open_ws(root)[0] as ws:
            info = ws.evaluate(
                "({title: document.title, url: location.href,"
                " text: (document.body ? document.body.innerText : '')"
                f".slice(0, {_SNAPSHOT_CHARS})}})") or {}
            head = f"{info.get('title') or 'Untitled'}\n{info.get('url') or ''}\n\n"
            return head + (info.get("text") or ""), False
    except RelayError as e:
        return f"snapshot failed: {e}", True


def tool_click(selector: str, text: str = "") -> tuple[str, bool]:
    """Click the first visible element matching `selector` (optionally the
    first whose text contains `text`)."""
    if not isinstance(selector, str) or not selector.strip():
        return "selector is required", True
    root = _RELAY_ENDPOINT_FN()
    if not root:
        return _RELAY_DOWN_TEXT, True
    text_filter = (
        f" && (el.innerText || '').includes({_js_literal(text)})"
        if isinstance(text, str) and text else ""
    )
    js = (
        "(() => {"
        f"const els = Array.from(document.querySelectorAll({_js_literal(selector)}))"
        ".filter(el => el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)"
        f"{text_filter});"
        "if (!els.length) return {ok: false, error: 'no visible element matches'};"
        "const el = els[0];"
        "el.scrollIntoView({block: 'center'});"
        "el.click();"
        "return {ok: true, tag: el.tagName.toLowerCase(),"
        " text: ((el.innerText || el.value || '') + '').trim().slice(0, 120)};"
        "})()"
    )
    try:
        with _open_ws(root)[0] as ws:
            out = ws.evaluate(js) or {}
            if not out.get("ok"):
                return str(out.get("error") or "the click did not land"), True
            return f"Clicked {out.get('tag', 'element')}" + (
                f" “{out.get('text')}”" if out.get("text") else ""), False
    except RelayError as e:
        return f"click failed: {e}", True


def tool_type(selector: str, text: str, submit: bool = False) -> tuple[str, bool]:
    """Replace the value of `selector` with `text` (native setter + input/
    change events so React-style listeners fire); optionally submit."""
    if not isinstance(selector, str) or not selector.strip():
        return "selector is required", True
    if not isinstance(text, str):
        return "text is required", True
    root = _RELAY_ENDPOINT_FN()
    if not root:
        return _RELAY_DOWN_TEXT, True
    js = (
        "(() => {"
        f"const el = document.querySelector({_js_literal(selector)});"
        "if (!el) return {ok: false, error: 'no element matches the selector'};"
        "el.focus();"
        "const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype"
        ": ((el instanceof HTMLInputElement) ? HTMLInputElement.prototype : null);"
        "if (proto) {"
        "Object.getOwnPropertyDescriptor(proto, 'value').set.call(el,"
        f"{_js_literal(text)});"
        "} else { el.textContent = " + _js_literal(text) + "; }"
        "el.dispatchEvent(new Event('input', {bubbles: true}));"
        "el.dispatchEvent(new Event('change', {bubbles: true}));"
        f"let submitted = {str(bool(submit)).lower()};"
        "if (submitted) {"
        "const form = el.form || el.closest('form');"
        "if (form && typeof form.requestSubmit === 'function') form.requestSubmit();"
        "else el.dispatchEvent(new KeyboardEvent('keydown',"
        "{key: 'Enter', code: 'Enter', bubbles: true}));"
        "}"
        "return {ok: true, submitted};"
        "})()"
    )
    try:
        with _open_ws(root)[0] as ws:
            out = ws.evaluate(js) or {}
            if not out.get("ok"):
                return str(out.get("error") or "the typing did not land"), True
            msg = f"Typed into {selector}"
            if out.get("submitted"):
                msg += " and submitted"
            return msg, False
    except RelayError as e:
        return f"type failed: {e}", True


_CONSOLE_TAP_JS = (
    "(() => {"
    "const w = window;"
    "if (!w.__mochConsole) {"
    "w.__mochConsole = [];"
    "const push = (level) => (...args) => {"
    "try {"
    "if (w.__mochConsole.length < 500) w.__mochConsole.push({level, text: args.map(a => {"
    "try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }"
    "}).join(' ')});"
    "} catch {}"
    "const orig = w.__mochOrig && w.__mochOrig[level];"
    "if (orig) orig.apply(console, args);"
    "};"
    "w.__mochOrig = {log: console.log.bind(console), warn: console.warn.bind(console),"
    "error: console.error.bind(console), info: console.info.bind(console)};"
    "console.log = push('log'); console.warn = push('warn');"
    "console.error = push('error'); console.info = push('info');"
    "w.addEventListener('error', (e) => { try {"
    "if (w.__mochConsole.length < 500) w.__mochConsole.push({level: 'error',"
    "text: 'Uncaught: ' + e.message}); } catch {} });"
    "}"
    "return w.__mochConsole.splice(0, w.__mochConsole.length);"
    "})()"
)


def tool_console() -> tuple[str, bool]:
    """Console entries collected since the tap was installed (first call
    installs it — captures only what logs from then on; said so honestly)."""
    root = _RELAY_ENDPOINT_FN()
    if not root:
        return _RELAY_DOWN_TEXT, True
    try:
        with _open_ws(root)[0] as ws:
            entries = ws.evaluate(_CONSOLE_TAP_JS) or []
            if not isinstance(entries, list):
                return "console tap returned unexpected data", True
            if not entries:
                return ("No console entries — the tap captures output from the "
                        "first browser_console call onward.", False)
            lines = [f"[{e.get('level', 'log')}] {e.get('text', '')}".rstrip()
                     for e in entries if isinstance(e, dict)]
            return "\n".join(lines), False
    except RelayError as e:
        return f"console failed: {e}", True


# ── opencode config seeding (pure builder + guest write) ────────────────────


def merge_mcp_config(existing_text: Optional[str], port: int) -> str:
    """Pure: the opencode.json contents for adapter `port`.

    Merges the `mcp` key into whatever config already exists (the user may
    have created one — never clobbered). A CORRUPT existing file raises
    ValueError: overwriting it would destroy user data we cannot recover.
    Shape: opencode's documented remote MCP entry —
    ``{"mcp": {"<name>": {"type": "remote", "url": …, "enabled": true}}}``.
    """
    cfg: dict = {}
    if existing_text and existing_text.strip():
        try:
            parsed = json.loads(existing_text)
        except json.JSONDecodeError as e:
            raise ValueError(
                "existing opencode.json is not valid JSON — refusing to overwrite") from e
        if isinstance(parsed, dict):
            cfg = parsed
    mcp = cfg.get("mcp")
    if not isinstance(mcp, dict):
        mcp = {}
    mcp[MCP_SERVER_NAME] = {
        "type": "remote",
        "url": f"http://127.0.0.1:{int(port)}",
        "enabled": True,
    }
    cfg["mcp"] = mcp
    return json.dumps(cfg, indent=2, ensure_ascii=False) + "\n"


def seed_opencode_config(port: int) -> dict:
    """Merge the moch-browser MCP entry into the GUEST's opencode.json.

    Read-modify-write through exec_in_guest (cat / base64 pipe — no guest
    python/jq assumed). Best-effort by contract: callers log failures and
    carry on; oc chat works without the browser tools.
    """
    from moch import linux_env  # lazy: keeps this module import-light

    made = linux_env.exec_in_guest("mkdir -p /root/.config/opencode", timeout_s=30)
    if not made.get("ok"):
        return {"ok": False,
                "error": f"mkdir failed: {made.get('error') or made.get('stderr') or 'guest error'}"}
    read = linux_env.exec_in_guest(f"cat {OC_CONFIG_PATH} 2>/dev/null || true", timeout_s=30)
    if not read.get("ok"):
        return {"ok": False,
                "error": f"config read failed: {read.get('error') or 'guest error'}"}
    existing = read.get("stdout") or ""
    try:
        merged = merge_mcp_config(existing, port)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    b64 = base64.b64encode(merged.encode("utf-8")).decode("ascii")
    wrote = linux_env.exec_in_guest(
        f"printf %s {b64} | base64 -d > {OC_CONFIG_PATH}", timeout_s=30)
    if not wrote.get("ok"):
        return {"ok": False,
                "error": f"config write failed: {wrote.get('error') or wrote.get('stderr') or 'guest error'}"}
    return {"ok": True, "path": OC_CONFIG_PATH, "merged": bool(existing.strip())}


# ── the MCP streamable-HTTP surface ─────────────────────────────────────────


def _tool_defs() -> list[dict]:
    """The five tools. Descriptions say what the tool HONESTLY does (text
    snapshot, tap-installed console) — no overpromising."""
    return [
        {
            "name": "browser_navigate",
            "description": (
                "Open a URL in the Moch in-app browser (the user's active tab, "
                "or a new tab when none is open). Waits briefly for the page to load."),
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string",
                                       "description": "Absolute http(s):// URL to open"}},
                "required": ["url"],
            },
        },
        {
            "name": "browser_snapshot",
            "description": "Read the active tab as text: title, URL and visible page text.",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "browser_click",
            "description": (
                "Click an element in the active tab. `selector` is a CSS selector; "
                "pass `text` to click the first visible match whose text contains it."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector"},
                    "text": {"type": "string",
                             "description": "Only click matches whose visible text contains this"},
                },
                "required": ["selector"],
            },
        },
        {
            "name": "browser_type",
            "description": (
                "Replace the text of an input/textarea/contenteditable in the active "
                "tab (fires input/change events), optionally submitting the form."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector"},
                    "text": {"type": "string", "description": "The text to enter"},
                    "submit": {"type": "boolean",
                               "description": "Submit the enclosing form after typing"},
                },
                "required": ["selector", "text"],
            },
        },
        {
            "name": "browser_console",
            "description": (
                "Console entries (log/warn/error/info + uncaught errors) collected "
                "since the tap was installed — the tap begins at this tool's first call."),
            "inputSchema": {"type": "object", "properties": {}},
        },
    ]


_TOOLS: dict[str, Callable[..., tuple[str, bool]]] = {
    "browser_navigate": lambda **a: tool_navigate(a.get("url") or ""),
    "browser_click": lambda **a: tool_click(
        a.get("selector") or "", a.get("text") or ""),
    "browser_type": lambda **a: tool_type(
        a.get("selector") or "", a.get("text") if isinstance(a.get("text"), str) else "",
        bool(a.get("submit"))),
    "browser_snapshot": lambda **a: tool_snapshot(),
    "browser_console": lambda **a: tool_console(),
}


def _jsonrpc_result(rid: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _jsonrpc_error(rid: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle_jsonrpc(payload: bytes) -> tuple[Optional[dict], int]:
    """One JSON-RPC message → (response-or-None, http status).

    Returns (None, 202) for notifications (no body, per the streamable-HTTP
    spec). Unknown methods are -32601; a tool failure is a NORMAL result with
    isError:true — the model reads the text, not a protocol error.
    """
    try:
        msg = json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _jsonrpc_error(None, -32700, "parse error"), 400
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _jsonrpc_error(None, -32600, "invalid request"), 400
    method = msg.get("method")
    rid = msg.get("id")
    if not method:
        return _jsonrpc_error(rid, -32600, "missing method"), 400
    if method == "initialize":
        params = msg.get("params") or {}
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and requested \
            else _DEFAULT_PROTOCOL_VERSION
        return _jsonrpc_result(rid, {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": MCP_SERVER_NAME, "version": MCP_SERVER_VERSION},
        }), 200
    if method == "tools/list":
        return _jsonrpc_result(rid, {"tools": _tool_defs()}), 200
    if method == "tools/call":
        params = msg.get("params") or {}
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        fn = _TOOLS.get(name)
        if fn is None:
            return _jsonrpc_error(rid, -32602, f"unknown tool: {name}"), 200
        try:
            text, is_error = fn(**args)
        except TypeError as e:
            text, is_error = f"bad arguments for {name}: {e}", True
        except Exception as e:  # noqa: BLE001 — a crash becomes an honest tool error
            text, is_error = f"{name} failed: {type(e).__name__}: {e}", True
        return _jsonrpc_result(rid, {
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
        }), 200
    if rid is None:
        return None, 202  # a notification we don't handle — accepted silently
    return _jsonrpc_error(rid, -32601, f"method not found: {method}"), 200


class _McpHandler(BaseHTTPRequestHandler):
    server_version = MCP_SERVER_NAME + "/" + MCP_SERVER_VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        logger.debug("%s %s", self.address_string(), fmt % args)

    def _reply(self, status: int, body: Optional[bytes], content_type: str) -> None:
        self.send_response(status)
        if body is None:
            # 202-accepted notifications still need a framed empty response.
            self.send_header("Content-Length", "0")
        else:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 — http.server naming
        if self.path.rstrip("/").endswith("moch-browser-mcp"):
            pass  # a named path is tolerated; the endpoint is "/" (+ anything)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        payload = self.rfile.read(length) if length > 0 else b""
        response, status = handle_jsonrpc(payload)
        if response is None:
            self._reply(status, None, "application/json")
            return
        self._reply(status, json.dumps(response).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        # No SSE channel: this server has nothing to push. 405 tells a
        # spec-compliant client the GET stream is not offered.
        self._reply(405, b"GET stream not offered (POST-only MCP server)\n",
                    "text/plain")

    do_DELETE = do_GET


# ── lifecycle ────────────────────────────────────────────────────────────────

_SERVER: Optional[ThreadingHTTPServer] = None
_PORT = 0
_LOCK = threading.Lock()


def ensure_started() -> dict:
    """Start the adapter once per process; idempotent.

    Bound to 127.0.0.1, preferring the STABLE port ``_PREFERRED_PORT`` so a
    surviving guest ``opencode serve`` keeps a valid seeded
    ``~/.config/opencode/opencode.json`` across app restarts. If that port is
    taken, falls back to an ephemeral port (port 0) exactly as before. Either
    way the bound port is logged and returned — it remains the authoritative
    value, and seeding still runs on every ensure. A daemon thread: the
    adapter lives as long as the app process, which already runs the gateway
    and the terminal session.
    """
    global _SERVER, _PORT
    with _LOCK:
        if _SERVER is not None:
            return {"ok": True, "port": _PORT, "started": False}
        server: Optional[ThreadingHTTPServer] = None
        stable = False
        try:
            server = ThreadingHTTPServer(("127.0.0.1", _PREFERRED_PORT), _McpHandler)
            stable = True
        except OSError as e:
            logger.warning(
                "moch browser MCP adapter could not bind 127.0.0.1:%d (%s); "
                "falling back to an ephemeral port", _PREFERRED_PORT, e)
        if server is None:
            try:
                server = ThreadingHTTPServer(("127.0.0.1", 0), _McpHandler)
            except Exception as e:  # noqa: BLE001 — an unbindable loopback is the answer
                return {"ok": False, "error": f"bind failed: {type(e).__name__}: {e}"}
        port = int(server.server_address[1])
        thread = threading.Thread(
            target=server.serve_forever, name="oc-browser-mcp", daemon=True)
        thread.start()
        _SERVER, _PORT = server, port
        logger.info(
            "moch browser MCP adapter listening on 127.0.0.1:%d (%s port)",
            port, "preferred" if stable else "ephemeral")
        # stdout too: the phone-side log capture reads the interpreter's
        # stdout; logger alone may not survive every log sink.
        print(f"[oc-browser-mcp] listening on 127.0.0.1:{port} "
              f"({'preferred' if stable else 'ephemeral'} port)", flush=True)
        return {"ok": True, "port": port, "started": True}
