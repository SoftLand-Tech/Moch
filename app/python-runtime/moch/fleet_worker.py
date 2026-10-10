"""M9.1b FleetWorker: in-process kanban worker spawn (moch-side adapter).

Upstream dispatch (kanban_db_dispatch.dispatch_once) starts workers via
``_default_spawn`` — a fire-and-forget ``hermes -p <profile> chat -q`` SUBPROCESS
(dead on Android, B4). ``dispatch_once`` already accepts an injectable
``spawn_fn(task, workspace, board) -> Optional[int]`` (:1911; contract :2287), so
the vendored diff is constructing THIS adapter as the spawn_fn (§6 row 2).

v1 semantics (documented, deliberate):
- fire-and-forget thread per claimed task; returns a synthetic NEGATIVE pid
  (non-OS range; the exit registry ignores pid<=0, kanban_db_dispatch :~204).
- liveness = DB task transitions (claimed→running→complete/block) + the worker's
  heartbeat via its own activity; heartbeats are the liveness signal (v1.2).
- reclaim: with a synthetic pid there is no process to signal. The fleet-aware
  ``_terminate_reclaimed_worker`` wrapper (installed flag-gated from
  gateway_server via :func:`install_reclaim_patch`) reports ``terminated: True``
  for pid<0, so a genuinely stale in-process worker is reclaimed cleanly and a
  live one is never stale (it transitions the DB itself). The worker checks
  claim ownership before completing → exactly-once is preserved across reclaim.
- task execution v1 = ONE in-process chat turn for the assignee with the kanban
  env framed (goal-loop judge parity is deferred; noted in M9.1b notes).
- worker env mutation (os.environ kanban vars) is serialized by a module lock —
  env is process-global; concurrent in-process workers would race (phone reality:
  the FleetTurnQueue bounds concurrency anyway).
"""
from __future__ import annotations

import contextlib
import os
import threading
import time
from pathlib import Path
from typing import Callable, Optional

_next_pid = -1000
_pid_lock = threading.Lock()
_worker_lock = threading.Lock()  # serializes env mutation + worker turns


def _next_synthetic_pid() -> int:
    global _next_pid
    with _pid_lock:
        _next_pid -= 1
        return _next_pid


def _resolve_profile_dir(name: str) -> Path:
    """Indirection so tests can patch profile-dir resolution without hermes imports."""
    from hermes_cli.profiles import get_profile_dir
    return Path(get_profile_dir(name))


def install_dispatch_spawn_patch(kanban_db_dispatch_module, worker: "FleetWorker") -> bool:
    """Flag-gated: wrap ``dispatch_once`` so the DEFAULT spawn (Popen) becomes the
    in-process FleetWorker spawn_fn. Callers that pass their own spawn_fn keep it.
    Idempotent."""
    import os
    if os.environ.get("MOCH_FLEET") != "1" and os.environ.get("MOCH_EMBEDDED") != "1":
        return False
    if getattr(kanban_db_dispatch_module, "_moch_spawn_patch", False):
        return True
    orig = kanban_db_dispatch_module.dispatch_once

    def dispatch_once_fleet(*args, **kwargs):
        if kwargs.get("spawn_fn") is None and len(args) < 2:
            kwargs["spawn_fn"] = worker.spawn_fn
        return orig(*args, **kwargs)

    dispatch_once_fleet.__moch_original__ = orig
    kanban_db_dispatch_module.dispatch_once = dispatch_once_fleet
    kanban_db_dispatch_module._moch_spawn_patch = True
    return True


