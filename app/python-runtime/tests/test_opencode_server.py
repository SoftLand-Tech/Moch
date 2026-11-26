#!/usr/bin/env python3
"""Unit tests for moch.opencode_server.create_session payload & fallback."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

_TEST_DIR = Path(__file__).resolve().parent
_RUNTIME_DIR = str(_TEST_DIR.parent)
if _RUNTIME_DIR not in sys.path:
    sys.path.insert(0, _RUNTIME_DIR)

from moch import opencode_server  # noqa: E402


class OpencodeCreateSessionTest(unittest.TestCase):
    def test_sends_location_directory_in_json_body(self) -> None:
        calls: list[dict] = []

        def fake_curl(method, path, *, password, body=None, timeout_s=30, headers=None):
            calls.append({
                "method": method,
                "path": path,
                "body": body,
                "headers": headers,
            })
            return {"ok": True, "status": 200, "data": {"id": "ses_1", "location": {"directory": "/workspace/alpha"}}}

        with mock.patch.object(opencode_server, "_curl", side_effect=fake_curl):
            res = opencode_server.create_session("pw", "New chat", "/workspace/alpha")

        self.assertTrue(res["ok"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["method"], "POST")
        self.assertEqual(calls[0]["path"], "/api/session")
        self.assertEqual(calls[0]["body"], {"title": "New chat", "location": {"directory": "/workspace/alpha"}})
        self.assertIsNone(calls[0]["headers"])

    def test_omits_location_when_directory_empty(self) -> None:
        calls: list[dict] = []

        def fake_curl(method, path, *, password, body=None, timeout_s=30, headers=None):
            calls.append({"path": path, "body": body, "headers": headers})
            return {"ok": True, "status": 200, "data": {"id": "ses_2"}}

        with mock.patch.object(opencode_server, "_curl", side_effect=fake_curl):
            res = opencode_server.create_session("pw", "Plain chat", "")

        self.assertTrue(res["ok"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["path"], "/api/session")
        self.assertEqual(calls[0]["body"], {"title": "Plain chat"})

    def test_falls_back_to_legacy_query_and_header_on_400_or_422(self) -> None:
        for status in (400, 422):
            calls: list[dict] = []

            def fake_curl(method, path, *, password, body=None, timeout_s=30, headers=None):
                calls.append({"path": path, "body": body, "headers": headers})
                if len(calls) == 1:
                    return {"ok": False, "status": status, "error": "unrecognized location field"}
                return {"ok": True, "status": 200, "data": {"id": "ses_legacy", "directory": "/workspace/alpha"}}

            with mock.patch.object(opencode_server, "_curl", side_effect=fake_curl):
                res = opencode_server.create_session("pw", "Legacy chat", "/workspace/alpha")

            self.assertTrue(res["ok"])
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0]["body"], {"title": "Legacy chat", "location": {"directory": "/workspace/alpha"}})
            self.assertIn("directory=%2Fworkspace%2Falpha", calls[1]["path"])
            self.assertIn("location%5Bdirectory%5D=%2Fworkspace%2Falpha", calls[1]["path"])
            self.assertEqual(calls[1]["body"], {"title": "Legacy chat"})
            self.assertEqual(calls[1]["headers"], {"X-Opencode-Directory": "%2Fworkspace%2Falpha"})

    def test_does_not_fallback_on_500(self) -> None:
        calls: list[dict] = []

        def fake_curl(method, path, *, password, body=None, timeout_s=30, headers=None):
            calls.append({"path": path, "body": body})
            return {"ok": False, "status": 500, "error": "internal error"}

        with mock.patch.object(opencode_server, "_curl", side_effect=fake_curl):
            res = opencode_server.create_session("pw", "Fail chat", "/workspace/alpha")

        self.assertFalse(res["ok"])
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
