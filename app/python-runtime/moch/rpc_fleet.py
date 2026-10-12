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

import contextlib
import os
import time
from pathlib import Path


def _parse_ts(v) -> float:
    """Cron timestamps are ISO strings; the other ledgers are epoch floats."""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    with contextlib.suppress(Exception):
        import datetime as _dt
        return _dt.datetime.fromisoformat(str(v)).timestamp()
    return 0.0

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

    def moch_profiles_mirror_model_key(rid, params):
        """Repair path for keyless bots created before the §2.8 default flipped:
        copy *API_KEY lines from the launch home's .env into the profile's .env
        (never overwriting an existing value; channel/bot tokens are NOT
        matched). Returns the list of mirrored key names."""
        name = str(params.get("profile") or "").strip()
        if not name or name == "default":
            return _err(rid, 4061, "a non-default profile is required")
        try:
            from hermes_cli.profiles import get_profile_dir
            from hermes_constants import get_hermes_home
            dst = Path(get_profile_dir(name)) / ".env"
            launch = Path(get_hermes_home()) / ".env"
            if not launch.is_file():
                return _err(rid, 4064, "launch profile has no .env to mirror")
            existing = {}
            if dst.is_file():
                for line in dst.read_text(encoding="utf-8").splitlines():
                    if "=" in line and not line.lstrip().startswith("#"):
                        k = line.split("=", 1)[0].strip()
                        existing[k] = line
            mirrored = []
            out = dst.read_text(encoding="utf-8") if dst.is_file() else ""
            add = []
            for line in launch.read_text(encoding="utf-8").splitlines():
                ls = line.strip()
                if not ls or ls.startswith("#") or "=" not in ls:
                    continue
                k = ls.split("=", 1)[0].strip()
                if not k.endswith("API_KEY") or k in existing:
                    continue
                add.append(ls)
                mirrored.append(k)
            if add:
                body = out.rstrip("\n") + "\n" + "\n".join(add) + "\n" if out.strip() else "\n".join(add) + "\n"
                dst.write_text(body, encoding="utf-8")
            audit.record("profile.model_key_mirrored", profile=name, keys=mirrored)
            return _ok(rid, {"profile": name, "mirrored": mirrored})
        except FileNotFoundError as exc:
            return _err(rid, 4063, str(exc))
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 5065, f"mirror failed: {exc}")

    def moch_kanban_tasks(rid, params):
        """Read-only crew-board view (default board): tasks grouped for the app.
        Params: {assignee?: str, status?: str, limit?: 100, board?: str}.
        BUG-138 hardening: db_path resolved at ENTRY (a concurrent in-process
        worker turn pins HERMES_KANBAN_DB process-globally — an ambient
        connect_closing() could read the WRONG board)."""
        limit = max(1, min(int(params.get("limit") or 100), 300))
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
            db_path = _kb.kanban_db_path(board=params.get("board") or None)
            with _kbc.connect_closing(db_path) as conn:
                tasks = _kb.list_tasks(
                    conn,
                    assignee=params.get("assignee") or None,
                    status=params.get("status") or None,
                    limit=limit,
                    order_by="updated",
                )
                return _ok(rid, {"tasks": [
                    {"id": t.id, "title": t.title, "assignee": t.assignee or "",
                     "status": t.status, "priority": t.priority,
                     "body": getattr(t, "body", "") or "",
                     "createdAt": t.created_at,
                     "completedAt": t.completed_at}
                    for t in tasks]})
        except ImportError as exc:
            return _err(rid, 5021, f"kanban unavailable: {exc}")
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 5022, f"kanban read failed: {exc}")

    def _kanban_db_path_at_entry(board):
        """Resolve the board DB path ONCE at RPC entry, before any in-process
        worker turn could mutate the process-global kanban env (the
        wrong-board-write race from the M9 research: FleetWorker._kanban_env
        pins HERMES_KANBAN_DB/BOARD for the duration of a worker turn)."""
        from hermes_cli import kanban_db as _kb
        return _kb.kanban_db_path(board=board)

    def _assignee_refusal(rid, name: str):
        """None when the assignee is spawnable; else an error dict. Refuses
        non-profile assignees (a forever-skip bucket upstream dispatch never
        surfaces) and frozen bots (claim→block loops that end in triage)."""
        from hermes_cli.profiles import get_profile_dir
        from moch import fleet
        home = Path(get_profile_dir(name))
        if not home.is_dir():
            return _err(rid, 4071, f"assignee '{name}' is not a profile on this install")
        if fleet.is_frozen(home):
            return _err(rid, 4071, f"assignee '{name}' is frozen (fleet kill switch)")
        return None

    def moch_kanban_create(rid, params):
        """Crew write slice: put a task on the board from the phone.
        Params: {title (required), assignee (required — validated, not
        frozen), body?, priority?, idempotency_key?, board?}.
        Mirrors kanban_create's required-assignee rule (the dispatcher only
        spawns assigned rows) and the dashboard plugin's operator semantics
        (created_by="moch-app"); follows with a flag-gated dispatch poke so
        the task doesn't wait out the heal ticker."""
        title = str(params.get("title") or "").strip()
        assignee = str(params.get("assignee") or "").strip()
        if not title:
            return _err(rid, 4071, "title required")
        if not assignee:
            return _err(rid, 4071,
                        "assignee required — the dispatcher only spawns assigned tasks")
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
        except ImportError as exc:
            return _err(rid, 5021, f"kanban unavailable: {exc}")
        board = params.get("board") or None
        refusal = _assignee_refusal(rid, assignee)
        if refusal is not None:
            return refusal
        from moch.audit import record as _audit
        from moch import kanban_dispatch
        try:
            db_path = _kanban_db_path_at_entry(board)
            with _kbc.connect_closing(db_path) as conn:
                tid = _kb.create_task(
                    conn,
                    title=title,
                    body=str(params.get("body") or "") or None,
                    assignee=assignee,
                    created_by="moch-app",
                    priority=int(params.get("priority") or 0),
                    idempotency_key=str(params.get("idempotency_key") or "") or None,
                    board=board,
                )
        except ValueError as exc:
            return _err(rid, 4071, str(exc))
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 5022, f"create failed: {exc}")
        _audit("kanban.create", task=tid, assignee=assignee, board=board or "default")
        kanban_dispatch.poke_dispatch(db_path, board=board)
        return _ok(rid, {"task": tid, "assignee": assignee})

    def moch_kanban_assign(rid, params):
        """Reassign a task ("" = unassign — note it then parks until
        reassigned: unassigned rows are a dispatch skip bucket).
        Params: {task_id, assignee (may be ""), reclaim_first?: bool}.
        RuntimeError while running-claimed maps to a 409-style refusal with
        the upstream message (assign_task raises; reassign_task returns
        False — we surface both the same way)."""
        task_id = str(params.get("task_id") or "").strip()
        if not task_id:
            return _err(rid, 4071, "task_id required")
        assignee = str(params.get("assignee") or "").strip()
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
        except ImportError as exc:
            return _err(rid, 5021, f"kanban unavailable: {exc}")
        if assignee:
            refusal = _assignee_refusal(rid, assignee)
            if refusal is not None:
                return refusal
        board = params.get("board") or None
        from moch.audit import record as _audit
        try:
            db_path = _kanban_db_path_at_entry(board)
            with _kbc.connect_closing(db_path) as conn:
                moved = _kb.reassign_task(
                    conn, task_id, assignee or None,
                    reclaim_first=bool(params.get("reclaim_first")),
                    reason="moch-app reassign")
        except Exception as exc:  # noqa: BLE001 — ValueError/RuntimeError both user-readable
            return _err(rid, 4072, str(exc))
        if not moved:
            return _err(rid, 4072,
                        f"cannot reassign '{task_id}': still running "
                        "(retry with reclaim_first)")
        _audit("kanban.assign", task=task_id, assignee=assignee or "(none)")
        from moch import kanban_dispatch
        kanban_dispatch.poke_dispatch(db_path, board=board)
        return _ok(rid, {"task": task_id, "assignee": assignee})

    def moch_kanban_complete(rid, params):
        """Complete a task as the human operator: force=True (dashboard
        precedent — a phone action overrides a live worker claim). Honest
        limit: force-completing a running card does NOT stop the in-process
        worker thread; its later writes no-op via the claim-ownership check.
        Params: {task_id, summary?, result?}."""
        task_id = str(params.get("task_id") or "").strip()
        if not task_id:
            return _err(rid, 4071, "task_id required")
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
        except ImportError as exc:
            return _err(rid, 5021, f"kanban unavailable: {exc}")
        board = params.get("board") or None
        from moch.audit import record as _audit
        try:
            db_path = _kanban_db_path_at_entry(board)
            with _kbc.connect_closing(db_path) as conn:
                done = _kb.complete_task(
                    conn, task_id,
                    result=str(params.get("result") or "") or None,
                    summary=str(params.get("summary") or "") or None,
                    force=True)
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 4074, str(exc))
        if not done:
            return _err(rid, 4074, f"cannot complete '{task_id}' (open parents?)")
        _audit("kanban.complete", task=task_id)
        from moch import kanban_dispatch
        kanban_dispatch.poke_dispatch(db_path, board=board)
        return _ok(rid, {"task": task_id, "done": True})

    def moch_kanban_block(rid, params):
        """Park a task with a reason (kind ∈ dependency|needs_input|
        capability|transient — validated upstream; dependency routes to
        todo, recurrence ≥2 to triage). Params: {task_id, reason, kind?}."""
        task_id = str(params.get("task_id") or "").strip()
        reason = str(params.get("reason") or "").strip()
        if not task_id or not reason:
            return _err(rid, 4071, "task_id and reason required")
        try:
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc
        except ImportError as exc:
            return _err(rid, 5021, f"kanban unavailable: {exc}")
        board = params.get("board") or None
        from moch.audit import record as _audit
        try:
            db_path = _kanban_db_path_at_entry(board)
            with _kbc.connect_closing(db_path) as conn:
                _kb.block_task(conn, task_id, reason=reason,
                               kind=str(params.get("kind") or "") or None)
        except ValueError as exc:
            return _err(rid, 4071, str(exc))
        except Exception as exc:  # noqa: BLE001
            return _err(rid, 4074, str(exc))
        _audit("kanban.block", task=task_id, reason=reason[:120])
        return _ok(rid, {"task": task_id, "blocked": True})

    def moch_skills_list(rid, params):
        """BUG-139 checklist picker: skills installed in the LAUNCH home
        (os.environ HERMES_HOME — under multiplex that is the launch profile
        by contract). Read-only walk of skills/ via upstream's own iterator
        (org-mirror aware), name = SKILL.md's parent dir (identity rule,
        methods_profiles.py). Description: top-level frontmatter line,
        display-truncated — parse-light by design (no yaml import on this path).
        Params: {limit?: 50}"""
        home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
        skills_dir = home / "skills"
        out = []
        if skills_dir.is_dir():
            try:
                from agent.skill_utils import iter_skill_index_files
            except ImportError as exc:
                return _err(rid, 5067, f"skill utils unavailable: {exc}")
            limit = max(1, min(int(params.get("limit") or 50), 200))
            for md in iter_skill_index_files(skills_dir, "SKILL.md"):
                rel = md.parent.relative_to(skills_dir)
                desc = ""
                try:
                    text = md.read_text(encoding="utf-8", errors="replace")
                    if text.startswith("---"):
                        for line in text.split("---", 2)[1].splitlines():
                            ls = line.strip()
                            if ls.startswith("description:"):
                                desc = ls[len("description:"):].strip().strip("'\"")[:140]
                                break
                except OSError:
                    pass
                out.append({"name": str(rel.name), "description": desc,
                            "path": str(rel)})
                if len(out) >= limit:
                    break
        return _ok(rid, {"skills": out})

    def moch_profiles_seed(rid, params):
        """BUG-139 checklist: copy identity files / selected skills from the
        LAUNCH home into a named profile — as real files, post-create.
        Never clone_from: that copies the whole .env/config.yaml (mirroring
        then skips the non-stub .env — §2.8's model-key-only default silently
        upgrades to full credential sharing) and is all-skills-all-memory.
        Params: {profile, copy_user_memory?: bool, copy_memory?: bool,
                 skills?: [names]} → per-item copied/skipped-exists/missing.
        Vendored helpers are import-only (no core edits); ImportError is a
        clean refusal, not a crash."""
        from moch import fleet  # noqa: F401 — consistency with sibling methods
        name = str(params.get("profile") or "").strip()
        if not name or name == "default":
            return _err(rid, 4061, "a non-default profile is required")
        want_user = bool(params.get("copy_user_memory"))
        want_memory = bool(params.get("copy_memory"))
        skills = [str(x).strip() for x in (params.get("skills") or [])
                  if str(x).strip()]
        if not (want_user or want_memory or skills):
            return _err(rid, 4062, "nothing to seed")
        try:
            from hermes_cli.profiles import get_profile_dir
        except ImportError as exc:
            return _err(rid, 5066, f"profile helpers unavailable: {exc}")
        dst = Path(get_profile_dir(name))
        if not dst.is_dir():
            return _err(rid, 4063, f"profile '{name}' not found")
        launch = Path(os.environ.get("HERMES_HOME",
                                     str(Path.home() / ".hermes")))
        try:
            from hermes_cli.profiles import (_clone_file,
                                             _copytree_keep_junctions,
                                             _non_exportable_entries)
        except ImportError as exc:
            return _err(rid, 5066, f"vendored copy helpers unavailable: {exc}")

        out = {"profile": name, "userMemory": None, "memory": None, "skills": []}
        for flag, rel, key in ((want_user, "memories/USER.md", "userMemory"),
                               (want_memory, "memories/MEMORY.md", "memory")):
            if not flag:
                continue
            if not (launch / rel).is_file():
                out[key] = "missing"
            elif (dst / rel).exists():
                out[key] = "skipped-exists"
            else:
                _clone_file(launch, dst, rel)
                out[key] = "copied"

        if skills:
            from agent.skill_utils import iter_skill_index_files
            launch_skills = launch / "skills"
            # name → (SKILL.md, rel): first match wins on category collisions
            found: dict[str, tuple] = {}
            if launch_skills.is_dir():
                for md in iter_skill_index_files(launch_skills, "SKILL.md"):
                    rel = md.parent.relative_to(launch_skills)
                    found.setdefault(str(rel.name), (md, rel))
            for want in skills:
                if want not in found:
                    out["skills"].append({"name": want, "result": "missing"})
                    continue
                md, rel = found[want]
                dst_dir = dst / "skills" / rel
                if dst_dir.exists():
                    # merge would duplicate a same-named candidate and
                    # _locate_skill refuses to guess (#113471) — skip.
                    out["skills"].append({"name": want,
                                          "result": "skipped-exists"})
                    continue
                if md.parent.is_symlink():
                    # symlinked source copies as a write-through link into
                    # the launch tree — never link a bot into Moch's files.
                    out["skills"].append({"name": want,
                                          "result": "skipped-symlink"})
                    continue
                dst_dir.parent.mkdir(parents=True, exist_ok=True)
                _copytree_keep_junctions(md.parent, dst_dir,
                                         _non_exportable_entries,
                                         dirs_exist_ok=True)
                out["skills"].append({"name": want, "result": "copied"})

        audit.record("profile.seeded", profile=name, userMemory=out["userMemory"],
                     memory=out["memory"],
                     skills={x["name"]: x["result"] for x in out["skills"]})
        return _ok(rid, out)

    def moch_runs_timeline(rid, params):
        """Merged read-side run ledger (§2.1: a VIEW, not a store):
        kanban tasks + cron executions + delegation records, newest first.
        Params: {limit?: 60, board?: str}. Missing sources are skipped."""
        limit = max(1, min(int(params.get("limit") or 60), 200))
        runs: list[dict] = []
        root = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))

        import sqlite3

        def _rows(db_path: Path, sql: str, map_fn, params: tuple = ()) -> None:
            try:
                if not db_path.is_file():
                    return
                con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                try:
                    for row in con.execute(sql, params).fetchall():
                        with contextlib.suppress(Exception):
                            runs.append(map_fn(row))
                finally:
                    con.close()
            except Exception:  # noqa: BLE001 — a broken source never breaks the view
                return

        # kanban tasks (default board + any board dirs)
        try:
            from hermes_cli import kanban_db as _kb
            boards = [None]
            board_root = root / "kanban" / "boards"
            if board_root.is_dir():
                boards.extend(d.name for d in sorted(board_root.iterdir()) if d.is_dir())
            for board in dict.fromkeys(boards):
                with contextlib.suppress(Exception):
                    dbp = _kb.kanban_db_path(board=board)
                    _rows(dbp,
                          "SELECT id, title, assignee, status, created_at, "
                          "COALESCE(completed_at, started_at, created_at) "
                          "FROM tasks ORDER BY 6 DESC LIMIT ?",
                          lambda r, b=board: {
                              "source": "kanban", "id": r[0], "profile": r[2] or "",
                              "title": r[1], "status": r[3], "ts": float(r[5] or 0),
                              "board": b or "default"}, params=(limit,))
        except Exception:  # noqa: BLE001
            pass

        # cron executions
        _rows(root / "cron" / "executions.db",
              "SELECT id, job_id, status, claimed_at, COALESCE(finished_at, started_at, "
              "claimed_at), COALESCE(error,'') FROM executions "
              "ORDER BY 5 DESC LIMIT ?",
              lambda r: {
                  "source": "cron", "id": r[0], "profile": "", "title": f"job {r[1]}",
                  "status": r[2], "ts": _parse_ts(r[4]), "error": r[5]},
              params=(limit,))

        # delegations (default home + each profile's state.db)
        candidates = [(root / "state.db", "default")]
        profiles_dir = root / "profiles"
        if profiles_dir.is_dir():
            for d in sorted(profiles_dir.iterdir()):
                if d.is_dir() and not d.name.startswith("."):
                    candidates.append((d / "state.db", d.name))
        for db_path, who in candidates:
            _rows(db_path,
                  "SELECT delegation_id, state, dispatched_at, "
                  "COALESCE(completed_at, updated_at) FROM async_delegations "
                  "ORDER BY 4 DESC LIMIT ?",
                  lambda r, w=who: {
                      "source": "delegate", "id": r[0], "profile": w,
                      "title": f"delegation {r[1]}", "status": r[1],
                      "ts": float(r[3] or 0)}, params=(limit,))

        runs = [r for r in runs if r]
        runs.sort(key=lambda r: r.get("ts") or 0.0, reverse=True)
        return _ok(rid, {"runs": runs[:limit], "total": len(runs)})

    registry = {
        "moch.fleet.status": moch_fleet_status,
        "moch.kanban.tasks": moch_kanban_tasks,
        "moch.kanban.create": moch_kanban_create,
        "moch.kanban.assign": moch_kanban_assign,
        "moch.kanban.complete": moch_kanban_complete,
        "moch.kanban.block": moch_kanban_block,
        "moch.profiles.mirror_model_key": moch_profiles_mirror_model_key,
        "moch.profiles.delete": moch_profiles_delete,
        "moch.profiles.seed": moch_profiles_seed,
        "moch.skills.list": moch_skills_list,
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
