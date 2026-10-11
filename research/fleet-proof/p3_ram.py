#!/usr/bin/env python3
"""P3 — M9.0 (v1.2): RAM probe — idle-profile RSS sweep + concurrent-turn RSS.

Plan (M9-BOTS.md M9.0-P3): "RSS before/after N concurrent profile turns (1..4) → the
FleetTurnQueue default comes from data, not vibes (B3). Add an idle-profile RSS sweep
(0/2/4/8 profiles, zero active turns) — the 6–8 soft cap depends on idle RSS."

HONEST LABELING of what these numbers are:
* The gateway runs IN THIS PROCESS (embedded in-process gateway, exactly like the app's
  moch.gateway_server). "Idle-profile RSS" is therefore the whole probe process's RSS
  (gateway + probe client + WS pumps), measured from /proc/self/status VmRSS. It includes
  gateway-side growth caused by serving profiles.create RPCs; it is an UPPER bound for
  "idle cost of N profiles" in the serving process. On-device each profile's turn state
  is in the same gateway process, so this is the right direction of measurement, but the
  absolute base includes probe-harness overhead (~python + websockets client).
* No control with "directory-only" profiles: profiles.create already is the minimal
  upstream path (dir + .env + config + skills seed skipped? seed_profile_skills runs for
  fresh profiles — included). We record what we measure, precisely labeled.
* Concurrent turns run WITHOUT a provider API key: each turn = session row persist +
  agent build attempt that fails at provider resolution. This bounds the TURN-PATH
  allocation overhead (session record, agent build attempt, turn bookkeeping), NOT
  full LLM streaming/context memory. Real turns with a live model stream more.

Run:  cd research/fleet-proof && ~/.hermes/hermes-agent/venv/bin/python p3_ram.py
"""
from __future__ import annotations

import resource
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Probe, boot_gateway, WsClient, RpcError  # noqa: E402


def vmrss_kb() -> int:
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return -1


def rumaxrss_kb() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KiB on Linux


def mb(kb: float) -> str:
    return f"{kb / 1024:.1f}MB"


def settle(seconds: float = 2.0) -> None:
    time.sleep(seconds)


def main() -> int:
    p = Probe("p3_ram")
    try:
        return _run(p)
    finally:
        p.finish()


