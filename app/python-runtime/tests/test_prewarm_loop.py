#!/usr/bin/env python3
"""BUG-132 residual hardening tests — the browser prewarm loop must never
silently expire, must stay CHEAP per pass, and must fire its readiness action
exactly once.

Local, stdlib-only, self-contained, no network, no device: run with

    python3 app/python-runtime/tests/test_prewarm_loop.py

and expect exit 0. Mirrors test_gateway_note_dispatch.py conventions
(``moch.gateway_server`` is stdlib-only at import time; ``model_tools`` and
``tools.registry`` are faked via ``sys.modules`` so nothing hermes-side is
imported).

What this pins:

- The loop is UNBOUNDED: it survives far past the old ``range(60)`` (~15
  minute) cap — the bug where a slow-maturing registry outgrew the window and
  the cold-kit window never closed.
- A readiness flip runs the ACTION exactly once, then the loop returns.
- Backoff grows after N consecutive not-ready passes and is capped; a fresh
  loop starts at base cadence again (no state carryover).
- Not-ready passes stay CHEAP: with the real per-pass probe wired in
  (``_browser_prewarm_probe``), a counting fake proves the full catalog probe
  (``get_tool_definitions``) is NEVER called per pass — only the toolset-level
  registry lookup is — while the between-pass memo drop still runs once per
  not-ready pass.
- The boot-time warm kit (``_warm_imports_and_catalog``) builds the full
  catalog exactly once, quietly, and swallows a missing hermes side.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

_TEST_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TEST_TESTS_DIR.parent
for _p in (str(_PY_RUNTIME),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# moch.gateway_server is stdlib-only at import time — safe on bare python3.
from moch.gateway_server import (  # noqa: E402
    _PREWARM_MAX_POLL_S,
    _browser_prewarm_probe,
    _browser_tools_registered,
    _prewarm_browser_loop,
    _prewarm_poll_delay,
    _warm_imports_and_catalog,
)


class _FakeHermesTools:
    """A controllable stand-in for hermes' ``model_tools`` + ``tools.registry``.

    ``registered`` models the cold-boot reality that the tool registry fills
    in late; ``check_ok`` models the routed availability gate. Every call is
    counted so tests can prove the expensive probe never runs per pass.
    """

    def __init__(self, *, registered: bool, check_ok: bool = True):
        self.calls = {
            "get_tool_definitions": 0,
            "get_tool_definitions_args": None,
            "get_toolset_for_tool": 0,
            "clear": 0,
        }
        self._registered = registered
        self._check_ok = check_ok
        self._saved: dict[str, object] = {}

        mod = types.ModuleType("model_tools")

        def get_tool_definitions(enabled=None, disabled=None, quiet_mode=False):
            self.calls["get_tool_definitions"] += 1
            self.calls["get_tool_definitions_args"] = (enabled, disabled, quiet_mode)
            return []

        mod.get_tool_definitions = get_tool_definitions  # type: ignore[attr-defined]
        mod.get_toolset_for_tool = lambda name: (  # type: ignore[attr-defined]
            self.calls.__setitem__("get_toolset_for_tool", self.calls["get_toolset_for_tool"] + 1)
            or ("browser" if self._registered else None)
        )
        mod._clear_tool_defs_cache = lambda: self.calls.__setitem__(  # type: ignore[attr-defined]
            "clear", self.calls["clear"] + 1
        )

        tools_pkg = types.ModuleType("tools")
        registry_mod = types.ModuleType("tools.registry")

        def _get_entry(name: str):
            # Lazy: tests flip ``registered`` mid-loop to model the registry
            # maturing, so the entry must be recomputed per lookup.
            if not self._registered:
                return None
            return types.SimpleNamespace(toolset="browser", check_fn=lambda: self._check_ok)

        registry_mod.registry = types.SimpleNamespace(get_entry=_get_entry)  # type: ignore[attr-defined]

        for name, module in (("model_tools", mod), ("tools", tools_pkg), ("tools.registry", registry_mod)):
            self._saved[name] = sys.modules.get(name)
            sys.modules[name] = module

    def restore(self) -> None:
        for name, previous in self._saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous  # type: ignore[assignment]


class PrewarmLoopSurvivalTests(unittest.TestCase):
    """_prewarm_browser_loop — unbounded, single action, growing backoff."""

    def _run(self, probe, *, poll_s=1.0, backoff_after=3, backoff_step_s=10.0, max_poll_s=25.0):
        sleeps: list[float] = []
        actions: list[int] = []
        _prewarm_browser_loop(
            probe,
            lambda: actions.append(1),
            sleep=sleeps.append,
            poll_s=poll_s,
            backoff_after=backoff_after,
            backoff_step_s=backoff_step_s,
            max_poll_s=max_poll_s,
        )
        return sleeps, actions

    def test_survives_far_past_the_old_60_pass_cap(self):
        # The old loop was `for _ in range(60)` — after 60 silent passes the
        # cold-kit window closed forever. 150 not-ready passes then readiness:
        # the new loop must still be there to act.
        flips = {"left": 150}

        def probe() -> bool:
            if flips["left"] == 0:
                return True
            flips["left"] -= 1
            return False

        sleeps, actions = self._run(probe)
        self.assertEqual(len(sleeps), 150, "loop must poll every not-ready pass, unbounded")
        self.assertEqual(actions, [1], "readiness flip runs the action exactly once")

    def test_ready_immediately_acts_once_and_sleeps_never(self):
        sleeps, actions = self._run(lambda: True)
        self.assertEqual(actions, [1])
        self.assertEqual(sleeps, [])

    def test_backoff_grows_then_caps(self):
        flips = {"left": 20}

        def probe() -> bool:
            if flips["left"] == 0:
                return True
            flips["left"] -= 1
            return False

        sleeps, _ = self._run(probe)
        # poll_s=1 for the first 3 passes, then +10 per pass, capped at 25:
        # passes 1..3 → 1, pass 4 → 11, pass 5 → 21, passes 6+ → 25.
        self.assertEqual(sleeps[:6], [1.0, 1.0, 1.0, 11.0, 21.0, 25.0])
        self.assertTrue(all(s == 25.0 for s in sleeps[5:]), f"cap must hold: {sleeps}")

    def test_fresh_loop_resets_backoff_to_base_cadence(self):
        # No state carryover: two cold runs both begin at poll_s, even though
        # the previous run backed off all the way to the cap first.
        for _ in range(2):
            flips = {"left": 6}

            def probe() -> bool:
                if flips["left"] == 0:
                    return True
                flips["left"] -= 1
                return False

            sleeps, actions = self._run(probe, poll_s=2.0)
            self.assertEqual(sleeps[0], 2.0, "a new warm-up starts at base cadence")
            self.assertEqual(sleeps[-1], 25.0, "the previous run reached the cap (so the reset is meaningful)")
            self.assertEqual(actions, [1])

    def test_delay_is_a_pure_ladder(self):
        kw = dict(poll_s=15.0, backoff_after=8, backoff_step_s=15.0, max_poll_s=60.0)
        self.assertEqual(_prewarm_poll_delay(1, **kw), 15.0)
        self.assertEqual(_prewarm_poll_delay(8, **kw), 15.0)
        self.assertEqual(_prewarm_poll_delay(9, **kw), 30.0)
        self.assertEqual(_prewarm_poll_delay(10, **kw), 45.0)
        self.assertEqual(_prewarm_poll_delay(11, **kw), 60.0)
        self.assertEqual(_prewarm_poll_delay(5000, **kw), _PREWARM_MAX_POLL_S)


class CheapProbeWiringTests(unittest.TestCase):
    """The real per-pass probe: cheap registry lookup, memo drop, no catalog."""

    def setUp(self):
        self._fake = None

    def tearDown(self):
        if self._fake is not None:
            self._fake.restore()

    def _wire(self, *, registered: bool, check_ok: bool = True):
        self._fake = _FakeHermesTools(registered=registered, check_ok=check_ok)
        return self._fake.calls

    def test_real_probe_loop_is_cheap_and_acts_once_on_flip(self):
        calls = self._wire(registered=False)
        state = {"pass_no": 0}

        def probe() -> bool:
            state["pass_no"] += 1
            # The registry matures at pass 6.
            self._fake._registered = state["pass_no"] >= 6  # noqa: SLF001 — the fake is the fixture
            return _browser_prewarm_probe()

        actions: list[int] = []
        sleeps: list[float] = []
        _prewarm_browser_loop(
            probe,
            lambda: actions.append(1),
            sleep=sleeps.append,
            poll_s=0.25,
            backoff_after=100,  # keep the ladder flat; growth is covered above
            backoff_step_s=0.0,
            max_poll_s=0.25,
        )
        self.assertEqual(actions, [1], "flip triggers the action exactly once")
        self.assertEqual(state["pass_no"], 6)
        self.assertEqual(calls["get_toolset_for_tool"], 6, "one cheap registry lookup per pass")
        self.assertEqual(
            calls["get_tool_definitions"],
            0,
            "the full-catalog probe must NEVER run per pass — that is the BUG-132 residual",
        )
        self.assertEqual(calls["clear"], 5, "memo drop once per NOT-READY pass, skipped on the ready pass")
        self.assertEqual(len(sleeps), 5)

    def test_registered_but_gate_closed_stays_not_ready(self):
        calls = self._wire(registered=True, check_ok=False)
        self.assertFalse(_browser_tools_registered())
        self.assertEqual(calls["get_tool_definitions"], 0)

    def test_registered_and_gate_open_is_ready(self):
        self._wire(registered=True, check_ok=True)
        self.assertTrue(_browser_prewarm_probe())
        calls = self._fake.calls
        self.assertEqual(calls["clear"], 0, "ready pass skips the memo drop")

    def test_unregistered_is_not_ready(self):
        self._wire(registered=False)
        self.assertFalse(_browser_tools_registered())

    def test_hermes_side_missing_is_not_ready_and_never_raises(self):
        # No fakes at all: bare python3 cannot import model_tools/tools.
        self.assertFalse(_browser_tools_registered())
        self.assertFalse(_browser_prewarm_probe())


class WarmKitTests(unittest.TestCase):
    """_warm_imports_and_catalog — ONE quiet full build at boot."""

    def setUp(self):
        self._fake = None

    def tearDown(self):
        if self._fake is not None:
            self._fake.restore()

    def test_builds_full_catalog_exactly_once_quietly(self):
        self._fake = _FakeHermesTools(registered=True)
        _warm_imports_and_catalog()
        calls = self._fake.calls
        self.assertEqual(calls["get_tool_definitions"], 1)
        self.assertEqual(calls["get_tool_definitions_args"], (None, None, True), "full catalog, quiet (memoized)")

    def test_missing_hermes_side_is_swallowed(self):
        # No fakes: model_tools is not importable on bare python3 — the warm
        # kit must stay best-effort, exactly like the Tier A module imports.
        _warm_imports_and_catalog()  # must not raise


if __name__ == "__main__":
    unittest.main(verbosity=2)
