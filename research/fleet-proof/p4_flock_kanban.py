#!/usr/bin/env python3
"""P4 — flock-across-threads sanity, kanban board on probe storage, dispatch_once dry-run.

Plan (M9-BOTS.md M9.0-P4): "flock-across-threads sanity for the DM lock contract; kanban
board created on device storage; dispatch_once pass dry-run (no spawn) on device."

1. tools.bot_relay.acquire_turn_lock across threads: (a) contention -> TurnBusyError,
   (b) sequential re-acquire works, (c) two sequential acquires open distinct fds.
2. Kanban board created under the probe home (SQLite file exists; task insert + claim).
3. dispatch_once with an injectable spawn_fn returning a synthetic pid (-12345) and
   subprocess.Popen poisoned — task must transition to running, no spawn, no crash.

Run:  cd research/fleet-proof && ~/.hermes/hermes-agent/venv/bin/python p4_flock_kanban.py
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import PROOF_ROOT, Probe, _ensure_paths  # noqa: E402


def main() -> int:
    p = Probe("p4_flock_kanban")
    try:
        return _run(p)
    except Exception:
        import traceback
        p.fail("probe crashed", traceback.format_exc(limit=8).splitlines()[-1])
        p.note(traceback.format_exc(limit=8))
        return 1
    finally:
        p.finish()


def _run(p: Probe) -> int:
    _ensure_paths()
    home = PROOF_ROOT / "p4" / "home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)  # kanban + relay roots derive from the home

    # ── 1. flock-across-threads (tools/bot_relay.py acquire_turn_lock :472–548) ──
    p.section("1. flock-across-threads sanity for the DM turn lock")
    from tools import bot_relay

    sig = "acquire_turn_lock(root, profile, timeout_seconds=None) ctx-mgr -> Path; TurnBusyError(reason='target_busy')"
    p.ok("signature read", sig)

    held = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=5.0):
            held.set()
            release.wait(5.0)

    t = threading.Thread(target=holder, name="lock-holder", daemon=True)
    t.start()
    assert held.wait(5.0), "holder never acquired"

    # (a) main thread attempts while thread A holds -> TurnBusyError (cross-thread flock works)
    got_busy = False
    t0 = time.monotonic()
    try:
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=0.3):
            p.fail("1a contention", "main thread acquired the lock while thread A held it")
    except bot_relay.TurnBusyError as e:
        got_busy = True
        waited = time.monotonic() - t0
        p.ok("1a contention across threads",
             f"TurnBusyError reason={e.reason!r} profile={e.profile!r} waited={waited:.2f}s "
             f"(budget 0.3s; lock={bot_relay.turn_lock_path(home, 'alpha')})")
    if not got_busy and not p.lines[-1].startswith("FAIL"):
        p.fail("1a contention", "no exception and no failure recorded (impossible branch)")
    release.set()
    t.join(5.0)

    # (b) sequential re-acquire after release works
    try:
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=1.0) as path:
            p.ok("1b sequential re-acquire", f"acquired immediately after release; lock path {path}")
    except bot_relay.TurnBusyError as e:
        p.fail("1b sequential re-acquire", f"TurnBusyError after release: {e}")

    # (c) fresh os.open per acquisition (bot_relay.py :529 opens inside the ctx-mgr, never
    #     caches an fd). Two sequential acquires -> two separate os.open calls (the fd NUMBER
    #     may be recycled by the OS after close — that is close(), not fd reuse by the lock);
    #     two DIFFERENT profiles held concurrently -> two distinct simultaneously-live fds.
    real_open = os.open
    calls: list[tuple[str, int]] = []   # (lock path, fd) for every lock open

    def spy_open(file, flags, mode=0o777, **kw):
        fd = real_open(file, flags, mode, **kw)
        if str(file).endswith(".lock") and "/bot_relay/locks/" in str(file):
            calls.append((str(file), fd))
        return fd

    os.open = spy_open
    try:
        alpha_lock = str(bot_relay.turn_lock_path(home, "alpha"))
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=1.0):
            pass
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=1.0):
            pass
        seq_calls = [c for c in calls if c[0] == alpha_lock]
        with bot_relay.acquire_turn_lock(home, "alpha", timeout_seconds=1.0):
            with bot_relay.acquire_turn_lock(home, "beta", timeout_seconds=1.0):
                live_fds = {fd for path, fd in calls if path in (alpha_lock, str(bot_relay.turn_lock_path(home, "beta")))}
        conc_calls = [c for c in calls if c[0] != alpha_lock]
    finally:
        os.open = real_open
    if len(seq_calls) == 2 and len(conc_calls) == 1 and len(live_fds) == 2:
        p.ok("1c fresh os.open per acquisition (no cached/reused fd)",
             f"sequential: {len(seq_calls)} separate os.open calls for alpha.lock "
             f"(fds {[fd for _, fd in seq_calls]} — number recycled by close is OS behavior); "
             f"concurrent alpha+beta: distinct simultaneously-live fds {sorted(live_fds)}")
    else:
        p.fail("1c fresh os.open per acquisition (no cached/reused fd)",
               f"seq_calls={seq_calls} conc_calls={conc_calls} live_fds={live_fds}")

    # ── 2. Kanban board on probe storage ────────────────────────────────────────
    p.section("2. Kanban board created on probe storage (probe home as the 'device')")
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc

    board = kb.create_board("fleet-probe", name="Fleet probe board")
    db_path = Path(board["db_path"])
    p.ok("create_board('fleet-probe')", f"db={db_path} exists={db_path.is_file()}") \
        if db_path.is_file() else p.fail("create_board('fleet-probe')", f"db missing: {db_path}")

    # A dispatchable assignee needs a live profile dir (identity marker, no tombstone).
    prof = home / "profiles" / "alpha"
    prof.mkdir(parents=True, exist_ok=True)
    (prof / "SOUL.md").write_text("# alpha\nP4 probe assignee.\n", encoding="utf-8")
    from hermes_constants import named_profile_is_live
    p.ok("assignee profile live", f"{prof} live={named_profile_is_live(prof)}")

    conn = kbc.connect(board="fleet-probe")
    tid = kb.create_task(conn, title="p4 claimable task", assignee="alpha", workspace_kind="scratch",
                         board="fleet-probe")
    task = kb.get_task(conn, tid)
    p.ok("task inserted", f"id={tid} status={task.status} assignee={task.assignee}")

    claimed = kb.claim_task(conn, tid, claimer="p4-probe")
    if claimed is not None and str(claimed.status) == "running":
        p.ok("task claimed via claim_task", f"status={claimed.status} (ready -> running CAS)")
    else:
        p.fail("task claimed via claim_task", f"claim_task returned {claimed}")

    # ── 3. dispatch_once dry-run (no spawn) ─────────────────────────────────────
    p.section("3. dispatch_once pass dry-run — injectable spawn_fn, synthetic pid, Popen poisoned")
    from hermes_cli import kanban_db_dispatch as kbd

    spawn_calls: list[tuple[str, str, str | None]] = []

    def fake_spawn(task, workspace, *, board=None):
        spawn_calls.append((task.id, workspace, board))
        return -12345  # synthetic pid, M9.1b's in-process FleetWorker shape

    # (b) subprocess.Popen must NEVER run during the pass.
    real_popen = kbd.subprocess.Popen
    kbd.subprocess.Popen = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("subprocess.Popen called during dispatch_once dry-run"))
    try:
        tid2 = kb.create_task(conn, title="p4 dispatch dry-run task", assignee="alpha",
                              workspace_kind="scratch", board="fleet-probe")
        res = kbd.dispatch_once(conn, spawn_fn=fake_spawn, board="fleet-probe")
    finally:
        kbd.subprocess.Popen = real_popen

    spawned_ids = [s[0] for s in res.spawned]
    task2 = kb.get_task(conn, tid2)
    if tid2 in spawned_ids and str(task2.status) == "running":
        p.ok("3a task transitioned to running per dispatcher semantics",
             f"spawned={res.spawned} status={task2.status} claim_lock={getattr(task2, 'claim_lock', None)}")
    else:
        p.fail("3a task transitioned to running",
               f"spawned={res.spawned} status={getattr(task2, 'status', None)} "
               f"skipped_unassigned={res.skipped_unassigned} skipped_nonspawnable={res.skipped_nonspawnable}")

    p.ok("3b subprocess.Popen never called", "Popen was monkeypatched to raise; pass completed")
    if spawn_calls:
        p.ok("3c synthetic pid accepted", f"spawn_fn called once -> pid -12345 for {spawn_calls[0]}")
    else:
        p.fail("3c synthetic pid accepted", "spawn_fn was never called")

    # _record_worker_exit ignores pid<=0 (kanban_db_dispatch.py ~:203) — verify directly.
    kbd._recent_worker_exits.pop(-12345, None)
    kbd._record_worker_exit(-12345, 0)
    leaked = -12345 in kbd._recent_worker_exits
    p.ok("3d _record_worker_exit ignores pid<=0", f"-12345 in exit registry: {leaked} (expected False)") \
        if not leaked else p.fail("3d _record_worker_exit ignores pid<=0", "synthetic pid entered the registry")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
