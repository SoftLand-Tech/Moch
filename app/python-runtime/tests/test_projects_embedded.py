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
        # Arbitrary caller paths are never mkdir'd. An unusable external path
        # no longer becomes the primary in embedded mode: a real workspace
        # folder is added as primary so new sessions cannot silently fall back
        # to /workspace.
        phantom = str(self.home / "nonexistent-phantom" / "xyz")
        res = self._call("projects.create", name="WithFolders", folders=[phantom])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        workspace_folder = str(self.ws / "withfolders")
        self.assertEqual([f["path"] for f in proj["folders"]], [workspace_folder, phantom])
        self.assertEqual(proj["primary_path"], workspace_folder)
        self.assertFalse(os.path.exists(phantom))
        self.assertTrue(os.path.isdir(workspace_folder))

    def test_create_guest_workspace_folder_maps_and_mkdirs(self):
        self._set_ws(str(self.ws))
        res = self._call("projects.create", name="Guest App", folders=["/workspace/guest-app"])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        expected = str(self.ws / "guest-app")
        self.assertEqual([f["path"] for f in proj["folders"]], [expected])
        self.assertEqual(proj["primary_path"], expected)
        self.assertTrue(os.path.isdir(expected), expected)

    def test_create_guest_workspace_nested_folder_maps(self):
        self._set_ws(str(self.ws))
        res = self._call("projects.create", name="Nested", folders=["/workspace/a/b"])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        expected = str(self.ws / "a" / "b")
        self.assertEqual(proj["primary_path"], expected)
        self.assertTrue(os.path.isdir(expected), expected)

    def test_create_guest_workspace_root_maps(self):
        self._set_ws(str(self.ws))
        res = self._call("projects.create", name="Root", folders=["/workspace"])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        # The workspace root is not a per-project workspace; adoption moves
        # the primary to <workspace>/<slug>.
        self.assertEqual(proj["primary_path"], str(self.ws / "root"))

    def test_create_guest_primary_path_maps(self):
        self._set_ws(str(self.ws))
        res = self._call("projects.create", name="Primary", primary_path="/workspace/primary")
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        expected = str(self.ws / "primary")
        self.assertEqual(proj["primary_path"], expected)
        self.assertEqual([f["path"] for f in proj["folders"]], [expected])
        self.assertTrue(os.path.isdir(expected), expected)

    def test_create_guest_escape_stays_verbatim_and_is_not_created(self):
        self._set_ws(str(self.ws))
        escape = "/workspace/../escaped-outside"
        res = self._call("projects.create", name="Escape", folders=[escape])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        # Never translated/mkdir'd: projects_db's own normalization stores an absolute spelling,
        # but nothing under (or beside) the workspace was created by this path.
        self.assertFalse((self.ws.parent / "escaped-outside").exists())
        self.assertFalse((self.ws / "escaped-outside").exists())

    def test_tree_heals_external_primary_into_workspace(self):
        self._set_ws(str(self.ws))
        external = Path(self._tmp.name) / "external-project"
        external.mkdir()
        project = self._call(
            "projects.create", name="External Project", folders=[str(external)]
        )["result"]["project"]
        expected = str(self.ws / "external-project")
        self.assertEqual(project["primary_path"], expected)
        tree = self._call("projects.tree")
        self.assertNotIn("error", tree, tree)
        node = next(p for p in tree["result"]["projects"] if p["id"] == project["id"])
        self.assertEqual(node["path"], expected)
        self.assertTrue(os.path.isdir(expected))
        # The external folder is kept, but the embedded primary is visible.
        from hermes_cli import projects_db as pdb
        with pdb.connect_closing() as conn:
            healed = pdb.get_project(conn, project["id"])
        self.assertIn(str(external), [f.path for f in healed.folders])

    def test_tree_heals_workspace_root_primary_to_project_dir(self):
        self._set_ws(str(self.ws))
        project = self._call(
            "projects.create", name="Rootly", primary_path="/workspace"
        )["result"]["project"]
        expected = str(self.ws / "rootly")
        # Create already heals; the next tree read is idempotent.
        self.assertEqual(project["primary_path"], expected)
        tree = self._call("projects.tree")
        node = next(p for p in tree["result"]["projects"] if p["id"] == project["id"])
        self.assertEqual(node["path"], expected)
        self.assertTrue(os.path.isdir(expected))

    def test_tree_keeps_a_valid_workspace_primary(self):
        self._set_ws(str(self.ws))
        project = self._call("projects.create", name="Already Good")["result"]["project"]
        first = project["primary_path"]
        tree = self._call("projects.tree")
        node = next(p for p in tree["result"]["projects"] if p["id"] == project["id"])
        self.assertEqual(node["path"], first)
        self.assertEqual(node["path"], str(self.ws / "already-good"))

    def test_create_guest_workspace_symlink_escape_is_not_created(self):
        self._set_ws(str(self.ws))
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        (self.ws / "escape").symlink_to(outside, target_is_directory=True)
        res = self._call("projects.create", name="Symlink Escape",
                         folders=["/workspace/escape/new"])
        self.assertNotIn("error", res, res)
        # The link is inside the workspace, its target is not: refuse to mkdir.
        self.assertFalse((outside / "new").exists())

    def test_session_cwd_accepts_guest_workspace_path(self):
        self._set_ws(str(self.ws))
        target = self.ws / "session-project"
        target.mkdir()
        cwd = self.tg._completion_cwd({"cwd": "/workspace/session-project"})
        self.assertEqual(cwd, str(target))

    def test_create_without_moch_workspace_leaves_guest_path_verbatim(self):
        res = self._call("projects.create", name="NoBind", folders=["/workspace/no-bind"])
        self.assertNotIn("error", res, res)
        proj = res["result"]["project"]
        self.assertEqual(proj["primary_path"], "/workspace/no-bind")
        self.assertFalse((self.ws / "no-bind").exists())

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
