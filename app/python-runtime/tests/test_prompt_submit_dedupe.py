#!/usr/bin/env python3
"""BUG-036 server-half tests — ``prompt.submit`` ``client_request_id`` idempotency.

The desktop attaches a ``client_request_id`` to every logical submit and REUSES it when a
reply is lost to a client timeout. The gateway must replay the STORED reply for a repeated
id instead of running the submit again — critically BEFORE the busy path, because a busy
session is never refused (``_handle_busy_submit`` steers/redirects/queues), so a late replay
would otherwise enqueue a duplicate user turn.

Local, stdlib-only bootstrap (test_cron_get.py conventions): HERMES_HOME tmp world-marker
FIRST, ``tui_gateway.server`` import SECOND, then call ``tg._methods[method](1, params)``
directly (the dispatcher's contract validation is pinned separately).

  python3 app/python-runtime/tests/test_prompt_submit_dedupe.py

Covers: duplicate id → identical reply, no second turn; different id → normal second
submit; TTL expiry → re-executes; no param → byte-identical legacy behavior; replay while
busy → stored receipt returned and the busy path (steer/redirect/queue) never re-runs.
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
for _p in (str(_PY_RUNTIME),
           str((_TESTS_DIR.parent.parent / "hermes-src").resolve())):
    if _p not in sys.path:
        sys.path.insert(0, _p)


class PromptSubmitDedupeTest(unittest.TestCase):
    def setUp(self):
        # World FIRST, import SECOND (test_kanban_rpc.py): the server import
        # rewrites HERMES_HOME when the dir lacks a home marker.
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        Path(self._tmp.name, "config.yaml").write_text("# test world marker", "utf-8")
        try:
            import tui_gateway.server  # noqa: F401
        except ImportError as exc:
            self.skipTest(f"hermes server deps unavailable: {exc}")
        from tui_gateway import server as tg
        self.tg = tg
        self._sessions: list[str] = []
        self._saved: dict[str, tuple[bool, object]] = {}
        self.turns: list[str] = []
        self.builds: list[str] = []
        # Turn machinery off; the submit path must stay the unit under test.
        self._patch("_voice_mode_enabled", lambda: False)
        self._patch("_session_uses_compute_host", lambda session, cfg=None: False)
        self._patch("_persist_session_row_for_submit", lambda rid, session, text=None, display_kind=None: None)
        self._patch("_restart_completed_failed_agent_build", lambda *a: False)
        self._patch("_start_agent_build",
                    lambda sid, session: self.builds.append(sid))
        self._patch("_run_after_agent_ready",
                    lambda rid, sid, session, text, *a, **k: self.turns.append(str(text)))
        # The session slot lease is claimed by session.create in production; a present
        # (opaque) lease short-circuits `_ensure_active_session_slot` the same way.
        self.lease = object()

    def tearDown(self):
        for sid in self._sessions:
            self.tg._sessions.pop(sid, None)
        for name, (existed, old) in self._saved.items():
            if existed:
                setattr(self.tg, name, old)
            else:
                delattr(self.tg, name)
        self._tmp.cleanup()

    def _patch(self, name, value):
        self._saved[name] = (hasattr(self.tg, name), getattr(self.tg, name, None))
        setattr(self.tg, name, value)

    def _session(self, sid="s-dedupe", running=False):
        session = {
            "session_id": sid, "session_key": f"key-{sid}",
            "history_lock": threading.Lock(), "running": running,
            "title": "", "history": [], "active_session_lease": self.lease,
        }
        self.tg._sessions[sid] = session
        self._sessions.append(sid)
        return session

    def _submit(self, **params):
        params.setdefault("session_id", "s-dedupe")
        params.setdefault("text", "hello")
        return self.tg._methods["prompt.submit"](1, params)

    def _join_turn_thread(self, session):
        thread = session.get("_run_thread")
        if thread is not None:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), "turn thread never finished")

    # ── 1. duplicate id → identical reply, second turn NOT started ────────────

    def test_duplicate_client_request_id_replays_reply_without_second_turn(self):
        session = self._session()
        first = self._submit(client_request_id="req-1")
        self.assertIn("result", first, first)
        self.assertEqual(first["result"]["status"], "streaming")
        self._join_turn_thread(session)
        self.assertEqual(self.turns, ["hello"])

        replay = self._submit(client_request_id="req-1")
        self.assertIsNot(replay, first, "replay is a FRESH dict re-stamped with this call's id")
        self.assertEqual(replay["result"], first["result"], "replay must return the STORED result verbatim")
        self.assertEqual(replay["id"], 1, "replayed frame carries the CALLER's JSON-RPC id")
        self._join_turn_thread(session)
        self.assertEqual(self.turns, ["hello"], "a deduped replay must not start a second turn")
        self.assertEqual(self.builds, ["s-dedupe"], "no second agent build either")

    # ── 2. different id → normal second submit ─────────────────────────────────

    def test_different_client_request_id_starts_second_turn(self):
        session = self._session()
        self._submit(client_request_id="req-1")
        self._join_turn_thread(session)
        # The first turn flipped the session to running (a real mid-submit second send
        # would land on the busy path) — settle it back the way turn-end does.
        with session["history_lock"]:
            session["running"] = False
        second = self._submit(client_request_id="req-2", text="again")
        self._join_turn_thread(session)
        self.assertIn("result", second, second)
        self.assertEqual(self.turns, ["hello", "again"], "a NEW id is a new logical submit")
        receipts = session["_submit_receipts"]
        self.assertEqual(sorted(receipts), ["req-1", "req-2"])

    # ── 3. TTL expiry → re-executes ────────────────────────────────────────────

    def test_receipt_ttl_expiry_reexecutes(self):
        session = self._session()
        first = self._submit(client_request_id="req-1")
        self._join_turn_thread(session)
        with session["history_lock"]:
            session["_submit_receipts"]["req-1"]["ts"] = time.time() - 400  # > 300s TTL
            session["running"] = False  # turn-end, so the re-execution claims the session again
        replay = self._submit(client_request_id="req-1")
        self._join_turn_thread(session)
        self.assertIsNot(replay, first, "an expired receipt must re-execute the submit")
        self.assertEqual(replay["result"]["status"], "streaming", replay)
        self.assertEqual(self.turns, ["hello", "hello"])
        # The re-execution re-stamped a FRESH receipt (and pruned the stale one).
        with session["history_lock"]:
            self.assertGreater(session["_submit_receipts"]["req-1"]["ts"], time.time() - 10)

    def test_receipt_pruning_drops_only_stale_entries(self):
        session = self._session()
        self._submit(client_request_id="req-old")
        self._join_turn_thread(session)
        with session["history_lock"]:
            session["running"] = False  # turn-end, so the next submit claims cleanly
        self._submit(client_request_id="req-new", text="two")
        self._join_turn_thread(session)
        with session["history_lock"]:
            session["running"] = False
            session["_submit_receipts"]["req-old"]["ts"] = time.time() - 400
        self._submit(client_request_id="req-newer", text="three")
        self._join_turn_thread(session)
        with session["history_lock"]:
            self.assertEqual(sorted(session["_submit_receipts"]), ["req-new", "req-newer"],
                             "insert must prune entries older than the TTL")

    # ── 4. no param → legacy behavior, byte-identical ──────────────────────────

    def test_no_client_request_id_keeps_legacy_behavior(self):
        session = self._session()
        for text in ("one", "two"):
            reply = self._submit(text=text)
            self._join_turn_thread(session)
            self.assertIn("result", reply, reply)
            with session["history_lock"]:
                session["running"] = False  # turn-end, so the next submit claims cleanly
        self.assertEqual(self.turns, ["one", "two"], "both submits ran; nothing was deduped")
        self.assertNotIn("_submit_receipts", session, "no id → no receipts are recorded")

        empty = self._submit(client_request_id="", text="three")
        self._join_turn_thread(session)
        self.assertIn("result", empty, empty)
        self.assertNotIn("_submit_receipts", session, "an EMPTY id behaves like no id")
        self.assertEqual(self.turns[-1], "three")

    # ── 5. replay while busy → stored receipt, nothing enqueued/steered ────────

    def test_busy_replay_returns_receipt_without_touching_busy_path(self):
        session = self._session(running=True)
        busy_calls: list[str] = []

        def fake_busy(rid, sid, session, text, transport, queued=False, turn_author=None):
            busy_calls.append(str(text))
            return {"jsonrpc": "2.0", "id": rid, "result": {"status": "queued"}}

        self._patch("_handle_busy_submit", fake_busy)
        first = self._submit(client_request_id="req-busy")
        self.assertEqual(first["result"]["status"], "queued", first)

        replay = self._submit(client_request_id="req-busy")
        self.assertIsNot(replay, first, "busy replay is re-stamped with this call's id")
        self.assertEqual(replay["result"], first["result"], "busy replay returns the ORIGINAL stored result")
        self.assertEqual(busy_calls, ["hello"],
                         "the dedupe check MUST precede _handle_busy_submit: a timed-out "
                         "replay would otherwise enqueue a duplicate")
        self.assertIsNone(session.get("queued_prompt"))
        self.assertIsNone(session.get("queued_prompts"))
        self.assertFalse(session.get("busy_path_ran", False))

        # A genuinely NEW message while busy still goes through the busy path.
        fresh = self._submit(client_request_id="req-busy-2", text="other")
        self.assertEqual(fresh["result"]["status"], "queued", fresh)
        self.assertEqual(busy_calls, ["hello", "other"])

    # ── contract surface ────────────────────────────────────────────────────────

    def test_contract_accepts_client_request_id_and_still_forbids_unknowns(self):
        from tui_gateway.contracts.prompt_voice import PromptSubmitParams
        from tui_gateway.contracts.registry import ValidationError, validate_params

        params = PromptSubmitParams(session_id="s", client_request_id="req-1")
        self.assertEqual(params.client_request_id, "req-1")
        with self.assertRaises(ValidationError):
            PromptSubmitParams(session_id="s", unknown_key=1)  # extra="forbid" intact

        contract = self.tg._contracts.METHODS["prompt.submit"]
        validated, problem = validate_params(contract, {"session_id": "s", "client_request_id": "req-1"})
        self.assertIsNone(problem, problem)
        self.assertEqual(validated["client_request_id"], "req-1")
        validated2, problem2 = validate_params(contract, {"session_id": "s"})
        self.assertIsNone(problem2, "the param stays OPTIONAL — old clients must be unaffected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
