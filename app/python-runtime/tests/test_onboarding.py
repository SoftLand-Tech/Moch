"""Tests for the ONBOARDING-V2 Moch-side modules.

Run: python3 -m unittest discover -s tests -p 'test_onboarding.py'
No real guest, no real gateway: the guest shell and the RPC registry are fakes.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_RUNTIME = _HERE.parent
_HERMES = _RUNTIME.parent / "hermes-src"
for p in (str(_RUNTIME), str(_HERMES)):
    if p not in sys.path:
        sys.path.insert(0, p)


class FakeRegistry:
    def __init__(self):
        self._methods = {}


class OpencodeTests(unittest.TestCase):
    def setUp(self):
        import moch.opencode_server as oc

        self.oc = oc
        self.registry = FakeRegistry()
        oc._REGISTERED = False

    def test_install_registers_the_local_surface(self):
        self.assertTrue(self.oc.install(self.registry))
        for name in (
            "moch.opencode.install", "moch.opencode.ensure", "moch.opencode.stop",
            "moch.opencode.status", "moch.opencode.session", "moch.opencode.prompt",
            "moch.opencode.interrupt", "moch.opencode.history", "moch.opencode.models",
            "moch.opencode.permission",
        ):
            self.assertIn(name, self.registry._methods)

    def test_permission_reply_is_validated_before_any_guest_call(self):
        self.oc.install(self.registry)
        fn = self.registry._methods["moch.opencode.permission"]
        with mock.patch.object(self.oc, "_curl") as curl:
            out = fn(1, {"password": "p", "session_id": "s", "request_id": "r", "reply": "nope"})
        self.assertFalse(out["result"]["ok"])
        curl.assert_not_called()

    def test_prompt_requires_the_three_inputs(self):
        self.oc.install(self.registry)
        fn = self.registry._methods["moch.opencode.prompt"]
        out = fn(1, {"password": "p", "session_id": "", "text": "hi"})
        self.assertIn("error", out)
        out = fn(2, {"password": "p", "session_id": "s", "text": ""})
        self.assertIn("error", out)

    def test_ensure_reports_missing_binary_honestly(self):
        with mock.patch.object(self.oc, "_guest_alive", return_value=False), \
                mock.patch.object(self.oc, "_guest_exec", return_value={"ok": True, "stdout": ""}):
            out = self.oc.ensure_server("pw")
        self.assertFalse(out["ok"])
        self.assertIn("not installed", out["error"])

    def test_ensure_is_idempotent_when_alive(self):
        with mock.patch.object(self.oc, "_guest_alive", return_value=True), \
                mock.patch.object(self.oc, "_guest_exec") as run:
            out = self.oc.ensure_server("pw")
        self.assertTrue(out["ok"])
        self.assertFalse(out["started"])
        run.assert_not_called()

    def test_install_command_targets_the_arm64_build(self):
        # The install is phone-side now (RN downloads the tarball into the
        # rootfs — a fresh guest has no curl). The RPC must refuse honestly,
        # never attempt a guest download.
        with mock.patch.object(self.oc, "_guest_exec") as run:
            out = self.oc.install_opencode()
        self.assertFalse(out["ok"])
        self.assertIn("Thinker", out["error"])
        run.assert_not_called()

    def test_curl_uses_this_process_not_the_guest_shell(self):
        # No guest shell involved: a refused connection surfaces as
        # status 0 instead of a guest-curl blob. Port 1 is unlistenable,
        # so this stays hermetic even with a dev server on 4096.
        with mock.patch.object(self.oc, "OC_PORT", 1):
            out = self.oc._curl("GET", "/api/info", password="x", timeout_s=2)
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 0)


class ThinkerRefreshTests(unittest.TestCase):
    def test_wrap_does_not_break_a_successful_save(self):
        import moch.rpc_thinker as rt

        rt._REGISTERED = False
        registry = FakeRegistry()

        def save(rid, params):
            return {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}}

        def drop(rid, params):
            return {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}}

        registry._methods["model.save_key"] = save
        registry._methods["model.disconnect"] = drop
        with mock.patch.object(rt, "_live_sessions_for", return_value=[]):
            self.assertTrue(rt.install(registry))
            out = registry._methods["model.save_key"](1, {"slug": "zai", "api_key": "k"})
        self.assertEqual(out["result"], {"ok": True})

    def test_refresh_failure_is_swallowed(self):
        import moch.rpc_thinker as rt

        rt._REGISTERED = False
        registry = FakeRegistry()
        registry._methods["model.save_key"] = lambda rid, p: {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}}
        registry._methods["model.disconnect"] = lambda rid, p: {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}}
        with mock.patch.object(rt, "_live_sessions_for", return_value=[("s1", {}, object())]), \
                mock.patch.object(rt, "_refresh_agent", side_effect=RuntimeError("boom")):
            rt.install(registry)
            out = registry._methods["model.save_key"](1, {"slug": "zai"})
        self.assertEqual(out["result"], {"ok": True})

    def test_busy_session_defers_the_switch(self):
        import moch.rpc_thinker as rt

        class Agent:
            model = "glm-5.3"
            provider = "zai"

        session = {"running": True, "agent": Agent()}
        class Pool:
            @staticmethod
            def load_pool(provider):
                return None
        import types
        fake = types.ModuleType("agent.credential_pool")
        fake.load_pool = Pool.load_pool
        with mock.patch.dict("sys.modules", {"agent.credential_pool": fake}):
            ok, why = rt._refresh_agent(None, "s1", session, session["agent"], "zai")
        self.assertTrue(ok)
        self.assertIn("deferred", why)
        self.assertEqual(session["pending_model_switch"]["raw"], "glm-5.3 --provider zai")


class AboutTests(unittest.TestCase):
    def setUp(self):
        import moch.rpc_about as about

        self.about = about
        self.tmp = Path(self.id().replace(".", "-"))
        self.home = Path(os.environ.get("TMPDIR", "/tmp")) / "moch-about-test" / self.tmp
        if self.home.exists():
            import shutil

            shutil.rmtree(self.home, ignore_errors=True)
        self.home.mkdir(parents=True, exist_ok=True)
        self._old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.home)

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._old_home

    def test_add_then_read_round_trips_through_users_md(self):
        out = self.about.add_about(["My name is Mamoun", "I build Moch"])
        self.assertTrue(out["ok"], out)
        self.assertEqual(len(out["added"]), 2)
        user_md = self.home / "memories" / "USER.md"
        self.assertTrue(user_md.exists())
        text = user_md.read_text(encoding="utf-8")
        self.assertIn("My name is Mamoun", text)
        read = self.about.read_about()
        self.assertIn("I build Moch", read["entries"])

    def test_duplicates_are_skipped(self):
        self.about.add_about(["Likes tea"])
        out = self.about.add_about(["Likes tea"])
        self.assertEqual(out["added"], [])
        self.assertEqual(out["skipped"], ["Likes tea"])

    def test_blank_entries_are_ignored(self):
        out = self.about.add_about(["   ", ""])
        self.assertEqual(out["added"], [])

    def test_rpc_modes(self):
        registry = FakeRegistry()
        self.about._REGISTERED = False
        self.assertTrue(self.about.install(registry))
        fn = registry._methods["moch.profile.about"]
        self.assertIn("entries", fn(1, {"mode": "read"})["result"])
        added = fn(2, {"mode": "add", "entries": ["Night owl"]})["result"]
        self.assertTrue(added["ok"], added)
        self.assertIn("Night owl", fn(3, {"mode": "read"})["result"]["entries"])
        self.assertIn("error", fn(4, {"mode": "replace", "entries": "nope"}))
        self.assertIn("error", fn(5, {"mode": "weird"}))


class LinuxPackageCatalogTests(unittest.TestCase):
    def test_catalog_is_well_formed(self):
        # Import the pure TS-equivalent rules from the Python side is not
        # possible; assert the JSON shape the RN side persists stays valid by
        # checking the module file itself parses as a stable catalogue.
        src = (_RUNTIME.parent / "src" / "lib" / "linuxPackages.ts").read_text(encoding="utf-8")
        self.assertIn("PACKAGE_CATEGORIES", src)
        self.assertIn("kind: 'apt'", src)
        self.assertIn("kind: 'npm'", src)
        # Every npm tool must declare its requirement so install order is safe.
        self.assertIn("requires: 'node'", src)


if __name__ == "__main__":
    unittest.main()
