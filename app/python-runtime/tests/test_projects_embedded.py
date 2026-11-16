#!/usr/bin/env python3
"""Embedded-workspace project reality tests — projects.create/tree make REAL directories.

A project created in the mobile app must not be a sqlite-only phantom: with
``MOCH_WORKSPACE`` set (embedded gateway only), creation adopts ``<workspace>/<slug>``
as the primary folder and mkdirs it HOST-side — the guest proot binds that dir at
``/workspace``, so the host dir IS the guest dir. The tree build heals pre-existing
folder-less projects the same way. Without ``MOCH_WORKSPACE`` (desktop/TUI/dashboard)
nothing changes.

Local, stdlib-only bootstrap; run with the hermes venv:
  ~/.hermes/hermes-agent/venv/bin/python tests/test_projects_embedded.py
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


class TestEmbeddedProjectFolders(unittest.TestCase):
    def setUp(self):
        # Import FIRST: a skip from here must not leak HERMES_HOME pointing
        # at a temp dir whose tearDown then never runs (skipTest in setUp
        # skips tearDown too).
        try:
            import tui_gateway.server as tg
        except ImportError as exc:
            self.skipTest(f"hermes server deps unavailable: {exc}")
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        os.environ["HERMES_HOME"] = str(tmp)
        # Real-hermes-home marker (see test_kanban_rpc): without it the server
        # import rewrites HERMES_HOME to a scratch dir under the machine's ~/.hermes.
        (tmp / "config.yaml").write_text("# test world marker", "utf-8")
        self._saved_ws = os.environ.pop("MOCH_WORKSPACE", None)
        self.tg = tg
        self.home = tmp
        # Stands in for the bound <home>/.hermes/workspace (hermes_boot mkdirs + exports
        # the real one before the gateway starts).
        self.ws = tmp / "ws"
        self.ws.mkdir()
        # The shared launch session-store handle caches per launch home; this suite may
        # have imported the server under another test's home, so re-acquire for ours.
        tg._db = None
        tg._db_error = None

    def tearDown(self):
        self._set_ws(self._saved_ws)
        self._tmp.cleanup()

    def _set_ws(self, value):
        if value is None:
            os.environ.pop("MOCH_WORKSPACE", None)
        else:
            os.environ["MOCH_WORKSPACE"] = value

    def _call(self, method, **params):
        return self.tg._methods[method](1, params)

    def test_create_adopts_workspace_folder_when_embedded(self):
        self._set_ws(str(self.ws))
        res = self._call("projects.create", name="My Cool App!")
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        expected = str(self.ws / "my-cool-app")
        # Host-side mkdir == the guest's /workspace/<slug> thanks to the bind.
        self.assertTrue(os.path.isdir(expected), expected)
        self.assertEqual(proj["primary_path"], expected)
        self.assertEqual([f["path"] for f in proj["folders"]], [expected])
        self.assertTrue(proj["folders"][0]["is_primary"])

    def test_create_without_moch_workspace_is_unchanged(self):
        res = self._call("projects.create", name="Plain")
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        self.assertEqual(proj["folders"], [])
        self.assertIsNone(proj["primary_path"])

    def test_create_with_caller_folders_never_mkdirs(self):
        self._set_ws(str(self.ws))
        # Caller-supplied free text: stored verbatim, never created (the gateway's fs is
        # the Android host — arbitrary paths must not be mkdir'd).
        phantom = str(self.home / "nonexistent-phantom" / "xyz")
        res = self._call("projects.create", name="WithFolders", folders=[phantom])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        self.assertEqual([f["path"] for f in proj["folders"]], [phantom])
        self.assertFalse(os.path.exists(phantom))
        self.assertFalse((self.ws / "withfolders").exists())

    def test_create_duplicate_names_get_distinct_dirs(self):
        self._set_ws(str(self.ws))
        p1 = self._call("projects.create", name="Test")["result"]["project"]
        p2 = self._call("projects.create", name="Test")["result"]["project"]
        # Distinct DB slugs → distinct dirs; no silent folder sharing between projects.
        self.assertEqual(p1["primary_path"], str(self.ws / "test"))
        self.assertEqual(p2["primary_path"], str(self.ws / "test-2"))
        self.assertTrue(os.path.isdir(str(self.ws / "test")))
        self.assertTrue(os.path.isdir(str(self.ws / "test-2")))

    def test_tree_heals_existing_phantom_project_once(self):
        # Phantom created pre-fix (no MOCH_WORKSPACE): sqlite row, no folder, no dir.
        phantom = self._call("projects.create", name="Old App")["result"]["project"]
        self.assertEqual(phantom["folders"], [])
        self._set_ws(str(self.ws))
        tree = self._call("projects.tree")
        self.assertNotIn("error", tree, tree)
        node = next(p for p in tree["result"]["projects"] if p["id"] == phantom["id"])
        expected = str(self.ws / "old-app")
        self.assertEqual(node["path"], expected)
        self.assertTrue(os.path.isdir(expected), expected)
        # Idempotent: a second read re-adopts nothing (no duplicate folder rows).
        tree2 = self._call("projects.tree")
        node2 = next(p for p in tree2["result"]["projects"] if p["id"] == phantom["id"])
        self.assertEqual(node2["path"], expected)
        from hermes_cli import projects_db as pdb
        with pdb.connect_closing() as conn:
            healed = pdb.get_project(conn, phantom["id"])
        self.assertEqual([f.path for f in healed.folders], [expected])


if __name__ == "__main__":
    unittest.main(verbosity=2)