def _wait_out_live_sessions(profile_home: str, timeout_s: float = 60.0) -> bool:
    """True when no live running chat session remains on this home (P4c)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        from tui_gateway import server as _srv
        sessions = getattr(_srv, "_sessions", {}) or {}
        live = [r for r in sessions.values()
                if isinstance(r, dict)
                and str(r.get("profile_home") or "") == profile_home
                and r.get("running")]
        if not live:
            return True
        time.sleep(0.25)
    return False


def install_reclaim_patch(kanban_db_dispatch_module) -> bool:
    """Flag-gated: make reclaim treat synthetic (negative) worker pids as
    terminated-with-nothing-to-signal. Idempotent."""
    import os
    if os.environ.get("MOCH_FLEET") != "1" and os.environ.get("MOCH_EMBEDDED") != "1":
        return False
    if getattr(kanban_db_dispatch_module, "_moch_reclaim_patch", False):
        return True
    orig = kanban_db_dispatch_module._terminate_reclaimed_worker

    def fleet_aware(pid: Optional[int], claim_lock, **kwargs):
        if pid is not None and int(pid) < 0:
            # synthetic fleet worker: no OS process exists to signal; reclaim may
            # proceed (the worker checks claim ownership before completing).
            return {"prev_pid": int(pid), "host_local": False,
                    "termination_attempted": False, "terminated": True,
                    "sigkill": False, "synthetic": True}
        return orig(pid, claim_lock, **kwargs)

    fleet_aware.__moch_original__ = orig
    kanban_db_dispatch_module._terminate_reclaimed_worker = fleet_aware
    kanban_db_dispatch_module._moch_reclaim_patch = True
    return True


class FleetWorker:
    """spawn_fn factory for dispatch_once (thread-backed, in-process)."""

    def __init__(self,
                 worker_turn_fn: Optional[Callable] = None,
                 complete_fn: Optional[Callable] = None,
                 block_fn: Optional[Callable] = None,
                 owns_claim_fn: Optional[Callable] = None,
                 audit=None):
        """Injectables (tests); production defaults resolve lazily:
        - worker_turn_fn(task, workspace, board) -> str reply: one in-process turn
        - complete_fn(task_id) / block_fn(task_id, reason): kanban DB transitions
        - owns_claim_fn(task) -> bool: claim-ownership check (exactly-once)
        - audit: moch.audit-like module (record(event, **fields)).
        """
        self._worker_turn_fn = worker_turn_fn
        self._complete_fn = complete_fn
        self._block_fn = block_fn
        self._owns_claim_fn = owns_claim_fn
        self._audit = audit
        self.workers: dict[int, dict] = {}  # synthetic pid -> {task, thread, status}
        self._lock = threading.Lock()

    # -- audit helper ---------------------------------------------------------
    def _record(self, event: str, **fields) -> None:
        with contextlib.suppress(Exception):
            if self._audit is not None:
                self._audit.record(event, **fields)

    # -- spawn_fn contract ----------------------------------------------------
    def spawn_fn(self, task, workspace: str, board: Optional[str] = None) -> int:
        from moch import fleet

        pid = _next_synthetic_pid()
        th = threading.Thread(target=self._run_task,
                              args=(task, workspace, board, pid),
                              name=f"fleet-worker-{task.id}-{pid}", daemon=True)
        with self._lock:
            self.workers[pid] = {"task_id": task.id, "assignee": task.assignee,
                                 "thread": th, "status": "spawned", "pid": pid}
        th.start()
        self._record("worker.spawned", task=task.id, assignee=task.assignee, pid=pid)
        return pid

    # -- worker body ----------------------------------------------------------
    def _run_task(self, task, workspace: str, board: Optional[str], pid: int) -> None:
        from moch import fleet

        assignee = task.assignee or "default"
        with self._lock:
            self.workers[pid]["status"] = "running"
        try:
            # freeze: a frozen assignee's task is blocked, never worked
            profile_home = str(_resolve_profile_dir(assignee).resolve())
            if fleet.is_frozen(profile_home):
                self._block(task, "worker frozen (fleet kill switch)", pid)
                return
            with _worker_lock:
                with _kanban_env(task, workspace, board):
                    with fleet.FLEET_QUEUE.turn(profile_home, fleet.PRIORITY_CRON_KANBAN,
                                                timeout=60.0):
                        with fleet.TURN_GATE.hold(profile_home):
                            if fleet.is_frozen(profile_home):
                                self._block(task, "worker frozen mid-run", pid)
                                return
                            self._execute(task, workspace, board, pid, profile_home)
        except Exception as exc:  # noqa: BLE001 — worker must never wedge the dispatcher
            self._record("worker.error", task=task.id, pid=pid, error=repr(exc))
            with contextlib.suppress(Exception):
                self._block(task, f"worker error: {exc}", pid)
            with self._lock:
                self.workers[pid]["status"] = "error"
        finally:
            with self._lock:
                self.workers.setdefault(pid, {})["status"] = \
                    (self.workers.get(pid, {}).get("status") or "finished")

    def _execute(self, task, workspace: str, board: Optional[str], pid: int,
                 profile_home: str) -> None:
        # wait out any live running chat session of the assignee (P4c composition)
        _wait_out_live_sessions(profile_home, 60.0)
        goal_text = "\n\n".join(p for p in (task.title or "", getattr(task, "body", "") or "")
                                ).strip() or f"kanban task {task.id}"
        prompt = (f"[kanban worker] task {task.id} in workspace {workspace}:\n"
                  f"{goal_text}\n\n"
                  "Do the work, then mark the kanban task complete via the kanban tools.")
        reply = (self._worker_turn_fn(task, workspace, board)
                 if self._worker_turn_fn is not None
                 else self._default_turn(assignee=task.assignee or "default",
                                         prompt=prompt))
        # exactly-once: only the current claim owner completes
        if self._owns(task):
            if self._complete_fn is not None:
                self._complete_fn(task.id)
            else:
                self._complete_default(task.id)
            self._record("worker.completed", task=task.id, pid=pid, chars=len(reply))
            with self._lock:
                self.workers[pid]["status"] = "completed"
        else:
            self._record("worker.discarded", task=task.id, pid=pid,
                         why="claim lost (reclaimed mid-run)")

    # -- defaults -------------------------------------------------------------
    def _owns(self, task) -> bool:
        if self._owns_claim_fn is not None:
            return bool(self._owns_claim_fn(task))
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
            with _kbc.connect_closing() as conn:
                fresh = _kb.get_task(conn, task.id)
            return bool(fresh) and getattr(fresh, "status", "") == "running" \
                and getattr(fresh, "claim_lock", None) == getattr(task, "claim_lock", None)
        except Exception:  # noqa: BLE001
            return False

    def _owns_claim(self, task) -> bool:
        return self._owns(task)

    def _complete_default(self, task_id) -> None:
        from hermes_cli import kanban_db as _kb
        from hermes_cli import kanban_db_connect as _kbc
        with _kbc.connect_closing() as conn:
            _kb.complete_task(conn, task_id)

    def _block(self, task, reason: str, pid: int) -> None:
        with contextlib.suppress(Exception):
            if self._block_fn is not None:
                self._block_fn(task.id, reason)
            else:
                from hermes_cli import kanban_db as _kb
                from hermes_cli import kanban_db_connect as _kbc
                with _kbc.connect_closing() as conn:
                    _kb.block_task(conn, task.id, reason=reason)
        self._record("worker.blocked", task=task.id, pid=pid, reason=reason)
        with self._lock:
            self.workers[pid]["status"] = "blocked"

    def _default_turn(self, assignee: str, prompt: str) -> str:
        """One in-process chat turn for the assignee (kanban-tagged session)."""
        from tui_gateway import server as _srv
        methods = getattr(_srv, "_methods", {}) or {}
        opened = methods["session.create"](0, {"profile": assignee,
                                               "title": "kanban"})
        sid = (opened.get("result") or {}).get("session_id")
        if not sid:
            raise RuntimeError(f"cannot open kanban session for @{assignee}")
        submitted = methods["prompt.submit"](0, {"session_id": sid, "text": prompt})
        if "error" in submitted:
            raise RuntimeError(str(submitted["error"].get("message")))
        deadline = time.time() + 180.0
        while time.time() < deadline:
            rec = (getattr(_srv, "_sessions", {}) or {}).get(sid)
            if rec is None or not rec.get("running"):
                break
            time.sleep(0.25)
        after = methods["session.create"](0, {"profile": assignee, "title": "kanban"})
        res = after.get("result") or {}
        for msg in reversed(res.get("messages") or []):
            if isinstance(msg, dict) and str(msg.get("role") or "") == "assistant":
                return str(msg.get("text") or msg.get("content") or "")
        return ""


@contextlib.contextmanager
def _kanban_env(task, workspace: str, board: Optional[str]):
    """Set/restore the worker env contract from _default_spawn (process-global:
    serialized by _worker_lock in the caller). Board pins are best-effort."""
    saved = {k: os.environ.get(k) for k in (
        "HERMES_KANBAN_TASK", "HERMES_KANBAN_WORKSPACE", "HERMES_SESSION_SOURCE",
        "HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_WORKSPACES_ROOT",
        "HERMES_PROFILE", "TERMINAL_CWD")}
    try:
        os.environ["HERMES_KANBAN_TASK"] = str(task.id)
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(workspace or "")
        os.environ["HERMES_SESSION_SOURCE"] = "kanban"
        os.environ["HERMES_PROFILE"] = str(task.assignee or "default")
        with contextlib.suppress(Exception):
            from hermes_cli import kanban_db as _kb
            os.environ["HERMES_KANBAN_DB"] = str(_kb.kanban_db_path(board=board))
            slug = _kb._normalize_board_slug(board) or _kb.get_current_board()
            if slug:
                os.environ["HERMES_KANBAN_BOARD"] = slug
            root = _kb.workspaces_root(board=board)
            os.environ["HERMES_KANBAN_WORKSPACES_ROOT"] = str(root)
        if workspace and os.path.isabs(workspace) and os.path.isdir(workspace):
            os.environ["TERMINAL_CWD"] = workspace
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
