#!/usr/bin/env python3
"""P2 — M9.0: a turn targeted at a non-default profile runs under the right home/scope.

Plan (M9-BOTS.md M9.0-P2): "a turn against a non-default profile via params['profile']
runs under the right home/scope; state.db rows land in the profile's store; secrets
fail closed for unscoped reads."

Mechanism found in code (pre-probe investigation):
* ``session.create`` (tui_gateway/methods_session.py:326) accepts ``params['profile']``
  → ``_profile_home()`` (server.py:517) resolves <root>/profiles/<name>, registers it
  in ``_served_profile_homes`` and — on the FIRST secondary home — calls
  ``launch_profile_policy.activate_multi_profile_hosting()`` which flips
  ``agent.secret_scope.get_secret`` to fail closed. The profile_home is stored on the
  session and every turn/build re-binds HERMES_HOME + secret + terminal scope
  (``_session_profile_runtime_scope`` / ``_bind_build_profile_scopes``).
* ``prompt.submit`` persists the session row via ``_ensure_session_db_row``
  (session_workdir.py:245) which routes through the session's OWN profile db
  (``_workdir_owner_db`` → profile_home/state.db), NOT the launch home's state.db.
* The RN client (app/src/lib/chat.ts) creates sessions with ``session.create`` then
  sends turns with ``prompt.submit {session_id, text}`` — profile targeting rides on
  session.create, not on prompt.submit.

Run:  cd research/fleet-proof && ~/.hermes/hermes-agent/venv/bin/python p2_profile_scoping.py
"""
from __future__ import annotations

import contextlib
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Probe, boot_gateway, WsClient, RpcError  # noqa: E402


def _db_sessions(db_path: Path) -> list[tuple]:
    if not db_path.exists():
        return []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT id, source, profile_name, cwd FROM sessions "
            "ORDER BY started_at DESC LIMIT 20"
        ).fetchall()
    finally:
        con.close()
    return rows


def main() -> int:
    p = Probe("p2_profile_scoping")
    try:
        return _run(p)
    finally:
        p.finish()


