#!/usr/bin/env python3
"""BUG-137 unit tests — moch/spawn_tool.py (the stage-3 tool door).

Local bootstrap; run with the hermes venv:
  ~/.hermes/hermes-agent/venv/bin/python tests/test_spawn_tool.py
Covers: registry install (idempotent, delegation toolset, check_fn flag),
parent identity resolution (launch home → default; profile dir → name),
parent depth from spawn records, the two-step approval-required flow
(card approved → re-issue with approved=True; denied → structured denial),
JSON-string results per the registry contract.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),
           str((_TESTS_DIR.parent.parent / "hermes-src").resolve())):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ.setdefault("MOCH_FLEET", "1")


class FakeService:
    """Records request() calls; scripted responses per approved flag."""

    def __init__(self, script):
        self.script = script  # fn(brief, est, parent, depth, approved) -> dict
        self.calls = []

    def request(self, parent, parent_home, brief, **kw):
        self.calls.append({"parent": parent, "home": parent_home,
                           "brief": brief, **kw})
        return self.script(parent, brief, kw.get("approved", False))

    def records(self):
        return getattr(self, "_records", {})


class TestSpawnTool(unittest.TestCase):
    def setUp(self):
        try:
            import tui_gateway.server  # noqa: F401
            import tools.registry  # noqa: F401
        except ImportError as exc:
            self.skipTest(f"hermes server deps unavailable: {exc}")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        from moch import spawn_tool
        self.spawn_tool = spawn_tool
        self._orig_service = spawn_tool._SERVICE

    def tearDown(self):
        self.spawn_tool._SERVICE = self._orig_service
        self._tmp.cleanup()

    def _install(self):
        # fresh registry state: unregister if a previous test installed it
        from tools.registry import registry
        try:
            registry.deregister("spawn_bot")
        except Exception:
            pass
        return self.spawn_tool.install()

    def test_install_idempotent_and_toolset(self):
        from tools.registry import registry
        self.assertTrue(self._install())
        self.assertFalse(self.spawn_tool.install())  # second call: no-op
        entry = registry.get_entry("spawn_bot")
        self.assertIsNotNone(entry)
        self.assertEqual(entry.toolset, "delegation")
        # check_fn follows the flag
        os.environ["MOCH_FLEET"] = "1"
        self.assertTrue(self.spawn_tool._check())
        os.environ["MOCH_FLEET"] = ""
        self.assertFalse(self.spawn_tool._check())
        os.environ["MOCH_FLEET"] = "1"

    def test_handler_happy_path_and_parent_identity(self):
        def script(parent, brief, approved):
            return {"ok": True, "name": "crew-x", "depth": 1}

        fake = FakeService(script)
        self.spawn_tool._SERVICE = fake
        raw = self.spawn_tool._handler({"task_brief": "do the thing"})
        self.assertIsInstance(raw, str)  # registry contract: JSON string
        res = json.loads(raw)
        self.assertTrue(res["ok"])
        self.assertEqual(res["name"], "crew-x")
        # parent = the launch home ("default" — HERMES_HOME == call home)
        self.assertEqual(fake.calls[0]["parent"], "default")
        self.assertEqual(fake.calls[0]["brief"], "do the thing")

    def test_handler_approval_flow(self):
        import tools.approval as approval
        from moch import spawn_tool as st

        state = {"asked": 0}

        def script(parent, brief, approved):
            if not approved:
                return {"ok": False, "code": "approval-required",
                        "reason": "first spawn today", "slice": 500,
                        "first_spawn_today": True}
            return {"ok": True, "name": "crew-y", "depth": 1}

        fake = FakeService(script)
        st._SERVICE = fake
        orig = approval.request_tool_approval

        def fake_approve(tool, reason, **kw):
            state["asked"] += 1
            state["reason"] = reason
            return {"approved": True}

        approval.request_tool_approval = fake_approve
        try:
            res = json.loads(st._handler({"task_brief": "b", "est_tokens": 100}))
        finally:
            approval.request_tool_approval = orig
        self.assertEqual(state["asked"], 1)
        self.assertIn("500", state["reason"])
        self.assertTrue(res["ok"])
        self.assertEqual(len(fake.calls), 2)
        self.assertFalse(fake.calls[0]["approved"])
        self.assertTrue(fake.calls[1]["approved"])

        # denial path: card answered no → structured denial, ONE call
        def fake_deny(tool, reason, **kw):
            return {"approved": False, "message": "nope"}

        approval.request_tool_approval = fake_deny
        fake2 = FakeService(script)
        st._SERVICE = fake2
        try:
            res2 = json.loads(st._handler({"task_brief": "b"}))
        finally:
            approval.request_tool_approval = orig
        self.assertFalse(res2["ok"])
        self.assertEqual(res2["code"], "denied")
        self.assertEqual(len(fake2.calls), 1)

    def test_handler_parent_depth_from_spawn_record(self):
        from moch import spawn_tool as st
        # the calling bot is itself a spawned grandchild (depth 2)
        fake = FakeService(lambda p, b, a: {"ok": False, "code": "depth-cap"})
        fake._records = {"default": {"name": "default", "depth": 2,
                                     "status": "live"}}
        st._SERVICE = fake
        res = json.loads(st._handler({"task_brief": "b"}))
        self.assertEqual(res["code"], "depth-cap")
        self.assertEqual(fake.calls[0]["parent_depth"], 2)

    def test_handler_requires_brief(self):
        res = json.loads(self.spawn_tool._handler({"task_brief": "  "}))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "bad-request")


if __name__ == "__main__":
    unittest.main(verbosity=2)