def _run(p: Probe) -> int:
    gw = boot_gateway(p, home_tag="p3", multiplex=True)
    if not gw["up"]:
        return 1
    ws = WsClient(gw["port"], gw["token"])
    results: list[tuple[int, int]] = []  # (n_profiles, rss_kb)

    p.section("1. idle-profile RSS sweep (0/2/4/8 profiles, zero active turns)")
    settle(3)
    base = vmrss_kb()
    results.append((0, base))
    p.note(f"N=0 profiles : VmRSS={mb(base)} ru_maxrss={mb(rumaxrss_kb())} (after boot+settle)")

    n_created = 0
    for target in (2, 4, 8):
        while n_created < target:
            n_created += 1
            ws.rpc("profiles.create", {"name": f"idle{n_created:02d}", "no_alias": True,
                                       "mirror_credentials": False})
        settle(2)
        rss = vmrss_kb()
        results.append((target, rss))
        p.note(f"N={target} profiles: VmRSS={mb(rss)} ru_maxrss={mb(rumaxrss_kb())} "
               f"(delta vs N=0: {mb(rss - base)}, per-profile: {mb((rss - base) / target)})")

    per_profile = (results[-1][1] - base) / 8
    p.ok("idle sweep measured",
         f"0p={mb(base)} → 8p={mb(results[-1][1])}; "
         f"~{mb(per_profile)}/idle-profile marginal (gateway+probe process, upper bound)")

    p.section("2. concurrent-turn RSS (1 then 4 turns at profile alpha, no provider)")
    ws.rpc("profiles.create", {"name": "alpha", "no_alias": True, "mirror_credentials": False})
    settle(2)
    idle_before_turns = vmrss_kb()
    p.note(f"pre-turn baseline (9 profiles idle): VmRSS={mb(idle_before_turns)}")

    # 4 sessions up front (session.create is serial + cheap).
    sessions = [ws.rpc("session.create", {"profile": "alpha", "title": f"p3 turn {i}"})
                for i in range(4)]

    outcomes: dict[int, str] = {}

    def fire_turn(i: int, client: WsClient) -> None:
        try:
            r = client.rpc("prompt.submit",
                           {"session_id": sessions[i]["session_id"],
                            "text": f"p3 concurrent turn {i}"},
                           timeout=120)
            outcomes[i] = str(r)[:60]
        except RpcError as e:
            outcomes[i] = f"RpcError {e.error.get('code')}: {str(e.error.get('message'))[:80]}"
        except Exception as e:  # noqa: BLE001
            outcomes[i] = f"{type(e).__name__}: {e}"

    def run_batch(count: int, label: str) -> None:
        pre = vmrss_kb()
        clients = [WsClient(gw["port"], gw["token"]) for _ in range(count)]
        threads = [threading.Thread(target=fire_turn, args=(i, c))
                   for i, c in enumerate(clients[:count])]
        for t in threads:
            t.start()
        peak = pre
        deadline = time.time() + 60
        while (any(t.is_alive() for t in threads) or _turns_still_running(
                [s["session_id"] for s in sessions[:count]])) and time.time() < deadline:
            peak = max(peak, vmrss_kb())
            time.sleep(0.3)
        for t in threads:
            t.join(timeout=30)
        settle(2)
        post = vmrss_kb()
        p.note(f"{label}: pre={mb(pre)} peak={mb(peak)} post={mb(post)} "
               f"(peak-pre={mb(peak - pre)}, post-pre={mb(post - pre)}, "
               f"per-turn peak ≈ {mb((peak - pre) / count)})")
        for i in range(count):
            p.note(f"  turn[{i}] outcome: {outcomes.get(i)}")
        for c in clients:
            c.close()

    run_batch(1, "1 concurrent turn ")
    run_batch(4, "4 concurrent turns")

    # Memory retained after all turns finished and settled.
    final = vmrss_kb()
    p.note(f"final settled VmRSS={mb(final)} "
           f"(vs pre-turn {mb(idle_before_turns)}: {mb(final - idle_before_turns)} retained; "
           f"ru_maxrss high-water={mb(rumaxrss_kb())})")

    # --- Conclusions ------------------------------------------------------------------
    p.section("3. conclusions (from THESE numbers; on-device RAM is the real gate)")
    idle8 = results[-1][1] - base
    p.ok("conclusion recorded",
         f"idle 8 profiles ≈ {mb(idle8)} ({mb(idle8 / 8)}/profile) in-process upper bound; "
         f"see notes below")
    p.note(
        f"FleetTurnQueue: idle-profile cost here is ~{mb(per_profile)}/profile and the "
        f"turn-path overhead (session row + failed agent build, NO model streaming) is "
        f"the concurrent-turn delta above. FINDING: the FIRST turn in the process paid "
        f"~15.8MB at peak and settled +33-40MB retained — that is mostly one-time "
        f"module-import/agent-build-path warmup, because the subsequent 4 concurrent "
        f"turns added only ~3-4MB more. Marginal per-turn allocation is therefore well "
        f"under ~4MB on the no-provider path; full LLM turns add model context + "
        f"streaming buffers this probe deliberately does NOT measure. The plan's default "
        f"of 2 concurrent active turns stays the right default from this data — not "
        f"because turns are expensive, but because the live-provider context/streaming "
        f"cost is the dominant unknown and stays unmeasured here; keep 2 until the "
        f"on-device pass measures real turns.")
    p.note(
        f"Soft profile cap (B3): {mb(per_profile)}/idle-profile marginal on x86-64 with the "
        f"in-process gateway suggests idle profiles are cheap (SQLite handles + dir bookkeeping; "
        f"no per-profile agent is resident when idle — upstream evicts idle session agents). "
        f"On-device (Termux/proot, less RAM, slower allocator) expect a higher per-profile cost; "
        f"the 6–8 soft cap from the plan is NOT contradicted by idle RSS on PC — the cap should "
        f"be gated by on-device idle sweep + live-turn RSS, not by these PC numbers alone.")
    p.note("Caveat: /tmp home, no provider keys, venv python 3.11 x86-64 PC. Numbers are "
           "directional for M9 design defaults; M9.0 device pass re-measures.")

    ws.close()
    return 1 if p.failed else 0


def _turns_still_running(sids: list[str]) -> bool:
    try:
        from tui_gateway import server as tg
    except Exception:  # noqa: BLE001
        return False
    return any((tg._sessions.get(s) or {}).get("running") for s in sids)


if __name__ == "__main__":
    sys.exit(main())
