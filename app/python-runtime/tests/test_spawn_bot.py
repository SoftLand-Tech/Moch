#!/usr/bin/env python3
"""M9.1a unit tests — moch/audit.py + moch/spawn_bot.py.

Local, stdlib-only, self-contained: run with

    python3 app/python-runtime/tests/test_spawn_bot.py

and expect exit 0 with ``OK``. Mirrors test_terminal.py / test_fleet.py
conventions. No hermes imports: profile creation, audit and budgets are
injected fakes; homes are tempdirs; MOCH_FLEET=1 is armed.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

os.environ["MOCH_FLEET"] = "1"
from moch import audit, fleet, spawn_bot  # noqa: E402


class Fakes:
    def __init__(self, *, now=None):
        self.now = now if now is not None else time.time
        self.created = []
        self.audit_events = []
        self.budget_rows = []
        self.spent = {}       # bot -> tokens (per-bot daily view)
        self.fleet_spent = 0
        self.per_bot_daily = 0
        self.fleet_daily = 0
        self.fail_check = ("", "")

    # profiles_create(name=..., soul=..., no_alias=..., mirror_credentials=...)
    def profiles_create(self, name, soul="", no_alias=True,
                        mirror_credentials=False):
        rec = {"name": name, "soul": soul, "no_alias": no_alias,
               "mirror_credentials": mirror_credentials}
        self.created.append(rec)
        return rec

    # audit sink
    def audit_record(self, event, **fields):
        self.audit_events.append({"event": event, **fields})

    # budgets ledger
    def budget_record(self, bot, tokens, kind="turn", **kw):
        self.budget_rows.append({"bot": bot, "tokens": tokens, "kind": kind})
        self.spent[bot] = self.spent.get(bot, 0) + tokens
        self.fleet_spent += tokens

    def budget_spend_today(self, bot=None):
        if bot is None:
            return self.fleet_spent
        return self.spent.get(bot, 0)

    def budget_check(self, bot, est_tokens, per_bot_daily, fleet_daily):
        self.per_bot_daily = per_bot_daily
        self.fleet_daily = fleet_daily
        why, detail = self.fail_check
        if why:
            return False, detail or why
        if fleet_daily > 0 and self.fleet_spent + est_tokens > fleet_daily:
            return False, "fleet-budget-exhausted"
        if per_bot_daily > 0 and self.spent.get(bot, 0) + est_tokens > per_bot_daily:
            return False, "bot-budget-exhausted"
        return True, ""


class EnvHome:
    """Per-test HERMES_HOME + env isolation."""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="moch-spawn-test-")
        self._old = {
            "HERMES_HOME": os.environ.get("HERMES_HOME"),
            "MOCH_FLEET": os.environ.get("MOCH_FLEET"),
            "MOCH_BOT_DAILY": os.environ.get("MOCH_BOT_DAILY"),
            "MOCH_FLEET_DAILY": os.environ.get("MOCH_FLEET_DAILY"),
        }
        os.environ["HERMES_HOME"] = self.tmp
        os.environ["MOCH_FLEET"] = "1"
        os.environ.pop("MOCH_BOT_DAILY", None)
        os.environ.pop("MOCH_FLEET_DAILY", None)
        return self.tmp

    def __exit__(self, *a):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False


def make_service(fakes=None, now=None):
    f = fakes or Fakes(now=now)
    svc = spawn_bot.SpawnBotService(
        profiles_create=f.profiles_create,
        audit=type("A", (), {"record": staticmethod(f.audit_record)})(),
        budgets=type("B", (), {
            "record": f.budget_record,
            "spend_today": f.budget_spend_today,
            "check": f.budget_check,
        })(),
        now=now if now is not None else f.now,
    )
    return svc, f


def approve_spawn(svc, parent="alpha", home="/tmp/nonexistent-home-alpha",
                  brief="do the thing", **kw):
    r = svc.request(parent, home, brief, **kw)
    if r.get("ok") is False and r.get("code") == "approval-required":
        r = svc.request(parent, home, brief, approved=True, **kw)
    return r


# --------------------------------------------------------------------- audit

class TestAudit(unittest.TestCase):
    def setUp(self):
        self.env = EnvHome()
        self.home = self.env.__enter__()
        self.addCleanup(self.env.__exit__, None, None, None)

    def test_record_and_events(self):
        audit.record("dm.send", src="alpha", dst="beta", chars=12)
        audit.record("dm.reply", src="beta", dst="alpha")
        evs = audit.events(limit=10)
        self.assertEqual([e["event"] for e in evs], ["dm.send", "dm.reply"])
        self.assertEqual(evs[0]["src"], "alpha")
        self.assertIn("ts", evs[0])
        p = Path(self.home) / "fleet" / "audit.jsonl"
        self.assertTrue(p.is_file())

    def test_events_limit_and_malformed_skip(self):
        for i in range(5):
            audit.record("spawn.request", i=i)
        p = Path(self.home) / "fleet" / "audit.jsonl"
        with open(p, "a", encoding="utf-8") as f:
            f.write("not-json\n\n")
        evs = audit.events(limit=3)
        self.assertEqual([e["i"] for e in evs], [2, 3, 4])  # chronological tail

    def test_never_raises_on_unwritable_home(self):
        os.environ["HERMES_HOME"] = "/proc/definitely/not/writable"
        audit.record("dm.send")  # must not raise
        self.assertEqual(audit.events(), [])
        os.environ["HERMES_HOME"] = self.home

    def test_rotation(self):
        old_max = audit.MAX_BYTES
        audit.MAX_BYTES = 512
        try:
            for i in range(40):
                audit.record("outbound.send", i=i, pad="x" * 60)
            live = Path(self.home) / "fleet" / "audit.jsonl"
            rot = Path(self.home) / "fleet" / "audit.jsonl.1"
            self.assertLess(live.stat().st_size, 512)
            self.assertTrue(rot.is_file())
            # rotated segment ends with the rotation marker
            lines = rot.read_text(encoding="utf-8").splitlines()
            self.assertEqual(json.loads(lines[-1])["event"], "audit.rotate")
            # events() spans both segments
            evs = audit.events(limit=100)
            self.assertEqual(evs[0]["event"], "outbound.send")
            self.assertLess(evs[0]["i"], 40)
            marker_seen = any(e["event"] == "audit.rotate" for e in evs)
            self.assertTrue(marker_seen)
        finally:
            audit.MAX_BYTES = old_max

    def test_second_rotation_drops_oldest(self):
        old_max = audit.MAX_BYTES
        audit.MAX_BYTES = 256
        try:
            for i in range(60):
                audit.record("outbound.send", i=i, pad="x" * 60)
            rot = Path(self.home) / "fleet" / "audit.jsonl.1"
            firsts = [e for e in audit.events(limit=200)
                      if e["event"] == "outbound.send"]
            # only the last two segments survive: earliest recorded i is gone
            self.assertGreater(firsts[0]["i"], 0)
            self.assertEqual(json.loads(
                rot.read_text(encoding="utf-8").splitlines()[-1])["event"],
                "audit.rotate")
        finally:
            audit.MAX_BYTES = old_max

    def test_thread_safety_smoke(self):
        import threading
        errs = []

        def hammer():
            try:
                for _ in range(50):
                    audit.record("dm.send", src="t")
            except Exception as e:  # pragma: no cover
                errs.append(e)

        ts = [threading.Thread(target=hammer) for _ in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(10)
        self.assertEqual(errs, [])
        self.assertEqual(len(audit.events(limit=500)), 200)


# ------------------------------------------------------------------ spawning

class SpawnBase(unittest.TestCase):
    def setUp(self):
        self.env = EnvHome()
        self.home = self.env.__enter__()
        self.addCleanup(self.env.__exit__, None, None, None)
        self.parent_home = str(Path(self.home) / "profiles" / "alpha")
        Path(self.parent_home).mkdir(parents=True, exist_ok=True)

    def service(self, now=None):
        return make_service(now=now)

    def writespawn(self, name, parent="alpha", depth=1, status="live",
                   created_ts=None, tombstoned_ts=None):
        d = Path(self.home) / "fleet" / "spawns"
        d.mkdir(parents=True, exist_ok=True)
        rec = {"name": name, "spawned_by": parent, "depth": depth,
               "created_ts": created_ts if created_ts is not None else time.time(),
               "ttl_ts": time.time() + 86400, "budget_slice": 100,
               "status": status}
        if tombstoned_ts is not None:
            rec["tombstoned_ts"] = tombstoned_ts
        (d / f"{name}.json").write_text(json.dumps(rec))
        return rec


class TestSpawnHappy(SpawnBase):
    def test_first_spawn_requires_approval_then_succeeds(self):
        svc, f = self.service()
        r = svc.request("alpha", self.parent_home, "summarize the report")
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "approval-required")
        self.assertTrue(r["first_spawn_today"])
        self.assertIn("slice", r)
        self.assertIn("approval", r["reason"])

        r2 = svc.request("alpha", self.parent_home, "summarize the report",
                         approved=True)
        self.assertTrue(r2["ok"], r2)
        self.assertTrue(r2["name"].startswith("crew-alpha-"))
        self.assertEqual(r2["depth"], 1)
        # record on disk
        rec_path = (Path(self.home) / "fleet" / "spawns" /
                    f"{r2['name']}.json")
        rec = json.loads(rec_path.read_text())
        self.assertEqual(rec["spawned_by"], "alpha")
        self.assertEqual(rec["status"], "live")
        self.assertEqual(rec["depth"], 1)
        # profile created with the brief + isolation flags
        self.assertEqual(len(f.created), 1)
        c = f.created[0]
        self.assertEqual(c["name"], r2["name"])
        self.assertIn("summarize the report", c["soul"])
        self.assertTrue(c["no_alias"])
        self.assertFalse(c["mirror_credentials"])
        # budget slice debited from parent as an allocation
        self.assertEqual(len(f.budget_rows), 1)
        self.assertEqual(f.budget_rows[0]["bot"], "alpha")
        self.assertEqual(f.budget_rows[0]["kind"], "spawn")
        self.assertEqual(f.budget_rows[0]["tokens"], r2["slice"])
        # audit trail
        kinds = [e["event"] for e in f.audit_events]
        self.assertIn("spawn.request", kinds)
        self.assertIn("spawn.approved", kinds)

    def test_second_spawn_same_day_is_silent(self):
        svc, _ = self.service()
        self.assertTrue(approve_spawn(svc, home=self.parent_home)["ok"])
        r = svc.request("alpha", self.parent_home, "another task")
        # not the first spawn today → no approval card
        self.assertTrue(r["ok"], r)
        self.assertFalse(r.get("first_spawn_today", False))

    def test_slice_uses_floor_of_fleet_daily(self):
        os.environ["MOCH_FLEET_DAILY"] = "10000"
        svc, _ = self.service()
        r = approve_spawn(svc, home=self.parent_home, est_tokens=4000)
        self.assertTrue(r["ok"])
        self.assertEqual(r["slice"], 500)  # 5% floor of 10000
        r2 = approve_spawn(svc, home=self.parent_home, est_tokens=4000)
        self.assertEqual(r2["slice"], 500)

    def test_mark_done_and_tombstone(self):
        svc, f = self.service()
        r = approve_spawn(svc, home=self.parent_home)
        name = r["name"]
        self.assertTrue(svc.mark_done(name))
        rec = json.loads((Path(self.home) / "fleet" / "spawns" /
                          f"{name}.json").read_text())
        self.assertEqual(rec["status"], "done")
        self.assertIn("done_ts", rec)
        self.assertTrue(svc.tombstone(name, reason="melt crew"))
        rec = json.loads((Path(self.home) / "fleet" / "spawns" /
                          f"{name}.json").read_text())
        self.assertEqual(rec["status"], "tombstoned")
        self.assertEqual(rec["tombstone_reason"], "melt crew")
        kinds = [e["event"] for e in f.audit_events]
        self.assertIn("spawn.done", kinds)
        self.assertIn("spawn.tombstone", kinds)
        # unknown name → False, never raises
        self.assertFalse(svc.mark_done("nope"))
        self.assertFalse(svc.tombstone("nope", "x"))


class TestSpawnRefusals(SpawnBase):
    def test_fleet_off(self):
        os.environ["MOCH_FLEET"] = "0"
        try:
            svc, f = self.service()
            r = svc.request("alpha", self.parent_home, "task")
            self.assertEqual((r["ok"], r["code"]), (False, "fleet-off"))
            self.assertIn("fleet runtime", r["reason"])
            self.assertTrue(any(e["event"] == "spawn.refused" and
                                e.get("code") == "fleet-off"
                                for e in f.audit_events))
        finally:
            os.environ["MOCH_FLEET"] = "1"

    def test_parent_frozen(self):
        fleet.freeze_bot(self.parent_home, True)
        svc, _ = self.service()
        r = svc.request("alpha", self.parent_home, "task")
        self.assertEqual((r["ok"], r["code"]), (False, "parent-frozen"))
        fleet.freeze_bot(self.parent_home, False)
        r2 = approve_spawn(svc, home=self.parent_home)
        self.assertTrue(r2["ok"], r2)

    def test_budget_refusal(self):
        os.environ["MOCH_BOT_DAILY"] = "1000"
        os.environ["MOCH_FLEET_DAILY"] = "50000"
        try:
            svc, f = self.service()
            f.spent["alpha"] = 5000  # already past per-bot daily
            r = svc.request("alpha", self.parent_home, "task",
                            est_tokens=4000)
            self.assertEqual((r["ok"], r["code"]), (False, "budget"))
        finally:
            os.environ.pop("MOCH_BOT_DAILY")
            os.environ.pop("MOCH_FLEET_DAILY")

    def test_depth_cap(self):
        svc, _ = self.service()
        # parent is a grandchild (depth 2) → its child would be depth 3 → refused
        r = svc.request("grand", self.parent_home, "task",
                        parent_depth=2, approved=True)
        self.assertEqual((r["ok"], r["code"]), (False, "depth-cap"))
        # depth 1 parent (child) may spawn a grandchild
        r2 = svc.request("child", self.parent_home, "task",
                         parent_depth=1, approved=True)
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["depth"], 2)

    def test_cap_parent(self):
        svc, _ = self.service()
        for i in range(3):
            self.writespawn(f"crew-alpha-x{i}", parent="alpha")
        r = svc.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual((r["ok"], r["code"]), (False, "cap-parent"))
        # done/tombstoned records do not count as live
        self.writespawn("crew-alpha-done", parent="alpha", status="done")
        r2 = svc.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual(r2["code"], "cap-parent")

    def test_cap_fleet(self):
        svc, _ = self.service()
        for i in range(5):
            self.writespawn(f"crew-beta-{i}", parent="beta")
        r = svc.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual((r["ok"], r["code"]), (False, "cap-fleet"))

    def test_cap_daily(self):
        svc, _ = self.service()
        now = time.time()
        for i in range(10):
            self.writespawn(f"crew-alpha-d{i}", parent="alpha",
                            status="done", created_ts=now - 60)
        r = svc.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual((r["ok"], r["code"]), (False, "cap-daily"))
        # records from YESTERDAY do not count toward the daily cap
        with EnvHome() as home2:
            now = time.time()
            d2 = Path(home2) / "fleet" / "spawns"
            d2.mkdir(parents=True, exist_ok=True)
            for i in range(10):
                (d2 / f"crew-alpha-y{i}.json").write_text(json.dumps({
                    "name": f"crew-alpha-y{i}", "spawned_by": "alpha",
                    "depth": 1, "created_ts": now - 86400 - 60,
                    "ttl_ts": now, "budget_slice": 1, "status": "tombstoned"}))
            svc2, _ = self.service()
            r2 = svc2.request("alpha", self.parent_home, "task")
            self.assertEqual(r2["code"], "approval-required")  # caps not hit

    def test_approval_required_big_slice(self):
        # not first spawn of the day, but slice > 20% of remaining fleet budget
        os.environ["MOCH_FLEET_DAILY"] = "100000"
        try:
            svc, f = self.service()
            r = approve_spawn(svc, home=self.parent_home, est_tokens=1000)
            self.assertTrue(r["ok"], r)
            # burn most of the fleet budget so remaining is small
            f.fleet_spent = 99000
            r2 = svc.request("alpha", self.parent_home, "task2",
                             est_tokens=1000)
            self.assertFalse(r2["ok"])
            self.assertEqual(r2["code"], "approval-required")
            self.assertFalse(r2["first_spawn_today"])
            r3 = svc.request("alpha", self.parent_home, "task2",
                             est_tokens=1000, approved=True)
            self.assertTrue(r3["ok"], r3)
        finally:
            os.environ.pop("MOCH_FLEET_DAILY")

    def test_create_failure_is_structured(self):
        svc, f = self.service()

        def boom(**kw):
            raise RuntimeError("profiles.create exploded")
        svc._profiles_create = boom
        r = svc.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual((r["ok"], r["code"]), (False, "create-failed"))
        self.assertIn("exploded", r["reason"])


class TestSpawnRecovery(SpawnBase):
    def test_crash_recovery_live_counts(self):
        # 2 live + 1 done records for alpha on disk before the service exists
        self.writespawn("crew-alpha-a", parent="alpha")
        self.writespawn("crew-alpha-b", parent="alpha")
        self.writespawn("crew-alpha-c", parent="alpha", status="done")
        svc, _ = self.service()  # init scan rebuilds counts
        counts = svc.live_counts()
        self.assertEqual(counts["per_parent"].get("alpha"), 2)
        self.assertEqual(counts["fleet"], 2)
        # one more live spawn reaches the parent cap
        self.writespawn("crew-alpha-d", parent="alpha")
        svc2, _ = self.service()
        r = svc2.request("alpha", self.parent_home, "task", approved=True)
        self.assertEqual(r["code"], "cap-parent")

    def test_gc_old_tombstones(self):
        now = time.time()
        self.writespawn("crew-alpha-old", parent="alpha", status="tombstoned",
                        tombstoned_ts=now - 8 * 86400)
        self.writespawn("crew-alpha-recent", parent="alpha",
                        status="tombstoned",
                        tombstoned_ts=now - 3600)
        d = Path(self.home) / "fleet" / "spawns"
        svc, _ = self.service()
        self.assertFalse((d / "crew-alpha-old.json").exists())
        self.assertTrue((d / "crew-alpha-recent.json").exists())
        self.assertEqual(svc.live_counts()["fleet"], 0)
        # tombstoned-but-not-live records do not block the cap
        r = approve_spawn(svc, home=self.parent_home)
        self.assertTrue(r["ok"], r)


def main():
    unittest.main(verbosity=1)


if __name__ == "__main__":
    main()
