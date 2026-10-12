#!/usr/bin/env python3
"""BH-000048 + BH-000047 regression tests — the gateway boot state machine.

GitHub #102 (BH-000048): ``_STATE['starting']`` was initialized False and
only ever written False again — never True — so ``info_json``'s ``running``
field reported false through the WHOLE cold boot (hermes extraction, compile,
uvicorn bind), telling the RN client the runtime was dead while it was
booting. ``start()`` now arms ``starting=True`` at boot entry, before any
hermes boot work, and ``running`` is an honest function of the state
(pure helper ``_running_payload``).

GitHub #101 (BH-000047): the boot chain was single-shot — a failure anywhere
in ``_run_server`` landed in ``_STATE['error']`` with no retry, and the
Kotlin side's ``bootAttempted`` AtomicBoolean never retries either, so cron
knocks and the RN client saw a dead gateway for the process life.
``_supervised_server_boot`` now retries on a bounded schedule
(``_BOOT_RETRY_DELAYS_S`` = 5s/15s/60s), resets the per-attempt state between
attempts, logs each failure with its attempt number, and gives up after the
last retry leaving the error state exactly as before.

Local, stdlib-only, self-contained, no network, no server, no device: run with

    python3 app/python-runtime/tests/test_gateway_boot_state.py

and expect exit 0 with ``OK``. Mirrors test_gateway_boot_gate.py conventions.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# moch.gateway_server is stdlib-only at import time — safe on bare python3.
import moch.gateway_server as gs  # noqa: E402
from moch.gateway_server import (  # noqa: E402
    _BOOT_RETRY_DELAYS_S,
    _boot_retry_delay_s,
    _running_payload,
    _supervised_server_boot,
)


def _fresh_state(**overrides) -> dict:
    """A copy of the module's initial state shape, for pure-view tests."""
    state = {
        "started": False,
        "starting": False,
        "port": None,
        "token": None,
        "error": None,
        "boot_gave_up": False,
    }
    state.update(overrides)
    return state


class RunningPayloadTests(unittest.TestCase):
    """#102 — ``running`` must be an honest function of the boot state."""

    def test_fresh_state_reports_not_running(self):
        payload = _running_payload(_fresh_state())
        self.assertFalse(payload["running"])
        self.assertFalse(payload["ready"])
        self.assertIsNone(payload["error"])

    def test_starting_true_reports_running_true(self):
        """The BH-000048 core: during the cold boot (starting armed, not yet
        ready) the payload says the gateway is coming up — not dead."""
        payload = _running_payload(_fresh_state(starting=True, port=9119))
        self.assertTrue(payload["running"])
        # not ready yet: nothing has accepted a connection
        self.assertFalse(payload["ready"])

    def test_started_reports_running_and_ready_shape(self):
        payload = _running_payload(_fresh_state(started=True, port=9119, token="t"))
        self.assertTrue(payload["running"])
        self.assertTrue(payload["ready"])  # port-independent half
        self.assertEqual(payload["port"], 9119)
        self.assertEqual(payload["token"], "t")

    def test_error_path_reports_running_false_with_error(self):
        """A failed boot must not look alive — error present and running
        false, both while starting and once started."""
        for overrides in ({"starting": True}, {"started": True}):
            with self.subTest(overrides=overrides):
                payload = _running_payload(_fresh_state(error="boom", **overrides))
                self.assertFalse(payload["running"])
                self.assertEqual(payload["error"], "boom")


class StartArmsBootStateTests(unittest.TestCase):
    """#102 — ``start()`` arms ``starting`` BEFORE any hermes boot work."""

    def setUp(self) -> None:
        self._state_snapshot = dict(gs._STATE)
        gs._STATE.update(_fresh_state())

    def tearDown(self) -> None:
        gs._STATE.clear()
        gs._STATE.update(self._state_snapshot)

    def test_starting_armed_before_hermes_boot_work(self):
        seen: list[bool] = []

        import moch.hermes_boot as hermes_boot

        def fake_boot():
            seen.append(bool(gs._STATE["starting"]))
            return {"ok": False, "errors": ["synthetic failure"]}

        with mock.patch.object(hermes_boot, "boot", fake_boot):
            info = gs.start()

        # During the (failing) hermes boot work the state was already armed.
        self.assertEqual(seen, [True], "starting must be True before hermes boot work")
        # And the failed-boot early return is honest too: not running, error set.
        self.assertFalse(info["running"])
        self.assertIn("hermes boot failed", info["error"])
        self.assertFalse(gs._STATE["starting"])

    def test_restart_clears_stale_terminal_error(self):
        """A re-start must not inherit the previous run's terminal error —
        the fresh attempt is judged on its own (the wait loop would otherwise
        bail instantly on the stale error)."""
        import moch.hermes_boot as hermes_boot

        gs._STATE["error"] = "old terminal failure"
        gs._STATE["boot_gave_up"] = True

        def fake_boot():
            self.assertIsNone(gs._STATE["error"], "stale error must be cleared at start()")
            self.assertFalse(gs._STATE["boot_gave_up"])
            return {"ok": False, "errors": ["stop here"]}

        with mock.patch.object(hermes_boot, "boot", fake_boot):
            gs.start()


