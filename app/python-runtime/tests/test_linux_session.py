#!/usr/bin/env python3
"""BH-000051 / GitHub #104 regression tests — persistent-session timeout desync.

``linux_session.run()`` reads stdout until a sentinel, then one more line
(the exit code). On timeout, ``_read_until_sentinel`` raised but the shell
kept running the command — its sentinel + rc lines arrived LATER and stayed
in the pipe, so the NEXT ``run()`` consumed the STALE sentinel/rc of the
previous command (wrong output, wrong exit code — a poisoned shell). The fix
marks the session poisoned on timeout, drains the pipe best-effort, and the
next ``run()`` respawns the shell through the existing restart machinery
instead of trusting the stream.

The protocol layer is pure pipe + sentinel — no proot needed — so the desync
scenario runs against a real ``sh`` subprocess with the proot launch builder
patched out. Local, stdlib-only, self-contained, no network, no device: run with

    python3 app/python-runtime/tests/test_linux_session.py

and expect exit 0 with ``OK``. Mirrors test_gateway_boot_gate.py conventions.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import moch.linux_session as ls  # noqa: E402

# The plain-sh stand-in for the proot launch: same pipes, same protocol, no
# guest. Everything under test (wrapper, sentinel read, timeout poison,
# respawn) lives above the launch mechanics.
_SH_ARGV = [os.environ.get("MOCH_TEST_SH", "/bin/sh")]


def _plain_sh_argv():
    return list(_SH_ARGV), {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}


def _have_sh() -> bool:
    try:
        return Path(_SH_ARGV[0]).exists()
    except OSError:
        return False


class WrapCommandTests(unittest.TestCase):
    """The extracted pure wrapper — exact wire shape the reader consumes."""

    def test_round_trip_shape(self):
        self.assertEqual(
            ls.wrap_command("echo hi"),
            "(echo hi) ; __rc=$? ; echo __MOCH_CMD_DONE__ ; echo $__rc",
        )

    def test_sentinel_lives_on_the_wrapper_not_the_caller(self):
        # the protocol's marker is owned here — callers pass raw payloads
        self.assertIn(ls._SENTINEL, ls.wrap_command("true"))
        self.assertNotIn(ls._SENTINEL, "true")

    def test_multiline_and_metacharacter_payloads_survive_wrapping(self):
        cmd = "printf 'a\\nb\\n' && grep -q x <<'EOF'\nline with ; echo and $__rc\nEOF"
        wrapped = ls.wrap_command(cmd)
        # the payload is parenthesized BEFORE the rc capture, so a payload
        # exit status is what $__rc sees
        self.assertTrue(wrapped.startswith("(" + cmd + ")"))
        self.assertTrue(wrapped.endswith("; echo $__rc"))


@unittest.skipUnless(_have_sh(), "needs a real sh for the pipe protocol")
class SessionDesyncTests(unittest.TestCase):
    """The desync scenario against a real sh subprocess (no proot): a timed-out
    command must not poison the next one."""

    def setUp(self) -> None:
        self._env_snapshot = dict(os.environ)
        self._state_snapshot = {k: v for k, v in ls._state.items() if k != "lock"}
        self._tmp = tempfile.TemporaryDirectory()
        home = Path(self._tmp.name) / ".hermes"
        os.environ["HERMES_HOME"] = str(home)
        # start() demands a bootstrapped-looking guest before launching
        linux = home / "linux"
        (linux / "bin").mkdir(parents=True)
        (linux / "bin" / "proot").write_bytes(b"fake")
        (linux / "rootfs").mkdir()
        # keep the drain window tight: the test's payload sleeps far longer
        self._drain = mock.patch.object(ls, "_DRAIN_TIMEOUT_S", 0.5)
        self._drain.start()
        self._argv = mock.patch.object(ls, "_build_argv", _plain_sh_argv)
        self._argv.start()
        ls._state["proc"] = None
        ls._state["started"] = False
        ls._state["poisoned"] = False

    def tearDown(self) -> None:
        try:
            ls.stop()
        except Exception:  # noqa: BLE001 — teardown must never mask the verdict
            pass
        self._drain.stop()
        self._argv.stop()
        ls._state.update(self._state_snapshot)
        os.environ.clear()
        os.environ.update(self._env_snapshot)
        self._tmp.cleanup()

    def test_healthy_round_trip(self):
        started = ls.start()
        self.assertTrue(started.get("ok"), started)
        result = ls.run("echo hello-$((1+1))")
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["exit"], 0)
        self.assertEqual(result["stdout"].strip(), "hello-2")

    def test_nonzero_exit_round_trips(self):
        ls.start()
        result = ls.run("echo before; exit 3")
        self.assertFalse(result.get("ok"))
        self.assertEqual(result["exit"], 3)
        self.assertEqual(result["stdout"].strip(), "before")

    def test_timeout_marks_poisoned_and_returns_error(self):
        ls.start()
        result = ls.run("sleep 5", timeout_s=0.3)
        self.assertFalse(result.get("ok"))
        self.assertEqual(result["error"], "command timed out")
        self.assertTrue(ls._state["poisoned"], "timeout must poison the session")

    def test_timed_out_command_cannot_poison_the_next_one(self):
        """The BH-000051 core: after a timeout the stream holds a stale
        sentinel/rc; the next command must see ITS OWN output and exit code
        (via respawn), not the leftovers of the timed-out one."""
        ls.start()
        first_proc = ls._state["proc"]
        timed_out = ls.run("sleep 5", timeout_s=0.3)
        self.assertEqual(timed_out.get("error"), "command timed out")

        result = ls.run("echo marker-$((20+3))")
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["exit"], 0, "must be the NEW command's rc, not the stale one")
        self.assertEqual(result["stdout"].strip(), "marker-23")
        # and it ran on a fresh shell: the poisoned stream was not trusted
        self.assertIsNot(ls._state["proc"], first_proc)
        self.assertFalse(ls._state["poisoned"])

    def test_poison_respawn_reuses_the_dead_shell_path(self):
        """The poison flag routes through the same restart machinery as a dead
        shell: a session whose shell also DIED after the timeout still boots a
        working replacement."""
        ls.start()
        ls.run("sleep 5", timeout_s=0.3)
        self.assertTrue(ls._state["poisoned"])
        result = ls.run("echo after-respawn")
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["stdout"].strip(), "after-respawn")


if __name__ == "__main__":
    unittest.main(verbosity=2)
