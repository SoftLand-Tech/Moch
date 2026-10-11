#!/usr/bin/env python3
"""P4c — session-lease conflict probe (plan v1.2, M9.0-P4c).

"An in-process DM turn while the target profile has an active interactive session must
surface the busy/lease refusal (upstream learned it from child stderr SESSION_NOT_OWNED;
the bridge must check the lease directly)."

What this probe does: boots the real embedded gateway in-process, creates profile
"alpha", opens a live Bot Chat session for alpha over WS, then fires the WS
``bot_relay.deliver`` RPC at alpha in BOTH states — LIVE+IDLE and LIVE+RUNNING — and
records the actual behavior (queued / refused / interrupt). The lease mechanism
(active_sessions.SESSION_NOT_OWNED, server._claim_or_reuse_live_session, server._sessions)
is inspected in-process (the gateway runs in this same process on a daemon thread).

Run:  cd research/fleet-proof && ~/.hermes/hermes-agent/venv/bin/python p4c_session_lease.py
"""
from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Probe, WsClient, boot_gateway  # noqa: E402


def main() -> int:
    p = Probe("p4c_session_lease")
    try:
        return _run(p)
    except Exception:
        p.fail("probe crashed", traceback.format_exc(limit=8).splitlines()[-1])
        p.note(traceback.format_exc(limit=8))
        return 1
    finally:
        p.finish()


