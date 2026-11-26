#!/usr/bin/env python3
"""M9 unit tests — interactive guest PTY sessions (moch/terminal.py).

Local, stdlib-only, self-contained, no network, no Android: run with

    python3 app/python-runtime/tests/test_terminal.py

and expect exit 0 with ``OK``. Covers the PTY engine through the
``_build_launch`` seam (patched to plain desktop bash): probe capabilities,
legacy start/write/drain round-trips, per-session isolation, the 64 KiB
replay bank, resize, kill/restart, cwd translation, and the
write-rejects-garbage / invalid-id contracts. Mirrors test_linux_exec.py
conventions.
"""

from __future__ import annotations

import atexit
import base64
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

_SANDBOX = tempfile.mkdtemp(prefix="moch-term-test-")
atexit.register(shutil.rmtree, _SANDBOX, True)
os.environ["HERMES_HOME"] = _SANDBOX
os.environ["HOME"] = _SANDBOX
os.environ["MOCH_NATIVE_LIB_DIR"] = _SANDBOX

from moch import linux_env  # noqa: E402
from moch import terminal  # noqa: E402

_SESSION_IDS = ("term-test-a", "term-test-b")


def _b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def _unb64(c: str) -> str:
    return base64.b64decode(c).decode(errors="replace")


class TerminalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Desktop seam: plain interactive bash instead of the Android guest.
        terminal._build_launch = lambda argv: (["/bin/bash", "-i"], dict(os.environ))  # noqa: E731

    def setUp(self) -> None:
        terminal.kill()
        for sid in _SESSION_IDS:
            terminal.kill_session(sid)

    def tearDown(self) -> None:
        terminal.kill()
        for sid in _SESSION_IDS:
            terminal.kill_session(sid)

    def _wait_for(self, marker: str, timeout: float = 10.0) -> str:
        deadline = time.monotonic() + timeout
        blob = ""
        while time.monotonic() < deadline:
            d = terminal.drain()
            for c in d["chunks"]:
                blob += _unb64(c)
            if marker in blob:
                return blob
            time.sleep(0.2)
        self.fail(f"marker {marker!r} never arrived; got: {blob[-500:]!r}")
        return blob

    def _wait_for_session(self, session_id: str, marker: str, timeout: float = 10.0) -> str:
        deadline = time.monotonic() + timeout
        blob = ""
        while time.monotonic() < deadline:
            d = terminal.drain_session(session_id)
            for c in d["chunks"]:
                blob += _unb64(c)
            if marker in blob:
                return blob
            time.sleep(0.2)
        self.fail(f"marker {marker!r} never arrived on {session_id}; got: {blob[-500:]!r}")
        return blob

    def test_probe_shell_roundtrip(self) -> None:
        p = terminal.probe()
        self.assertTrue(p["pty"], p)
        self.assertTrue(p["shell"], p)

    def test_start_write_drain(self) -> None:
        r = terminal.start(80, 24)
        self.assertTrue(r["ok"], r)
        self.assertTrue(terminal.is_running())
        # Idempotent while alive.
        r2 = terminal.start(80, 24)
        self.assertTrue(r2["ok"] and r2["already_running"])
        marker = f"HELLO_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        blob = self._wait_for(marker)
        self.assertIn(marker, blob)

    def test_ctrl_c_interrupt(self) -> None:
        terminal.start(80, 24)
        terminal.drain()
        terminal.write(_b64("sleep 30\n"))
        time.sleep(0.5)
        terminal.write(_b64("\x03"))
        marker = f"AFTER_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        blob = self._wait_for(marker)
        self.assertIn(marker, blob)
        self.assertTrue(terminal.is_running())

    def test_replay_and_resize(self) -> None:
        terminal.start(80, 24)
        marker = f"REPLAY_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        self._wait_for(marker)
        rep = terminal.replay()
        self.assertTrue(rep["ok"] and rep["alive"])
        self.assertIn(marker, _unb64(rep["chunk"]))
        rs = terminal.resize(100, 30)
        self.assertTrue(rs["ok"] and rs["cols"] == 100)

    def test_kill_and_write_rejected(self) -> None:
        terminal.start(80, 24)
        self.assertTrue(terminal.kill()["ok"])
        self.assertFalse(terminal.is_running())
        w = terminal.write(_b64("echo hi\n"))
        self.assertFalse(w["ok"])
        bad = terminal.write("!!!not-base64!!!")
        self.assertFalse(bad["ok"])
        # Fresh boot after kill.
        r = terminal.start(80, 24)
        self.assertTrue(r["ok"] and not r.get("already_running"))

    def test_rapid_restart_race(self) -> None:
        # A lingering reader from a killed shell must neither mark the new
        # session dead nor leak its output into it (generation guard).
        for i in range(5):
            r = terminal.start(80, 24)
            self.assertTrue(r["ok"], f"cycle {i}: {r}")
            self.assertTrue(terminal.is_running(), f"cycle {i}: stale reader killed it")
            terminal.kill()
        r = terminal.start(80, 24)
        self.assertTrue(r["ok"] and terminal.is_running())
        marker = f"RACE_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        self._wait_for(marker)

    def test_replay_reset_across_kill_restart(self) -> None:
        # BUG-115: start → emit → kill → start must replay NOTHING from the
        # dead session — the JS cold-attach repaints from replay(), so a
        # surviving bank painted the old scrollback into the fresh shell.
        terminal.start(80, 24)
        marker = f"DEAD_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        self._wait_for(marker)
        self.assertIn(marker, _unb64(terminal.replay()["chunk"]))
        terminal.kill()
        # Killed alone: replay is empty (kill clears the bank too) — no
        # process exists, so this is deterministic.
        rep = terminal.replay()
        self.assertTrue(rep["ok"] and not rep["alive"])
        self.assertEqual(_unb64(rep["chunk"]), "")
        # Fresh boot: immediately after start the bank is empty again (the
        # new bash's own prompt may race in, but the DEAD session's bytes
        # must be gone)…
        r = terminal.start(80, 24)
        self.assertTrue(r["ok"] and not r.get("already_running"))
        self.assertNotIn(marker, _unb64(terminal.replay()["chunk"]))
        # …and the bank serves the NEW session's own output afterwards.
        fresh = f"FRESH_{os.getpid()}"
        terminal.write(_b64(f"echo {fresh}\n"))
        self._wait_for(fresh)
        rep2 = terminal.replay()
        self.assertTrue(rep2["ok"] and rep2["alive"])
        self.assertIn(fresh, _unb64(rep2["chunk"]))
        self.assertNotIn(marker, _unb64(rep2["chunk"]))

    def test_replay_survives_reattach_without_kill(self) -> None:
        # The bank itself is NOT removed (BUG-115 fix keeps it): a WebView
        # reload of a LIVE session still repaints from replay().
        terminal.start(80, 24)
        marker = f"LIVE_{os.getpid()}"
        terminal.write(_b64(f"echo {marker}\n"))
        self._wait_for(marker)
        terminal.drain()  # the UI consumed the live chunks…
        self.assertTrue(terminal.is_running())
        rep = terminal.replay()  # …and repaints from the bank
        self.assertTrue(rep["ok"] and rep["alive"])
        self.assertIn(marker, _unb64(rep["chunk"]))

    # ── Per-session isolation ──────────────────────────────────────────────

    def test_two_sessions_are_isolated(self) -> None:
        a, b = _SESSION_IDS
        self.assertTrue(terminal.start_session(a, None, 80, 24)["ok"])
        self.assertTrue(terminal.start_session(b, None, 90, 30)["ok"])
        self.assertTrue(terminal.is_session_running(a))
        self.assertTrue(terminal.is_session_running(b))

        mark_a = f"ONLY_A_{os.getpid()}"
        terminal.write_session(a, _b64(f"echo {mark_a}\n"))
        self.assertIn(mark_a, self._wait_for_session(a, mark_a))
        # B's live queue and replay bank never see A's bytes.
        self.assertNotIn(mark_a, _unb64(terminal.replay_session(b)["chunk"]))
        b_chunks = "".join(_unb64(c) for c in terminal.drain_session(b)["chunks"])
        self.assertNotIn(mark_a, b_chunks)

        mark_b = f"ONLY_B_{os.getpid()}"
        terminal.write_session(b, _b64(f"echo {mark_b}\n"))
        self.assertIn(mark_b, self._wait_for_session(b, mark_b))
        self.assertIn(mark_b, _unb64(terminal.replay_session(b)["chunk"]))
        self.assertNotIn(mark_b, _unb64(terminal.replay_session(a)["chunk"]))

        # Resize is per-session too.
        self.assertEqual(terminal.resize_session(a, 120, 40)["cols"], 120)
        self.assertEqual(terminal.resize_session(b, 100, 30)["cols"], 100)

        # Killing A leaves B's shell alive and writable.
        self.assertTrue(terminal.kill_session(a)["ok"])
        self.assertFalse(terminal.is_session_running(a))
        self.assertTrue(terminal.is_session_running(b))
        self.assertFalse(terminal.write_session(a, _b64("echo x\n"))["ok"])
        mark_b2 = f"AFTER_KILL_{os.getpid()}"
        terminal.write_session(b, _b64(f"echo {mark_b2}\n"))
        self.assertIn(mark_b2, self._wait_for_session(b, mark_b2))
        self.assertTrue(terminal.drain_session(b)["alive"])
        # A's read path is a clean dead snapshot, never B's bytes.
        self.assertFalse(terminal.drain_session(a)["alive"])
        self.assertEqual(_unb64(terminal.replay_session(a)["chunk"]), "")

    def test_invalid_session_ids_are_rejected(self) -> None:
        # `__default__` is the OpenCode server's hidden shell: public
        # per-session APIs must never address it.
        for bad in ("", "   ", "../escape", "a/b", "x" * 65, ".", "..", "__default__"):
            r = terminal.start_session(bad)
            self.assertFalse(r["ok"], bad)
            self.assertIn("invalid session id", r.get("error", ""))
            self.assertFalse(terminal.write_session(bad, _b64("hi"))["ok"])
            self.assertFalse(terminal.resize_session(bad, 80, 24)["ok"])
            self.assertFalse(terminal.kill_session(bad)["ok"])
        # Valid but unknown ids are safe reads, never a new session.
        self.assertEqual(terminal.drain_session("term-unknown")["chunks"], [])
        self.assertFalse(terminal.is_session_running("term-unknown"))
        self.assertTrue(terminal.kill_session("term-unknown")["ok"])

    def test_replay_consumes_pending_queue(self) -> None:
        # A reattach snapshot must not be followed by the same bytes on the
        # next drain (the remounted xterm would paint them twice).
        a = _SESSION_IDS[0]
        self.assertTrue(terminal.start_session(a, None, 80, 24)["ok"])
        marker = f"SNAP_{os.getpid()}"
        terminal.write_session(a, _b64(f"echo {marker}\n"))
        deadline = time.monotonic() + 10
        chunk = ""
        while time.monotonic() < deadline:
            chunk = _unb64(terminal.replay_session(a)["chunk"])
            if marker in chunk:
                break
            time.sleep(0.2)
        self.assertIn(marker, chunk)
        later = "".join(_unb64(c) for c in terminal.drain_session(a)["chunks"])
        self.assertNotIn(marker, later)

    def test_clear_session_keeps_shell_and_wipes_bank(self) -> None:
        a = _SESSION_IDS[0]
        self.assertTrue(terminal.start_session(a, None, 80, 24)["ok"])
        marker = f"CLEAR_{os.getpid()}"
        terminal.write_session(a, _b64(f"echo {marker}\n"))
        self.assertIn(marker, self._wait_for_session(a, marker))
        self.assertTrue(terminal.clear_session(a)["ok"])
        self.assertEqual(_unb64(terminal.replay_session(a)["chunk"]), "")
        self.assertEqual(terminal.drain_session(a)["chunks"], [])
        self.assertTrue(terminal.is_session_running(a))
        after = f"POSTWIPE_{os.getpid()}"
        terminal.write_session(a, _b64(f"echo {after}\n"))
        self.assertIn(after, self._wait_for_session(a, after))
        self.assertNotIn(marker, _unb64(terminal.replay_session(a)["chunk"]))

    def test_session_start_passes_host_cwd_to_launcher(self) -> None:
        recorded: list[str | None] = []
        original = terminal._build_launch

        def fake(argv, cwd=None):  # noqa: ANN001, ANN202 — test seam
            recorded.append(cwd)
            return ["/bin/bash", "-i"], dict(os.environ)

        terminal._build_launch = fake
        try:
            r = terminal.start_session(_SESSION_IDS[0], "/tmp/some-project", 80, 24)
            self.assertTrue(r["ok"], r)
            self.assertEqual(recorded, ["/tmp/some-project"])
            self.assertTrue(terminal.is_session_running(_SESSION_IDS[0]))
        finally:
            terminal._build_launch = original

    # ── cwd translation (linux_env) ────────────────────────────────────────

    def test_cwd_mapping(self) -> None:
        workspace = Path(_SANDBOX) / "workspace"
        project = workspace / "proj" / "sub"
        project.mkdir(parents=True, exist_ok=True)
        elsewhere = Path(_SANDBOX) / "elsewhere"
        elsewhere.mkdir(parents=True, exist_ok=True)
        missing = Path(_SANDBOX) / "missing"
        old_ws = os.environ.get("MOCH_WORKSPACE")
        os.environ["MOCH_WORKSPACE"] = str(workspace)
        try:
            def launch(cwd):
                argv, _env = linux_env.build_guest_launch(["/bin/bash", "-i"], cwd)
                return argv[argv.index("-w") + 1], argv

            # Default (and garbage) still start at the workspace bind.
            self.assertEqual(launch(None)[0], "/workspace")
            self.assertEqual(launch("")[0], "/workspace")
            self.assertEqual(launch(str(missing))[0], "/workspace")
            self.assertNotIn(f"{missing}:{missing}", launch(str(missing))[1])

            # Host path under MOCH_WORKSPACE → guest /workspace/<rel>, no
            # additional bind (the workspace bind already covers it).
            workdir, argv = launch(str(project))
            self.assertEqual(workdir, "/workspace/proj/sub")
            self.assertNotIn(f"{project}:{project}", argv)
            workdir, _argv = launch(str(workspace))
            self.assertEqual(workdir, "/workspace")

            # Guest-style /workspace path maps back to the host workspace.
            self.assertEqual(launch("/workspace/proj/sub")[0], "/workspace/proj/sub")
            self.assertEqual(launch("/workspace/../etc")[0], "/workspace")
            self.assertEqual(launch("/workspace/nope")[0], "/workspace")

            # Any other existing host dir is self-bound and used as workdir.
            workdir, argv = launch(str(elsewhere))
            self.assertEqual(workdir, str(elsewhere))
            self.assertIn(f"{elsewhere}:{elsewhere}", argv)
        finally:
            if old_ws is None:
                os.environ.pop("MOCH_WORKSPACE", None)
            else:
                os.environ["MOCH_WORKSPACE"] = old_ws


if __name__ == "__main__":
    unittest.main(verbosity=2)
