"""Moch fleet core (M9.1a): per-profile turn gate, FleetTurnQueue, freeze, budget ledger.

Everything here is additive and inert unless armed:
  - the turn gate/queue/freeze only engage when ``moch.fleet.fleet_enabled()`` is true
    (``MOCH_FLEET=1``, set by the embedded gateway boot on fleet-capable installs);
  - with the flag off, ``maybe_acquire_dispatch()`` is a passthrough and every other
    entry point short-circuits — upstream behavior is byte-for-byte unchanged.

Design per M9-BOTS.md v1.2.1 §2.2/§2.4:
  - Lock order is ALWAYS FleetTurnQueue slot first, then the per-profile turn gate;
    never hold a gate while waiting for a slot (deadlock rule).
  - The turn gate is a process-global registry ``dict[home_key → threading.RLock]``
    acquired by ALL six turn entry points (chat RPC, DM delivery, cron occurrence,
    kanban worker turn, delegate child targeting another profile, A2A inbound).
    The upstream bot_relay flock stays cross-process only.
  - Priority classes (lowest number = admitted first): user interactive >
    approval-unblocking > cron/kanban > DM delivery > spawned-bot; FIFO within class.
  - Budgets: fleet-level SQLite ledger, per-bot + fleet daily, checked at turn
    admission / before each in-turn model call / spawn admission.
"""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

_FLEET_FLAG = "MOCH_FLEET"

# ---------------------------------------------------------------------------- flag


def fleet_enabled() -> bool:
    """True when the fleet runtime is armed (MOCH_FLEET=1)."""
    return os.environ.get(_FLEET_FLAG, "") == "1"


# ------------------------------------------------------------------- turn gate


def home_key(home) -> str:
    """Canonical key for a profile home (stable across Path/str)."""
    try:
        return str(Path(home).resolve())
    except OSError:
        return str(home)


class TurnGate:
    """Process-global per-profile mutual exclusion for turns.

    RLock (not Lock): a path that legitimately re-enters for the SAME home on the
    same thread (e.g. a delegate child resolved back to its parent's profile) must
    not self-deadlock; cross-thread exclusion is the point and holds.
    """

    def __init__(self) -> None:
        self._locks: dict[str, threading.RLock] = {}
        self._meta: dict[str, dict] = {}
        self._super = threading.RLock()

    def _lock_for(self, key: str) -> threading.RLock:
        with self._super:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    @contextlib.contextmanager
    def hold(self, home) -> Iterator[dict]:
        """Exclusive per-profile turn window. Yields an info dict (holder state,
        mainly for tests and the Fleet screen)."""
        key = home_key(home)
        lock = self._lock_for(key)
        with self._super:
            meta = self._meta.setdefault(key, {"held": False, "holder": None,
                                               "acquires": 0})
        acquired = lock.acquire(timeout=30.0)
        if not acquired:  # bounded: never wedge the gateway on a stuck holder
            raise TimeoutError(f"fleet turn gate: home {key} held >30s")
        try:
            with self._super:
                meta["held"] = True
                meta["holder"] = threading.current_thread().name
                meta["acquires"] += 1
            yield meta
        finally:
            with self._super:
                meta["held"] = False
                meta["holder"] = None
            lock.release()

    def held(self, home) -> bool:
        return self._meta.get(home_key(home), {}).get("held", False)

    def stats(self) -> dict:
        with self._super:
            return {k: dict(v) for k, v in self._meta.items()}


TURN_GATE = TurnGate()


# ------------------------------------------------------------- FleetTurnQueue


class FleetBusy(Exception):
    """Structured overflow/admission refusal (mirrors upstream target_busy)."""

    def __init__(self, reason: str, detail: dict | None = None):
        self.reason = reason
        self.detail = detail or {}
        super().__init__(reason)


