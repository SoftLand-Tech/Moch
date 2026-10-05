"""Milestone 2: boot the vendored hermes agent runtime inside the app.

Runs on the HermesRuntime background thread (never UI/JS). Establishes the
app-private hermes home, imports the real agent module tree (``run_agent``),
and reports exactly what loaded and what failed — the report is the
Milestone 2 acceptance evidence in logcat.

The hermes source ships as its own Chaquopy source root (``app/hermes-src``,
flat layout), so its modules sit on ``sys.path`` next to this package with no
sys.path manipulation. Dependencies come from
``requirements-embedded.txt``; jiter is intentionally absent until
Milestone 3 wheels exist, and ``agent.jiter_preload`` degrades cleanly.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

_BOOT_REPORT: dict | None = None


def _vendor_stamp() -> dict:
    """VENDOR.json lives at the root of the vendored hermes tree."""
    for entry in sys.path:
        try:
            stamp = Path(entry) / "VENDOR.json"
            if stamp.is_file():
                return json.loads(stamp.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — stamp is diagnostic only
            continue
    return {}


def _hermes_home() -> Path:
    """App-private hermes home: ``$HERMES_HOME`` or ``<HOME>/Moch``.

    On Android, Chaquopy sets ``HOME`` to the app's internal files dir
    (/data/data/<pkg>/files), so the default keeps everything hermes writes
    inside app-private storage — no scoped-storage permissions needed.
    """
    override = os.environ.get("HERMES_HOME")
    if override:
        return Path(override)
    return Path(os.environ.get("HOME", ".")) / "Moch"


def _prepare_home(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    # Workspace (M5): new sessions' default cwd. Rooting happens app-side —
    # the client passes cwd=<workspace> on session.create (hermes treats an
    # explicit existing dir as a persistent session workspace).
    # NOTE: os.chdir(workspace) and TERMINAL_CWD both deadlocked
    # session.create in the embedded gateway (verified via thread dump);
    # the explicit-cwd path is exercised instead.
    workspace = home / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    os.environ["MOCH_WORKSPACE"] = str(workspace)
    # Android child-VM shim (M5 hotfix): hermes spawns child interpreters
    # (slash worker = automations "Run now", cron jobs, one-shots) via
    # sys.executable, which under Chaquopy is an app_process64 launcher. The
    # child VM needs a writable dalvik-cache; default $ANDROID_DATA (/data)
    # is root-only and the spawn died with "Error changing dalvik-cache
    # ownership: Permission denied". Point ANDROID_DATA at app storage.
    android_data = home / "cache" / "android-data"
    (android_data / "dalvik-cache").mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("ANDROID_DATA", str(android_data))
    # before importing run_agent and reset tempfile's cache so it takes hold.
    scratch = home / "cache" / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(scratch)
    os.environ.setdefault("HERMES_SCRATCH_DIR", str(scratch))
    tempfile.tempdir = None


def boot() -> dict:
    """Import the vendored hermes runtime; idempotent, returns the report."""
    global _BOOT_REPORT
    if _BOOT_REPORT is not None:
        return _BOOT_REPORT

    stamp = _vendor_stamp()
    report: dict = {
        "ok": False,
        "version": stamp.get("version", "unknown"),
        "commit": (stamp.get("commit") or "unknown")[:7],
        "home": None,
        "jiter": False,
        "errors": [],
    }
    try:
        home = _hermes_home()
        _prepare_home(home)
        report["home"] = str(home)

        before = set(sys.modules)
        import run_agent  # noqa: F401 — the real hermes agent module tree

        report["newModules"] = len(set(sys.modules) - before)
        report["ok"] = True
        try:
            from agent import jiter_preload

            report["jiter"] = bool(jiter_preload._JITER_PRELOADED)
        except Exception:  # noqa: BLE001 — diagnostic only
            report["jiter"] = False
    except Exception:  # noqa: BLE001 — the report IS the error surface
        report["errors"].append(traceback.format_exc(limit=12))

    _BOOT_REPORT = report
    return report


def version() -> str:
    """Vendored hermes version string for the Kotlin status probe."""
    return str(_vendor_stamp().get("version") or "unknown")


def status() -> dict:
    """Cheap status for the bridge: no imports, no boot side effects."""
    return {
        "booted": bool(_BOOT_REPORT and _BOOT_REPORT.get("ok")),
        "version": version(),
    }
