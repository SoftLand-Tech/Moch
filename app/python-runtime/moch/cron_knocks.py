"""Post local notifications for finished cron executions (embedded mode).

hermes' ``deliver: local`` path has no live adapter under embedded serve, so
background jobs complete silently (execution recorded, output saved, no
knock). This bridge watches ``cron/executions.db`` in-process and calls an
injected Java notifier (Chaquopy interop) for each newly finished run — it
keeps working while the app is backgrounded because the foreground service
holds the process alive.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

POLL_S = 15.0

_state = {"started": False}
_lock = threading.Lock()
_notifiers: list = []
_seen: set[str] = set()


def start(notifier) -> None:
    """Register the Java notifier (idempotent) and arm the poll thread."""
    with _lock:
        if notifier is not None:
            _notifiers.append(notifier)
        if _state["started"]:
            return
        _state["started"] = True
    threading.Thread(target=_loop, name="moch-cron-knocks", daemon=True).start()


def _jobs_by_id(home: Path) -> dict[str, str]:
    try:
        data = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
        return {
            str(j.get("job_id")): str(j.get("name") or j.get("job_id") or "automation")
            for j in data.get("jobs", [])
        }
    except Exception:  # noqa: BLE001 — best effort naming
        return {}


def _loop() -> None:
    from moch import hermes_boot

    home = hermes_boot._hermes_home()
    db = home / "cron" / "executions.db"
    primed = False
    while True:
        try:
            if db.exists():
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
                try:
                    rows = con.execute(
                        "SELECT id, job_id, status, error, finished_at FROM executions"
                        " WHERE status IN ('completed','failed')"
                        " ORDER BY claimed_at DESC LIMIT 20"
                    ).fetchall()
                finally:
                    con.close()
                if not primed:
                    # Never knock for history that predates this boot.
                    _seen.update(str(r[0]) for r in rows)
                    primed = True
                else:
                    names = _jobs_by_id(home)
                    for rid, job_id, status, error, _finished in reversed(rows):
                        rid = str(rid)
                        if rid in _seen:
                            continue
                        _seen.add(rid)
                        _notify(names.get(str(job_id), str(job_id or "automation")), str(status), error)
        except Exception:  # noqa: BLE001 — polling must never die
            pass
        time.sleep(POLL_S)


def _notify(name: str, status: str, error) -> None:
    failed = status != "completed"
    title = f"{name} {'failed' if failed else 'finished'}"
    text = (str(error)[:180] if error else "Automation ran on this phone.") + (
        " (on this phone)" if not error else ""
    )
    for n in list(_notifiers):
        try:
            n.notify(title, text)
        except Exception:  # noqa: BLE001 — one bad sink must not kill the rest
            pass
