#!/usr/bin/env python3
"""BUG-132 regression — the tool-definitions memo must key on the browser gate.

The embedded agent boots the relay itself mid-process (AgentBrowserHost →
BrowserRelayModule → moch.browser_gate.activate, which sets MOCH_BROWSER_RELAY
and BROWSER_CDP_URL). The assembled tool catalog DIFFERS between the two
states — browser_* enter/leave via check_fn — so the memo key must carry the
gate env. Before this fix, a catalog computed pre-arm was replayed post-arm
for the life of the process (the memo has no TTL; activate's double-clear
loses any compute-in-flight race), which is the "new chats have no browser
tools" report.

Run:  PYTHONPATH=app/python-runtime:app/hermes-src python3 tests/test_browser_cache_key.py
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_APP = _TESTS_DIR.parents[1]
for _p in (str(_TESTS_DIR.parent), str(_APP / "hermes-src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _stub_optional_deps() -> None:
    """model_tools' import chain pulls httpx; stand in a permissive module when
    the real one is absent (the device bundles it)."""
    import importlib.util
    import types

    if importlib.util.find_spec("httpx") is not None:
        return

    class _AnyModule(types.ModuleType):
        def __getattr__(self, name):  # pragma: no cover — import shim
            if name.startswith("__"):
                raise AttributeError(name)
            return type(name, (), {})

    sys.modules.setdefault("httpx", _AnyModule("httpx"))


_stub_optional_deps()

from model_tools import _tool_defs_cache_key  # noqa: E402


class GateInCacheKeyTest(unittest.TestCase):
    def setUp(self):
        self._saved = {
            k: os.environ.get(k) for k in ("MOCH_BROWSER_RELAY", "BROWSER_CDP_URL")
        }
        os.environ.pop("MOCH_BROWSER_RELAY", None)
        os.environ.pop("BROWSER_CDP_URL", None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_key_changes_when_the_gate_flips(self):
        pre = _tool_defs_cache_key(None, None, False)
        os.environ["MOCH_BROWSER_RELAY"] = "1"
        os.environ["BROWSER_CDP_URL"] = "http://127.0.0.1:9334/tok"
        post = _tool_defs_cache_key(None, None, False)
        self.assertIsNotNone(pre)
        self.assertIsNotNone(post)
        self.assertNotEqual(pre, post, "pre-arm and post-arm catalogs must not share a memo key (BUG-132)")

    def test_url_is_part_of_the_key_too(self):
        os.environ["MOCH_BROWSER_RELAY"] = "1"
        os.environ["BROWSER_CDP_URL"] = "http://127.0.0.1:9334/a"
        a = _tool_defs_cache_key(None, None, False)
        os.environ["BROWSER_CDP_URL"] = "http://127.0.0.1:9334/b"
        b = _tool_defs_cache_key(None, None, False)
        self.assertNotEqual(a, b, "a relay restart on another port must not reuse the old catalog")

    def test_key_stable_within_a_state(self):
        os.environ["MOCH_BROWSER_RELAY"] = "1"
        os.environ["BROWSER_CDP_URL"] = "http://127.0.0.1:9334/tok"
        self.assertEqual(
            _tool_defs_cache_key(None, None, False),
            _tool_defs_cache_key(None, None, False),
            "the same gate state must still hit the memo",
        )


class CheckFnScopePartitionsByGateTest(unittest.TestCase):
    """BUG-132 cause 3: the check_fn cache scope must partition by gate state,
    else a pre-arm False verdict is served post-arm and the first armed
    get_tool_definitions memoizes a browser-less list under the armed key."""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("MOCH_BROWSER_RELAY", "BROWSER_CDP_URL")}
        os.environ.pop("MOCH_BROWSER_RELAY", None)
        os.environ.pop("BROWSER_CDP_URL", None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # (scope-partition test removed with the revert: a non-None scope in a
    # single-profile process broke check_fn evaluation on device — see the
    # BUG-132 tracker entry. The gate-env partition lives in
    # model_tools._tool_defs_cache_key + activate()'s double clear.)

    def test_bypass_sentinel_passes_through(self):
        from tools.registry import CHECK_FN_CACHE_BYPASS, _check_fn_cache_scope_base

        if _check_fn_cache_scope_base() != CHECK_FN_CACHE_BYPASS:
            self.skipTest("base scope is not the bypass sentinel in this environment")
        os.environ["MOCH_BROWSER_RELAY"] = "1"
        self.assertEqual(check_fn_cache_scope(), CHECK_FN_CACHE_BYPASS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
