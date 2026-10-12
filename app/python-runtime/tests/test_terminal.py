#!/usr/bin/env python3
"""M9 unit tests — interactive guest PTY session (moch/terminal.py).

Local, stdlib-only, self-contained, no network, no Android: run with

    python3 app/python-runtime/tests/test_terminal.py

and expect exit 0 with ``OK``. Covers the PTY engine through the
``_build_launch`` seam (patched to plain desktop bash): probe capabilities,
start/write/drain round-trip, replay buffer, resize, kill/restart, and the
write-rejects-garbage contract. Mirrors test_linux_exec.py conventions.
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

from moch import terminal  # noqa: E402


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

    def tearDown(self) -> None:
        terminal.kill()

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