# priority classes — lowest value admitted first
PRIORITY_USER = 0
PRIORITY_APPROVAL_UNBLOCK = 1
PRIORITY_CRON_KANBAN = 2
PRIORITY_DM = 3
PRIORITY_SPAWNED = 4
PRIORITY_NAMES = {
    PRIORITY_USER: "user-interactive",
    PRIORITY_APPROVAL_UNBLOCK: "approval-unblocking",
    PRIORITY_CRON_KANBAN: "cron-kanban",
    PRIORITY_DM: "dm-delivery",
    PRIORITY_SPAWNED: "spawned-bot",
}

DEFAULT_SLOTS = 2
MAX_WAIT_S = 30.0            # bounded wait; beyond → FleetBusy (delegate rule)
MAX_QUEUED_PER_HOME = 8      # overflow → fleet_busy instead of unbounded queue


@dataclass
class Ticket:
    home: str
    priority: int
    seq: int
    enqueued_at: float = field(default_factory=time.monotonic)


class FleetTurnQueue:
    """Priority turn admission with a bounded slot count (default 2).

    Slot FIRST, then the turn gate (never reverse — deadlock rule, §2.2).
    FIFO within a priority class; per-home queue depth cap → FleetBusy.
    """

    def __init__(self, slots: int = DEFAULT_SLOTS):
        self._slots = max(1, int(slots))
        self._cond = threading.Condition()
        self._active = 0
        self._seq = 0
        self._waiting: deque[Ticket] = deque()
        self._per_home_waiting: dict[str, int] = {}

    # -- admission -----------------------------------------------------------
    def acquire(self, home, priority: int = PRIORITY_USER,
                timeout: float = MAX_WAIT_S) -> Ticket:
        key = home_key(home)
        with self._cond:
            if self._active < self._slots and not self._waiting:
                self._active += 1
                return Ticket(key, priority, self._next_seq())
            if self._per_home_waiting.get(key, 0) >= MAX_QUEUED_PER_HOME:
                raise FleetBusy("fleet_busy", {
                    "why": "queue-depth-cap", "home": key,
                    "queued": self._per_home_waiting[key]})
            ticket = Ticket(key, priority, self._next_seq())
            self._waiting.append(ticket)
            self._per_home_waiting[key] = self._per_home_waiting.get(key, 0) + 1
            deadline = time.monotonic() + max(0.0, timeout)
            while True:
                if self._admit_locked(ticket):
                    return ticket
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._drop_locked(ticket)
                    raise FleetBusy("fleet_busy", {
                        "why": "wait-timeout", "home": key,
                        "waited_s": round(timeout, 2)})
                self._cond.wait(remaining)

    def release(self, ticket: Ticket) -> None:
        with self._cond:
            self._active = max(0, self._active - 1)
            self._cond.notify_all()

    @contextlib.contextmanager
    def turn(self, home, priority: int = PRIORITY_USER,
             timeout: float = MAX_WAIT_S) -> Iterator[Ticket]:
        ticket = self.acquire(home, priority, timeout)
        try:
            yield ticket
        finally:
            self.release(ticket)

    # -- internals -----------------------------------------------------------
    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def _admit_locked(self, ticket: Ticket) -> bool:
        if self._active >= self._slots:
            return False
        best = min(self._waiting, key=lambda t: (t.priority, t.seq))
        if best is not ticket:
            return False
        self._waiting.remove(ticket)
        n = self._per_home_waiting.get(ticket.home, 0) - 1
        if n <= 0:
            self._per_home_waiting.pop(ticket.home, None)
        else:
            self._per_home_waiting[ticket.home] = n
        self._active += 1
        return True

    def _drop_locked(self, ticket: Ticket) -> None:
        with contextlib.suppress(ValueError):
            self._waiting.remove(ticket)
        n = self._per_home_waiting.get(ticket.home, 0) - 1
        if n <= 0:
            self._per_home_waiting.pop(ticket.home, None)
        else:
            self._per_home_waiting[ticket.home] = n

    # -- introspection (Fleet screen "waiting" list) --------------------------
    def snapshot(self) -> dict:
        with self._cond:
            return {
                "slots": self._slots,
                "active": self._active,
                "waiting": [
                    {"home": t.home, "priority": PRIORITY_NAMES.get(t.priority, t.priority),
                     "seq": t.seq, "queued_s": round(time.monotonic() - t.enqueued_at, 2)}
                    for t in sorted(self._waiting, key=lambda t: (t.priority, t.seq))],
            }


