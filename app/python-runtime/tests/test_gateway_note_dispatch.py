#!/usr/bin/env python3
"""BUG-121 (gate-off half) + BUG-132 (warming half) + Bug 5 (model-only
delivery) tests — the capability note must fire exactly when the browser tools
are unusable, never when they are present, and must reach the MODEL ONLY.

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
- Bug 5: notes travel on ``_hud_surface_note`` (model input only) and the
  auto-continue is armed only for plausible browsing requests.
"""

from __future__ import annotations

import os
import sys
import types
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
    _MOCH_MODEL_NOTE_KEY,
    _MOCH_WARMING_NOTE,
    _install_moch_model_note,
    _looks_like_browser_request,
    _moch_platform,
    _moch_prompt_note,
    _stash_moch_model_note,
    _take_moch_model_note,
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


class LooksLikeBrowserRequestTests(unittest.TestCase):
    """Bug 5 — the auto-continue gate must not arm on ordinary chat."""

    def test_urls_are_browser_requests(self):
        for text in (
            "open https://example.com/pricing",
            "check http://10.0.0.2:8080",
            "what is on www.example.org?",
        ):
            self.assertTrue(_looks_like_browser_request(text), text)

    def test_browser_words_are_browser_requests(self):
        for text in (
            "browser",
            "open google.com",
            "search the web for the cheapest flight",
            "what does this webpage say?",
            "that web page is broken",
            "the website is not loading",
        ):
            self.assertTrue(_looks_like_browser_request(text), text)

    def test_open_near_a_page_noun_is_a_browser_request(self):
        for text in (
            "open the site",
            "can you open that link?",
            "open this url please",
            "please open a new tab",
            "open the page for me",
        ):
            self.assertTrue(_looks_like_browser_request(text), text)

    def test_bare_domains_and_browsing_verbs_are_browser_requests(self):
        for text in (
            "open example.com",
            "browse example.com",
            "visit example.com",
            "navigate to example.com",
            "go to example.com",
            "load news.ycombinator.com",
            "browse that page",
        ):
            self.assertTrue(_looks_like_browser_request(text), text)

    def test_open_without_a_page_noun_is_not(self):
        self.assertFalse(_looks_like_browser_request("open the door"))
        self.assertFalse(_looks_like_browser_request("open the settings app"))

    def test_general_chat_is_not_a_browser_request(self):
        for text in (
            "Hi",
            "hello",
            "what's the weather",
            "",
            "   ",
            "tell me a joke",
            "how are you?",
        ):
            self.assertFalse(_looks_like_browser_request(text), text)

    def test_non_string_is_not_a_browser_request(self):
        for value in (None, 7, ["browser"], {"text": "open google"}):
            self.assertFalse(_looks_like_browser_request(value))  # type: ignore[arg-type]


class StashAndTakeMochModelNoteTests(unittest.TestCase):
    """Bug 5 — the note is bound to the submitted text, not the next turn.

    A steered/redirected prompt or a rejected submit never starts a turn with
    its text, so its note must stay parked rather than leak into an unrelated
    later turn (HUD/voice or the synthetic auto-continue).
    """

    def _session(self, user="Hi"):
        return {"inflight_turn": {"user": user}}

    def test_returns_the_note_bound_to_the_turn_text_then_pops_it(self):
        session = self._session()
        _stash_moch_model_note(session, "Hi", "note for the model")
        self.assertEqual(_take_moch_model_note(session), "note for the model")
        self.assertNotIn(_MOCH_MODEL_NOTE_KEY, session)
        self.assertEqual(_take_moch_model_note(session), "")

    def test_note_is_not_delivered_to_a_different_turn(self):
        session = self._session("Hi")
        _stash_moch_model_note(session, "open example.com", "browser note")
        session["inflight_turn"] = {"user": "tell me a joke"}
        self.assertEqual(_take_moch_model_note(session), "")
        self.assertIn(_MOCH_MODEL_NOTE_KEY, session, "a parked note survives a non-matching turn")
        # The queued prompt it belongs to eventually runs with its own text.
        session["inflight_turn"] = {"user": "open example.com"}
        self.assertEqual(_take_moch_model_note(session), "browser note")

    def test_matching_is_whitespace_trimmed(self):
        session = self._session("  Hi  ")
        _stash_moch_model_note(session, "Hi\n", "note")
        self.assertEqual(_take_moch_model_note(session), "note")

    def test_structured_or_empty_prompts_are_not_stashed(self):
        session = self._session()
        _stash_moch_model_note(session, ["part"], "note")
        _stash_moch_model_note(session, "", "note")
        _stash_moch_model_note(session, "Hi", "")
        self.assertNotIn(_MOCH_MODEL_NOTE_KEY, session)

    def test_entries_are_bounded(self):
        session = self._session()
        for i in range(10):
            _stash_moch_model_note(session, f"prompt {i}", f"note {i}")
        self.assertEqual(len(session[_MOCH_MODEL_NOTE_KEY]), 4)
        self.assertEqual(session[_MOCH_MODEL_NOTE_KEY][-1]["text"], "prompt 9")

    def test_corrupt_value_is_ignored_and_popped(self):
        session = self._session()
        session[_MOCH_MODEL_NOTE_KEY] = 7
        self.assertEqual(_take_moch_model_note(session), "")
        self.assertNotIn(_MOCH_MODEL_NOTE_KEY, session)

    def test_missing_key_or_turn_user_is_safe(self):
        self.assertEqual(_take_moch_model_note({}), "")
        session = {_MOCH_MODEL_NOTE_KEY: [{"text": "Hi", "note": "n"}]}
        self.assertEqual(_take_moch_model_note(session), "")
        self.assertEqual(_take_moch_model_note(None), "")  # type: ignore[arg-type]


