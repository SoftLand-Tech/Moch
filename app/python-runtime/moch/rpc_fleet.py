"""M9.1a stage 2: `moch.*` JSON-RPC layer (Appendix A), registered onto the
embedded gateway's method table — zero vendored diff (flag-gated install from
``gateway_server``; with the flag off nothing registers).

Stage-2 methods:
  moch.fleet.status   — fleetEnabled, queue snapshot, per-profile freeze state
  moch.fleet.freeze   — {profile, frozen: bool} → freeze/unfreeze + audit
  moch.fleet.budgets  — per-bot + fleet spend today (+ limits from env)
Later milestones add moch.runs.timeline (M9.4) / moch.skills.teach_draft (M9.5).
"""
from __future__ import annotations

import os
from pathlib import Path

_REGISTERED = False


def _err(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _ok(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _install(tg_server) -> bool:
    methods = getattr(tg_server, "_methods", None)
    if methods is None:
        return False

    from moch import audit, fleet

    def moch_fleet_status(rid, params):
        profiles_dir = Path(os.environ.get("HERMES_HOME",
                                           str(Path.home() / ".hermes"))) / "profiles"
        profiles = []
        if profiles_dir.is_dir():
            for d in sorted(profiles_dir.iterdir()):
                if d.is_dir() and not d.name.startswith("."):
                    profiles.append({
                        "name": d.name,
                        "frozen": fleet.is_frozen(d),
                        "gateHeld": fleet.TURN_GATE.held(d),
                    })
        return _ok(rid, {
            "fleetEnabled": fleet.fleet_enabled(),
            "queue": fleet.FLEET_QUEUE.snapshot(),
            "profiles": profiles,
        })

    def moch_fleet_freeze(rid, params):
        name = str(params.get("profile") or "").strip()
        if not name:
            return _err(rid, 4061, "profile required")
        frozen = bool(params.get("frozen"))
        from hermes_cli.profiles import get_profile_dir
        home = Path(get_profile_dir(name))
        fleet.freeze_bot(home, frozen)
        audit.record("freeze" if frozen else "unfreeze", profile=name)
        return _ok(rid, {"profile": name, "frozen": fleet.is_frozen(home)})

    def moch_fleet_budgets(rid, params):
        bots = {}
        profiles_dir = Path(os.environ.get("HERMES_HOME",
                                           str(Path.home() / ".hermes"))) / "profiles"
        if profiles_dir.is_dir():
            for d in sorted(profiles_dir.iterdir()):
                if d.is_dir() and not d.name.startswith("."):
                    bots[d.name] = fleet.BUDGETS.spend_today(d.name)
        return _ok(rid, {
            "fleetToday": fleet.BUDGETS.spend_today(),
            "bots": bots,
            "limits": {
                "botDaily": int(os.environ.get("MOCH_BOT_DAILY", "0") or 0),
                "fleetDaily": int(os.environ.get("MOCH_FLEET_DAILY", "0") or 0),
            },
        })

    def moch_profiles_delete(rid, params):
        """Tombstone a named profile (never the default). The cron ticker stops a
        tombstoned profile by construction (profiles_to_serve excludes it), so its
        scheduled jobs stop firing; kanban task reassignment lands with the M9.4
        crew board."""
        name = str(params.get("profile") or "").strip()
        if not name or name == "default":
            return _err(rid, 4061, "a non-default profile is required")
        if not params.get("confirm"):
            return _err(rid, 4090, "confirm required")
        try:
            from hermes_cli.profiles import delete_profile
            delete_profile(name, yes=True)
        except FileNotFoundError as exc:
            return _err(rid, 4063, str(exc))
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 5064, f"delete failed: {exc}")
        audit.record("profile.deleted", profile=name)
        return _ok(rid, {"deleted": name})

    def moch_runs_timeline(rid, params):
        # M9.4 merges the delegation ledger + cron executions + kanban claims.
        # Stage-2 minimal honest shape: not built yet.
        return _err(rid, 5020, "moch.runs.timeline lands in M9.4 (run graph)")

    registry = {
        "moch.fleet.status": moch_fleet_status,
        "moch.profiles.delete": moch_profiles_delete,
        "moch.fleet.freeze": moch_fleet_freeze,
        "moch.fleet.budgets": moch_fleet_budgets,
        "moch.runs.timeline": moch_runs_timeline,
    }
    for name, fn in registry.items():
        methods.setdefault(name, fn)
    return True


def install(tg_server) -> bool:
    """Flag-gated registration; idempotent. Returns True when installed."""
    global _REGISTERED
    if _REGISTERED:
        return True
    from moch import fleet
    if not (fleet.fleet_enabled() or os.environ.get("MOCH_EMBEDDED") == "1"):
        return False
    _REGISTERED = _install(tg_server)
    return _REGISTERED
