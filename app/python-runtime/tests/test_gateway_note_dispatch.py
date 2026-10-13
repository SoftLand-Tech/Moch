#!/usr/bin/env python3
"""BUG-121 (gate-off half) + BUG-132 (warming half) tests — the capability
note that rides ``prompt.submit`` must fire exactly when the browser tools
are unusable, and never when they are present.

Local, stdlib-only, self-contained, no network, no device: run with

    python3 app/python-runtime/tests/test_gateway_note_dispatch.py

and expect exit 0 with ``OK``. Mirrors test_gateway_root_shim.py conventions
(``moch.gateway_server`` is stdlib-only at import time).

What this pins:

- ``_moch_prompt_note`` is the single decision point for BOTH notes: the
  warming note (relay armed, catalog not matured — the auto-continue promise)
  and the gate-off note (BUG-121: Moch platform, browser tools absent from
  the catalog — the model used to improvise with terminal curl because
  nothing told it the Moch Browser exists).
- Tools present ⇒ NEVER a note (either platform, either relay state).
- Desktop hermes (not the Moch platform, relay not armed) gets no note even
  with tools absent — the gate-off note is Moch-scoped.
- Warming wins over gate-off when both windows technically apply (the relay
  IS on its way; promising an auto-continue beats telling the user to act).
- ``_moch_platform`` honors MOCH_EMBEDDED=1 / MOCH_FLEET=1, the flags the
  embedded gateway itself sets at boot.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# moch.gateway_server is stdlib-only at import time — safe on bare python3.
from moch.gateway_server import (  # noqa: E402
    _MOCH_GATE_OFF_NOTE,
    _MOCH_WARMING_NOTE,
    _moch_platform,
    _moch_prompt_note,
)

_PLATFORM_KEYS = ("MOCH_EMBEDDED", "MOCH_FLEET")


class PromptNoteDecisionTests(unittest.TestCase):
    """``_moch_prompt_note`` — the pure note-selection contract."""

    def test_warming_fires_when_armed_but_not_ready(self):
        self.assertIs(
            _moch_prompt_note(relay_armed=True, moch_platform=True, tools_ready=False),
            _MOCH_WARMING_NOTE,
        )

    def test_gate_off_fires_on_moch_platform_with_tools_absent(self):
        """The BUG-121 regression: relay off + Moch platform ⇒ the note that
        names the Browser screen and forbids the curl improvisation."""
        note = _moch_prompt_note(relay_armed=False, moch_platform=True, tools_ready=False)
        self.assertIs(note, _MOCH_GATE_OFF_NOTE)
        self.assertIn("Moch Browser", note)
        self.assertIn("Browser screen", note)
        self.assertIn("curl", note)

    def test_no_note_when_tools_present(self):
        for relay_armed in (True, False):
            for moch_platform in (True, False):
                self.assertIsNone(
                    _moch_prompt_note(relay_armed=relay_armed, moch_platform=moch_platform, tools_ready=True),
                    "a live catalog must never carry a capability note",
                )

    def test_gate_off_is_moch_scoped(self):
        """Desktop hermes with tools absent (no Moch platform, relay off)
        keeps today's behavior — no note."""
        self.assertIsNone(_moch_prompt_note(relay_armed=False, moch_platform=False, tools_ready=False))

    def test_warming_wins_when_both_windows_apply(self):
        """relay_armed+not-ready is warming even on a non-Moch platform (a
        desktop PC driving the relay for tests): the auto-continue promise is
        the honest one."""
        self.assertIs(
            _moch_prompt_note(relay_armed=True, moch_platform=False, tools_ready=False),
            _MOCH_WARMING_NOTE,
        )

    def test_warming_note_keeps_the_auto_continue_promise(self):
        self.assertIn("CONTINUE AUTOMATICALLY", _MOCH_WARMING_NOTE)
        self.assertIn("curl", _MOCH_WARMING_NOTE)


class MochPlatformFlagTests(unittest.TestCase):
    """``_moch_platform`` — the embedded-gateway flags themselves."""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in _PLATFORM_KEYS}
        for k in _PLATFORM_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_unset_is_not_moch(self):
        self.assertFalse(_moch_platform())

    def test_moch_embedded_flag(self):
        os.environ["MOCH_EMBEDDED"] = "1"
        self.assertTrue(_moch_platform())

    def test_moch_fleet_flag(self):
        os.environ["MOCH_FLEET"] = "1"
        self.assertTrue(_moch_platform())

    def test_flag_must_be_exactly_one(self):
        for value in ("", "  ", "0", "false"):
            os.environ["MOCH_EMBEDDED"] = value
            self.assertFalse(_moch_platform(), f"MOCH_EMBEDDED={value!r} must not read as the Moch platform")


if __name__ == "__main__":
    unittest.main(verbosity=2)
