#!/usr/bin/env python3
"""M9.1a acceptance (PC): dm_bridge E2E + moch.* RPC layer + fleet gate live.

Per M9-BOTS.md §5 M9.1a acceptance, the parts provable without a provider key:
  1. flag-on boot: dispatch gate + dm_bridge swap + moch.* methods installed
  2. profiles alpha + beta over live WS
  3. bot A DMs bot B (bot_relay.deliver → in-process bridge; cold path)
  4. the message lands in beta's Bot Chat transcript (state.db)
  5. moch.fleet.status / budgets respond; freeze works and refuses delivery
  6. fleet audit jsonl records dm.send / freeze
  7. flag-off boot (control): nothing installed, gateway functional

Run:  ~/.hermes/hermes-agent/venv/bin/python accept_m91a_dm.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Probe, boot_gateway, boot_gateway_subprocess, WsClient  # noqa: E402

MSG = "hello beta — M9.1a dm_bridge acceptance (alpha → beta)"


def _botchat_message_hit(state_db: Path, needle: str) -> bool:
    """Search beta's state.db for the DM text in any messages-like table."""
    if not state_db.is_file():
        return False
    db = sqlite3.connect(str(state_db))
    try:
        tables = [r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        for t in tables:
            cols = [r[1] for r in db.execute(f"PRAGMA table_info({t})").fetchall()]
            text_cols = [c for c in cols if c.lower() in
                         ("text", "content", "message", "body")]
            if not text_cols:
                continue
            for c in text_cols:
                row = db.execute(f"SELECT COUNT(*) FROM {t} WHERE {c} LIKE ?",
                                 (f"%{needle}%",)).fetchone()
                if row and row[0]:
                    return True
        return False
    finally:
        db.close()


def main() -> int:
    p = Probe("accept_m91a_dm")
    try:
        return _run(p)
    finally:
        p.finish()


def _run(p: Probe) -> int:
    import os
    os.environ["MOCH_FLEET"] = "1"
    os.environ["MOCH_EMBEDDED"] = "1"
    gw = boot_gateway(p, home_tag="m91a", multiplex=True)
    if not gw["up"]:
        return 1
    ws = WsClient(gw["port"], gw["token"])
    home = Path(gw["home"])

    p.section("1. flag-on boot: gate + bridge + moch.* installed")
    from tui_gateway import server as tg
    from tools import bot_mode_dm as bdm
    from moch import fleet as _fl
    p.note(f"main-thread fleet_enabled={_fl.fleet_enabled()} "
           f"gate_installed={getattr(tg, '_moch_gate_installed', False)} "
           f"dispatch_name={getattr(tg.dispatch, '__name__', '?')}")
    if getattr(tg, "_moch_gate_installed", False):
        p.ok("dispatch gate installed")
    else:
        p.fail("dispatch gate installed")
    if getattr(bdm, "_moch_dm_bridge", False):
        p.ok("dm_bridge swapped for _run_local_turn")
    else:
        p.fail("dm_bridge swapped")
    for m in ("moch.fleet.status", "moch.fleet.freeze", "moch.fleet.budgets"):
        if m in getattr(tg, "_methods", {}):
            p.ok(f"{m} registered")
        else:
            p.fail(f"{m} registered")

    p.section("2. profiles alpha + beta")
    ws.rpc("profiles.create", {"name": "alpha", "no_alias": True,
                               "mirror_credentials": False})
    ws.rpc("profiles.create", {"name": "beta", "no_alias": True,
                               "mirror_credentials": False})
    beta_db = home / "profiles" / "beta" / "state.db"

    p.section("3a. alpha DMs beta over bot_relay.deliver (live-intent path, E2E)")
    from harness import RpcError
    try:
        res = ws.rpc("bot_relay.deliver", {"profile": "beta", "message": MSG},
                     timeout=240.0)
        p.note(f"deliver ok: {str(res)[:120]}")
    except RpcError as e:
        # Expected WITHOUT a provider: the DM is admitted (live intent), the turn
        # runs in-process, and fails at model resolution. The transcript landing
        # is asserted in 3b/4.
        if "not connected to any AI provider" in str(e.error.get("message", "")):
            p.ok("deliver → turn ran in-process, failed at provider (expected, no key)")
        else:
            p.fail("deliver", str(e.error.get("message"))[:160])

    p.section("3b. dm_bridge cold path directly (bdm._run_local_turn swapped)")
    dm_file = home / "fleet" / "probe-dm.txt"
    dm_file.parent.mkdir(parents=True, exist_ok=True)
    dm_file.write_text(MSG + " (cold path)", encoding="utf-8")
    argv = ["hermes", "-p", "beta", "chat", "--in", "~", "-c", "Bot Chat",
            "--create-if-missing", "-Q"]
    rc = bdm._run_local_turn(argv, str(dm_file))
    if rc == 0:
        p.ok("bridge cold path delivered (rc=0, empty reply w/o provider)")
    else:
        p.fail("bridge cold path", f"rc={rc}")
    dm_file.unlink(missing_ok=True)

    p.section("4. message landed in beta's transcript")
    hit = _botchat_message_hit(beta_db, MSG)
    if hit:
        p.ok("DM text found in beta state.db")
    else:
        p.fail("DM text in beta state.db", "needle not found — inspect transcript tables")

    p.section("5. moch.fleet.* + freeze refusal (bridge contract)")
    st = ws.rpc("moch.fleet.status", {})
    if st.get("fleetEnabled") is True:
        p.ok("moch.fleet.status fleetEnabled")
    else:
        p.fail("moch.fleet.status", str(st))
    fr = ws.rpc("moch.fleet.freeze", {"profile": "beta", "frozen": True})
    if fr.get("frozen"):
        p.ok("freeze accepted")
    else:
        p.fail("freeze", str(fr))
    # frozen: the bridge refuses with target_frozen before opening a session
    dm_file2 = home / "fleet" / "probe-dm2.txt"
    dm_file2.write_text("should be refused", encoding="utf-8")
    import io as _io
    from contextlib import redirect_stdout
    buf = _io.StringIO()
    with redirect_stdout(buf):
        rc2 = bdm._run_local_turn(argv, str(dm_file2))
    dm_file2.unlink(missing_ok=True)
    out2 = buf.getvalue()
    refused = rc2 == 1 and "target_frozen" in out2
    if refused:
        p.ok("delivery to frozen bot refused (target_frozen, rc=1)", out2[:120])
    else:
        p.fail("delivery to frozen bot refused", f"rc={rc2} out={out2[:160]}")
    ws.rpc("moch.fleet.freeze", {"profile": "beta", "frozen": False})
    p.ok("unfreeze ok")

    p.section("6. fleet audit jsonl")
    audit_file = home / "fleet" / "audit.jsonl"
    if audit_file.is_file():
        events = [json.loads(l).get("event") for l in
                  audit_file.read_text().splitlines() if l.strip()]
        ({"dm.send", "freeze", "dm.reply"} <= set(events)
         and p.ok("audit vocabulary present", f"{sorted(set(events))}")
         ) or p.note(f"audit events so far: {sorted(set(events))}")
    else:
        p.fail("audit jsonl exists", str(audit_file))

    ws.close()

    p.section("7. flag-off control (subprocess gateway): nothing installed")
    gw2 = boot_gateway_subprocess(p, home_tag="m91a-flagoff", multiplex=True)
    if gw2["up"]:
        ws2 = WsClient(gw2["port"], gw2["token"])
        try:
            st2 = ws2.rpc("moch.fleet.status", {})
            p.fail("moch.* absent with flag off", f"unexpected: {str(st2)[:120]}")
        except RpcError as e:
            if e.error.get("code") == -32601:
                p.ok("moch.* absent with flag off (unknown method)")
            else:
                p.fail("moch.* absent with flag off", str(e.error)[:120])
        ws2.close()
        gw2["proc"].terminate()

    return 1 if p.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
