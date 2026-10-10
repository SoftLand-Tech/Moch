#!/usr/bin/env python3
"""BUG-104 regression tests — Moch WebView per-page attach (tools/browser_supervisor).

Local, stdlib-only, self-contained, no network, no device: run with

    python3 app/python-runtime/tests/test_browser_attach.py

and expect exit 0 with ``OK``. Mirrors test_terminal.py conventions; puts the
vendored hermes sources (``hermes-src``) on sys.path — tools.browser_supervisor
imports only stdlib plus its two sibling mixins at module scope.

Covers the exact on-device chain the shipped battery missed:

- probe URLs derived from a ws:// cdp_url are rewritten to http:// at the same
  authority + token (requests has no ws:// adapter — the probe used to raise
  InvalidSchema every time and silently disable per-page auto-detect);
- a failed probe under ``MOCH_BROWSER_RELAY=1`` defaults to the per-page branch
  (the ws dial already proved the relay tunneled a LIVE page);
- per-page attach is SESSIONLESS end to end: ``_page_session_id is None`` and
  NO ``Target.*`` command is ever sent — including ``Target.setAutoAttach``,
  which the per-page branch used to send and a WebView page socket rejects;
- without the relay env, a failed probe still defaults to the stock
  browser-level branch (desktop behavior unchanged);
- ``MOCH_BROWSER_FORCE_PER_PAGE=1`` now actually forces the per-page branch.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# The supervisor imports ``requests`` lazily inside the function under test;
# keep the suite stdlib-only by stubbing it when the real package is absent.
try:
    import requests  # noqa: F401
except ImportError:
    sys.modules["requests"] = types.ModuleType("requests")

from tools.browser_supervisor import CDPSupervisor, DEFAULT_DIALOG_POLICY, _http_probe_root  # noqa: E402

_CDP_WS_URL = "ws://127.0.0.1:9334/tok123/devtools/browser"
_PAGE = {"type": "page", "id": "page-1", "url": "https://example.com/"}


class _FakeWS:
    """Records sent CDP commands; auto-answers each pending call so ``_cdp`` resolves."""

    def __init__(self, sup: CDPSupervisor) -> None:
        self.sup = sup
        self.sent: list = []

    async def send(self, payload: str) -> None:
        msg = json.loads(payload)
        self.sent.append(msg)
        fut = self.sup._pending_calls.get(msg["id"])
        if fut is not None and not fut.done():
            fut.set_result({"result": {}})


class _FakeResponse:
    def __init__(self, payload) -> None:
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self) -> None:
        pass


def _supervisor(cdp_url: str = _CDP_WS_URL) -> CDPSupervisor:
    sup = CDPSupervisor("default", cdp_url, dialog_policy=DEFAULT_DIALOG_POLICY)
    sup._ws = _FakeWS(sup)
    return sup


def _sent_methods(sup: CDPSupervisor) -> list:
    return [m.get("method") for m in sup._ws.sent]


class HttpProbeRootTests(unittest.TestCase):
    def test_ws_rewrites_to_http_keeping_token_path(self):
        self.assertEqual(_http_probe_root(_CDP_WS_URL), "http://127.0.0.1:9334/tok123")

    def test_wss_rewrites_to_https(self):
        self.assertEqual(_http_probe_root("wss://h.example/t/devtools/browser"), "https://h.example/t")

    def test_non_ws_passes_through(self):
        self.assertEqual(_http_probe_root("http://127.0.0.1:9222/json"), "http://127.0.0.1:9222/json")
        self.assertEqual(_http_probe_root("ws://127.0.0.1:9222"), "http://127.0.0.1:9222")

    def test_empty_is_safe(self):
        self.assertEqual(_http_probe_root(""), "")


class PerPageAttachTests(unittest.TestCase):
    _ENV_KEYS = ("MOCH_BROWSER_RELAY", "MOCH_BROWSER_FORCE_PER_PAGE")

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in self._ENV_KEYS}
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _assert_per_page(self, sup: CDPSupervisor, fetched: list, probe_ran: bool = True):
        """The regression the shipped battery lacked: per-page ENGAGED, sessionless."""
        self.assertIsNone(sup._page_session_id)
        methods = _sent_methods(sup)
        self.assertEqual(methods[:2], ["Page.enable", "Runtime.enable"])
        self.assertFalse([m for m in methods if m.startswith("Target.")],
                         f"browser-level Target.* sent in per-page mode: {methods}")
        if probe_ran:
            self.assertEqual(fetched[0], "http://127.0.0.1:9334/tok123/json/version")
        self.assertEqual(fetched[-1], "http://127.0.0.1:9334/tok123/json/list")

    def test_relay_flag_false_attaches_per_page(self):
        """The real post-fix device path: probe succeeds, relay advertises no browser level."""
        sup = _supervisor()
        fetched = []

        def fake_get(url, **kwargs):
            fetched.append(url)
            if "/json/version" in url:
                return _FakeResponse({"Browser": "MochRelay/1.0", "Moch-Browser-Level": False})
            return _FakeResponse([_PAGE])

        with mock.patch("requests.get", new=fake_get):
            asyncio.run(sup._attach_initial_page())
        self._assert_per_page(sup, fetched)

    def test_probe_failure_with_relay_env_defaults_per_page(self):
        """Probe dead (the old InvalidSchema case) + MOCH_BROWSER_RELAY=1 → per-page anyway."""
        sup = _supervisor()
        fetched = []

        def fake_get(url, **kwargs):
            fetched.append(url)
            if "/json/version" in url:
                raise OSError("simulated probe failure")
            return _FakeResponse([_PAGE])

        os.environ["MOCH_BROWSER_RELAY"] = "1"
        with mock.patch("requests.get", new=fake_get):
            asyncio.run(sup._attach_initial_page())
        self._assert_per_page(sup, fetched)

    def test_force_per_page_flag_forces_branch(self):
        """Probe inconclusive (real Chromium, no flag) + FORCE_PER_PAGE=1 → per-page."""
        sup = _supervisor()
        fetched = []

        def fake_get(url, **kwargs):
            fetched.append(url)
            if "/json/version" in url:
                return _FakeResponse({"Browser": "HeadlessChrome/140"})  # no Moch-Browser-Level
            return _FakeResponse([_PAGE])

        os.environ["MOCH_BROWSER_FORCE_PER_PAGE"] = "1"
        with mock.patch("requests.get", new=fake_get):
            asyncio.run(sup._attach_initial_page())
        self._assert_per_page(sup, fetched, probe_ran=False)  # forced selection skips the probe

    def test_probe_failure_without_relay_env_stays_browser_level(self):
        """Desktop default preserved: failed probe → stock branch sends Target.getTargets."""
        sup = _supervisor()

        def fake_get(url, **kwargs):
            raise OSError("simulated probe failure")

        with mock.patch("requests.get", new=fake_get):
            # Stock branch: empty targetInfos → createTarget returns {} → KeyError on targetId.
            with self.assertRaises(KeyError):
                asyncio.run(sup._attach_initial_page())
        methods = _sent_methods(sup)
        self.assertEqual(methods[0], "Target.getTargets")
        self.assertIn("Target.createTarget", methods)  # walked the FULL stock path
        # The KeyError fires at attach["result"]["sessionId"] — before any assignment —
        # so the supervisor never registers and webview tools see "no session".
        self.assertIsNone(sup._page_session_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
