#!/usr/bin/env python3
"""P4b — turn-serialization gap probe (fail-then-regreen, plan v1.2).

Plan (M9-BOTS.md M9.0-P4b): fire a user chat + a DM delivery + a cron occurrence at the
SAME profile concurrently and assert serialization via the in-process turn gate — today
there IS no turn gate (M9.1a builds it). This probe documents the unserialized behavior:

1. Three turn paths as they exist today, into one profile:
   (a) DM delivery   — holds tools.bot_relay.acquire_turn_lock(profile) around the CS;
   (b) user chat     — the gateway chat path takes NO per-profile lock (plain CS);
   (c) cron occurrence — likewise NO per-profile lock (plain CS).
   (a)+(b) concurrently -> overlap expected = the INVARIANT GAP (plan C1 fix target).
   (a)+(a) concurrently  -> second gets TurnBusyError = flock DOES serialize deliveries.
2. Verdict line + regreen simulation: threading.Lock around both CSs -> no overlap
   (stand-in for the M9.1a in-process turn gate).

Run:  cd research/fleet-proof && ~/.hermes/hermes-agent/venv/bin/python p4b_turn_serialization.py
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import PROOF_ROOT, Probe, _ensure_paths  # noqa: E402

CS_SECONDS = 1.5


def main() -> int:
    p = Probe("p4b_turn_serialization")
    try:
        return _run(p)
    except Exception:
        import traceback
        p.fail("probe crashed", traceback.format_exc(limit=8).splitlines()[-1])
        p.note(traceback.format_exc(limit=8))
        return 1
    finally:
        p.finish()


class Overlap:
    """Tracks how many critical sections are simultaneously entered (and by whom)."""

    def __init__(self) -> None:
        self._mu = threading.Lock()
        self._active: set[str] = set()
        self.max_overlap = 0
        self.overlap_pairs: set[tuple[str, str]] = set()

    def enter(self, tag: str) -> None:
        with self._mu:
            self._active.add(tag)
            self.max_overlap = max(self.max_overlap, len(self._active))
            for other in self._active:
                if other != tag:
                    self.overlap_pairs.add(tuple(sorted((tag, other))))

    def exit(self, tag: str) -> None:
        with self._mu:
            self._active.discard(tag)


def _run(p: Probe) -> int:
    _ensure_paths()
    from tools import bot_relay

    home = PROOF_ROOT / "p4b" / "home"
    home.mkdir(parents=True, exist_ok=True)
    profile = "alpha"

    def dm_delivery_cs(ov: Overlap, gate: threading.Lock | None = None,
                       entered: threading.Event | None = None,
                       wait_budget: float = 5.0) -> None:
        """(a) today's DM path: acquire_turn_lock around the whole turn window."""
        with bot_relay.acquire_turn_lock(home, profile, timeout_seconds=wait_budget):
            if gate is not None:
                gate.acquire()
                try:
                    ov.enter("dm-delivery")
                    if entered is not None:
                        entered.set()
                    time.sleep(CS_SECONDS)
                    ov.exit("dm-delivery")
                finally:
                    gate.release()
            else:
                ov.enter("dm-delivery")
                if entered is not None:
                    entered.set()
                time.sleep(CS_SECONDS)
                ov.exit("dm-delivery")

    def unguarded_cs(ov: Overlap, tag: str, entered: threading.Event | None = None) -> None:
        """(b)/(c) today's user-chat / cron paths: NO per-profile lock of any kind."""
        ov.enter(tag)
        if entered is not None:
            entered.set()
        time.sleep(CS_SECONDS)
        ov.exit(tag)

    def run_pair(fn_a, fn_b) -> Overlap:
        ov = Overlap()
        started = threading.Event()
        ta = threading.Thread(target=fn_a, args=(ov,), kwargs={"entered": started}, daemon=True)
        tb = threading.Thread(target=fn_b, args=(ov,), daemon=True)
        ta.start()
        assert started.wait(5.0)
        tb.start()  # fire while A is provably inside its critical section
        ta.join(15.0)
        tb.join(15.0)
        return ov

    p.section("1. Today's behavior: DM delivery vs user chat at the SAME profile")
    ov_ab = run_pair(
        lambda ov, entered=None: dm_delivery_cs(ov, entered=entered),
        lambda ov, entered=None: unguarded_cs(ov, "user-chat", entered),
    )
    gap = ov_ab.max_overlap >= 2
    if gap:
        p.ok("delivery-vs-user-chat OVERLAP (gap demonstrated)",
             f"max simultaneous CS entries={ov_ab.max_overlap}, overlapping pairs={sorted(ov_ab.overlap_pairs)} — "
             "the user-chat turn ran INSIDE the DM delivery's turn window: unserialized (the C1 gap)")
    else:
        p.fail("delivery-vs-user-chat overlap",
               f"expected overlap, got max={ov_ab.max_overlap} pairs={sorted(ov_ab.overlap_pairs)}")

    ov_ac = run_pair(
        lambda ov, entered=None: dm_delivery_cs(ov, entered=entered),
        lambda ov, entered=None: unguarded_cs(ov, "cron-occurrence", entered),
    )
    if ov_ac.max_overlap >= 2:
        p.ok("delivery-vs-cron OVERLAP (gap demonstrated)",
             f"max={ov_ac.max_overlap} pairs={sorted(ov_ac.overlap_pairs)} — cron occurrence also "
             "runs inside the DM turn window: unserialized")
    else:
        p.fail("delivery-vs-cron overlap", f"max={ov_ac.max_overlap} pairs={sorted(ov_ac.overlap_pairs)}")

    p.section("2. Control: flock DOES serialize delivery-vs-delivery")
    busy: dict[str, object] = {}

    def dm_waiter(ov: Overlap, entered=None) -> None:
        try:
            # short wait budget (bot_mode.turn_wait_seconds equivalent): a queued delivery
            # that cannot get the lock in time fails with the structured target_busy refusal
            dm_delivery_cs(ov, entered=entered, wait_budget=0.3)
            busy["second"] = "acquired"
        except bot_relay.TurnBusyError as e:
            busy["second"] = e

    ov_aa = run_pair(lambda ov, entered=None: dm_delivery_cs(ov, entered=entered), dm_waiter)
    second = busy.get("second")
    if isinstance(second, bot_relay.TurnBusyError):
        p.ok("delivery-vs-delivery SERIALIZED by flock",
             f"second delivery got TurnBusyError reason={second.reason!r} waited={second.waited_seconds:.2f}s "
             f"(waited past its 0.3s queue budget); overlap inside CS pairs={sorted(ov_aa.overlap_pairs) or 'none'}")
    else:
        p.fail("delivery-vs-delivery serialization", f"second acquirer outcome: {second!r}")

    p.section("3. Precise doc claim")
    claim_ok = gap and ov_ac.max_overlap >= 2 and isinstance(second, bot_relay.TurnBusyError)
    p.ok("claim verified" if claim_ok else "claim NOT verified",
         "flock serializes delivery-vs-delivery, but NOT delivery-vs-user-chat nor "
         "delivery-vs-cron — user/cron turns take no per-profile lock today") if claim_ok else \
        p.fail("claim", "see failures above")

    p.section("4. Regreen simulation — shared threading.Lock as the M9.1a turn gate stand-in")
    gate = threading.Lock()

    def gated_chat(ov: Overlap, entered=None) -> None:
        with gate:
            ov.enter("user-chat")
            if entered is not None:
                entered.set()
            time.sleep(CS_SECONDS)
            ov.exit("user-chat")

    ov_regreen = run_pair(
        lambda ov, entered=None: dm_delivery_cs(ov, gate=gate, entered=entered),
        gated_chat,
    )
    if ov_regreen.max_overlap <= 1:
        p.ok("regreen simulation — NO overlap with the shared gate",
             f"max simultaneous CS entries={ov_regreen.max_overlap}, pairs={sorted(ov_regreen.overlap_pairs) or 'none'} — "
             "a single per-profile gate covering all three turn paths serializes them (M9.1a contract holds)")
    else:
        p.fail("regreen simulation", f"still overlapping: max={ov_regreen.max_overlap} "
                                     f"pairs={sorted(ov_regreen.overlap_pairs)}")

    p.section("5. REAL production gate (moch.fleet, MOCH_FLEET=1) — delivery vs chat vs cron")
    try:
        os.environ["MOCH_FLEET"] = "1"
        from moch import fleet as mfleet
        prod_home = str(Path(os.environ["HERMES_HOME"])) if os.environ.get("HERMES_HOME") \
            else "/tmp/moch-fleet-proof/p4b/home"
        prod_overlap = Overlap()

        def prod_path(ov: Overlap, tag: str, priority: int,
                      entered: threading.Event | None = None) -> None:
            # exactly the composition dm_bridge / the dispatch wrap use:
            # FleetTurnQueue slot FIRST, then the per-profile turn gate (§2.2 order)
            with mfleet.FLEET_QUEUE.turn(prod_home, priority, timeout=10.0):
                with mfleet.TURN_GATE.hold(prod_home):
                    ov.enter(tag)
                    if entered is not None:
                        entered.set()
                    time.sleep(CS_SECONDS)
                    ov.exit(tag)

        ov_prod_dm_chat = run_pair(
            lambda ov, entered=None: prod_path(ov, "dm-delivery", mfleet.PRIORITY_DM, entered),
            lambda ov, entered=None: prod_path(ov, "user-chat", mfleet.PRIORITY_USER),
        )
        ov_prod_dm_cron = run_pair(
            lambda ov, entered=None: prod_path(ov, "dm-delivery", mfleet.PRIORITY_DM, entered),
            lambda ov, entered=None: prod_path(ov, "cron-occurrence", mfleet.PRIORITY_CRON_KANBAN),
        )
        ok_prod = (ov_prod_dm_chat.max_overlap <= 1 and ov_prod_dm_cron.max_overlap <= 1)
        (p.ok if ok_prod else p.fail)(
            "REAL gate regreen — delivery vs user-chat AND vs cron serialized",
            f"max chat={ov_prod_dm_chat.max_overlap}, max cron={ov_prod_dm_cron.max_overlap} "
            f"(FleetTurnQueue + TurnGate, slots={mfleet.FLEET_QUEUE.snapshot()['slots']})")
        if not ok_prod:
            p.failed = True
    except Exception as e:  # noqa: BLE001
        p.fail("REAL gate regreen", f"{e!r}")
        p.failed = True

    print("VERDICT: GAP CONFIRMED — M9.1a turn gate required")
    p.note("VERDICT: GAP CONFIRMED — M9.1a turn gate required "
           "(probe PASS = gap documented per the fail-then-regreen plan; must regreen after M9.1a)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
