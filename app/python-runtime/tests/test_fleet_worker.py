#!/usr/bin/env python3
"""M9.1b unit tests — moch/fleet_worker.py (in-process kanban worker).

Local, stdlib-only: run with  python3 tests/test_fleet_worker.py  → exit 0 "OK".
Covers: negative synthetic pid, claim→work→complete (no subprocess), freeze→block,
exactly-once on reclaim (claim lost → discarded, never completed), worker env
contract set + restored.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ.setdefault("MOCH_FLEET", "1")
from moch import fleet, fleet_worker  # noqa: E402


class FakeTask:
    def __init__(self, tid="t1", assignee="alpha", title="Do a thing",
                 body="steps", claim_lock="lock-1"):
        self.id = tid
        self.assignee = assignee
        self.title = title
        self.body = body
        self.status = "running"
        self.claim_lock = claim_lock
        self.goal_mode = False
        self.goal_max_turns = None
        self.max_runtime_seconds = None
        self.tenant = None
        self.branch_name = None
        self.current_run_id = None
        self.skills = []


class FakeKanban:
    def __init__(self, task_status="running", task_lock="lock-1"):
        self.statuses = {("t" + "1"): task_status}
        self.locks = {"t1": task_lock}
        self.blocks = []
        self.completes = []

    def complete(self, tid):
        self.completes.append(tid)
        self.statuses[tid] = "complete"

    def block(self, tid, reason=""):
        self.blocks.append((tid, reason))
        self.statuses[tid] = "blocked"


class TestFleetWorker(unittest.TestCase):
    def setUp(self):
        self._old_flag = os.environ.get("MOCH_FLEET")
        os.environ["MOCH_FLEET"] = "1"
        self.patches = []
        self.tmpdirs = []

        def patch(obj, name, val):
            old = getattr(obj, name)
            setattr(obj, name, val)
            self.patches.append((obj, name, old))

        # profile dir resolution → throwaway dirs (no real profiles needed)
        def fake_get_profile_dir(name):
            d = Path(tempfile.mkdtemp(prefix=f"fw-{name}-"))
            self.tmpdirs.append(d)
            return d

        patch(fleet_worker, "_resolve_profile_dir", fake_get_profile_dir)

        # immediate lease-free target (no _sessions registry access in tests)
        patch(fleet_worker, "_wait_out_live_sessions", lambda home, timeout_s=60.0: True)

        # frozen state under test control
        self.frozen = False
        patch(fleet, "is_frozen", lambda home: self.frozen)

    def tearDown(self):
        for obj, name, old in reversed(self.patches):
            setattr(obj, name, old)
        for d in self.tmpdirs:
            import shutil
            shutil.rmtree(d, ignore_errors=True)
        if self._old_flag is None:
            os.environ.pop("MOCH_FLEET", None)
        else:
            os.environ["MOCH_FLEET"] = self._old_flag

    def make_worker(self, kanban, turn_fn=None):
        audits = []
        import types
        fake_audit = types.SimpleNamespace(
            record=lambda event, **f: audits.append((event, f)))
        owns = lambda task: (kanban.statuses.get(task.id, "running") == "running"
                             and task.claim_lock == "lock-1")
        w = fleet_worker.FleetWorker(
            worker_turn_fn=turn_fn or (lambda t, ws, b: "done"),
            complete_fn=kanban.complete,
            block_fn=kanban.block,
            owns_claim_fn=owns,
            audit=fake_audit)
        return w, kanban, audits

    def run_worker(self, w, task):
        pid = w.spawn_fn(task, "/tmp/fw-ws", board="b")
        self.assertLess(pid, 0, "synthetic pid must be negative (non-OS range)")
        w.workers[pid]["thread"].join(20)
        self.assertFalse(w.workers[pid]["thread"].is_alive(), "worker thread hung")
        return pid

    def test_spawn_complete_no_subprocess(self):
        import subprocess
        kanban = FakeKanban()
        w, kb, audits = self.make_worker(kanban)
        real_popen = subprocess.Popen
        poisoned = []

        def no_popen(*a, **k):
            poisoned.append(a)
            raise AssertionError("subprocess.Popen called by in-process worker")

        subprocess.Popen = no_popen
        try:
            pid = self.run_worker(w, FakeTask())
        finally:
            subprocess.Popen = real_popen
        self.assertEqual(kb.completes, ["t1"])
        self.assertEqual(w.workers[pid]["status"], "completed")
        self.assertEqual(poisoned, [])
        events = [e for e, _ in audits]
        self.assertIn("worker.spawned", events)
        self.assertIn("worker.completed", events)

    def test_exactly_once_on_reclaim(self):
        kanban = FakeKanban(task_status="running", task_lock="fresh-lock")
        w, kb, audits = self.make_worker(kanban)
        task = FakeTask(claim_lock="stale-lock")  # our claim is no longer current
        pid = self.run_worker(w, task)
        self.assertEqual(kb.completes, [], "completed a task whose claim was lost")
        self.assertTrue(any(e == "worker.discarded" for e, _ in audits))

    def test_frozen_blocks_task(self):
        kanban = FakeKanban()
        w, kb, audits = self.make_worker(kanban)
        self.frozen = True
        pid = self.run_worker(w, FakeTask())
        self.frozen = False
        self.assertEqual(kb.completes, [])
        self.assertEqual(len(kb.blocks), 1)
        self.assertIn("frozen", kb.blocks[0][1])

    def test_env_contract_set_and_restored(self):
        seen = {}

        def turn(task, ws, board):
            seen["task"] = os.environ.get("HERMES_KANBAN_TASK")
            seen["source"] = os.environ.get("HERMES_SESSION_SOURCE")
            return "ok"

        kanban = FakeKanban()
        w, kb, audits = self.make_worker(kanban, turn_fn=turn)
        self.run_worker(w, FakeTask(tid="env-1"))
        self.assertEqual(seen["task"], "env-1")
        self.assertEqual(seen["source"], "kanban")
        self.assertIsNone(os.environ.get("HERMES_KANBAN_TASK"),
                          "worker env leaked into the process")

    def test_reclaim_patch_noop_for_synthetic(self):
        try:
            from hermes_cli import kanban_db_dispatch as kbd
        except ImportError:
            self.skipTest("hermes imports unavailable under this interpreter")
        self.assertTrue(fleet_worker.install_reclaim_patch(kbd))
        info = kbd._terminate_reclaimed_worker(-123, "lock", signal_fn=None)
        self.assertTrue(info.get("terminated"))
        self.assertTrue(info.get("synthetic"))
        # passthrough for real pids: handled by the original (fingerprint-aware)
        # machinery — the only contract we can assert here is "not synthetic".
        info2 = kbd._terminate_reclaimed_worker(12345, "lock", signal_fn=None)
        self.assertNotIn("synthetic", info2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