FLEET_QUEUE = FleetTurnQueue()


# ------------------------------------------------------------------- freeze

_FREEZE_FILE = "fleet/freeze.json"


def _freeze_path(home) -> Path:
    return Path(home) / _FREEZE_FILE


def freeze_bot(home, frozen: bool) -> None:
    """Persist freeze state for a profile home (survives restarts)."""
    path = _freeze_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    state: dict = {}
    if path.is_file():
        with contextlib.suppress(OSError, json.JSONDecodeError):
            state = json.loads(path.read_text(encoding="utf-8"))
    state["frozen"] = bool(frozen)
    state["ts"] = time.time()
    path.write_text(json.dumps(state), encoding="utf-8")


def is_frozen(home) -> bool:
    try:
        return bool(json.loads(_freeze_path(home).read_text(encoding="utf-8")).get("frozen"))
    except (OSError, json.JSONDecodeError):
        return False


# ------------------------------------------------------------ budget ledger

_SCHEMA = """
CREATE TABLE IF NOT EXISTS fleet_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    bot TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'turn'   -- turn|spawn|other
);
CREATE INDEX IF NOT EXISTS idx_fleet_spend_ts ON fleet_spend(ts);
"""


class BudgetLedger:
    """Fleet-level SQLite spend ledger (one DB for the whole install, not per-profile).

    Incremented at model-call completion; checked at turn admission, before each
    in-turn model call, and at spawn admission (§2.4 enforcement points).
    """

    def __init__(self, root: Path):
        self._root = Path(root)
        self._lock = threading.RLock()  # reentrant: record() holds it across _conn()
        self._db: Optional[sqlite3.Connection] = None

    def _conn(self) -> sqlite3.Connection:
        with self._lock:
            if self._db is None:
                self._root.mkdir(parents=True, exist_ok=True)
                self._db = sqlite3.connect(str(self._root / "fleet.db"),
                                           check_same_thread=False)
                self._db.executescript(_SCHEMA)
                self._db.commit()
            return self._db

    @staticmethod
    def _day_start() -> float:
        import datetime as _dt
        now = _dt.datetime.now()
        d = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return d.timestamp()

    def record(self, bot: str, tokens: int, model: str = "", provider: str = "",
               kind: str = "turn", ts: float | None = None) -> None:
        with self._lock:
            c = self._conn()
            c.execute("INSERT INTO fleet_spend (ts, bot, model, provider, tokens, kind) "
                      "VALUES (?,?,?,?,?,?)",
                      (ts if ts is not None else time.time(), bot, model, provider,
                       int(tokens), kind))
            c.commit()

    def spend_today(self, bot: str | None = None) -> int:
        with self._lock:
            c = self._conn()
            since = self._day_start()
            if bot is None:
                row = c.execute("SELECT COALESCE(SUM(tokens),0) FROM fleet_spend "
                                "WHERE ts >= ?", (since,)).fetchone()
            else:
                row = c.execute("SELECT COALESCE(SUM(tokens),0) FROM fleet_spend "
                                "WHERE ts >= ? AND bot = ?", (since, bot)).fetchone()
            return int(row[0] or 0)

    def check(self, bot: str, est_tokens: int, per_bot_daily: int,
              fleet_daily: int) -> tuple[bool, str]:
        """Admission check → (ok, reason)."""
        if fleet_daily > 0 and self.spend_today() + est_tokens > fleet_daily:
            return False, "fleet-budget-exhausted"
        if per_bot_daily > 0 and self.spend_today(bot) + est_tokens > per_bot_daily:
            return False, "bot-budget-exhausted"
        return True, ""


# ------------------------------------------------------- dispatch integration

