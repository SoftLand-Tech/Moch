"""Moch spawn_bot service (M9.1a, S2 tier): the pure, testable spawn logic.

The toolset/plugin registration wrapper (stage 3) calls into
:class:`SpawnBotService`; this module has NO hermes imports — the profile
creation callable is injected (``profiles_create``), so tests run with fakes.

Committed caps and rules (M9-BOTS.md v1.2.1 §2.4):
  - max live spawned per parent = 3, per fleet = 5;
  - max spawns/day per parent = 10 (counted from spawn records, tombstoned
    and done included);
  - depth cap = 3 levels INCLUSIVE of the parent: parent(0) -> child(1) ->
    grandchild(2); a bot at the cap (a grandchild, depth 2) cannot spawn —
    great-grandchildren are refused;
  - budget slice per spawn = max(parent's remaining per-bot daily share,
    floor 5% of the fleet daily budget), recorded in the spawn record and
    debited from the parent's ledger (kind="spawn");
  - FIRST spawn per parent per day — or any spawn whose slice exceeds 20% of
    the fleet's REMAINING daily budget — returns ``approval-required``; the
    caller (RPC/tool layer) turns that into an approval card and re-issues the
    request with ``approved=True`` (the approved envelope);
  - every refusal is structured: ``{"ok": False, "code": ..., "reason": ...}``
    — never silent;
  - spawn records are one JSON file per spawned bot under
    ``<HERMES_HOME>/fleet/spawns/<name>.json`` (HERMES_HOME read at call
    time); on init the directory is scanned to rebuild live counts (crash
    recovery), and tombstones older than 7 days are garbage-collected.
"""
from __future__ import annotations

import contextlib
import json
import os
import time
import uuid
from pathlib import Path

from moch import fleet
from moch import audit as _default_audit

# committed caps (§2.4 / §8)
MAX_LIVE_PER_PARENT = 3
MAX_LIVE_FLEET = 5
MAX_SPAWNS_PER_DAY = 10
DEPTH_CAP = 3            # levels, inclusive of the parent
SLICE_FLOOR_FRACTION = 0.05   # floor = 5% of fleet daily budget
SLICE_APPROVAL_FRACTION = 0.2  # slice > 20% of fleet REMAINING daily → approval
TOMBSTONE_GC_DAYS = 7
DEFAULT_TTL_S = 24 * 3600

_REFUSAL_REASONS = {
    "fleet-off": "the fleet runtime is not armed (MOCH_FLEET != 1)",
    "parent-frozen": "the parent bot is frozen (fleet kill switch)",
    "budget": "the spawn would exceed the parent or fleet daily budget",
    "depth-cap": "depth cap reached (3 levels inclusive of the parent); "
                 "great-grandchildren are refused",
    "cap-parent": "parent already has the maximum of "
                  f"{MAX_LIVE_PER_PARENT} live spawned bots",
    "cap-fleet": "the fleet already has the maximum of "
                 f"{MAX_LIVE_FLEET} live spawned bots",
    "cap-daily": f"parent already spawned {MAX_SPAWNS_PER_DAY} bots today",
    "approval-required": "this spawn needs user approval (first spawn of the "
                         "day, or slice above 20% of the fleet's remaining "
                         "daily budget)",
    "create-failed": "profile creation failed",
}


def _day_start(now: float) -> float:
    import datetime as _dt
    d = _dt.datetime.fromtimestamp(now)
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _env_int(name: str) -> int:
    try:
        return int(os.environ.get(name, "0") or 0)
    except ValueError:
        return 0


