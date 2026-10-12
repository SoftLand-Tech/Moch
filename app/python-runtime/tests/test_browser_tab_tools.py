#!/usr/bin/env python3
"""Tab-management tool regression tests (tools/browser_webview + browser_tool).

Covers the pure logic behind browser_tab_list/create/close/switch — argument
validation, tab-id normalization, index coercion, last-tab protection, the
error contract — plus the registry advertisement (schemas + tool table). No
live CDP: every relay/HTTP/supervisor touchpoint is stubbed.

Run:  PYTHONPATH=app/python-runtime:app/hermes-src python3 tests/test_browser_tab_tools.py
"""

from __future__ import annotations

import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

_TESTS_DIR = Path(__file__).resolve().parent
_PY_RUNTIME = _TESTS_DIR.parent
_HERMES_SRC = _PY_RUNTIME.parent / "hermes-src"  # app/hermes-src (sibling of python-runtime)
for _p in (str(_PY_RUNTIME), str(_HERMES_SRC)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# The webview module imports ``requests`` lazily and the registration test pulls
# ``model_tools``' chain (httpx); keep the suite stdlib-only by stubbing absent deps.
try:
    import requests  # noqa: F401
except ImportError:
    sys.modules.setdefault("requests", types.ModuleType("requests"))
try:
    import httpx  # noqa: F401
except ImportError:

    class _AnyModule(types.ModuleType):
        def __getattr__(self, name):  # pragma: no cover — import shim
            if name.startswith("__"):
                raise AttributeError(name)
            return type(name, (), {})

    sys.modules.setdefault("httpx", _AnyModule("httpx"))

from tools import browser_webview as wv  # noqa: E402

_TABS = [
    {"id": "AAA111", "title": "First", "url": "https://first.example.com/"},
    {"id": "BBB222", "title": "Second", "url": "https://second.example.com/"},
    {"id": "CCC333", "title": "Third", "url": "https://third.example.com/"},
]


def _targets(tabs=_TABS, active_id="BBB222", note=None):
    return {"tabs": [dict(t) for t in tabs], "active_id": active_id, "note": note}


class _Recorder:
    """Callable that records (args, kwargs) and returns ``result``."""

    def __init__(self, result=None):
        self.calls = []
        self.result = result

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


class TabIdNormalizationTests(unittest.TestCase):
    def test_none_and_empty_stay_empty(self):
        self.assertEqual(wv._normalize_tab_id(None), "")
        self.assertEqual(wv._normalize_tab_id(""), "")

    def test_whitespace_stripped(self):
        self.assertEqual(wv._normalize_tab_id("  AAA111 \n"), "AAA111")

    def test_surrounding_quotes_stripped(self):
        self.assertEqual(wv._normalize_tab_id('"AAA111"'), "AAA111")
        self.assertEqual(wv._normalize_tab_id("'AAA111'"), "AAA111")

    def test_mismatched_or_inner_quotes_kept(self):
        self.assertEqual(wv._normalize_tab_id('"AAA111'), '"AAA111')
        self.assertEqual(wv._normalize_tab_id('AB"C'), 'AB"C')


class TabIndexCoercionTests(unittest.TestCase):
    def test_int_passthrough(self):
        self.assertEqual(wv._coerce_index(2), 2)
        self.assertEqual(wv._coerce_index(0), 0)

    def test_integer_strings(self):
        self.assertEqual(wv._coerce_index("2"), 2)
        self.assertEqual(wv._coerce_index(" 3 "), 3)
        self.assertEqual(wv._coerce_index("+1"), 1)
        self.assertEqual(wv._coerce_index("-1"), -1)

    def test_non_indices_are_none(self):
        self.assertIsNone(wv._coerce_index(None))
        self.assertIsNone(wv._coerce_index(""))
        self.assertIsNone(wv._coerce_index("abc"))
        self.assertIsNone(wv._coerce_index("1.5"))
        self.assertIsNone(wv._coerce_index("0x10"))
        self.assertIsNone(wv._coerce_index(True), "bools are ints in Python but never a tab index")
        self.assertIsNone(wv._coerce_index(2.5))


class ResolveTabTests(unittest.TestCase):
    def test_by_id(self):
        tab, error = wv._resolve_tab(_TABS, tab_id=" CCC333 ")
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "CCC333")

    def test_quoted_id(self):
        tab, error = wv._resolve_tab(_TABS, tab_id='"AAA111"')
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "AAA111")

    def test_by_index_int_and_string(self):
        for index in (2, "2"):
            tab, error = wv._resolve_tab(_TABS, index=index)
            self.assertIsNone(error)
            self.assertEqual(tab["id"], "CCC333")

    def test_numeric_tab_id_falls_back_to_index(self):
        tab, error = wv._resolve_tab(_TABS, tab_id="0")
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "AAA111")

    def test_unknown_id_lists_known_ids(self):
        tab, error = wv._resolve_tab(_TABS, tab_id="deadbeef")
        self.assertIsNone(tab)
        self.assertIn("unknown tab id 'deadbeef'", error)
        for known in ("AAA111", "BBB222", "CCC333"):
            self.assertIn(known, error)

    def test_index_out_of_range_reports_count(self):
        tab, error = wv._resolve_tab(_TABS, index=99)
        self.assertIsNone(tab)
        self.assertIn("out of range", error)
        self.assertIn("3 open tab(s)", error)

    def test_negative_index_python_style(self):
        tab, error = wv._resolve_tab(_TABS, index=-1)
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "CCC333")

    def test_both_given_rejected(self):
        tab, error = wv._resolve_tab(_TABS, tab_id="AAA111", index=1)
        self.assertIsNone(tab)
        self.assertIn("not both", error)

    def test_default_is_active_tab(self):
        tab, error = wv._resolve_tab(_TABS, active_id="BBB222")
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "BBB222")

    def test_default_falls_back_to_first_without_active(self):
        tab, error = wv._resolve_tab(_TABS, active_id=None)
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "AAA111")

    def test_require_choice_rejects_the_default(self):
        tab, error = wv._resolve_tab(_TABS, active_id="BBB222", require_choice=True)
        self.assertIsNone(tab)
        self.assertIn("tab_id or index is required", error)

    def test_empty_tab_id_behaves_like_omitted(self):
        tab, error = wv._resolve_tab(_TABS, tab_id="   ", active_id="BBB222")
        self.assertIsNone(error)
        self.assertEqual(tab["id"], "BBB222")


