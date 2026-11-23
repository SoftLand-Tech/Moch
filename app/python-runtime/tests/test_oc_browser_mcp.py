#!/usr/bin/env python3
"""BUG-148 — the host-side browser MCP adapter (``moch.oc_browser_mcp``).

Covers the three seams the device path depends on, against a FAKE relay:

1. Tool call → relay request SHAPE: /json/list reads, the PUT-then-GET
   lifecycle on /json/new (the browser_webview.py dance), the token-prefix
   gate, and the /devtools/page/<id> websocket URL the CDP client dials.
2. Tool result → MCP content: every tool maps a relay/CDP exchange onto
   {content:[text], isError} honestly (relay down, no matching element).
3. Config seeding: ``merge_mcp_config`` (pure builder) and the guest
   command sequence ``seed_opencode_config`` issues (mkdir → cat → base64
   pipe write), including the refuse-to-clobber-corrupt-file rule.

The tool-path CDP leg is stood in by a fake client class — the wire shapes
under test there are the relay HTTP calls and the URL the adapter dials. The
REAL CdpWebSocket handshake/frame plumbing gets its own raw-TCP tests: a
deliberately WRONG Sec-WebSocket-Accept must be tolerated (with a warning)
while non-101 responses still raise.

Run:

    PYTHONPATH=app/python-runtime \
        python3 app/python-runtime/tests/test_oc_browser_mcp.py

Local, stdlib-only, self-contained: expect exit 0 with ``OK``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

_TEST_DIR = Path(__file__).resolve().parent
for _p in (str(_TEST_DIR.parent),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from moch import oc_browser_mcp as obm  # noqa: E402

TOKEN = "tok123"


# ── the fake relay (HTTP only; the WS leg is faked at the client class) ─────


class _FakeRelayHandler(BaseHTTPRequestHandler):
    server_version = "FakeCdpRelay/1.0"

    def log_message(self, fmt, *args):  # noqa: N802 — silence
        pass

    def _w(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _inner(self):
        return self.path.split("/", 2)[1] if self.path.count("/") >= 2 else ""

    def _route(self):
        relay = self.server.relay
        if self._inner() != TOKEN:
            return self._w(403, b"forbidden")
        if self.path.endswith("/json/version"):
            return self._w(200, json.dumps({"Browser": "fake/1"}).encode())
        if self.path.endswith("/json/list") or self.path.endswith("/json"):
            return self._w(200, json.dumps(relay["pages"]).encode())
        if "/json/new" in self.path:
            url = ""
            if "?" in self.path:
                from urllib.parse import parse_qs, urlsplit

                q = parse_qs(urlsplit(self.path).query)
                url = (q.get("url") or [""])[0]
            relay["pages"] = [{"id": "page-1", "type": "page", "url": url,
                               "title": "Example"}]
            return self._w(200, json.dumps(relay["pages"][0]).encode())
        if "/json/close" in self.path or "/json/activate" in self.path:
            return self._w(200, b"ok")
        return self._w(404, b"no route")

    def do_GET(self):  # noqa: N802
        self.server.relay["requests"].append(("GET", self.path))
        self._route()

    def do_PUT(self):  # noqa: N802
        self.server.relay["requests"].append(("PUT", self.path))
        self._route()


class FakeRelay:
    """Owns a real HTTP server on 127.0.0.1:<ephemeral> with token routing."""

    def __init__(self):
        self.state = {"pages": [], "requests": []}
        server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeRelayHandler)
        server.relay = self.state
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        self.port = server.server_address[1]
        self.server = server
        self.root = f"http://127.0.0.1:{self.port}/{TOKEN}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def requests(self):
        return list(self.state["requests"])

    def set_pages(self, pages):
        self.state["pages"] = pages


# ── the fake CDP websocket client ───────────────────────────────────────────


class FakeCdpWebSocket:
    """Stands in for CdpWebSocket: records the dialed URL, answers evaluates
    by expression marker, records CDP calls."""

    urls: list[str] = []
    calls: list[tuple[str, dict]] = []
    evaluates: list[str] = []
    next_evaluate: object = None

    def __init__(self, url: str, timeout: float = 10.0):
        FakeCdpWebSocket.urls.append(url)

    def call(self, method, params=None):
        FakeCdpWebSocket.calls.append((method, params or {}))
        return {}

    def evaluate(self, expression, *, await_promise=False):
        FakeCdpWebSocket.evaluates.append(expression)
        if "document.readyState" in expression:
            return "complete"
        if FakeCdpWebSocket.next_evaluate is not None:
            return FakeCdpWebSocket.next_evaluate
        if "el.click()" in expression:  # click shape (may contain innerText too)
            return {"ok": True, "tag": "button", "text": "Submit"}
        if "requestSubmit" in expression:
            return {"ok": True, "submitted": True}
        if "__mochConsole" in expression:
            return [{"level": "warn", "text": "deprecation"}]
        if "innerText" in expression:  # snapshot shape
            return {"title": "Example", "url": "https://example.com/",
                    "text": "Hello world"}
        return {"title": "Example", "url": "https://example.com/"}

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


# ── real CdpWebSocket against a raw TCP peer (no relay, no client mocks) ────


def _server_text_frame(payload: bytes) -> bytes:
    """An unmasked, single-shot server text frame (FIN=1, opcode=1)."""
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


class RawHandshakeServer:
    """Tiny threaded TCP peer for CdpWebSocket handshake/frame tests.

    Sends ``response_head`` as soon as the client dials, then (optionally)
    reads ONE masked client frame and answers it with a CDP result frame
    keyed by the request id. Errors are surfaced through ``self.error`` so
    the test can assert them instead of dangling in a thread.
    """

    def __init__(self, response_head: bytes, answer_frames: bool = True):
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(1)
        self.port = self._listener.getsockname()[1]
        self.response_head = response_head
        self.answer_frames = answer_frames
        self.requests: list[bytes] = []
        self.frames: list[tuple[int, bytes]] = []
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        try:
            conn, _ = self._listener.accept()
            with conn:
                conn.settimeout(5)
                self.requests.append(self._read_until(conn, b"\r\n\r\n"))
                conn.sendall(self.response_head)
                if not self.answer_frames:
                    return
                opcode, payload = self._read_frame(conn)
                self.frames.append((opcode, payload))
                request = json.loads(payload.decode("utf-8"))
                body = json.dumps({
                    "id": request.get("id"),
                    "result": {"result": {"value": "ok"}},
                }).encode("utf-8")
                conn.sendall(_server_text_frame(body))
        except BaseException as e:  # noqa: BLE001 — asserted via self.error
            self.error = e

    @staticmethod
    def _read_until(conn, marker):
        buf = b""
        while marker not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
        return buf

    @staticmethod
    def _read_exact(conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise EOFError("client closed mid-frame")
            buf += chunk
        return buf

    def _read_frame(self, conn):
        b1, b2 = self._read_exact(conn, 2)
        opcode, masked, length = b1 & 0x0F, bool(b2 & 0x80), b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(conn, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(conn, 8))[0]
        mask = self._read_exact(conn, 4) if masked else b""
        payload = self._read_exact(conn, length)
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def wait(self, timeout: float = 5.0) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise AssertionError("raw websocket server thread did not finish")

    def close(self):
        try:
            self._listener.close()
        except OSError:
            pass


class CdpWebSocketHandshakeTest(unittest.TestCase):
    """The 101 is proof of upgrade; a bad accept only warns. Non-101 refuses."""

    _KEY = "dGhlIHNhbXBsZSBub25jZQ=="

    def _head(self, accept_line: str) -> bytes:
        return (
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            + accept_line.encode("latin-1")
            + b"\r\n"
        )

    # ── the pure helper ──

    def test_accept_matches_correct_value_any_header_case(self):
        expected = obm._ws_accept_expected(self._KEY)
        head = ("HTTP/1.1 101 Switching Protocols\r\n"
                f"sec-websocket-accept: {expected}\r\n\r\n").encode("latin-1")
        self.assertTrue(obm._ws_accept_matches(head, self._KEY))

    def test_accept_matches_rejects_wrong_value(self):
        head = ("HTTP/1.1 101 Switching Protocols\r\n"
                "Sec-WebSocket-Accept: not-the-right-value\r\n\r\n").encode("latin-1")
        self.assertFalse(obm._ws_accept_matches(head, self._KEY))

    def test_accept_matches_rejects_missing_header(self):
        head = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
        self.assertFalse(obm._ws_accept_matches(head, self._KEY))

    def test_accept_matches_rejects_accept_for_a_different_key(self):
        expected = obm._ws_accept_expected(self._KEY)
        head = ("HTTP/1.1 101 Switching Protocols\r\n"
                f"Sec-WebSocket-Accept: {expected}\r\n\r\n").encode("latin-1")
        self.assertFalse(obm._ws_accept_matches(head, "a-different-key"))

    # ── end-to-end over a real socket ──

    def test_wrong_accept_is_tolerated_and_cdp_still_works(self):
        server = RawHandshakeServer(self._head(
            "Sec-WebSocket-Accept: deliberately-wrong-accept\r\n"))
        self.addCleanup(server.close)
        with self.assertLogs("moch.oc_browser_mcp", level="WARNING") as logs:
            ws = obm.CdpWebSocket(
                f"ws://127.0.0.1:{server.port}/devtools/page/p1", timeout=5)
        self.addCleanup(ws.close)
        self.assertTrue(
            any("accept" in line.lower() for line in logs.output), logs.output)

        self.assertEqual(ws.evaluate("1"), "ok")
        server.wait()
        self.assertIsNone(server.error)

        # The client's upgrade request kept canonical header names.
        request = server.requests[0]
        self.assertIn(b"Sec-WebSocket-Key:", request)
        self.assertIn(b"Sec-WebSocket-Version: 13", request)
        # ...and the framed Runtime.evaluate actually arrived, masked.
        opcode, payload = server.frames[0]
        self.assertEqual(opcode, 0x1)
        self.assertEqual(json.loads(payload)["method"], "Runtime.evaluate")

    def test_non_101_still_raises_upgrade_refused(self):
        server = RawHandshakeServer(
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
            answer_frames=False)
        self.addCleanup(server.close)
        with self.assertRaises(obm.RelayError) as ctx:
            obm.CdpWebSocket(
                f"ws://127.0.0.1:{server.port}/devtools/page/p1", timeout=5)
        self.assertIn("websocket upgrade refused", str(ctx.exception))
        server.wait()
        self.assertIsNone(server.error)


class OcBrowserMcpTest(unittest.TestCase):
    def setUp(self):
        self.relay = FakeRelay()
        FakeCdpWebSocket.urls = []
        FakeCdpWebSocket.calls = []
        FakeCdpWebSocket.next_evaluate = None
        # Inject the fake relay + fake WS class for every test.
        patcher = mock.patch.object(obm, "_RELAY_ENDPOINT_FN", lambda: self.relay.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        ws_patcher = mock.patch.object(obm, "CdpWebSocket", FakeCdpWebSocket)
        ws_patcher.start()
        self.addCleanup(ws_patcher.stop)

    def tearDown(self):
        self.relay.close()

    # ── endpoint resolution (host-side; token never leaves the process) ──

    def test_relay_endpoint_reads_pid_gated_state_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            bdir = Path(tmp) / "browser"
            bdir.mkdir()
            state = bdir / "relay.json"
            state.write_text(json.dumps(
                {"token": "abc", "port": 9334, "pid": __import__("os").getpid()}))
            with mock.patch.dict(os.environ, {"HERMES_HOME": tmp},
                                 clear=False):
                os.environ.pop("BROWSER_CDP_URL", None)
                self.assertEqual(obm.relay_endpoint(),
                                 "http://127.0.0.1:9334/abc")
            # Stale pid (relay stopped / app restarted): honestly None.
            state.write_text(json.dumps(
                {"token": "abc", "port": 9334, "pid": 0}))
            with mock.patch.dict(os.environ, {"HERMES_HOME": tmp},
                                 clear=False):
                os.environ.pop("BROWSER_CDP_URL", None)
                self.assertIsNone(obm.relay_endpoint())

    def test_relay_down_tools_are_honest_errors(self):
        with mock.patch.object(obm, "_RELAY_ENDPOINT_FN", lambda: None):
            for fn in (obm.tool_snapshot, obm.tool_console,
                       lambda: obm.tool_click("a"),
                       lambda: obm.tool_type("a", "x"),
                       lambda: obm.tool_navigate("https://x.example")):
                text, err = fn()
                self.assertTrue(err)
                self.assertIn("relay is not running", text)

    # ── tool call → relay request shape ──

    def test_navigate_with_no_tab_runs_the_new_tab_lifecycle(self):
        text, err = obm.tool_navigate("https://example.com/")
        self.assertFalse(err, text)
        reqs = self.relay.requests()
        # The BUG-136 dance: PUT /json/new?url=… first, then re-list.
        self.assertIn(("PUT", f"/{TOKEN}/json/new?url=https%3A%2F%2Fexample.com%2F"), reqs)
        self.assertIn(("GET", f"/{TOKEN}/json/list"), reqs)
        # The CDP leg dialed the NEW page's tunnel with the token prefix.
        self.assertEqual(
            FakeCdpWebSocket.urls,
            [f"ws://127.0.0.1:{self.relay.port}/{TOKEN}/devtools/page/page-1"])
        methods = [m for m, _ in FakeCdpWebSocket.calls]
        self.assertIn("Page.navigate", methods)
        self.assertIn("Page.enable", methods)
        self.assertIn("https://example.com", text)

    def test_navigate_with_active_tab_skips_tab_creation(self):
        self.relay.set_pages([{"id": "p9", "type": "page", "url": "about:blank",
                               "title": ""}])
        _, err = obm.tool_navigate("https://example.com/2")
        self.assertFalse(err)
        self.assertFalse(any("/json/new" in p for _, p in self.relay.requests()),
                         "an active tab must not open a new one")
        self.assertTrue(FakeCdpWebSocket.urls[0].endswith("/devtools/page/p9"))

    def test_snapshot_maps_page_body_to_text_content(self):
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        text, err = obm.tool_snapshot()
        self.assertFalse(err)
        self.assertIn("Example", text)
        self.assertIn("Hello world", text)
        self.assertIn("https://example.com/", text)

    def test_click_reports_no_match_as_tool_error(self):
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        FakeCdpWebSocket.next_evaluate = {"ok": False,
                                          "error": "no visible element matches"}
        text, err = obm.tool_click("button.missing")
        self.assertTrue(err)
        self.assertIn("no visible element matches", text)

    def test_click_success_reports_the_element(self):
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        text, err = obm.tool_click("button", text="Go")
        self.assertFalse(err)
        self.assertIn("Clicked button", text)
        self.assertIn("Submit", text)
        # The text filter rode along inside the evaluated JS.
        click_js = [e for e in FakeCdpWebSocket.evaluates if "el.click()" in e]
        self.assertTrue(click_js)
        self.assertIn('"Go"', click_js[-1])

    def test_type_success_and_submit_flag(self):
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        text, err = obm.tool_type("input[name=q]", "hello", submit=True)
        self.assertFalse(err)
        self.assertIn("and submitted", text)

    def test_console_formats_entries(self):
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        text, err = obm.tool_console()
        self.assertFalse(err)
        self.assertEqual(text, "[warn] deprecation")

    # ── the MCP surface over REAL HTTP ──

    def test_adapter_http_protocol_end_to_end(self):
        started = obm.ensure_started()
        self.assertTrue(started["ok"])
        port = started["port"]
        base = f"http://127.0.0.1:{port}/"

        def post(body):
            req = urllib.request.Request(
                base, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read().decode())

        # initialize: echoes the requested protocol version.
        status, resp = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {"protocolVersion": "2025-06-18"}})
        self.assertEqual(status, 200)
        self.assertEqual(resp["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(resp["result"]["serverInfo"]["name"], obm.MCP_SERVER_NAME)

        # notification (no id): 202, no body.
        req = urllib.request.Request(
            base, data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=5) as res:
            self.assertEqual(res.status, 202)
            self.assertEqual(res.read(), b"")

        # tools/list: exactly the five browser tools.
        status, resp = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t["name"] for t in resp["result"]["tools"]]
        self.assertEqual(names, ["browser_navigate", "browser_snapshot",
                                 "browser_click", "browser_type",
                                 "browser_console"])

        # tools/call rides the injected fake relay end-to-end.
        self.relay.set_pages([{"id": "p1", "type": "page"}])
        status, resp = post({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                             "params": {"name": "browser_snapshot",
                                        "arguments": {}}})
        self.assertEqual(status, 200)
        self.assertFalse(resp["result"]["isError"])
        self.assertIn("Hello world", resp["result"]["content"][0]["text"])

        # unknown method: JSON-RPC error, still HTTP 200.
        status, resp = post({"jsonrpc": "2.0", "id": 4, "method": "nope"})
        self.assertEqual(status, 200)
        self.assertEqual(resp["error"]["code"], -32601)

        # GET: the POST-only server honestly declines the SSE stream.
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(base, timeout=5)
        self.assertEqual(ctx.exception.code, 405)
        ctx.exception.close()  # the error body is also a response — close it


class MergeConfigTest(unittest.TestCase):
    def test_fresh_config_shape_is_the_documented_remote_mcp_entry(self):
        out = json.loads(obm.merge_mcp_config("", 5123))
        self.assertEqual(out, {
            "mcp": {"moch-browser": {
                "type": "remote",
                "url": "http://127.0.0.1:5123",
                "enabled": True,
            }},
        })

    def test_existing_config_keys_and_other_servers_survive(self):
        existing = json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "theme": "dark",
            "mcp": {"other": {"type": "local", "command": ["run"], "enabled": True}},
        })
        out = json.loads(obm.merge_mcp_config(existing, 6001))
        self.assertEqual(out["theme"], "dark")
        self.assertEqual(out["$schema"], "https://opencode.ai/config.json")
        self.assertEqual(out["mcp"]["other"]["type"], "local")
        self.assertEqual(out["mcp"]["moch-browser"],
                         {"type": "remote", "url": "http://127.0.0.1:6001",
                          "enabled": True})

    def test_corrupt_existing_config_refuses_to_clobber(self):
        with self.assertRaises(ValueError):
            obm.merge_mcp_config("{not json", 6001)


class SeedConfigTest(unittest.TestCase):
    """``seed_opencode_config`` pins the GUEST command sequence: mkdir → cat
    → printf|base64 write, and the merged content is exactly what the pure
    builder produces (the same bytes the guest file ends up with)."""

    def setUp(self):
        import moch.linux_env as linux_env

        self.linux_env = linux_env
        self.calls: list[str] = []
        self.existing = ""

        def fake_exec(command, timeout_s=30):
            self.calls.append(command)
            if command.startswith("mkdir "):
                return {"ok": True, "stdout": ""}
            if command.startswith("cat "):
                return {"ok": True, "stdout": self.existing}
            if command.startswith("printf %s "):
                return {"ok": True, "stdout": ""}
            return {"ok": False, "error": "unexpected command"}

        self._patcher = mock.patch.object(linux_env, "exec_in_guest", fake_exec)
        self._patcher.start()
        self.addCleanup(self._patcher.stop)

    def _written_payload(self) -> bytes:
        writes = [c for c in self.calls if c.startswith("printf %s ")]
        self.assertEqual(len(writes), 1, f"expected one write, got {self.calls}")
        b64 = writes[0][len("printf %s "):].split()[0]
        return base64.b64decode(b64)

    def test_seed_sequence_and_merged_bytes(self):
        self.existing = '{"theme": "dark"}'
        out = obm.seed_opencode_config(4711)
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["merged"])
        self.assertEqual(
            self.calls[0], "mkdir -p /root/.config/opencode")
        self.assertIn("cat /root/.config/opencode/opencode.json", self.calls[1])
        self.assertEqual(
            self._written_payload().decode("utf-8"),
            obm.merge_mcp_config(self.existing, 4711))

    def test_seed_on_fresh_config_has_no_merge_flag(self):
        out = obm.seed_opencode_config(4712)
        self.assertTrue(out["ok"])
        self.assertFalse(out["merged"])
        self.assertEqual(json.loads(self._written_payload().decode())["mcp"]
                         ["moch-browser"]["url"], "http://127.0.0.1:4712")

    def test_seed_on_corrupt_guest_config_is_reported_not_overwritten(self):
        self.existing = "{{{"
        out = obm.seed_opencode_config(4713)
        self.assertFalse(out["ok"])
        self.assertIn("refusing to overwrite", out["error"])
        self.assertFalse(any(c.startswith("printf %s ") for c in self.calls),
                         "a corrupt config must never be written over")


if __name__ == "__main__":
    print("running test_oc_browser_mcp…")
    unittest.main(verbosity=2)