_TURN_PATH_METHODS = {
    # entry point 1: interactive chat RPC (session.create carries params['profile'];
    # prompt.submit re-binds from the session's stored profile_home)
    "session.create", "prompt.submit",
    # entry point 6: A2A inbound (handled via its own RPC surface when enabled)
    "a2a.message", "a2a.task.submit",
}


def resolve_home_for_request(req: dict) -> Optional[str]:
    """Best-effort profile-home resolution for a dispatch request.

    session.create → params['profile']; prompt.submit → the session's stored
    profile_home from server._sessions; anything else → None (launch profile).
    """
    params = req.get("params") if isinstance(req.get("params"), dict) else {}
    method = req.get("method") or ""
    try:
        from hermes_cli.profiles import get_profile_dir
        if method == "session.create":
            name = str(params.get("profile") or "").strip()
            if name:
                return str(get_profile_dir(name))
            return None
        if method in ("prompt.submit", "session.interrupt", "session.steer"):
            sid = str(params.get("session_id") or "")
            if sid:
                from tui_gateway import server as _srv
                rec = getattr(_srv, "_sessions", {}).get(sid)
                if isinstance(rec, dict) and rec.get("profile_home"):
                    return str(rec["profile_home"])
    except Exception:  # noqa: BLE001 — resolution is best-effort; never break dispatch
        return None
    return None


def admission_check(req: dict) -> Optional[dict]:
    """Pure refusal checks for a turn-path request (freeze + budget). Returns an
    error-response dict to refuse, or None to proceed. Flag-gated: None when the
    fleet runtime is off."""
    if not fleet_enabled():
        return None
    method = req.get("method") or ""
    if method not in _TURN_PATH_METHODS:
        return None
    home = resolve_home_for_request(req)
    if not home:
        return None  # launch profile / unresolvable: upstream behavior
    if is_frozen(home):
        return {"jsonrpc": "2.0", "id": req.get("id"),
                "error": {"code": 4091, "message": "bot is frozen (fleet kill switch)"}}
    # budget admission (est: cheap until real usage lands at model-call completion)
    est = 2000
    ok, reason = BUDGETS.check(bot=Path(home).name, est_tokens=est,
                              per_bot_daily=int(os.environ.get("MOCH_BOT_DAILY", "0") or 0),
                              fleet_daily=int(os.environ.get("MOCH_FLEET_DAILY", "0") or 0))
    if not ok:
        return {"jsonrpc": "2.0", "id": req.get("id"),
                "error": {"code": 4092, "message": reason}}
    return None


def install_dispatch_gate(tg_server) -> None:
    """Flag-gated (MOCH_FLEET=1): wrap ``tg_server.dispatch`` so chat-path requests
    pass fleet admission (freeze, budget, FleetTurnQueue slot) before upstream
    handling; the queue+gate window is held across the inline upstream call.

    Stage-1 composition contract (recorded in M9.1a notes): this window covers
    ADMISSION for chat paths. Cross-path serialization vs chat TURNS is provided
    by the moch-side turn paths themselves — dm_bridge/cron/kanban hold the same
    gate across their whole turn AND wait out any live running chat session of
    the target home (P4c: upstream queues DMs behind a running session via
    prompt.submit(queued=True); dm_bridge adds the explicit wait + busy check).
    With MOCH_FLEET unset, dispatch is untouched.
    """
    if not fleet_enabled() or getattr(tg_server, "_moch_gate_installed", False):
        return
    upstream = tg_server.dispatch

    def gated_dispatch(req: dict, transport=None):
        refusal = admission_check(req)
        if refusal is not None:
            return refusal
        method = req.get("method") or ""
        if method not in _TURN_PATH_METHODS or not fleet_enabled():
            return upstream(req, transport)
        home = resolve_home_for_request(req)
        if not home:
            return upstream(req, transport)
        with FLEET_QUEUE.turn(home, PRIORITY_USER), TURN_GATE.hold(home):
            return upstream(req, transport)

    tg_server._moch_upstream_dispatch = upstream
    tg_server.dispatch = gated_dispatch
    tg_server._moch_gate_installed = True


BUDGETS = BudgetLedger(Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "fleet")