class _TabToolTestCase(unittest.TestCase):
    """Common patching: tab enumeration + every relay/supervisor touchpoint."""

    def setUp(self):
        self.targets = _targets()
        patcher = mock.patch.object(wv, "_webview_tab_targets")
        self.targets_mock = patcher.start()
        self.targets_mock.side_effect = lambda task_id=None: self.targets
        self.addCleanup(patcher.stop)

        for name in ("_http_tab_op", "_activate_tab", "_resync_supervisor",
                     "_ensure_or_resync_supervisor", "_poll_tabs_after_close", "_relay_down_error"):
            recorder = _Recorder()
            setattr(self, f"{name}_mock", recorder)
            p = mock.patch.object(wv, name, recorder)
            p.start()
            self.addCleanup(p.stop)
        # Sensible defaults; individual tests override .result / .side_effect.
        self._http_tab_op_mock.result = (True, "")
        self._activate_tab_mock.result = (True, "")
        # The default scenario closes the ACTIVE tab (BBB222): the post-close
        # poll must return the list WITHOUT it.
        self._poll_tabs_after_close_mock.result = [t for t in _TABS if t["id"] != "BBB222"]


class LastTabProtectionTests(_TabToolTestCase):
    def test_close_refused_when_single_tab(self):
        self.targets = _targets(tabs=_TABS[:1], active_id="AAA111")
        result = json.loads(wv.webview_tab_close(task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("last remaining tab", result["error"])
        self.assertFalse(self._http_tab_op_mock.calls, "no close command may be attempted")
        self.assertFalse(self._activate_tab_mock.calls)

    def test_close_refused_when_no_tabs_at_all(self):
        self.targets = _targets(tabs=[], active_id=None)
        result = json.loads(wv.webview_tab_close(task_id="t"))
        self.assertFalse(result["success"])


class TabCloseFlowTests(_TabToolTestCase):
    def test_close_active_activates_survivor_and_resyncs(self):
        result = json.loads(wv.webview_tab_close(task_id="t"))  # no tab_id -> active BBB222
        self.assertTrue(result["success"], result)
        self.assertEqual(result["closed"], "BBB222")
        self.assertEqual(result["tabs_remaining"], 2)
        close_args = [c[0][0] for c in self._http_tab_op_mock.calls]
        self.assertEqual(close_args, ["/json/close/BBB222"])
        self.assertEqual(self._activate_tab_mock.calls[0][0][0], "AAA111",
                         "the first surviving tab must be activated")
        self.assertTrue(self._resync_supervisor_mock.calls)

    def test_close_background_tab_skips_resync(self):
        result = json.loads(wv.webview_tab_close(tab_id="AAA111", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["closed"], "AAA111")
        self.assertFalse(self._activate_tab_mock.calls, "the active tab did not change")
        self.assertFalse(self._resync_supervisor_mock.calls)

    def test_close_http_failure_falls_back_to_cdp(self):
        self._http_tab_op_mock.result = (False, "HTTP 405: tab lifecycle is native-owned in Moch")
        with mock.patch.object(wv, "_supervisor", return_value=object()), \
                mock.patch.object(wv, "_cdp_tab_op", _Recorder((True, ""))) as cdp:
            result = json.loads(wv.webview_tab_close(tab_id="AAA111", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(cdp.calls[0][0][1], "Target.closeTarget")

    def test_close_all_paths_failed_is_an_error(self):
        self._http_tab_op_mock.result = (False, "HTTP 405: tab lifecycle is native-owned in Moch")
        with mock.patch.object(wv, "_supervisor", return_value=None):
            result = json.loads(wv.webview_tab_close(tab_id="AAA111", task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("failed on every available path", result["error"])
        self.assertIn("browser_navigate", result["error"])

    def test_close_unknown_id(self):
        result = json.loads(wv.webview_tab_close(tab_id="deadbeef", task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("unknown tab id 'deadbeef'", result["error"])

    def test_close_poll_timeout_falls_back_to_preclose_list(self):
        self._poll_tabs_after_close_mock.result = None
        result = json.loads(wv.webview_tab_close(task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tabs_remaining"], 2)


class TabSwitchFlowTests(_TabToolTestCase):
    def _patch_snapshot(self, url):
        payload = {"success": True, "snapshot": f"URL: {url}\nTitle: t\n[e1] link"}
        p = mock.patch.object(wv, "webview_snapshot", lambda task_id=None: json.dumps(payload))
        p.start()
        self.addCleanup(p.stop)

    def test_switch_by_id_snapshots_the_tab(self):
        self._patch_snapshot("https://second.example.com/")
        result = json.loads(wv.webview_tab_switch(tab_id="BBB222", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tab"]["id"], "BBB222")
        self.assertTrue(result["snapshot"].startswith("URL: https://second.example.com/"))
        self.assertEqual(self._activate_tab_mock.calls[0][0][0], "BBB222")
        self.assertTrue(self._ensure_or_resync_supervisor_mock.calls)

    def test_switch_by_index(self):
        self._patch_snapshot("https://third.example.com/")
        result = json.loads(wv.webview_tab_switch(index=2, task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tab"]["id"], "CCC333")

    def test_switch_by_numeric_tab_id(self):
        self._patch_snapshot("https://first.example.com/")
        result = json.loads(wv.webview_tab_switch(tab_id="0", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tab"]["id"], "AAA111")

    def test_switch_snapshot_of_a_different_page_gets_a_note(self):
        self._patch_snapshot("https://elsewhere.example.com/")
        result = json.loads(wv.webview_tab_switch(tab_id="BBB222", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertIn("previous tab", result.get("note", ""))

    def test_switch_activation_failure_is_an_error(self):
        self._activate_tab_mock.result = (False, "HTTP 405: tab lifecycle is native-owned in Moch")
        result = json.loads(wv.webview_tab_switch(tab_id="BBB222", task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("activating tab BBB222", result["error"])
        self.assertFalse(self._ensure_or_resync_supervisor_mock.calls)

    def test_switch_neither_arg(self):
        result = json.loads(wv.webview_tab_switch(task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("tab_id or index is required", result["error"])

    def test_switch_both_args(self):
        result = json.loads(wv.webview_tab_switch(tab_id="AAA111", index=1, task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("not both", result["error"])

    def test_switch_index_out_of_range(self):
        result = json.loads(wv.webview_tab_switch(index=42, task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("out of range", result["error"])


class TabCreateTests(_TabToolTestCase):
    def test_empty_url_rejected(self):
        result = json.loads(wv.webview_tab_create("   ", task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("url is required", result["error"])

    def test_create_via_http_new(self):
        new_tab = {"id": "NEW444", "title": "", "url": "https://new.example.com/"}
        self.targets = _targets(tabs=_TABS + [new_tab], active_id="NEW444")

        class _Resp:
            status_code = 200

            def json(self):
                return {"id": "NEW444", "type": "page", "title": "", "url": "https://new.example.com/"}

        with mock.patch.object(wv, "_relay_lifecycle", _Recorder(_Resp())) as lifecycle, \
                mock.patch.object(wv, "_poll_new_tab", _Recorder(new_tab)) as poll:
            result = json.loads(wv.webview_tab_create("https://new.example.com", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tab"]["id"], "NEW444")
        self.assertEqual(result["url"], "https://new.example.com/")
        self.assertIn("/json/new?", lifecycle.calls[0][0][0])
        self.assertIn("https://new.example.com", lifecycle.calls[0][0][0])
        self.assertEqual(self._activate_tab_mock.calls[0][0][0], "NEW444")
        self.assertTrue(self._ensure_or_resync_supervisor_mock.calls)
        self.assertTrue(poll.calls)

    def test_create_all_paths_failed_mentions_the_relay_reason(self):
        class _Resp:
            status_code = 405
            text = "tab lifecycle is native-owned in Moch"

        with mock.patch.object(wv, "_relay_lifecycle", _Recorder(_Resp())), \
                mock.patch.object(wv, "_supervisor", return_value=None):
            result = json.loads(wv.webview_tab_create("https://new.example.com", task_id="t"))
        self.assertFalse(result["success"])
        error = result["error"]
        self.assertIn("/json/new", error)
        self.assertIn("native-owned", error)
        self.assertIn("browser_navigate", error, "the agent must be told the working alternative")

    def test_create_falls_back_to_target_create(self):
        self.targets = _targets()
        with mock.patch.object(wv, "_relay_lifecycle", side_effect=OSError("refused")), \
                mock.patch.object(wv, "_supervisor", return_value=object()) as sup, \
                mock.patch.object(wv, "_call", _Recorder({"targetId": "NEW444"})) as call, \
                mock.patch.object(wv, "_poll_new_tab", _Recorder({"id": "NEW444", "title": "", "url": "https://x.example/"})):
            result = json.loads(wv.webview_tab_create("https://x.example", task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["tab"]["id"], "NEW444")
        self.assertEqual(call.calls[0][0][1], "Target.createTarget")
        self.assertEqual(call.calls[0][0][0], sup.return_value)


class TabListTests(unittest.TestCase):
    """Drives the REAL `_webview_tab_targets` merge with faked HTTP/supervisor."""

    def setUp(self):
        p = mock.patch.object(wv, "_relay_down_error", _Recorder(None))
        p.start()
        self.addCleanup(p.stop)

    def _relay(self, pages, *, browser_level_flag=None):
        """Fake `_relay_http`. ``browser_level_flag=None`` omits the
        Moch-Browser-Level key entirely (plain desktop DevTools); True/False set
        it to that verdict (True = real browser-level endpoint)."""
        class _Resp:
            def __init__(self, payload, status_code=200):
                self._payload, self.status_code = payload, status_code
                self.text = json.dumps(payload)

            def json(self):
                return self._payload

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError(f"HTTP {self.status_code}")

        def fake_http(path, **kwargs):
            if path == "/json/list":
                return _Resp(pages)
            if path == "/json/version":
                version = {"Browser": "Moch"}
                if browser_level_flag is not None:
                    version["Moch-Browser-Level"] = browser_level_flag
                return _Resp(version)
            raise AssertionError(f"unexpected probe: {path}")

        return fake_http

    def test_list_marks_active_and_counts(self):
        pages = [{"id": "AAA111", "type": "page", "title": "First", "url": "https://first.example/"}]
        with mock.patch.object(wv, "_relay_http", self._relay(pages)), \
                mock.patch.object(wv, "_supervisor", return_value=None):
            result = json.loads(wv.webview_tab_list(task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["count"], 1)
        self.assertTrue(result["tabs"][0]["active"])

    def test_relay_without_cdp_widening_gets_the_note(self):
        pages = [{"id": "AAA111", "type": "page", "title": "First", "url": "https://first.example/"}]
        with mock.patch.object(wv, "_relay_http", self._relay(pages, browser_level_flag=False)), \
                mock.patch.object(wv, "_supervisor", return_value=None):
            result = json.loads(wv.webview_tab_list(task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertIn("note", result)
        self.assertIn("ACTIVE tab", result["note"])

    def test_plain_devtools_gets_no_note(self):
        pages = [{"id": "AAA111", "type": "page", "title": "First", "url": "https://first.example/"}]
        with mock.patch.object(wv, "_relay_http", self._relay(pages)), \
                mock.patch.object(wv, "_supervisor", return_value=None):
            result = json.loads(wv.webview_tab_list(task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertNotIn("note", result)

    def test_gettargets_widens_the_relay_list_and_dedupes(self):
        relay_pages = [{"id": "BBB222", "type": "page", "title": "Second", "url": "https://second.example/"}]
        cdp_infos = [
            {"targetId": "BBB222", "type": "page", "title": "Second", "url": "https://second.example/"},
            {"targetId": "CCC333", "type": "page", "title": "Third", "url": "https://third.example/"},
            {"targetId": "SW01", "type": "service_worker", "title": "", "url": ""},
        ]
        fake_sup = object()
        with mock.patch.object(wv, "_relay_http", self._relay(relay_pages, browser_level_flag=False)), \
                mock.patch.object(wv, "_supervisor", return_value=fake_sup), \
                mock.patch.object(wv, "_call", _Recorder({"targetInfos": cdp_infos})):
            result = json.loads(wv.webview_tab_list(task_id="t"))
        self.assertTrue(result["success"], result)
        self.assertEqual([t["id"] for t in result["tabs"]], ["BBB222", "CCC333"],
                         "active tab first, non-page targets dropped, no duplicates")
        self.assertEqual(result["tabs"][0]["active"], True)
        self.assertEqual(result["tabs"][1]["active"], False)

    def test_relay_down_returns_the_bug105_error(self):
        with mock.patch.object(wv, "_relay_http", side_effect=OSError("refused")), \
                mock.patch.object(wv, "_supervisor", return_value=None), \
                mock.patch.object(wv, "_relay_down_error", _Recorder("RELAY-DOWN-MARKER")):
            result = json.loads(wv.webview_tab_list(task_id="t"))
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "RELAY-DOWN-MARKER")


class RegistrationTests(unittest.TestCase):
    """The four tools must be advertised: schema + table row (schema-arg defaults match)."""

    NAMES = ("browser_tab_list", "browser_tab_create", "browser_tab_close", "browser_tab_switch")

    def test_schemas_and_table_rows_present(self):
        from tools import browser_tool

        schemas = {s["name"]: s for s in browser_tool.BROWSER_TOOL_SCHEMAS}
        table = {row[0]: row for row in browser_tool._BROWSER_TOOL_TABLE}
        for name in self.NAMES:
            self.assertIn(name, schemas, f"{name} needs a BROWSER_TOOL_SCHEMAS entry")
            self.assertIn(name, table, f"{name} needs a _BROWSER_TOOL_TABLE row so it is registered")
            defaults = table[name][3]
            self.assertEqual(set(defaults), set(schemas[name]["parameters"]["properties"]),
                             f"{name}: table defaults must mirror the schema parameters")

    def test_tab_tools_route_to_the_webview_backend(self):
        from tools import browser_tool

        for name in self.NAMES:
            self.assertTrue(callable(getattr(browser_tool, name)), f"{name} wrapper missing")
        with mock.patch.object(browser_tool, "_is_webview_mode", return_value=True), \
                mock.patch.object(browser_tool, "_webview") as webview, \
                mock.patch.object(browser_tool, "_is_camofox_mode", return_value=False):
            webview.webview_tab_list.return_value = '{"success": true}'
            self.assertEqual(browser_tool.browser_tab_list(task_id="t"), '{"success": true}')
            self.assertTrue(webview.webview_tab_list.called)

    def test_tab_tools_refuse_non_webview_backends(self):
        from tools import browser_tool

        with mock.patch.object(browser_tool, "_is_webview_mode", return_value=False), \
                mock.patch.object(browser_tool, "_is_camofox_mode", return_value=False):
            result = json.loads(browser_tool.browser_tab_list(task_id="t"))
        self.assertFalse(result["success"])
        self.assertIn("only available in the Moch embedded browser", result["error"])

    def test_tab_create_runs_the_url_safety_checks(self):
        from tools import browser_tool

        with mock.patch.object(browser_tool, "_is_webview_mode", return_value=True), \
                mock.patch.object(browser_tool, "_is_camofox_mode", return_value=False), \
                mock.patch.object(browser_tool, "_secret_url_error_normalized",
                                  return_value=("https://x.example/?token=sk-live-abc123",
                                                {"success": False, "error": "Blocked: secret in URL"})) as secret, \
                mock.patch.object(browser_tool, "_webview") as webview:
            result = json.loads(browser_tool.browser_tab_create("https://x.example/?token=sk-live-abc123", task_id="t"))
        self.assertFalse(result["success"])
        self.assertTrue(secret.called)
        self.assertFalse(webview.webview_tab_create.called, "a flagged URL must never reach the backend")


if __name__ == "__main__":
    unittest.main(verbosity=2)