class InstallMochModelNoteTests(unittest.TestCase):
    """Bug 5 — the wrapper is the model-only channel ``_prepare_turn_input``
    reads (``run_message``); the note must never land anywhere else."""

    def _fake_server(self, hud_note=""):
        return types.SimpleNamespace(_hud_surface_note=lambda session: hud_note)

    def _session(self, user="Hi", note="Moch note"):
        return {
            "inflight_turn": {"user": user},
            _MOCH_MODEL_NOTE_KEY: [{"text": user, "note": note}],
        }

    def test_appends_the_moch_note_after_the_original(self):
        server = self._fake_server("HUD note")
        self.assertTrue(_install_moch_model_note(server))
        session = self._session(note="Moch note")
        self.assertEqual(
            server._hud_surface_note(session),
            "HUD note\n\n<system-reminder>Moch note</system-reminder>",
        )
        self.assertNotIn(_MOCH_MODEL_NOTE_KEY, session, "the note is consumed by the matching turn")

    def test_non_matching_turn_renders_only_the_original(self):
        server = self._fake_server("HUD note")
        _install_moch_model_note(server)
        session = {
            "inflight_turn": {"user": "tell me a joke"},
            _MOCH_MODEL_NOTE_KEY: [{"text": "open example.com", "note": "Moch note"}],
        }
        self.assertEqual(server._hud_surface_note(session), "HUD note")
        self.assertIn(_MOCH_MODEL_NOTE_KEY, session, "the note must stay parked")

    def test_empty_original_returns_just_the_moch_note(self):
        server = self._fake_server("")
        _install_moch_model_note(server)
        self.assertEqual(
            server._hud_surface_note(self._session()),
            "<system-reminder>Moch note</system-reminder>",
        )
        self.assertEqual(server._hud_surface_note({}), "")

    def test_note_is_wrapped_for_title_safety(self):
        """The wrapper matters: hermes' title generator strips
        ``<system-reminder>`` and titles from the user's real text, while a
        bare ``[SYSTEM: …]`` prefix would become the session title."""
        server = self._fake_server("")
        _install_moch_model_note(server)
        rendered = server._hud_surface_note(self._session(note=_MOCH_WARMING_NOTE))
        self.assertTrue(rendered.startswith("<system-reminder>"))
        self.assertTrue(rendered.endswith("</system-reminder>"))
        self.assertIn(_MOCH_WARMING_NOTE, rendered)

    def test_non_str_original_note_is_coerced(self):
        server = self._fake_server()
        server._hud_surface_note = lambda session: None
        _install_moch_model_note(server)
        self.assertEqual(
            server._hud_surface_note(self._session(note="Moch")),
            "<system-reminder>Moch</system-reminder>",
        )

    def test_idempotent(self):
        server = self._fake_server("HUD")
        self.assertTrue(_install_moch_model_note(server))
        wrapped = server._hud_surface_note
        self.assertFalse(_install_moch_model_note(server), "second install must be a no-op")
        self.assertIs(server._hud_surface_note, wrapped)

    def test_missing_hud_hook_is_a_no_op(self):
        server = types.SimpleNamespace()
        self.assertFalse(_install_moch_model_note(server))
        self.assertFalse(hasattr(server, "_moch_model_note_installed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
