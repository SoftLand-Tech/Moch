#!/usr/bin/env python3
"""BH-000088 unit tests — ``config.set`` refuses explicitly session-scoped writes naming an
unknown session (4001) instead of silently escalating them to the profile-wide default.

Direct-run, no server stack: the vendored ``methods_config_set`` module is installed onto a
fake server module via its own ``register()`` seam (``method_ctx.bind_module`` rebinds the
handler's globals to the fake's), so the dispatcher runs against a fake ``_sessions``
registry without importing server.py (which drags the whole agent stack).

The fake is built ONCE (class-level): a second ``register()`` onto a fresh module would not
re-bind the setters dict (rebound copies take ``__module__`` from the fake's ``__name__``),
but the rebound handlers resolve their globals LIVE through the fake's namespace — so each
test just swaps ``_sessions`` / ``_write_config_key`` on it.

  python3 tests/test_config_set_scope.py
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

_HERMES_SRC = str((Path(__file__).resolve().parent.parent.parent / "hermes-src").resolve())
if _HERMES_SRC not in sys.path:
    sys.path.insert(0, _HERMES_SRC)


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _err(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


class TestConfigSetScopedUnknownSession(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from tui_gateway import methods_config_set as mcs
        except ImportError as exc:
            raise unittest.SkipTest(f"hermes sources unavailable: {exc}")
        cls.mcs = mcs
        server = types.ModuleType("fake_config_server")
        server._ok = _ok
        server._err = _err
        server._profile_scoped = lambda fn: fn  # identity: no profile machinery in this test
        cls.server = server
        registered: dict[str, object] = {}
        server.register_method = lambda name, fn: registered.__setitem__(name, fn)
        mcs.register(server)
        # staticmethod: a bare function attribute would otherwise bind `self`
        # as its first argument on access.
        cls.handler = staticmethod(registered["config.set"])

    def setUp(self):
        # Live-swap the state the rebound handlers resolve through their globals.
        self.fake_sessions = {"live-1": {"session_key": "k1"}}
        self.config_writes: list[tuple[str, object]] = []
        self.server._sessions = self.fake_sessions
        self.server._write_config_key = lambda key, value: self.config_writes.append((key, value))

    def test_scoped_write_to_unknown_session_is_4001(self):
        """The bug: a client-side provisional window's id (`pending:new:…`) named a session the
        gateway does not hold; the setters treated the call as sessionless and _set_reasoning
        persisted the GLOBAL default while reporting success."""
        res = self.handler(7, {"key": "reasoning", "value": "high", "scope": "session",
                               "session_id": "pending:new:m1_1"})
        self.assertIn("error", res, res)
        self.assertEqual(res["error"]["code"], 4001)
        self.assertEqual(res["error"]["message"], "session not found")
        self.assertEqual(self.config_writes, [], "a rejected scoped write must not touch config")

    def test_scoped_write_to_known_session_still_works(self):
        res = self.handler(8, {"key": "reasoning", "value": "high", "scope": "session",
                               "session_id": "live-1"})
        self.assertNotIn("error", res, res)
        self.assertEqual(res["result"]["value"], "high")
        self.assertEqual(self.config_writes, [], "session-scoped picks never persist global config")
        self.assertIn("create_reasoning_override", self.fake_sessions["live-1"],
                      "the session pin is what makes the pick session-scoped")

    def test_global_scope_is_not_blocked(self):
        """Global writes may be sessionless (that IS their contract); the guard only covers
        explicitly session-scoped calls."""
        res = self.handler(9, {"key": "reasoning", "value": "high", "scope": "global",
                               "session_id": "pending:new:m1_1"})
        self.assertNotIn("error", res, res)
        self.assertIn(("agent.reasoning_effort", "high"), self.config_writes)

    def test_scopeless_unknown_session_is_unchanged(self):
        """Legacy shape: a call with no scope key keeps today's behavior (the app sends none
        for its session-scoped picks — the wire contract forbids the key — and never ships a
        provisional id after the client half of BH-000088)."""
        res = self.handler(10, {"key": "reasoning", "value": "high",
                                "session_id": "pending:new:m1_1"})
        self.assertNotIn("error", res, res)
        self.assertIn(("agent.reasoning_effort", "high"), self.config_writes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
