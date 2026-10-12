#!/usr/bin/env python3
"""C-08 / GH #98 — docs/install.sh (the publicly served copy) must be
BYTE-IDENTICAL to the canonical moch-link/install.sh.

PROJECT.md has mandated "always cmp the copies" since the deploy pipeline
existed; this test makes the mandate mechanical. Run directly:

    python3 app/python-runtime/tests/test_docs_sync.py

Local, stdlib-only, no network, no device; expects exit 0 with ``OK``.
"""

from __future__ import annotations

import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
CANONICAL = _REPO_ROOT / "moch-link" / "install.sh"
DOCS_COPY = _REPO_ROOT / "docs" / "install.sh"


class DocsInstallSyncTest(unittest.TestCase):
    def test_docs_copy_is_byte_identical_to_canonical(self) -> None:
        self.assertTrue(CANONICAL.is_file(), f"canonical missing: {CANONICAL}")
        self.assertTrue(DOCS_COPY.is_file(), f"served copy missing: {DOCS_COPY}")
        canonical = CANONICAL.read_bytes()
        served = DOCS_COPY.read_bytes()
        if canonical != served:
            import difflib

            diff = "\n".join(
                difflib.unified_diff(
                    canonical.decode("utf-8", "replace").splitlines(),
                    served.decode("utf-8", "replace").splitlines(),
                    "moch-link/install.sh",
                    "docs/install.sh",
                    lineterm="",
                )
            )
            self.fail(
                "docs/install.sh (publicly served) has diverged from the canonical "
                "moch-link/install.sh. A fresh website install would talk an old "
                "wire protocol. Regenerate with: cp moch-link/install.sh "
                "docs/install.sh\n\n" + diff[:4000]
            )

    def test_both_copies_carry_the_sync_note(self) -> None:
        for path in (CANONICAL, DOCS_COPY):
            head = path.read_text(encoding="utf-8")[:1200]
            self.assertIn("CANONICAL SOURCE", head, f"{path.name} lost the sync note")


if __name__ == "__main__":
    unittest.main(verbosity=2)
