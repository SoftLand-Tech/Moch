#!/usr/bin/env python3
"""BUG-138 unit tests — moch.kanban.* write RPCs + dispatch poke/ticker.

Local, stdlib-only bootstrap; run with the hermes venv:
  ~/.hermes/hermes-agent/venv/bin/python tests/test_kanban_rpc.py
Covers: create (validation, frozen/unknown assignee, idempotency key),
assign/unassign, complete(force), block(kind), poke-after-write wiring.
"""
from __future__ import annotations

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


def _make_world(tmp: Path):
    os.environ["HERMES_HOME"] = str(tmp)
    from tui_gateway import server as tg
    from moch import rpc_fleet
    assert rpc_fleet.install(tg), "rpc_fleet.install returned False"
    # two spawnable assignees: the launch home (default) + a named profile
    (tmp / "profiles" / "alpha").mkdir(parents=True, exist_ok=True)
    (tmp / "profiles" / "alpha" / "SOUL.md").write_text("# alpha", "utf-8")
    (tmp / "profiles" / "frozenbot").mkdir(parents=True, exist_ok=True)
    (tmp / "profiles" / "frozenbot" / "SOUL.md").write_text("# f", "utf-8")
    (tmp / "profiles" / "frozenbot" / "fleet").mkdir(exist_ok=True)
    (tmp / "profiles" / "frozenbot" / "fleet" / "freeze.json").write_text(
        '{"frozen": true}', "utf-8")
    return tg, tmp


class TestKanbanRpc(unittest.TestCase):
    def setUp(self):
        try:
            import tui_gateway.server  # noqa: F401
        except ImportError as exc:
            self.skipTest(f"hermes server deps unavailable: {exc}")
        self._tmp = tempfile.TemporaryDirectory()
        self.tg, self.home = _make_world(Path(self._tmp.name))
        # dispatch poke → recorder (never run a real dispatch pass in tests:
        # without the boot spawn patch, dispatch_once would Popen)
        from moch import kanban_dispatch
        self.poked = []
        self._orig_poke = kanban_dispatch.poke_dispatch
        kanban_dispatch.poke_dispatch = (
            lambda db_path, board=None: self.poked.append(str(db_path)))

    def tearDown(self):
        from moch import kanban_dispatch
        kanban_dispatch.poke_dispatch = self._orig_poke
        self._tmp.cleanup()

    def _call(self, method, **params):
        return self.tg._methods[method](1, params)

    def _task_row(self, tid):
        from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
        with kbc.connect_closing() as conn:
            t = kb.get_task(conn, tid)
            return {"status": t.status, "assignee": t.assignee} if t else None

    def test_create_validation_and_happy_path(self):
        # title + assignee required
        self.assertIn("error", self._call("moch.kanban.create", title="x"))
        self.assertIn("error", self._call("moch.kanban.create", assignee="alpha"))
        # unknown profile / frozen bot refused (dispatch would silently skip)
        self.assertIn("error", self._call("moch.kanban.create",
                                          title="x", assignee="ghost"))
        self.assertIn("error", self._call("moch.kanban.create",
                                          title="x", assignee="frozenbot"))
        # happy path: created ready + assigned + poked
        res = self._call("moch.kanban.create",
                         title="watch prices", assignee="alpha", body="daily")
        self.assertNotIn("error", res, res)
        tid = res["result"]["task"]
        row = self._task_row(tid)
        self.assertEqual(row["assignee"], "alpha")
        self.assertEqual(row["status"], "ready")
        self.assertEqual(len(self.poked), 1)

    def test_create_idempotency_key(self):
        r1 = self._call("moch.kanban.create", title="once", assignee="alpha",
                        idempotency_key="moch-test-1")
        r2 = self._call("moch.kanban.create", title="once", assignee="alpha",
                        idempotency_key="moch-test-1")
        self.assertEqual(r1["result"]["task"], r2["result"]["task"])

    def test_assign_and_unassign(self):
        tid = self._call("moch.kanban.create",
                         title="move me", assignee="alpha")["result"]["task"]
        res = self._call("moch.kanban.assign", task_id=tid, assignee="default")
        self.assertNotIn("error", res, res)
        self.assertEqual(self._task_row(tid)["assignee"], "default")
        # "" unassigns (parks — unassigned rows are a dispatch skip bucket)
        res2 = self._call("moch.kanban.assign", task_id=tid, assignee="")
        self.assertNotIn("error", res2, res2)
        self.assertIsNone(self._task_row(tid)["assignee"])
        # unknown task errors
        self.assertIn("error", self._call("moch.kanban.assign",
                                          task_id="nope", assignee="alpha"))

    def test_complete_force_and_block(self):
        tid = self._call("moch.kanban.create",
                         title="finish me", assignee="alpha")["result"]["task"]
        res = self._call("moch.kanban.complete", task_id=tid,
                         summary="done from phone")
        self.assertNotIn("error", res, res)
        self.assertEqual(self._task_row(tid)["status"], "done")
        # block requires a reason; kind is validated upstream
        tid2 = self._call("moch.kanban.create",
                          title="park me", assignee="alpha")["result"]["task"]
        self.assertIn("error", self._call("moch.kanban.block", task_id=tid2))
        self.assertIn("error", self._call("moch.kanban.block", task_id=tid2,
                                          reason="r", kind="bogus"))
        res2 = self._call("moch.kanban.block", task_id=tid2,
                          reason="waiting on user", kind="needs_input")
        self.assertNotIn("error", res2, res2)

    def test_heal_ticker_idempotent(self):
        from moch import kanban_dispatch
        first = kanban_dispatch.start_heal_ticker(interval_s=3600.0)
        second = kanban_dispatch.start_heal_ticker(interval_s=3600.0)
        self.assertTrue(first)
        self.assertFalse(second)


if __name__ == "__main__":
    unittest.main(verbosity=2)
