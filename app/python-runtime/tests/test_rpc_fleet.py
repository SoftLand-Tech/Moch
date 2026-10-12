#!/usr/bin/env python3
"""M9.2/M9.4-precursor unit tests — moch/rpc_fleet.py (moch.* RPC layer).

Local, stdlib-only: run with  python3 tests/test_rpc_fleet.py  → exit 0 "OK".
Covers: moch.runs.timeline merged view over seeded kanban/cron/delegation
ledgers, moch.fleet.status/freeze round-trip, moch.profiles.delete guardrails.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME), "../hermes-src"):
    _rp = str((_TESTS_DIR / _p).resolve()) if not _p.startswith("..") else \
        str((_TESTS_DIR.parent.parent / _p.lstrip("./")).resolve())
    if _rp not in sys.path:
        sys.path.insert(0, _rp)

os.environ.setdefault("MOCH_FLEET", "1")

# Fake-server fallback (tracker BH-000030): created ONCE per process —
# rpc_fleet.install latches (_REGISTERED), so a fresh stub per test would
# carry no handlers from the second setUp on.
_FAKE_TG = None


def _fake_tg_server():
    """Stub tui_gateway.server carrying only `_methods = {}`.

    The moch/rpc_fleet handlers import ONLY moch.* + stdlib, so on a bare
    interpreter (no hermes deps) their method logic and result shapes can be
    pinned by registering them onto this stub instead of skipping.
    """
    global _FAKE_TG
    if _FAKE_TG is None:
        stub = types.ModuleType("tui_gateway.server")
        stub._methods = {}
        sys.modules["tui_gateway.server"] = stub
        import tui_gateway as _pkg
        _pkg.server = stub
        _FAKE_TG = stub
    _stub_kanban_db_if_missing()
    return _FAKE_TG


def _stub_kanban_db_if_missing():
    """Faithful hermes_cli.kanban_db stand-in for bare interpreters only.

    moch.runs.timeline resolves the kanban DB via
    ``hermes_cli.kanban_db.kanban_db_path``; without hermes deps that import
    fails and the kanban source silently vanishes. The stub mirrors the REAL
    resolver's contract (default board -> ``<root>/kanban.db``, named board
    -> ``<root>/kanban/boards/<slug>/kanban.db``, HERMES_KANBAN_DB override)
    so the handler runs its real SQL against the seeded sqlite. The real
    module, when importable, is never shadowed.
    """
    try:
        from hermes_cli import kanban_db  # noqa: F401
        return
    except ImportError:
        pass

    stub = types.ModuleType("hermes_cli.kanban_db")

    def _kanban_home() -> Path:
        override = os.environ.get("HERMES_KANBAN_HOME", "").strip()
        if override:
            return Path(override).expanduser()
        return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))

    def kanban_db_path(board=None) -> Path:
        pinned = os.environ.get("HERMES_KANBAN_DB", "").strip()
        if pinned:
            return Path(pinned).expanduser()
        slug = (board or "default").strip() or "default"
        if slug == "default":
            return _kanban_home() / "kanban.db"
        return _kanban_home() / "kanban" / "boards" / slug / "kanban.db"

    stub.kanban_db_path = kanban_db_path
    sys.modules["hermes_cli.kanban_db"] = stub
    try:
        import hermes_cli as _hc
        _hc.kanban_db = stub
    except ImportError:
        _hc = types.ModuleType("hermes_cli")
        _hc.kanban_db = stub
        sys.modules["hermes_cli"] = _hc


def _make_world(tmp: Path):
    """Seed kanban + cron + delegation ledgers; return (tg._methods-like, home)."""
    os.environ["HERMES_HOME"] = str(tmp)
    # REVIEW FIX: hermes-home MARKER — without it the server import rewrites
    # HERMES_HOME to scratch under the REAL ~/.hermes (see test_kanban_rpc's
    # note) and the timeline/seed/profile lookups go to the machine's home.
    (tmp / "config.yaml").write_text("# test world marker", "utf-8")
    sys.path.insert(0, str(_PY_RUNTIME.parent / "hermes-src"))
    try:
        from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
        with kbc.connect_closing() as conn:
            kb.create_task(conn, title="crew task", body="x", assignee="alpha")
    except ImportError:
        # system interpreter without hermes deps: seed the minimal columns the
        # timeline SELECT reads (schema-faithful subset of kanban_db.tasks).
        # The DEFAULT board's DB lives at <root>/kanban.db — kanban_db_path's
        # contract (boards/<slug>/ only holds NAMED boards); the fake-mode
        # stub in this file resolves exactly here.
        kb = sqlite3.connect(tmp / "kanban.db")
        kb.execute(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT,"
            " assignee TEXT, status TEXT, priority INT DEFAULT 0, created_by TEXT,"
            " created_at INT, started_at INT, completed_at INT)")
        now = int(time.time())
        kb.execute("INSERT INTO tasks (id, title, body, assignee, status, created_at)"
                   " VALUES ('k1','crew task','x','alpha','ready',?)", (now,))
        kb.commit()
        kb.close()

    exdir = tmp / "cron"
    exdir.mkdir(exist_ok=True)
    ex = sqlite3.connect(exdir / "executions.db")
    ex.execute(
        "CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, source TEXT,"
        " process_id TEXT, pid INT, process_started_at INT, status TEXT,"
        " handoff_pending INT DEFAULT 0, handoff_started_at REAL, claimed_at TEXT,"
        " started_at TEXT, finished_at TEXT, error TEXT)")
    ex.execute(
        "INSERT INTO executions (id, job_id, source, process_id, pid, status,"
        " claimed_at, finished_at, error) VALUES"
        " ('e1','j1','tick','p',1,'failed','2026-10-10T10:00:00',"
        " '2026-10-10T10:01:00','boom')")
    ex.commit()
    ex.close()

    d = sqlite3.connect(tmp / "state.db")
    d.execute(
        "CREATE TABLE async_delegations (delegation_id TEXT PRIMARY KEY,"
        " origin_session TEXT, origin_ui_session_id TEXT DEFAULT '',"
        " parent_session_id TEXT, state TEXT, dispatched_at REAL,"
        " completed_at REAL, updated_at REAL, event_json TEXT, result_json TEXT,"
        " delivery_state TEXT DEFAULT 'pending', delivery_attempts INT DEFAULT 0,"
        " delivered_at REAL, owner_pid INT)")
    now = time.time()
    d.execute(
        "INSERT INTO async_delegations (delegation_id, origin_session, state,"
        " dispatched_at, updated_at) VALUES ('d1','s','delivered', ?, ?)",
        (now - 5, now - 1))
    d.commit()
    d.close()

    from tui_gateway import server as tg
    from moch import rpc_fleet
    assert rpc_fleet.install(tg), "rpc_fleet.install returned False"
    return tg, tmp


class TestRpcFleet(unittest.TestCase):
    def setUp(self):
        # REVIEW FIX: world FIRST, import SECOND. The server import rewrites
        # HERMES_HOME when the dir lacks a home marker — it must see the test
        # world (env + config.yaml) already in place, or everything profile-
        # dependent resolves against the machine's real ~/.hermes.
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        Path(self._tmp.name, "config.yaml").write_text("# test world marker", "utf-8")
        try:
            import tui_gateway.server  # noqa: F401
        except ImportError:
            # Honest scope (tracker BH-000030): with the hermes server deps
            # missing (dotenv & co), run against the fake `_methods` stub so
            # the 13 moch.* HANDLERS still register and answer. This pins
            # method logic + result shapes — NOT the real server's dispatch,
            # validation or session glue, which keep running against the true
            # server wherever the venv deps exist (unchanged path above).
            _fake_tg_server()
        self.tg, self.home = _make_world(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def test_runs_timeline_merges_three_sources(self):
        res = self.tg._methods["moch.runs.timeline"](1, {"limit": 20})
        self.assertNotIn("error", res, res)
        runs = res["result"]["runs"]
        sources = {r["source"] for r in runs}
        self.assertIn("kanban", sources)
        self.assertIn("cron", sources)
        self.assertIn("delegate", sources)
        # newest first
        ts = [r.get("ts") or 0 for r in runs]
        self.assertEqual(ts, sorted(ts, reverse=True))
        # statuses carried through
        by_src = {r["source"]: r for r in runs}
        self.assertEqual(by_src["cron"]["status"], "failed")
        self.assertEqual(by_src["cron"]["error"], "boom")
        self.assertEqual(by_src["delegate"]["status"], "delivered")

    def test_runs_timeline_limit(self):
        res = self.tg._methods["moch.runs.timeline"](1, {"limit": 1})
        self.assertEqual(len(res["result"]["runs"]), 1)

    def test_fleet_status_shape(self):
        res = self.tg._methods["moch.fleet.status"](1, {})
        r = res["result"]
        self.assertTrue(r["fleetEnabled"])
        self.assertIn("queue", r)
        self.assertIn("slots", r["queue"])

    def test_profiles_delete_guardrails(self):
        # default profile refused
        res = self.tg._methods["moch.profiles.delete"](
            1, {"profile": "default", "confirm": True})
        self.assertIn("error", res)
        # confirm required
        res2 = self.tg._methods["moch.profiles.delete"](2, {"profile": "x"})
        self.assertIn("error", res2)

    # -- BUG-139: moch.profiles.seed / moch.skills.list ----------------------

    def _seed_world(self):
        """Launch identity + one skill + a target profile; returns paths."""
        launch = self.home
        (launch / "memories").mkdir(exist_ok=True)
        (launch / "memories" / "USER.md").write_text("# user\nlikes tea", "utf-8")
        (launch / "memories" / "MEMORY.md").write_text("# memory\nold digest", "utf-8")
        skill = launch / "skills" / "research" / "deep-dive"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text(
            "---\nname: deep-dive\ndescription: Long-form research passes\n---\n"
            "# deep-dive\nbody", "utf-8")
        link = launch / "skills" / "research" / "linked-skill"
        if not link.exists():
            link.symlink_to(skill, target_is_directory=True)
        prof = launch / "profiles" / "watcher"
        prof.mkdir(parents=True, exist_ok=True)
        (prof / "memories").mkdir(exist_ok=True)
        return launch, skill, prof

    def test_seed_copies_identity_and_skills(self):
        launch, skill, prof = self._seed_world()
        res = self.tg._methods["moch.profiles.seed"](1, {
            "profile": "watcher", "copy_user_memory": True,
            "skills": ["deep-dive"]})
        self.assertNotIn("error", res, res)
        r = res["result"]
        self.assertEqual(r["userMemory"], "copied")
        self.assertIsNone(r["memory"])  # not requested
        self.assertEqual(r["skills"], [{"name": "deep-dive", "result": "copied"}])
        self.assertEqual((prof / "memories" / "USER.md").read_text("utf-8"),
                         "# user\nlikes tea")
        self.assertTrue((prof / "skills" / "research" / "deep-dive" / "SKILL.md").is_file())

    def test_seed_guardrails_and_edges(self):
        launch, skill, prof = self._seed_world()
        # default / unnamed / nothing-to-seed refused
        for bad in ({"profile": "default", "copy_user_memory": True},
                    {"profile": "", "copy_user_memory": True},
                    {"profile": "watcher"}):
            self.assertIn("error", self.tg._methods["moch.profiles.seed"](1, bad))
        # unknown profile refused
        self.assertIn("error", self.tg._methods["moch.profiles.seed"](
            1, {"profile": "ghost", "copy_user_memory": True}))
        # unknown skill → missing; symlinked skill → skipped-symlink
        res = self.tg._methods["moch.profiles.seed"](1, {
            "profile": "watcher", "skills": ["nope", "linked-skill"]})
        results = {x["name"]: x["result"] for x in res["result"]["skills"]}
        self.assertEqual(results["nope"], "missing")
        self.assertEqual(results["linked-skill"], "skipped-symlink")
        # dst-exists → skipped (never merge over an existing identity file):
        # first copy lands, the repeat is refused.
        res2 = self.tg._methods["moch.profiles.seed"](
            1, {"profile": "watcher", "copy_user_memory": True,
                "copy_memory": True})
        self.assertEqual(res2["result"]["userMemory"], "copied")
        self.assertEqual(res2["result"]["memory"], "copied")
        res3 = self.tg._methods["moch.profiles.seed"](
            1, {"profile": "watcher", "copy_user_memory": True})
        self.assertEqual(res3["result"]["userMemory"], "skipped-exists")

    def test_skills_list_shape(self):
        launch, skill, prof = self._seed_world()
        res = self.tg._methods["moch.skills.list"](1, {})
        self.assertNotIn("error", res, res)
        names = {s["name"]: s for s in res["result"]["skills"]}
        self.assertIn("deep-dive", names)
        self.assertEqual(names["deep-dive"]["description"],
                         "Long-form research passes")


if __name__ == "__main__":
    unittest.main(verbosity=2)