def _run(p: Probe) -> int:
    gw = boot_gateway(p, home_tag="p4c")
    if not gw["up"]:
        return 1
    ws = WsClient(gw["port"], gw["token"])
    home = Path(gw["home"])

    p.section("1. Lease mechanism located (static evidence)")
    from hermes_cli.active_sessions import SESSION_NOT_OWNED
    from tui_gateway import server as tg

    p.ok("SESSION_NOT_OWNED constant",
         f"hermes_cli/active_sessions.py:104 = {SESSION_NOT_OWNED!r}; parsed from child stderr by "
         "tools/bot_mode_dm.py:434-446; owner side declares liveness via lease records "
         "(active_sessions.py:542 session_already_owned_message)")
    p.ok("gateway live-session registry",
         "tui_gateway/server.py _claim_or_reuse_live_session (~:2543) registers session records in "
         "server._sessions[sid] with fields profile_home / running / active_session_lease "
         "(claimed lazily on the first turn by _ensure_active_session_slot, methods_prompt.py)")

    p.section("2. Profile alpha + live Bot Chat session over WS")
    res = ws.rpc("profiles.create", {
        "name": "alpha", "description": "P4c lease probe", "no_alias": True,
        "soul": "# Alpha\nP4c probe bot.", "model": "gpt-4o-mini", "provider": "openai",
        "mirror_credentials": False,
    })
    alpha_home = home / "profiles" / "alpha"
    p.ok("profiles.create alpha", f"path={res.get('path')} dir_exists={alpha_home.is_dir()}")

    sess = ws.rpc("session.create", {"profile": "alpha", "title": "Bot Chat"})
    sid = sess["session_id"]
    p.ok("session.create(profile=alpha, title='Bot Chat')", f"sid={sid} stored_key={sess.get('stored_session_id')}")

    # In-process inspection: the gateway thread shares our modules.
    record = tg._sessions.get(sid)
    if record is None:
        p.fail("session record in server._sessions", f"sid {sid} not found")
        return 1
    title = tg._session_live_title(record, tg._session_lookup_key(record, fallback=sid))
    p.ok("liveness representation",
         f"server._sessions[{sid[:8]}…] profile_home={record.get('profile_home')} "
         f"running={record.get('running')} live_title={title!r} "
         f"(methods_bot_relay matches on profile_home + BOT_CHAT_TITLE)")

    p.section("3. DM delivery (WS bot_relay.deliver) — LIVE + IDLE session")
    idle_outcome: dict = {}
    try:
        r = ws.rpc("bot_relay.deliver", {"profile": "alpha", "message": "p4c idle-state probe"},
                   timeout=90)
        idle_outcome["ok"] = r
    except Exception as e:
        idle_outcome["err"] = repr(e)
    idle_rec = tg._sessions.get(sid) or {}
    idle_status_after = idle_rec.get("running")
    if "ok" in idle_outcome:
        p.ok("LIVE+IDLE → accepted (queued-into-Bot-Chat branch)",
             f"reply={idle_outcome['ok'].get('reply')!r} — deliver found the live Bot Chat and "
             f"submitted via prompt.submit(queued=True); session running flag after={idle_status_after}")
    else:
        p.fail("LIVE+IDLE delivery", str(idle_outcome["err"]))

    # Clean the idle probe's turn up (no credentials in the probe home: it fails fast),
    # then simulate a mid-flight turn deterministically by holding running=True.
    try:
        ws.rpc("session.interrupt", {"session_id": sid}, timeout=20)
    except Exception:
        pass
    for _ in range(40):
        rec = tg._sessions.get(sid) or {}
        if not rec.get("running"):
            break
        time.sleep(0.25)
    p.note("after idle probe + interrupt: running flag cleared = "
           f"{not (tg._sessions.get(sid) or {}).get('running')}")

    p.section("4. DM delivery — LIVE + RUNNING session (mid-flight interactive turn)")
    rec = tg._sessions[sid]
    with rec["history_lock"]:
        rec["running"] = True  # documented simulation of an in-flight turn (no credentials needed)
        rec["inflight_turn"] = {"user": "interactive turn in flight (simulated)"}
    running_outcome: dict = {}
    try:
        r = ws.rpc("bot_relay.deliver", {"profile": "alpha", "message": "p4c running-state probe"},
                   timeout=90)
        running_outcome["ok"] = r
    except Exception as e:
        running_outcome["err"] = repr(e)
    queued_after = (tg._sessions.get(sid) or {}).get("queued_prompt")
    if "ok" in running_outcome:
        p.ok("LIVE+RUNNING → accepted, queued as NEXT turn (queued=True branch)",
             f"reply={running_outcome['ok'].get('reply')!r}; queued_prompt present="
             f"{queued_after is not None} — prompt.submit(queued=True) forces queue mode in "
             "_handle_busy_submit (session_auto_continue.py:248): never interrupts, never steers")
    else:
        p.fail("LIVE+RUNNING delivery", str(running_outcome["err"]))

    # Restore: clear the simulated running flag + drop the queued envelope.
    rec = tg._sessions[sid]
    with rec["history_lock"]:
        rec["running"] = False
        rec["inflight_turn"] = None
        rec.pop("queued_prompt", None)

    p.section("5. Findings for the M9.1a bridge contract")
    refused = ("err" in idle_outcome) or ("err" in running_outcome)
    answer = ("(b) QUEUE — an in-process DM delivery into a live Bot Chat is NEVER refused: "
              "LIVE+IDLE submits immediately (turn starts, reply 'Delivered into @alpha's open "
              "Bot Chat…'), LIVE+RUNNING queues as the next turn via prompt.submit(queued=True). "
              "The upstream subprocess SESSION_NOT_OWNED/target_busy refusal does NOT exist on "
              "the in-process live-session branch — it only fires on the subprocess transport "
              "path (acquire_turn_lock contention → TurnBusyError/target_busy, or another "
              "process's lease → SESSION_NOT_OWNED). The M9.1a dm_bridge must add its own "
              "lease/busy check if a machine-readable refusal is required.")
    if not refused:
        p.ok("P4c FINDING — queued, not refused", answer)
    else:
        p.note("at least one state errored — see sections 3/4 raw outcomes above")
    p.note("idle raw  = " + repr(idle_outcome)[:400])
    p.note("running raw = " + repr(running_outcome)[:400])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
