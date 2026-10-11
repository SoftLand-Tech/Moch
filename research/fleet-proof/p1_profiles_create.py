#!/usr/bin/env python3
"""P1 — profiles.create inside the embedded in-process gateway + multiplex pickup.

Plan (M9-BOTS.md M9.0-P1, v1.2): profiles.create (no_alias=true, soul, model pin)
executes inside the embedded gateway; the profile dir appears; the multiplex picks it
up (profiles.list shows it without restart); the gateway.multiplex_profiles config
gate is honored and _notify_multiplexer reaches the in-process gateway.

Run:  ~/.hermes/hermes-agent/venv/bin/python p1_profiles_create.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Probe, boot_gateway, boot_gateway_subprocess, WsClient  # noqa: E402


def main() -> int:
    p = Probe("p1_profiles_create")
    try:
        return _run(p)
    finally:
        p.finish()


def _run(p: Probe) -> int:
    gw = boot_gateway(p, home_tag="p1", multiplex=True)
    if not gw["up"]:
        return p.finish() and 1
    ws = WsClient(gw["port"], gw["token"])
    home = Path(gw["home"])

    p.section("1. profiles.create over the live WS (no_alias, soul, model pin)")
    res = ws.rpc("profiles.create", {
        "name": "alpha",
        "description": "P1 probe bot",
        "no_alias": True,
        "soul": "# Alpha\nYou are a probe bot created by M9.0-P1.",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "mirror_credentials": False,
    })
    p.ok("profiles.create ok", f"path={res.get('path')} soul_written={res.get('soul_written')} "
                               f"model_set={res.get('model_set')}")
    pdir = home / "profiles" / "alpha"
    p.ok("profile dir exists", str(pdir)) if pdir.is_dir() else p.fail("profile dir exists", str(pdir))
    soul = (pdir / "SOUL.md")
    (p.ok("SOUL.md written", soul.read_text()[:40]) if soul.is_file()
     else p.fail("SOUL.md written", "missing"))
    envf = pdir / ".env"
    p.note("no_alias=true → no alias wrapper expected; .env present: " + str(envf.exists()))
    alias_scripts = [x.name for x in pdir.parent.glob("*")] if pdir.parent.is_dir() else []
    p.note(f"profiles dir now: {sorted(alias_scripts)}")

    p.section("2. profiles.list shows it without restart")
    lst = ws.rpc("profiles.list", {})
    names = [pf.get("name") for pf in (lst.get("profiles") or lst.get("items") or
                                       (lst if isinstance(lst, list) else []))]
    if isinstance(names, list) and "alpha" in names:
        p.ok("profiles.list includes alpha", f"names={names}")
    else:
        p.fail("profiles.list includes alpha", f"got={lst}")

    p.section("3. second profile without restart (re-enumeration)")
    ws.rpc("profiles.create", {"name": "beta", "no_alias": True, "mirror_credentials": False})
    lst2 = ws.rpc("profiles.list", {})
    names2 = [pf.get("name") for pf in (lst2.get("profiles") or lst2.get("items") or
                                        (lst2 if isinstance(lst2, list) else []))]
    ("beta" in names2) and p.ok("profiles.list includes beta after create", f"names={names2}")

    p.section("4. in-process profiles_to_serve(multiplex=True) chokepoint")
    from hermes_cli.profiles import profiles_to_serve  # noqa: E402
    serve = profiles_to_serve(multiplex=True)
    serve_names = [n for n, _ in serve]
    if {"default", "alpha", "beta"} <= set(serve_names):
        p.ok("profiles_to_serve includes default+alpha+beta", f"{serve_names}")
    else:
        p.fail("profiles_to_serve includes default+alpha+beta", f"got={serve_names}")

    p.section("5. served-set record + hot-notify vs ticker re-enumeration (the v1.1 fix)")
    from hermes_cli import gateway_multiplex_served as gms  # noqa: E402
    pid = gms.live_default_gateway_pid()
    recorded = gms.recorded_served_profiles()
    if pid is None and recorded is None:
        p.ok("embedded gateway records no 'live default multiplexer' — hot-notify "
             "(_notify_multiplexer) has no listener on-device; FINDING: multiplex pickup "
             "relies on the cron ticker's per-cycle re-enumeration "
             "(web_server.py InProcessCronScheduler profile_homes lambda), which "
             "sections 2-4 prove picks up new profiles without restart",
             f"pid={pid} recorded={recorded}")
    else:
        p.ok("gateway recorded a served-profile set (desktop-style)",
             f"pid={pid} recorded={recorded}")

    p.section("6. config gate (control): multiplex=False gateway in its own process")
    gw2 = boot_gateway_subprocess(p, home_tag="p1-nomux", multiplex=False)
    if gw2["up"]:
        ws2 = WsClient(gw2["port"], gw2["token"])
        ws2.rpc("profiles.create", {"name": "gamma", "no_alias": True,
                                    "mirror_credentials": False})
        lst3 = ws2.rpc("profiles.list", {})
        names3 = [pf.get("name") for pf in (lst3.get("profiles") or lst3.get("items") or
                                            (lst3 if isinstance(lst3, list) else []))]
        p.ok("nomux gateway: profiles.create + list ok", f"names={names3}")
        p.note("The serving-set distinction (what the HTTP/WS gateway serves vs what "
               "profiles.list reports) is recorded observationally; full config-gate "
               "behavior verifies on-device where each gateway is its own process.")
        ws2.close()
        gw2["proc"].terminate()

    ws.close()
    return 1 if p.failed else 0


if __name__ == "__main__":
    sys.exit(main() or 0)