class SpawnBotService:
    """Pure spawn admission + record lifecycle with injectable dependencies.

    ``profiles_create(name=..., soul=..., no_alias=True, mirror_credentials=False)
    -> dict`` is the actual creation callable (production wraps
    hermes_cli.profiles.create_profile via the gateway's profiles.create;
    tests inject a fake). ``audit`` is anything with ``record(event, **fields)``
    (moch.audit module by default); ``budgets`` is a fleet.BUDGETS-like ledger
    with ``record(bot, tokens, kind)`` / ``spend_today(bot)`` / ``check(...)``.
    """

    def __init__(self, profiles_create=None, audit=None, budgets=None,
                 queue=None, now=time.time):
        self._profiles_create = profiles_create
        self._audit = audit if audit is not None else _default_audit
        self._budgets = budgets if budgets is not None else fleet.BUDGETS
        self._queue = queue  # parity slot for the stage-3 toolset wrapper
        self._now = now
        self._lock_time = 0.0
        # crash recovery: scan the spawns dir so live counts are correct after
        # a restart (and stale tombstones are GC'd)
        self._records = self._scan()

    # ------------------------------------------------------------- paths
    def _spawns_dir(self) -> Path:
        root = Path(os.environ.get("HERMES_HOME",
                                   str(Path.home() / ".hermes"))) / "fleet" / "spawns"
        return root

    def _record_path(self, name: str) -> Path:
        return self._spawns_dir() / f"{name}.json"

    # ------------------------------------------------------------- scan/GC
    def _scan(self) -> dict:
        """Load all spawn records from disk; GC tombstones older than 7 days."""
        records: dict[str, dict] = {}
        d = self._spawns_dir()
        try:
            entries = list(d.glob("*.json"))
        except OSError:
            return records
        cutoff = self._now() - TOMBSTONE_GC_DAYS * 86400
        for p in entries:
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(rec, dict) or not rec.get("name"):
                continue
            if rec.get("status") == "tombstoned" and \
                    float(rec.get("tombstoned_ts") or rec.get("created_ts") or 0) < cutoff:
                with contextlib.suppress(OSError):
                    p.unlink()
                continue
            records[str(rec["name"])] = rec
        return records

    def _refresh(self) -> dict:
        if self._now() != self._lock_time:  # clock moved: rescan (cheap)
            self._records = self._scan()
            self._lock_time = self._now()
        return self._records

    def _write_record(self, rec: dict) -> None:
        p = self._record_path(rec["name"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rec), encoding="utf-8")
        self._records[rec["name"]] = rec

    # ------------------------------------------------------------- counts
    def _live_counts(self, records: dict) -> tuple[dict, int]:
        per_parent: dict[str, int] = {}
        fleet_live = 0
        for rec in records.values():
            if rec.get("status") == "live":
                per_parent[rec.get("spawned_by", "?")] = \
                    per_parent.get(rec.get("spawned_by", "?"), 0) + 1
                fleet_live += 1
        return per_parent, fleet_live

    def _spawns_today(self, records: dict, parent: str, now: float) -> int:
        since = _day_start(now)
        return sum(1 for rec in records.values()
                   if rec.get("spawned_by") == parent
                   and float(rec.get("created_ts") or 0) >= since)

    def _budget_slice(self, parent: str, est_tokens: int,
                      per_bot_daily: int, fleet_daily: int) -> int:
        """slice = max(parent's remaining daily share, 5% of fleet daily)."""
        remaining = 0
        if per_bot_daily > 0:
            remaining = max(per_bot_daily - self._budgets.spend_today(bot=parent), 0)
        floor = int(fleet_daily * SLICE_FLOOR_FRACTION) if fleet_daily > 0 else 0
        return max(remaining, floor)

    # ------------------------------------------------------------- request
    def request(self, parent_profile: str, parent_home: str, task_brief: str, *,
                est_tokens: int = 4000, parent_depth: int = 0,
                approved: bool = False) -> dict:
        """Spawn admission flow. Returns ``{"ok": True, ...}`` on success or a
        structured refusal ``{"ok": False, "code": ..., "reason": ...}``."""
        self._audit.record("spawn.request", parent=parent_profile,
                           est_tokens=est_tokens,
                           parent_depth=parent_depth)
        refuse = self._refuse
        # a. fleet armed?
        if not fleet.fleet_enabled():
            return refuse("fleet-off", parent_profile)
        # b. parent frozen?
        if fleet.is_frozen(parent_home):
            return refuse("parent-frozen", parent_profile)
        # c. budget admission
        per_bot_daily = _env_int("MOCH_BOT_DAILY")
        fleet_daily = _env_int("MOCH_FLEET_DAILY")
        ok, why = self._budgets.check(bot=parent_profile, est_tokens=est_tokens,
                                      per_bot_daily=per_bot_daily,
                                      fleet_daily=fleet_daily)
        if not ok:
            return refuse("budget", parent_profile, why)
        # d. depth cap (3 levels inclusive of the parent)
        if parent_depth + 1 >= DEPTH_CAP:
            return refuse("depth-cap", parent_profile)
        # e. live/daily caps from persisted spawn records
        records = self._refresh()
        per_parent, fleet_live = self._live_counts(records)
        now = self._now()
        today = self._spawns_today(records, parent_profile, now)
        if per_parent.get(parent_profile, 0) >= MAX_LIVE_PER_PARENT:
            return refuse("cap-parent", parent_profile,
                          live=per_parent[parent_profile])
        if fleet_live >= MAX_LIVE_FLEET:
            return refuse("cap-fleet", parent_profile, live=fleet_live)
        if today >= MAX_SPAWNS_PER_DAY:
            return refuse("cap-daily", parent_profile, today=today)
        # f. first-spawn-per-day / big-slice approval gate
        slice_tokens = self._budget_slice(parent_profile, est_tokens,
                                          per_bot_daily, fleet_daily)
        fleet_remaining = (fleet_daily - self._budgets.spend_today()) \
            if fleet_daily > 0 else 0
        needs_approval = (today == 0) or (
            fleet_daily > 0 and
            slice_tokens > SLICE_APPROVAL_FRACTION * max(fleet_remaining, 0))
        if needs_approval and not approved:
            return {
                "ok": False, "code": "approval-required",
                "reason": _REFUSAL_REASONS["approval-required"],
                "parent": parent_profile, "task_brief": task_brief,
                "est_tokens": est_tokens, "slice": slice_tokens,
                "slice_fraction_of_fleet_remaining":
                    round(slice_tokens / fleet_remaining, 3) if fleet_remaining > 0
                    else None,
                "first_spawn_today": today == 0,
            }
        # g. create
        name = f"crew-{parent_profile}-{uuid.uuid4().hex[:8]}"
        depth = parent_depth + 1
        soul = (f"You are a spawned crew bot. Task brief:\n{task_brief}\n"
                "You are ephemeral and task-scoped; report results back to "
                f"your parent ({parent_profile}).")
        try:
            if self._profiles_create is not None:
                self._profiles_create(name=name, soul=soul, no_alias=True,
                                      mirror_credentials=False)
        except Exception as exc:  # noqa: BLE001 — structured, never silent
            return refuse("create-failed", parent_profile, str(exc))
        self._budgets.record(bot=parent_profile, tokens=slice_tokens,
                             kind="spawn")
        rec = {
            "name": name,
            "spawned_by": parent_profile,
            "depth": depth,
            "created_ts": now,
            "ttl_ts": now + DEFAULT_TTL_S,
            "budget_slice": slice_tokens,
            "status": "live",
            "task_brief": task_brief,
        }
        self._write_record(rec)
        self._audit.record("spawn.approved", name=name, parent=parent_profile,
                           depth=depth, slice=slice_tokens)
        return {"ok": True, "name": name, "depth": depth,
                "slice": slice_tokens, "record": rec}

    def _refuse(self, code: str, parent: str, detail=None, **extra) -> dict:
        reason = _REFUSAL_REASONS.get(code, code)
        if detail:
            reason = f"{reason} ({detail})"
        self._audit.record("spawn.refused", parent=parent, code=code, **extra)
        out = {"ok": False, "code": code, "reason": reason, "parent": parent}
        out.update(extra)
        return out

    # ------------------------------------------------------------- lifecycle
    def _update_status(self, name: str, status: str, extra: dict) -> bool:
        records = self._refresh()
        rec = records.get(name)
        if rec is None:
            return False
        rec["status"] = status
        rec.update(extra)
        self._write_record(rec)
        return True

    def mark_done(self, name: str) -> bool:
        """Mark a spawned bot's task as done (record status → done)."""
        if not self._update_status(name, "done",
                                   {"done_ts": self._now()}):
            return False
        self._audit.record("spawn.done", name=name)
        return True

    def tombstone(self, name: str, reason: str = "") -> bool:
        """Tombstone a spawned bot (kill switch / melt crew)."""
        if not self._update_status(name, "tombstoned",
                                   {"tombstoned_ts": self._now(),
                                    "tombstone_reason": reason}):
            return False
        self._audit.record("spawn.tombstone", name=name, reason=reason)
        return True

    # ------------------------------------------------------------- view
    def live_counts(self) -> dict:
        per_parent, fleet_live = self._live_counts(self._refresh())
        return {"per_parent": per_parent, "fleet": fleet_live}

    def records(self) -> dict:
        return dict(self._refresh())
