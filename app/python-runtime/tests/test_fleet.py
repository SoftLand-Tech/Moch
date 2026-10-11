#!/usr/bin/env python3
"""M9.1a unit tests — moch/fleet.py (turn gate, FleetTurnQueue, freeze, budgets).

Local, stdlib-only, self-contained: run with

    python3 app/python-runtime/tests/test_fleet.py

and expect exit 0 with ``OK``. Mirrors test_terminal.py conventions. The fleet
runtime is flag-gated (MOCH_FLEET=1); these tests arm the flag explicitly and
also verify the flag-off passthrough contract.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ.setdefault("MOCH_FLEET", "1")
from moch import fleet  # noqa: E402


class TestTurnGate(unittest.TestCase):
    def test_mutual_exclusion_across_threads(self):
        gate = fleet.TurnGate()
        home = "/tmp/fleet-test-home-a"
        entered = threading.Event()
        release = threading.Event()
        overlaps = []

        def holder():
            with gate.hold(home):
                entered.set()
                release.wait(5)
                overlaps.append("holder-in-cs")

        t = threading.Thread(target=holder)
        t.start()
        self.assertTrue(entered.wait(5))
        # second thread must NOT enter while held
        entered2 = threading.Event()
        entered2_done = threading.Event()

        def second():
            with gate.hold(home):
                entered2.set()
            entered2_done.set()

        t2 = threading.Thread(target=second)
        t2.start()
        self.assertFalse(entered2.wait(0.5), "second thread entered a held gate")
        self.assertFalse(gate.stats()[fleet.home_key(home)]["held"] is False)
        release.set()
        t.join(5)
        self.assertTrue(entered2.wait(5), "second thread never admitted after release")
        entered2_done.wait(5)
        self.assertEqual(overlaps, ["holder-in-cs"], "critical sections overlapped")

    def test_same_thread_reentrance(self):
        gate = fleet.TurnGate()
        home = "/tmp/fleet-test-home-reent"
        with gate.hold(home):
            with gate.hold(home):  # RLock reentrance on the same thread
                pass
        self.assertFalse(gate.held(home))

    def test_held_flag_and_stats(self):
        gate = fleet.TurnGate()
        home = "/tmp/fleet-test-home-stats"
        self.assertFalse(gate.held(home))
        with gate.hold(home):
            self.assertTrue(gate.held(home))
            self.assertGreaterEqual(gate.stats()[fleet.home_key(home)]["acquires"], 1)
        self.assertFalse(gate.held(home))


class TestFleetTurnQueue(unittest.TestCase):
    def test_slot_cap_and_release(self):
        q = fleet.FleetTurnQueue(slots=2)
        t1 = q.acquire("h1", fleet.PRIORITY_USER, timeout=0.1)
        t2 = q.acquire("h2", fleet.PRIORITY_USER, timeout=0.1)
        with self.assertRaises(fleet.FleetBusy):
            q.acquire("h3", fleet.PRIORITY_USER, timeout=0.05)
        q.release(t1)
        t3 = q.acquire("h3", fleet.PRIORITY_USER, timeout=1.0)
        q.release(t2)
        q.release(t3)

    def test_priority_order(self):
        q = fleet.FleetTurnQueue(slots=1)
        holder = q.acquire("h", fleet.PRIORITY_USER, timeout=0.1)
        order = []
        tickets = []
        threads = []
        prio_seq = [fleet.PRIORITY_SPAWNED, fleet.PRIORITY_DM,
                    fleet.PRIORITY_CRON_KANBAN, fleet.PRIORITY_APPROVAL_UNBLOCK,
                    fleet.PRIORITY_USER]
        for prio in prio_seq:
            def run(p=prio):
                t = q.acquire("h", p, timeout=6.0)
                order.append(p)
                q.release(t)
            th = threading.Thread(target=run)
            th.start()
            threads.append(th)
            time.sleep(0.05)  # deterministic enqueue order → deterministic seq
        q.release(holder)
        for th in threads:
            th.join(8)
        self.assertEqual(order, sorted(prio_seq),
                         f"admission not priority-ordered: {order}")

    def test_fifo_within_class(self):
        q = fleet.FleetTurnQueue(slots=1)
        holder = q.acquire("h", fleet.PRIORITY_USER, timeout=0.1)
        order = []
        seqs = {}
        orig_seq = q._next_seq

        def traced_seq():
            s = orig_seq()
            seqs[threading.current_thread().name] = s
            return s

        q._next_seq = traced_seq  # test hook: capture true enqueue order

        def run(name):
            t = q.acquire("h", fleet.PRIORITY_DM, timeout=6.0)
            order.append(name)
            q.release(t)

        threads = [threading.Thread(target=run, args=(n,), name=n)
                   for n in ("a", "b", "c")]
        for th in threads:
            th.start()
            time.sleep(0.02)
        q.release(holder)
        for th in threads:
            th.join(8)
        # FIFO = admission order equals true enqueue (seq) order, whatever the
        # OS thread-start order was.
        expected = sorted(("a", "b", "c"), key=lambda n: seqs[n])
        self.assertEqual(order, expected)

    def test_depth_cap_fleet_busy(self):
        q = fleet.FleetTurnQueue(slots=1)
        holder = q.acquire("h", fleet.PRIORITY_USER, timeout=0.1)
        old_cap = fleet.MAX_QUEUED_PER_HOME
        fleet.MAX_QUEUED_PER_HOME = 2
        try:
            waiters = [threading.Thread(
                target=lambda: q.acquire("h", fleet.PRIORITY_DM, timeout=5.0))
                for _ in range(2)]
            for w in waiters:
                w.start()
                time.sleep(0.05)
            with self.assertRaises(fleet.FleetBusy):
                q.acquire("h", fleet.PRIORITY_DM, timeout=0.2)  # 3rd → over cap
            q.release(holder)
            for w in waiters:
                w.join(6)
        finally:
            fleet.MAX_QUEUED_PER_HOME = old_cap

    def test_snapshot(self):
        q = fleet.FleetTurnQueue(slots=1)
        holder = q.acquire("h", fleet.PRIORITY_DM, timeout=0.1)
        th = threading.Thread(target=lambda: q.acquire("h", fleet.PRIORITY_DM,
                                                       timeout=1.0))
        th.start()
        time.sleep(0.1)
        snap = q.snapshot()
        self.assertEqual(snap["slots"], 1)
        self.assertEqual(snap["active"], 1)
        self.assertEqual(len(snap["waiting"]), 1)
        self.assertEqual(snap["waiting"][0]["priority"], "dm-delivery")
        q.release(holder)
        th.join(3)


class TestFreeze(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "profiles" / "x"
            home.mkdir(parents=True)
            self.assertFalse(fleet.is_frozen(home))
            fleet.freeze_bot(home, True)
            self.assertTrue(fleet.is_frozen(home))
            fleet.freeze_bot(home, False)
            self.assertFalse(fleet.is_frozen(home))

    def test_missing_dir_false(self):
        self.assertFalse(fleet.is_frozen("/tmp/fleet-nope-does-not-exist"))


class TestBudgetLedger(unittest.TestCase):
    def test_record_spend_check(self):
        with tempfile.TemporaryDirectory() as d:
            led = fleet.BudgetLedger(Path(d))
            self.assertEqual(led.spend_today("alpha"), 0)
            led.record("alpha", 100, model="m", provider="p")
            led.record("alpha", 50)
            led.record("beta", 10)
            self.assertEqual(led.spend_today("alpha"), 150)
            self.assertEqual(led.spend_today(), 160)
            ok, why = led.check("alpha", 40, per_bot_daily=200, fleet_daily=1000)
            self.assertTrue(ok)          # 150 + 40 = 190 ≤ 200 (admission only)
            led.record("alpha", 40)      # the call completes → usage recorded
            self.assertEqual(led.spend_today("alpha"), 190)
            ok, why = led.check("alpha", 40, per_bot_daily=200, fleet_daily=1000)
            self.assertFalse(ok)         # 190 + 40 = 230 > 200
            self.assertEqual(why, "bot-budget-exhausted")
            ok, why = led.check("beta", 100, per_bot_daily=0, fleet_daily=200)
            self.assertFalse(ok)
            self.assertEqual(why, "fleet-budget-exhausted")


class TestAdmissionAndGateInstall(unittest.TestCase):
    def setUp(self):
        self._old_flag = os.environ.get("MOCH_FLEET")
        os.environ["MOCH_FLEET"] = "1"

    def tearDown(self):
        if self._old_flag is None:
            os.environ.pop("MOCH_FLEET", None)
        else:
            os.environ["MOCH_FLEET"] = self._old_flag

    def test_flag_off_passthrough(self):
        os.environ["MOCH_FLEET"] = "0"
        self.assertIsNone(fleet.admission_check({"method": "prompt.submit",
                                                 "params": {"session_id": "x"}}))
        self.assertFalse(fleet.fleet_enabled())

    def test_non_turn_method_untouched(self):
        self.assertIsNone(fleet.admission_check({"method": "gateway.ping", "params": {}}))

    def test_frozen_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "alpha"
            home.mkdir()
            fleet.freeze_bot(home, True)
            req = {"id": 7, "method": "prompt.submit",
                   "params": {"session_id": "sid-1", "text": "hi"}}
            with tempfile.TemporaryDirectory() as d2:
                # resolution path: session_id unknown → home unresolved → None;
                # so drive resolution directly via resolve_home_for_request patch:
                orig = fleet.resolve_home_for_request
                fleet.resolve_home_for_request = lambda r: str(home)
                try:
                    resp = fleet.admission_check(req)
                finally:
                    fleet.resolve_home_for_request = orig
            self.assertEqual(resp["error"]["code"], 4091)

    def test_budget_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "alpha"
            home.mkdir()
            led = fleet.BudgetLedger(Path(d) / "fleet")
            led.record("alpha", 990)
            old_budgets = fleet.BUDGETS
            old_fd = os.environ.get("MOCH_FLEET_DAILY")
            fleet.BUDGETS = led
            os.environ["MOCH_FLEET_DAILY"] = "1000"
            orig = fleet.resolve_home_for_request
            fleet.resolve_home_for_request = lambda r: str(home)
            try:
                resp = fleet.admission_check({"id": 8, "method": "prompt.submit",
                                              "params": {"session_id": "s"}})
            finally:
                fleet.resolve_home_for_request = orig
                fleet.BUDGETS = old_budgets
                if old_fd is None:
                    os.environ.pop("MOCH_FLEET_DAILY", None)
                else:
                    os.environ["MOCH_FLEET_DAILY"] = old_fd
            self.assertEqual(resp["error"]["code"], 4092)

    def test_install_gate_flag_off_identity(self):
        os.environ["MOCH_FLEET"] = "0"

        class FakeServer:
            def dispatch(self, req, transport=None):
                return {"ok": True}

        fake = FakeServer()
        fleet.install_dispatch_gate(fake)
        self.assertFalse(getattr(fake, "_moch_gate_installed", False))
        self.assertEqual(fake.dispatch({"method": "x"}), {"ok": True})

    def test_install_gate_wraps_and_refuses_frozen(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "alpha"
            home.mkdir()
            fleet.freeze_bot(home, True)

            class FakeServer:
                def dispatch(self, req, transport=None):
                    return {"ok": True, "ran": True}

            fake = FakeServer()
            fleet.install_dispatch_gate(fake)
            self.assertTrue(fake._moch_gate_installed)
            orig = fleet.resolve_home_for_request
            fleet.resolve_home_for_request = lambda r: str(home)
            try:
                resp = fake.dispatch({"id": 9, "method": "prompt.submit",
                                      "params": {"session_id": "s"}})
            finally:
                fleet.resolve_home_for_request = orig
            self.assertEqual(resp["error"]["code"], 4091)
            # unfreeze → passes through to upstream
            fleet.freeze_bot(home, False)
            fleet.resolve_home_for_request = lambda r: str(home)
            try:
                resp = fake.dispatch({"id": 10, "method": "prompt.submit",
                                      "params": {"session_id": "s"}})
            finally:
                fleet.resolve_home_for_request = orig
            self.assertEqual(resp.get("ran"), True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
