#!/usr/bin/env python3
"""BUG-105 regression tests — the boot browser gate must not arm from a STALE relay.json.

Local, stdlib-only, self-contained, no network, no device: run with

    python3 app/python-runtime/tests/test_browser_boot_gate.py

and expect exit 0 with ``OK``. Mirrors test_browser_attach.py conventions.

The failure this pins: ``CdpRelay.stop()`` never deletes
``<hermesHome>/browser/relay.json`` (the token is deliberately stable per
install), so after ANY app restart the file describes a DEAD relay in a dead
process. ``moch.hermes_boot._prepare_home`` used to arm
``BROWSER_CDP_URL`` + ``MOCH_BROWSER_RELAY=1`` from it unconditionally, which
made ``check_browser_requirements()`` advertise every browser tool — and every
call then died as "No browser page…" (the "the browser is dead" report). The
relay is in-process, so the file's ``pid`` must equal THIS pid for the file to
be evidence of a live relay; anything else defers to the live
``moch.browser_gate.activate`` flip (Browser screen opened → tools appear
mid-session, no restart).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
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

from moch.hermes_boot import _prepare_home  # noqa: E402

_RELAY_KEYS = ("BROWSER_CDP_URL", "MOCH_BROWSER_RELAY")
_TOKEN = "tok" + "a" * 28
# A loopback port with nothing listening; the probe must fail fast against it.
_DEAD_PORT = 9451

# The relay-down distinction lives in the vendored webview backend; same
# sys.path treatment as test_browser_attach.py (stdlib + stubbed requests).
try:
    import requests  # noqa: F401
except ImportError:
    sys.modules["requests"] = types.ModuleType("requests")


class BootGatePidTests(unittest.TestCase):
    """``_prepare_home`` arms the browser gate ONLY from a same-process relay.json."""

    def setUp(self) -> None:
        self._env_snapshot = dict(os.environ)
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name) / ".hermes"
        os.environ["HERMES_HOME"] = str(self.home)
        for key in _RELAY_KEYS:
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_snapshot)
        self._tmp.cleanup()

    # ── helpers ──────────────────────────────────────────────────────────────

    def _write_relay(self, payload: dict) -> None:
        browser_dir = self.home / "browser"
        browser_dir.mkdir(parents=True, exist_ok=True)
        (browser_dir / "relay.json").write_text(json.dumps(payload), encoding="utf-8")

    def _gate_url(self) -> str:
        return f"http://127.0.0.1:9334/{_TOKEN}"

    # ── the regression ───────────────────────────────────────────────────────

    def test_stale_pid_does_not_arm(self):
        """The bug: a file from the previous process advertised tools against a dead relay."""
        self._write_relay({"token": _TOKEN, "port": 9334, "pid": os.getpid() + 4242})
        _prepare_home(self.home)
        for key in _RELAY_KEYS:
            self.assertNotIn(key, os.environ,
                             f"stale relay.json armed {key} — tools would be advertised with the relay down")

    def test_current_pid_arms(self):
        """Same-process file (Browser screen opened before gateway boot): arm as before."""
        self._write_relay({"token": _TOKEN, "port": 9334, "pid": os.getpid()})
        _prepare_home(self.home)
        self.assertEqual(os.environ.get("BROWSER_CDP_URL"), self._gate_url())
        self.assertEqual(os.environ.get("MOCH_BROWSER_RELAY"), "1")

    # ── edges that must stay inert ───────────────────────────────────────────

    def test_missing_pid_field_does_not_arm(self):
        """Pre-BUG-105 files carry no pid — treat as stale, never arm."""
        self._write_relay({"token": _TOKEN, "port": 9334})
        _prepare_home(self.home)
        for key in _RELAY_KEYS:
            self.assertNotIn(key, os.environ)

    def test_malformed_file_does_not_crash_and_does_not_arm(self):
        browser_dir = self.home / "browser"
        browser_dir.mkdir(parents=True, exist_ok=True)
        (browser_dir / "relay.json").write_text("{not json", encoding="utf-8")
        _prepare_home(self.home)  # must not raise — boot never dies on this file
        for key in _RELAY_KEYS:
            self.assertNotIn(key, os.environ)

    def test_preset_env_survives_stale_file(self):
        """Manual PC workflow (BROWSER_CDP_URL set by hand): a stale file must
        not clobber it — this branch only ever arms FROM the file."""
        manual = "http://127.0.0.1:9222/json"
        os.environ["BROWSER_CDP_URL"] = manual
        self._write_relay({"token": _TOKEN, "port": 9334, "pid": os.getpid() + 1})
        _prepare_home(self.home)
        self.assertEqual(os.environ.get("BROWSER_CDP_URL"), manual)

    def test_absent_file_unchanged(self):
        """No file ⇒ no arm (the documented rollback state)."""
        _prepare_home(self.home)
        for key in _RELAY_KEYS:
            self.assertNotIn(key, os.environ)


class RelayDownErrorTests(unittest.TestCase):
    """``webview_navigate`` must tell a dead relay from a live one with no page."""

    def setUp(self) -> None:
        self._saved = os.environ.get("BROWSER_CDP_URL")
        os.environ["BROWSER_CDP_URL"] = f"http://127.0.0.1:{_DEAD_PORT}/{_TOKEN}"

    def tearDown(self) -> None:
        if self._saved is None:
            os.environ.pop("BROWSER_CDP_URL", None)
        else:
            os.environ["BROWSER_CDP_URL"] = self._saved

    def test_unreachable_relay_reports_down(self):
        from tools.browser_webview import _RELAY_DOWN_ERROR, _relay_down_error

        self.assertEqual(_relay_down_error(), _RELAY_DOWN_ERROR,
                         "a dead relay must yield the open-the-Browser-screen instruction")

    def test_reachable_relay_reports_none(self):
        from tools import browser_webview

        def fake_get(url, **kwargs):
            class _Resp:
                ok = True

            return _Resp()

        with mock.patch("requests.get", new=fake_get):
            self.assertIsNone(browser_webview._relay_down_error(),
                              "relay up + probe ok ⇒ generic no-live-page message is the truth")

    def test_no_url_configured_reports_none(self):
        from tools import browser_webview

        os.environ.pop("BROWSER_CDP_URL")
        self.assertIsNone(browser_webview._relay_down_error())


if __name__ == "__main__":
    unittest.main(verbosity=2)
