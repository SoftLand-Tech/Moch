#!/usr/bin/env python3
"""BUG-114 regression — session search must still find message CONTENT when the
interpreter has no ``fts5`` module.

The Android embedded runtime links a SQLite without FTS5 ("no such module:
fts5"), and ``hermes_state_search.search_messages`` used to answer ``[]`` for
EVERY query in that state — returning *before* the LIKE fallback that sits
directly above it for the stale-index case. Device symptom: the Chats search box
reported "No matches" for text that was plainly in the transcript, and
``/api/sessions/search`` always returned ``{"results": []}``.

Run:

    PYTHONPATH=app/python-runtime:app/hermes-src \
        python3 app/python-runtime/tests/test_search_no_fts.py

Local, stdlib-only, self-contained: expect exit 0 with ``OK``.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_APP = _TESTS_DIR.parents[1]  # app/python-runtime/tests -> app
for _p in (str(_TESTS_DIR.parent), str(_APP / "hermes-src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

def _stub_optional_deps() -> None:
    """``hermes_state`` reaches a module chain that imports httpx; the Android
    runtime bundles it but a bare desktop interpreter may not. Only the search
    path is under test here, so stand in a permissive module rather than
    requiring the dependency — and only when it is genuinely absent."""
    import importlib.util
    import types

    try:
        if importlib.util.find_spec("httpx") is not None:
            return
    except Exception:
        pass  # a stub from a sibling test module has no __spec__ — treat as absent

    class _AnyModule(types.ModuleType):
        def __getattr__(self, name):  # pragma: no cover — import shim
            if name.startswith("__"):
                raise AttributeError(name)
            return type(name, (), {})

    sys.modules.setdefault("httpx", _AnyModule("httpx"))


_stub_optional_deps()

from hermes_state import SessionDB  # noqa: E402

PHRASE = "the relay is not reachable from my side at all"


class SearchWithoutFts5Test(unittest.TestCase):
    """The LIKE fallback is the whole point: without it the phone cannot search."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        (tmp / "workspace").mkdir(parents=True, exist_ok=True)
        self.db = SessionDB(tmp / "state.db")
        self.db.create_session("s1", "mobile")
        self.db.append_message("s1", "assistant", PHRASE)
        self.db.append_message("s1", "user", "an unrelated line about lunch")
        self.db.append_message("s1", "user", "wire the chat-send button to the settings page")

    def tearDown(self):
        try:
            close = getattr(self.db, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
        self._tmp.cleanup()

    def _force_no_fts(self):
        """Stand in for the Android interpreter: no index, and not 'stale' either
        (the stale branch is a *different* path and must not mask this one)."""
        self.db._fts_enabled = False
        self.db._fts_stale = False

    def test_content_is_found_without_fts(self):
        self._force_no_fts()
        hits = self.db.search_messages("reachable from my side")
        self.assertTrue(hits, "BUG-114: a no-FTS search must use the LIKE fallback, not return []")
        self.assertIn("reachable", json.dumps(hits, default=str).lower())

    def test_multiple_words_from_the_body_are_found(self):
        self._force_no_fts()
        hits = self.db.search_messages("unrelated line")
        self.assertTrue(hits, "a phrase from a second message must match too")

    def test_a_real_miss_stays_empty(self):
        self._force_no_fts()
        self.assertEqual(self.db.search_messages("zzqqxx-no-such-thing"), [])

    def test_hyphenated_term_hits_on_both_routes(self):
        """BUG-114 pin: ``chat-send`` must match on BOTH routes — the LIKE fallback
        (substring, no index) and the indexed route, where the sanitizer quotes the
        hyphenated term into a phrase so MATCH can't choke on the bare token."""
        if not self.db._fts_enabled:  # pragma: no cover — fts5-less desktop python
            self.skipTest("this interpreter has no fts5; only the fallback route is testable")
        self._force_no_fts()
        hits = self.db.search_messages("chat-send")
        self.assertTrue(hits, "the no-FTS route must find a hyphenated term via LIKE")
        self.assertIn("chat-send", json.dumps(hits, default=str).lower())
        self.db._fts_enabled = True
        self.db._fts_stale = False
        hits = self.db.search_messages("chat-send")
        self.assertTrue(hits, "the indexed route must find the quoted hyphenated phrase")
        self.assertIn("chat-send", json.dumps(hits, default=str).lower())

    def test_fts_rejected_query_falls_back_to_like_not_empty(self):
        """BUG-114 residual: a query that survives sanitization yet still raises at
        MATCH — ``a OR OR b`` leaves an empty side on the boolean, and real sqlite
        raises ``fts5: syntax error near "OR"`` — used to hit
        ``except sqlite3.OperationalError: return []`` and silently answer the
        empty-set. The LIKE fallback (which compiles the boolean subset itself)
        must answer instead."""
        if not self.db._fts_enabled:  # pragma: no cover — fts5-less desktop python
            self.skipTest("this interpreter has no fts5; the rejected-MATCH arm is unreachable")
        self._force_no_fts()
        hits = self.db.search_messages("reachable OR OR lunch")
        self.assertTrue(hits, "the no-FTS route already LIKE-falls-back; keep it honest")
        self.db._fts_enabled = True
        self.db._fts_stale = False
        hits = self.db.search_messages("reachable OR OR lunch")
        self.assertTrue(
            hits,
            "BUG-114: an FTS-rejected query must retry via the LIKE fallback, not return []")
        self.assertIn("reachable", json.dumps(hits, default=str).lower())

    def test_transient_operational_error_answers_empty_without_fallback(self):
        """BUG-114 residual review: the LIKE fallback is for SYNTAX rejections only.
        A transient OperationalError (``database is locked`` contention window) must
        keep the historical empty answer — routing it to the full-table LIKE scan
        mid-lock could raise out of search_messages."""
        if not self.db._fts_enabled:  # pragma: no cover — fts5-less desktop python
            self.skipTest("this interpreter has no fts5; the MATCH arm is unreachable")
        self.db._fts_stale = False
        fallback_calls = []
        original = type(self.db)._search_messages_like_fallback
        real_read_all = type(self.db)._read_all

        def locked_on_match(db, sql, params=None):
            if "MATCH" in sql:  # only the FTS MATCH read — earlier reads stay real
                raise sqlite3.OperationalError("database is locked")
            return real_read_all(db, sql, params)

        def counting_fallback(db, *a, **k):
            fallback_calls.append(1)
            return original(db, *a, **k)

        with mock.patch.object(type(self.db), "_search_messages_like_fallback", counting_fallback), \
                mock.patch.object(type(self.db), "_read_all", locked_on_match):
            hits = self.db.search_messages("reachable")
        self.assertEqual(hits, [], "a transient lock answers empty — no LIKE scan mid-lock")
        self.assertEqual(fallback_calls, [], "the fallback must NOT run for a non-syntax error")

    def test_indexed_path_agrees_when_fts5_is_available(self):
        """Guard the normal route too: when the interpreter HAS fts5 the index is
        used, and it must return the same conversation."""
        if not self.db._fts_enabled:  # pragma: no cover — fts5-less desktop python
            self.skipTest("this interpreter has no fts5; the fallback tests cover it")
        hits = self.db.search_messages("reachable")
        self.assertTrue(hits, "the indexed path must find the message")


if __name__ == "__main__":
    unittest.main(verbosity=2)
