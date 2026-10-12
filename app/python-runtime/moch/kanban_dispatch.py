"""Moch kanban dispatch (BUG-138): poke + heal ticker for app-created work.

Why this exists: NOTHING in the embedded process dispatches. Upstream's
dispatcher watcher is a *messaging*-gateway mixin (gateway/run_startup.py)
and the moch app runs web_server.start_server(headless=True), which arms
only the cron ticker. An app-created+assigned task would sit in ``ready``
forever, and stale claims / crashed in-process workers would never reclaim.

Two pieces:
- :func:`poke_dispatch` — one ``dispatch_once`` pass on a daemon thread,
  called after each moch.kanban.* write commits (dashboard-nudge precedent,
  plugins/kanban/dashboard/plugin_api.py /dispatch). The boot-installed
  spawn patch (gateway_server.py → fleet_worker.install_dispatch_spawn_patch)
  injects the in-process FleetWorker when we pass no spawn_fn.
- :func:`start_heal_ticker` — a ~60 s daemon loop running the same pass.
  A full tick runs the reclaim phase FIRST (release_stale_claims, zombie
  reap, max-runtime enforcement) before spawning, so the tick both heals
  the board and starts work.

Env-race serialization: FleetWorker mutates process-global os.environ
(HERMES_KANBAN_DB/BOARD/WORKSPACES_ROOT) for the duration of a worker
turn, serialized only against other workers by fleet_worker._worker_lock.
Every pass here takes that same lock (bounded) so path resolution and
dispatch never interleave with a mutated environment — the wrong-board
write class from the M9 research.
"""
from __future__ import annotations

import contextlib
import os
import threading
import time

_ticker_started = False
_ticker_lock = threading.Lock()

# floor for both poke and tick cadence — tighter than this is a footgun
# (upstream's own sanity floor, kanban_watchers_dispatcher.py).
_MIN_INTERVAL_S = 10.0


def _dispatch_pass(db_path, board=None) -> dict:
    """Synchronous one-pass dispatch (reclaim phase first, then spawn).

    ``db_path`` must be pre-resolved by the RPC ENTRY (before any worker
    could mutate the environment) — this function never resolves from env
    when given a path. Serialized against in-process worker turns via
    fleet_worker._worker_lock (5 s bounded acquire; skip the pass on
    contention — the next tick covers it).
    """
    from hermes_cli import kanban_db_connect as _kbc
    from hermes_cli import kanban_db_dispatch as _kbd
    from moch import fleet_worker as _fw

    if not _fw._worker_lock.acquire(timeout=5.0):
        return {"skipped": "worker-busy"}
    try:
        with _kbc.connect_closing(db_path) as conn:
            return dict(_kbd.dispatch_once(conn, board=board) or {})
    finally:
        _fw._worker_lock.release()


def poke_dispatch(db_path, board=None) -> None:
    """Fire one dispatch pass on a daemon thread. NEVER raises and never
    blocks the RPC: the write already committed; a poke failure means the
    task waits for the heal ticker instead of starting immediately."""
    def _run():
        from moch import audit
        try:
            out = _dispatch_pass(db_path, board=board)
            audit.record("kanban.dispatch.poke", board=board or "default",
                         skipped=bool(out.get("skipped")))
        except Exception as exc:  # noqa: BLE001 — poke failure is non-fatal
            with contextlib.suppress(Exception):
                audit.record("kanban.dispatch.poke.error", error=repr(exc))

    threading.Thread(target=_run, name="moch-kanban-poke", daemon=True).start()


def start_heal_ticker(interval_s: float | None = None) -> bool:
    """Flag-gated (MOCH_FLEET/MOCH_EMBEDDED), idempotent background loop.

    Each tick resolves the DEFAULT board path fresh (ambient env — the env
    race is closed by the _worker_lock serialization inside _dispatch_pass).
    Interval: MOCH_KANBAN_TICK_S env override, default 60 s (upstream's
    dispatcher default), floored at 10 s.
    """
    global _ticker_started
    if os.environ.get("MOCH_FLEET") != "1" and os.environ.get("MOCH_EMBEDDED") != "1":
        return False
    with _ticker_lock:
        if _ticker_started:
            return False
        _ticker_started = True
    try:
        interval = float(interval_s if interval_s is not None
                         else os.environ.get("MOCH_KANBAN_TICK_S", "60") or 60)
    except (TypeError, ValueError):
        interval = 60.0
    interval = max(interval, _MIN_INTERVAL_S)

    def _loop():
        from moch import audit
        while True:
            time.sleep(interval)
            try:
                from hermes_cli import kanban_db as _kb
                _dispatch_pass(_kb.kanban_db_path(board=None))
            except Exception as exc:  # noqa: BLE001 — a broken tick never kills the loop
                with contextlib.suppress(Exception):
                    audit.record("kanban.dispatch.tick.error", error=repr(exc))

    threading.Thread(target=_loop, name="moch-kanban-heal", daemon=True).start()
    return True
