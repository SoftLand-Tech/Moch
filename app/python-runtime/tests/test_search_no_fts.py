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
import sys
import tempfile
import unittest
from pathlib import Path

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

    def test_indexed_path_agrees_when_fts5_is_available(self):
        """Guard the normal route too: when the interpreter HAS fts5 the index is
        used, and it must return the same conversation."""
        if not self.db._fts_enabled:  # pragma: no cover — fts5-less desktop python
            self.skipTest("this interpreter has no fts5; the fallback tests cover it")
        hits = self.db.search_messages("reachable")
        self.assertTrue(hits, "the indexed path must find the message")


if __name__ == "__main__":
    unittest.main(verbosity=2)
