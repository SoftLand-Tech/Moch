#!/usr/bin/env python3
"""BUG-120 / GitHub #67 regression tests — the embedded loopback gateway must
NOT hand its session token to an unauthenticated ``GET /``.

Local, self-contained, no network, no device, no HTTP server: run with

    python3 app/python-runtime/tests/test_gateway_root_shim.py

and expect exit 0 with ``OK``. On interpreters without the dashboard stack
(bare ``python3``: no fastapi) the full-stack class skips cleanly while the
stdlib contract class still runs; with the embedded venv
(``app/.venv-embedcheck/bin/python``) everything runs. Mirrors
test_browser_boot_gate.py conventions.

The failure this pins: under ``HERMES_SERVE_HEADLESS=1`` hermes' SPA mount
(``hermes_cli.web_server_dashboard.mount_spa``) registers a catch-all
``GET /{full_path:path}`` whose root branch answers 200 with an HTML page
embedding ``window.__HERMES_SESSION_TOKEN__=<the live gateway token>`` — a
desktop-Electron handshake with no consumer in the embedded app (the RN client
receives the token over the JNI bridge and authenticates via
``X-Hermes-Session-Token`` / WS ``?token=``). The gateway binds plain loopback
TCP (127.0.0.1:9119), reachable by every app on the phone, so any co-installed
app could read the token and drive the full API.
``moch.gateway_server._run_server`` now calls
``_neutralize_root_token_handshake`` before ``start_server``: the shim's
catch-all route is swapped for an endpoint that always returns the shim's own
no-token 404 JSON. These tests pin (a) the neutralized root serves no token,
(b) the swap is idempotent and surgical (every other route — /api/*, public
paths, ``/api/ws`` — untouched), (c) the pre-fix shim really did serve the
token (so the pin is anchored in the actual upstream shape, guarded to skip if
that shape ever changes), all asserted without an HTTP server — via the route
table, the endpoints directly, and a full ASGI dispatch of ``GET /``.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# moch.gateway_server is stdlib-only at import time — safe on bare python3.
from moch.gateway_server import (  # noqa: E402
    _ROOT_SHIM_MARKER,
    _ROOT_SHIM_PATH,
    _neutralize_root_token_handshake,
)

_TOKEN = "bug120-" + "t" * 27  # known value: proves the page leaks the LIVE token


def _is_catch_all(route) -> bool:
    """The upstream shim's shape: GET on the catch-all path template.

    Deliberately hardcoded here (not imported from the neutralizer) so the
    test independently pins the route shape the fix targets.
    """
    return (
        getattr(route, "path", None) == "/{full_path:path}"
        and "GET" in (getattr(route, "methods", None) or ())
    )


def _drive_asgi(app, path: str):
    """Dispatch one real request through the full ASGI app — no socket.

    Returns ``(status, body_bytes)``. Goes through every middleware exactly
    like a live request would.
    """

    async def _run():
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "scheme": "http",
            "query_string": b"",
            "headers": [(b"host", b"127.0.0.1")],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 9119),
        }
        messages = []

        async def receive():
            return {"type": "http.request", "body": b""}

        async def send(message):
            messages.append(message)

        await app(scope, receive, send)
        status = next(m["status"] for m in messages if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        return status, body

    return asyncio.run(_run())


def _import_headless_stack():
    """Import the REAL ``hermes_cli.web_server`` in headless mode.

    The SPA mount runs at import time, so the returned app carries the actual
    shim routes the embedded gateway boots with. Raises ImportError (→ skip)
    when the dashboard stack is unavailable to this interpreter.
    """
    for mod in ("fastapi", "uvicorn"):  # cheap pre-check for a clean skip reason
        try:
            __import__(mod)
        except ImportError as exc:
            raise ImportError(f"{mod} unavailable to {sys.executable}") from exc
    import hermes_cli.web_server as ws

    return ws, ws.app


class RootShimNeutralizerTests(unittest.TestCase):
    """The live hermes app, mounted headless: `/` must hold no token."""

    @classmethod
    def setUpClass(cls):
        try:
            cls._env_snapshot = dict(os.environ)
            cls._tmp = tempfile.TemporaryDirectory()
            os.environ["HERMES_HOME"] = str(Path(cls._tmp.name) / ".hermes")
            os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = _TOKEN  # how moch boots it
            os.environ["HERMES_SERVE_HEADLESS"] = "1"  # armed by gateway_server.start()
            cls.ws, cls.app = _import_headless_stack()
        except ImportError as exc:
            raise unittest.SkipTest(f"dashboard stack unavailable ({exc}) — full-coverage tests skipped")
        # PRE-neutralization snapshot (the shim is live right after import).
        cls._shim_endpoints = [r.endpoint for r in cls.app.router.routes if _is_catch_all(r)]
        cls._other_routes = [
            (getattr(r, "path", None), tuple(sorted(getattr(r, "methods", ()) or ())))
            for r in cls.app.router.routes
            if not _is_catch_all(r)
        ]

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_env_snapshot"):
            os.environ.clear()
            os.environ.update(cls._env_snapshot)
        if hasattr(cls, "_tmp"):
            cls._tmp.cleanup()

    # ── (c) the anchor: the pre-fix shim DID serve the token ────────────────

    def test_shim_pre_fix_served_the_token(self):
        """Pins the bug itself: un-neutralized, the catch-all root answered
        200 HTML embedding the LIVE session token."""
        if not self._shim_endpoints:
            self.skipTest("upstream root shim changed shape — pre-fix anchor no longer applicable")
        resp = asyncio.run(self._shim_endpoints[0](""))
        body = resp.body.decode("utf-8", "replace")
        self.assertEqual(resp.status_code, 200, "pre-fix GET / answered 200 HTML")
        self.assertIn("__HERMES_SESSION_TOKEN__", body)
        self.assertIn(_TOKEN, body, "the shim leaked the LIVE gateway token, not a placeholder")

    # ── (a) neutralized: no unauthenticated token at / ──────────────────────

    def test_neutralized_root_is_tokenless_404(self):
        """After the neutralizer, `/` answers the generic headless 404 — the
        exact response every other unmatched path gives — with no token."""
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        status, raw = _drive_asgi(self.app, "/")
        body = raw.decode("utf-8", "replace")
        self.assertEqual(status, 404, "GET / must not answer 200 HTML anymore")
        self.assertNotIn("__HERMES_SESSION_TOKEN__", body)
        self.assertNotIn(_TOKEN, body)
        self.assertIn("error", body, "the 404 JSON parity response")

    def test_neutralized_endpoint_invoked_directly_is_tokenless(self):
        """Route-level view (no ASGI): the surviving catch-all endpoint never
        yields the token page, root and non-root alike."""
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        catch_alls = [r for r in self.app.router.routes if _is_catch_all(r)]
        self.assertEqual(len(catch_alls), 1, "exactly one catch-all (the replacement) must remain")
        for path_arg in ("", "some/other/path"):
            resp = asyncio.run(catch_alls[0].endpoint(path_arg))
            body = resp.body.decode("utf-8", "replace")
            self.assertEqual(resp.status_code, 404)
            self.assertNotIn("__HERMES_SESSION_TOKEN__", body)
            self.assertNotIn(_TOKEN, body)

    # ── (b) idempotent + surgical ───────────────────────────────────────────

    def test_neutralizer_is_idempotent(self):
        """Running twice (e.g. a gateway restart in-process) changes nothing."""
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        before = [id(r) for r in self.app.router.routes]
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        self.assertEqual([id(r) for r in self.app.router.routes], before,
                         "the second run must not add, remove or reorder any route")
        status, raw = _drive_asgi(self.app, "/")
        self.assertEqual(status, 404)
        self.assertNotIn(_TOKEN, raw.decode("utf-8", "replace"))

    def test_surgery_touches_only_the_catch_all(self):
        """Every non-catch-all route — /api/* auth surface, public paths, the
        RN client's /api/ws ?token= handshake — is byte-identical after the
        swap (paths AND methods, in order)."""
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        after = [
            (getattr(r, "path", None), tuple(sorted(getattr(r, "methods", ()) or ())))
            for r in self.app.router.routes
            if not _is_catch_all(r)
        ]
        self.assertEqual(after, self._other_routes)
        self.assertIn("/api/ws", [p for p, _ in after],
                      "the WS route the RN client speaks (?token=) must survive untouched")

    def test_double_mount_strips_duplicate_shim(self):
        """A second mount_spa (upstream re-mount) must not resurrect the leak:
        the neutralizer keeps exactly its own replacement."""
        from hermes_cli.web_server_dashboard import mount_spa

        self.assertTrue(_neutralize_root_token_handshake(self.app))
        mount_spa(self.app)  # registers a FRESH upstream token shim
        self.assertEqual(len([r for r in self.app.router.routes if _is_catch_all(r)]), 2)
        self.assertTrue(_neutralize_root_token_handshake(self.app))
        catch_alls = [r for r in self.app.router.routes if _is_catch_all(r)]
        self.assertEqual(len(catch_alls), 1, "the duplicate upstream shim is dropped, ours kept")
        self.assertTrue(getattr(catch_alls[0].endpoint, _ROOT_SHIM_MARKER, False))
        status, raw = _drive_asgi(self.app, "/")
        self.assertEqual(status, 404)
        self.assertNotIn(_TOKEN, raw.decode("utf-8", "replace"))


class NeutralizerContractTests(unittest.TestCase):
    """Stdlib-only contract (runs on bare python3 too): the neutralizer must
    never raise, whatever app shape it meets — boot must not die on it."""

    @staticmethod
    def _stub(routes):
        return types.SimpleNamespace(router=types.SimpleNamespace(routes=routes))

    def test_alien_app_object_is_survived(self):
        self.assertFalse(_neutralize_root_token_handshake(object()))

    def test_empty_route_table_warns_and_survives(self):
        self.assertFalse(_neutralize_root_token_handshake(self._stub([])))

    def test_marked_stub_needs_no_fastapi(self):
        """Already-neutralized shape (marker route present): returns True via
        the strip-only path — no fastapi import, nothing re-registered."""
        endpoint = lambda full_path: None  # noqa: E731
        setattr(endpoint, _ROOT_SHIM_MARKER, True)
        ours = types.SimpleNamespace(path=_ROOT_SHIM_PATH, methods={"GET"}, endpoint=endpoint)
        api_ws = types.SimpleNamespace(path="/api/ws", methods={"GET"}, endpoint=lambda p: None)
        routes = [api_ws, ours]
        self.assertTrue(_neutralize_root_token_handshake(self._stub(routes)))
        self.assertEqual(routes, [api_ws, ours])

    def test_duplicate_upstream_shim_is_stripped_without_fastapi(self):
        endpoint = lambda full_path: None  # noqa: E731
        setattr(endpoint, _ROOT_SHIM_MARKER, True)
        ours = types.SimpleNamespace(path=_ROOT_SHIM_PATH, methods={"GET"}, endpoint=endpoint)
        fresh = types.SimpleNamespace(path=_ROOT_SHIM_PATH, methods={"GET"}, endpoint=lambda p: None)
        api_ws = types.SimpleNamespace(path="/api/ws", methods={"GET"}, endpoint=lambda p: None)
        routes = [api_ws, fresh, ours]
        self.assertTrue(_neutralize_root_token_handshake(self._stub(routes)))
        self.assertEqual(routes, [api_ws, ours], "only the duplicate upstream shim is removed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
