#!/usr/bin/env python3
"""#108 unit tests — cron.manage action='get' returns the FULL stored prompt.

The list action's ``prompt_preview`` is capped at 100 chars (+ literal
"..."), and the app's edit sheet used to prefill from that preview — saving
then rewrote the stored prompt to the truncated text. ``get`` exists so the
edit prefill reads the real prompt.

Local, stdlib-only bootstrap (test_kanban_rpc.py conventions); run with the
hermes venv or a stdlib-capable python3:

  python3 app/python-runtime/tests/test_cron_get.py

Covers: get returns the full prompt while list truncates it; the formatted
row (job_id/schedule) is the same shape pause/resume return; unknown and
empty refs error with the cronjob resolver's message.
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


class CronGetTest(unittest.TestCase):
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

    def tearDown(self):
        self._tmp.cleanup()

    def _call(self, method, **params):
        return self.tg._methods[method](1, params)

    def test_get_returns_full_prompt_despite_truncated_preview(self):
        prompt = "SUMMARIZE-" + "x" * 250
        created = self._call("cron.manage", action="add", name="longjob",
                             schedule="every 30m", prompt=prompt)
        self.assertNotIn("error", created, created)
        jid = created["result"]["job_id"]

        listing = self._call("cron.manage", action="list", include_disabled=True)
        row = next(j for j in listing["result"]["jobs"] if j["job_id"] == jid)
        # The preview IS truncated — this is the truncation 'get' repairs.
        self.assertTrue(row["prompt_preview"].endswith("..."), row["prompt_preview"])
        self.assertLess(len(row["prompt_preview"]), len(prompt))
        self.assertNotIn("prompt", row)

        got = self._call("cron.manage", action="get", name=jid)
        self.assertNotIn("error", got, got)
        job = got["result"]["job"]
        self.assertEqual(job["job_id"], jid)
        self.assertEqual(job["schedule"], row["schedule"])  # same _format_job row…
        self.assertEqual(job["prompt"], prompt)  # …plus the full prompt
        self.assertTrue(got["result"]["success"])

    def test_get_unknown_and_empty_refs_error(self):
        got = self._call("cron.manage", action="get", name="no-such-job")
        res = got.get("result", {})
        self.assertFalse(res.get("success", True), got)
        self.assertIn("not found", res.get("error", ""))
        self.assertIn("cronjob(action='list')", res.get("error", ""))

        empty = self._call("cron.manage", action="get", name="")
        res2 = empty.get("result", {})
        self.assertFalse(res2.get("success", True), empty)
        self.assertIn("job_id is required", res2.get("error", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