def _run(p: Probe) -> int:
    # --- Pre-boot: plant a secret in the LAUNCH (default) home's .env -----------------
    home = Path("/tmp/moch-fleet-proof/p2/home")
    home.mkdir(parents=True, exist_ok=True)
    (home / ".env").write_text("PROBE_SECRET=launchvalue\n", encoding="utf-8")
    p.note(f"pre-boot: wrote PROBE_SECRET=launchvalue to launch home .env ({home}/.env)")

    gw = boot_gateway(p, home_tag="p2", multiplex=True)
    if not gw["up"]:
        return 1
    ws = WsClient(gw["port"], gw["token"])

    # --- 1. Create profile alpha ------------------------------------------------------
    p.section("1. profiles.create alpha (no_alias, no creds)")
    res = ws.rpc("profiles.create", {"name": "alpha", "no_alias": True,
                                     "mirror_credentials": False})
    alpha_home = Path(res.get("path") or (gw["home"] / "profiles" / "alpha"))
    p.ok("profiles.create ok", f"path={alpha_home} .env={ (alpha_home / '.env').exists() }")

    # --- 2. Target a chat turn at alpha: session.create{profile} + prompt.submit ------
    p.section("2. session.create{profile:'alpha'} + prompt.submit turn")
    before_default = _db_sessions(gw["home"] / "state.db")
    ses = ws.rpc("session.create", {"profile": "alpha", "title": "p2 alpha turn"})
    sid, key = ses.get("session_id"), ses.get("stored_session_id")
    p.ok("session.create returned",
         f"session_id={sid} stored_session_id={key} profile_name={ses.get('info', {}).get('profile_name')}")

    turn_err = None
    try:
        r = ws.rpc("prompt.submit", {"session_id": sid, "text": "hello from p2"},
                   timeout=90)
        p.note(f"prompt.submit returned (unexpected full success): {str(r)[:200]}")
    except RpcError as e:
        turn_err = e
        p.note(f"prompt.submit RPC error (expected — no provider key): "
               f"code={e.error.get('code')} msg={str(e.error.get('message'))[:160]}")
    except Exception as e:  # noqa: BLE001
        p.note(f"prompt.submit raised {type(e).__name__}: {e}")

    # Let the (failing) agent build + persistence settle.
    time.sleep(3)

    # --- 3. Where did the state land? -------------------------------------------------
    p.section("3. state.db routing")
    alpha_db = alpha_home / "state.db"
    default_db = gw["home"] / "state.db"
    a_rows = _db_sessions(alpha_db)
    d_rows = _db_sessions(default_db)
    alpha_has = [r for r in a_rows if key in (r[0],)]
    default_has = [r for r in d_rows if key in (r[0],)]
    p.note(f"alpha state.db={alpha_db} exists={alpha_db.exists()} rows={a_rows}")
    p.note(f"default state.db rows (before turn: {len(before_default)}, after: {len(d_rows)}): {d_rows}")
    if alpha_has:
        p.ok("session row landed in profile alpha's state.db", f"row={alpha_has[0]} db={alpha_db}")
    else:
        p.fail("session row landed in profile alpha's state.db",
               f"no row for stored id {key} in {alpha_db}; rows={a_rows}; "
               f"turn_err={turn_err and turn_err.error.get('code')}")
    if default_has:
        p.fail("row must NOT land in default home state.db", f"found {default_has[0]} in {default_db}")
    else:
        p.ok("default home state.db has no alpha row", f"{default_db} rows={d_rows}")

    # Session record's profile_home via server internals (scope proof independent of db).
    try:
        from tui_gateway import server as tg
        rec = tg._sessions.get(sid) or {}
        ph = rec.get("profile_home")
        if ph and Path(ph).resolve() == alpha_home.resolve():
            p.ok("server session record binds alpha's profile_home", f"profile_home={ph}")
        else:
            p.fail("server session record binds alpha's profile_home", f"got={ph!r}")
    except Exception as e:  # noqa: BLE001
        p.note(f"server internals introspection failed: {type(e).__name__}: {e}")

    # --- 4. Secrets fail closed --------------------------------------------------------
    p.section("4. secrets fail closed for unscoped reads under multi-profile hosting")
    from tui_gateway.launch_profile_policy import (  # noqa: E402
        activate_multi_profile_hosting, launch_secret_scope)
    from agent import secret_scope  # noqa: E402

    # The gateway already activated multi-profile hosting when alpha's home was
    # registered (server._profile_home); flipping explicitly is idempotent.
    activate_multi_profile_hosting()
    p.note(f"multiplex active={secret_scope.is_multiplex_active()}")

    # Control: single-profile read BEFORE activation would read os.environ. The launch
    # .env value must NOT be reachable unscoped now.
    unscoped = None
    try:
        unscoped = secret_scope.get_secret("PROBE_SECRET")
    except secret_scope.UnscopedSecretError as e:
        p.ok("unscoped get_secret raises UnscopedSecretError (fail closed)",
             f"mechanism: agent.secret_scope.get_secret with _MULTIPLEX_ACTIVE=True "
             f"(flipped by launch_profile_policy.activate_multi_profile_hosting); "
             f"msg={str(e)[:120]}")
    except Exception as e:  # noqa: BLE001
        p.fail("unscoped get_secret raised unexpected exception",
               f"{type(e).__name__}: {e}")
    if unscoped is not None:
        leaked = (unscoped == "launchvalue")
        (p.fail if leaked else p.ok)(
            "unscoped get_secret must not return the launch .env value",
            f"returned {unscoped!r} (leak={leaked})")

    # Launch profile still reads its own secret through its bound scope.
    try:
        scope = launch_secret_scope(gw["home"])
        token = secret_scope.set_secret_scope(scope)
        try:
            v = secret_scope.get_secret("PROBE_SECRET")
        finally:
            secret_scope.reset_secret_scope(token)
        if v == "launchvalue":
            p.ok("launch scope still resolves its own .env secret",
                 "launch_secret_scope(<launch home>) + set_secret_scope → launchvalue")
        else:
            p.fail("launch scope should resolve PROBE_SECRET=launchvalue", f"got {v!r}")
    except Exception as e:  # noqa: BLE001
        p.fail("launch-scope secret read failed", f"{type(e).__name__}: {e}")

    # A secondary (alpha) scope built the way upstream builds it must NOT see the
    # launch .env value: alpha's own .env is comment-only (mirror_credentials=false).
    try:
        from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
        alpha_scope = build_profile_secret_scope(alpha_home)
        token = set_secret_scope(alpha_scope)
        try:
            v = secret_scope.get_secret("PROBE_SECRET")
        finally:
            reset_secret_scope(token)
        if v is None:
            p.ok("alpha's scope cannot read the launch secret",
                 "build_profile_secret_scope(alpha_home) miss → None under multiplex (no os.environ fallthrough)")
        elif v == "launchvalue":
            p.fail("alpha's scope LEAKED the launch .env value", f"got {v!r}")
        else:
            p.note(f"alpha scope returned unexpected value {v!r}")
    except Exception as e:  # noqa: BLE001
        p.fail("alpha-scope secret read failed", f"{type(e).__name__}: {e}")

    ws.close()
    return 1 if p.failed else 0


if __name__ == "__main__":
    sys.exit(main())
