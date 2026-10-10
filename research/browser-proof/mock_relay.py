#!/usr/bin/env python3
"""Moch WebView CDP relay MOCK — a faithful port of CdpRelay.kt's contract.

Serves 127.0.0.1:9334 with the exact wire behavior the Kotlin relay will have:
  - token path prefix auth (403 otherwise)
  - /json/version  -> upstream truth + webSocketDebuggerUrl rewritten to the
    tokenized browser path + Moch-Browser-Level: false
  - /json/list     -> filtered to ONE page target (url-matched else first)
  - /devtools/browser/<...> ws -> tunnelled to the CHOSEN PAGE target's socket
  - /json/new|close|activate -> 405
Control socket 127.0.0.1:9335: send an URL prefix (what the RN app syncs).
Upstream: a real Chromium DevTools server on 127.0.0.1:9777.
"""
from __future__ import annotations

import json
import secrets
import socket
import threading
import urllib.request

UPSTREAM = ("127.0.0.1", 9777)
LISTEN = 9334
CONTROL = 9335
TOKEN = secrets.token_hex(16)

_active_prefix: str | None = None
_lock = threading.Lock()


def set_active(prefix: str | None):
    global _active_prefix
    with _lock:
        _active_prefix = prefix or None


def chosen_page() -> dict | None:
    with _lock:
        prefix = _active_prefix
    req = urllib.request.Request(f"http://{UPSTREAM[0]}:{UPSTREAM[1]}/json/list",
                                 headers={"Host": "localhost"})
    with urllib.request.urlopen(req, timeout=5) as r:
        arr = json.loads(r.read())
    pages = [t for t in arr if t.get("type") == "page"]
    if not pages:
        return None
    if prefix:
        matching = [t for t in pages if t.get("url", "").startswith(prefix)]
        if len(matching) == 1:
            return matching[0]
    return pages[0]


def fetch_upstream(path: str) -> bytes:
    req = urllib.request.Request(f"http://{UPSTREAM[0]}:{UPSTREAM[1]}{path}",
                                 headers={"Host": "localhost"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.read()


def http_response(body: bytes, code=200, ctype="application/json; charset=UTF-8"):
    reason = {200: "OK", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
              503: "Service Unavailable"}.get(code, "Error")
    head = f"HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    return head.encode() + body


def read_head(conn: socket.socket):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        buf += chunk
    head, _, _rest = buf.partition(b"\r\n\r\n")
    lines = head.decode("latin1").split("\r\n")
    method, path, _ = lines[0].split(" ", 2)
    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return method, path, headers


def handle(conn: socket.socket):
    conn.settimeout(30)
    parsed = read_head(conn)
    if parsed is None:
        conn.close()
        return
    method, path, headers = parsed
    try:
        segs = path.split("?")[0].strip("/").split("/")
        if segs[0] != TOKEN:
            conn.sendall(http_response(b"forbidden", 403, "text/plain"))
            return
        inner = "/" + "/".join(segs[1:])

        if inner == "/json/version" and method == "GET":
            obj = json.loads(fetch_upstream("/json/version"))
            obj["webSocketDebuggerUrl"] = f"ws://127.0.0.1:{LISTEN}/{TOKEN}/devtools/browser"
            obj["Moch-Browser-Level"] = False
            conn.sendall(http_response(json.dumps(obj).encode()))
            return
        if inner in ("/json/list", "/json") and method == "GET":
            page = chosen_page()
            arr = []
            if page:
                page = dict(page)
                page["webSocketDebuggerUrl"] = f"ws://127.0.0.1:{LISTEN}/{TOKEN}/devtools/page/{page['id']}"
                arr = [page]
            conn.sendall(http_response(json.dumps(arr).encode()))
            return
        if inner.startswith(("/json/new", "/json/close", "/json/activate")):
            conn.sendall(http_response(b"tab lifecycle is native-owned", 405, "text/plain"))
            return
        if method == "GET" and inner.startswith("/devtools/"):
            if inner.startswith("/devtools/browser"):
                page = chosen_page()
                if page is None:
                    conn.sendall(http_response(b"no live page target", 503, "text/plain"))
                    return
                inner = f"/devtools/page/{page['id']}"
            tunnel(conn, inner, headers)
            return
        conn.sendall(http_response(b"no route", 404, "text/plain"))
    except Exception as e:  # noqa: BLE001
        print("relay handler error:", e, flush=True)
        try:
            conn.sendall(http_response(str(e).encode(), 502, "text/plain"))
        except OSError:
            pass
    finally:
        if inner_path_is_ws(locals().get("inner", "")):
            return  # tunnel owns the socket
        try:
            conn.close()
        except OSError:
            pass


def inner_path_is_ws(inner: str) -> bool:
    return inner.startswith("/devtools/")


def tunnel(client: socket.socket, inner_path: str, client_headers: dict):
    up = socket.create_connection(UPSTREAM)
    key = client_headers.get("sec-websocket-key") or (secrets.token_urlsafe(16))
    req = (
        f"GET {inner_path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    up.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = up.recv(4096)
        if not chunk:
            break
        resp += chunk
    client.sendall(resp)
    if not resp.startswith(b"HTTP/1.1 101"):
        client.close()
        up.close()
        print("tunnel upgrade refused:", resp[:120], flush=True)
        return

    def pump(src, dst):
        try:
            while True:
                data = src.recv(1 << 20)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.close()
                except OSError:
                    pass

    threading.Thread(target=pump, args=(client, up), daemon=True).start()
    pump(up, client)


def control_server():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", CONTROL))
    srv.listen(8)
    while True:
        conn, _ = srv.accept()
        try:
            url = conn.recv(4096).decode().strip()
            set_active(url or None)
            conn.sendall(b"ok")
        except Exception:  # noqa: BLE001
            pass
        finally:
            conn.close()


def main():
    threading.Thread(target=control_server, daemon=True).start()
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", LISTEN))
    srv.listen(16)
    print(f"MOCK_RELAY_READY token={TOKEN}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