class BootRetryScheduleTests(unittest.TestCase):
    """#101 — the pure retry schedule: 5s / 15s / 60s, then give up."""

    def test_schedule_contents(self):
        self.assertEqual(_BOOT_RETRY_DELAYS_S, (5.0, 15.0, 60.0))

    def test_delay_before_each_retry_then_exhausted(self):
        self.assertEqual(_boot_retry_delay_s(1), 5.0)   # after failed attempt 1
        self.assertEqual(_boot_retry_delay_s(2), 15.0)  # after failed attempt 2
        self.assertEqual(_boot_retry_delay_s(3), 60.0)  # after failed attempt 3
        self.assertIsNone(_boot_retry_delay_s(4))       # schedule exhausted → give up
        self.assertIsNone(_boot_retry_delay_s(99))
        self.assertIsNone(_boot_retry_delay_s(0))       # non-attempts never retry


class SupervisedBootTests(unittest.TestCase):
    """#101 — the supervised wrapper around the server boot.

    ``_run_server`` is patched at module level (it blocks while the real
    server serves); ``time.sleep`` records instead of waiting, capturing the
    state at each backoff so the between-attempt reset is observable.
    """

    def setUp(self) -> None:
        self._state_snapshot = dict(gs._STATE)
        gs._STATE.update(_fresh_state(port=9119))
        self.calls: list[int] = []

    def tearDown(self) -> None:
        gs._STATE.clear()
        gs._STATE.update(self._state_snapshot)

    def _run_supervisor(self, fail_times: int):
        """fake _run_server: fails (records error, returns) for the first
        ``fail_times`` calls, then returns without an error (a boot that
        serves / stops cleanly). Returns the recorded sleeps as
        (delay, error_at_sleep_time) pairs."""
        sleeps: list[tuple[float, object]] = []
        total = fail_times + 1

        def fake_run_server(port: int) -> None:
            self.calls.append(port)
            if len(self.calls) <= fail_times:
                gs._STATE["error"] = f"synthetic failure {len(self.calls)}/{total}"

        def fake_sleep(delay: float) -> None:
            sleeps.append((delay, gs._STATE["error"]))

        with mock.patch.object(gs, "_run_server", fake_run_server), \
                mock.patch.object(gs.time, "sleep", fake_sleep):
            _supervised_server_boot(9119)
        return sleeps

    def test_retry_schedule_is_used_and_state_cleared_between_attempts(self):
        sleeps = self._run_supervisor(fail_times=3)
        # one initial try + one retry per scheduled delay
        self.assertEqual(len(self.calls), 1 + len(_BOOT_RETRY_DELAYS_S))
        self.assertEqual(self.calls, [9119] * len(self.calls))
        # every backoff fired, in schedule order, with the per-attempt error
        # already cleared — the honest "booting" state across the window
        self.assertEqual([d for d, _ in sleeps], list(_BOOT_RETRY_DELAYS_S))
        for delay, error in sleeps:
            self.assertIsNone(error, "error must be cleared between attempts")

    def test_give_up_after_last_retry_preserves_error_state(self):
        sleeps = self._run_supervisor(fail_times=99)  # never succeeds
        total = 1 + len(_BOOT_RETRY_DELAYS_S)
        self.assertEqual(len(self.calls), total)
        self.assertEqual(len(sleeps), len(_BOOT_RETRY_DELAYS_S))
        # exactly today's give-up shape: terminal error from the LAST failure,
        # gave_up marker set for the wait loop / info() self-heal
        self.assertIn(f"synthetic failure {total}/", str(gs._STATE["error"]))
        self.assertTrue(gs._STATE["boot_gave_up"])
        self.assertFalse(gs._STATE["started"])

    def test_success_on_later_attempt_stops_the_schedule(self):
        sleeps = self._run_supervisor(fail_times=1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual([d for d, _ in sleeps], [_BOOT_RETRY_DELAYS_S[0]])
        # serving boot: no terminal error, never gave up
        self.assertIsNone(gs._STATE["error"])
        self.assertFalse(gs._STATE["boot_gave_up"])

    def test_clean_first_attempt_never_retries(self):
        sleeps = self._run_supervisor(fail_times=0)
        self.assertEqual(self.calls, [9119])
        self.assertEqual(sleeps, [])
        self.assertFalse(gs._STATE["boot_gave_up"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
