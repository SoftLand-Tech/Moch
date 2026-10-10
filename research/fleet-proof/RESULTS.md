# M9.0 Fleet probes — PC results (2026-10-10)

**Verdict: 6/6 PASS** (P4b passes by documenting the expected gap — fail-then-regreen
per plan; must regreen after M9.1a lands). Environment: x86-64 PC, app venv
(python 3.11.16), in-process embedded gateway per `moch.gateway_server` pattern,
throwaway `HERMES_HOME` under `/tmp/moch-fleet-proof/`, no provider keys (turns fail
at the model call by design). Raw evidence: `results/<tag>.txt` (regenerate any time —
`run_all.sh`).

| Probe | Verdict | One-line result |
|---|---|---|
| P1 `p1_profiles_create.py` | PASS | `profiles.create` (no_alias + SOUL) over live WS; dir appears; `profiles.list` re-enumerates without restart; `profiles_to_serve(multiplex=True)` = default+alpha+beta; `multiplex=False` control gateway (subprocess) behaves |
| P2 `p2_profile_scoping.py` | PASS | `session.create{profile:"alpha"}` → session row in `profiles/alpha/state.db` (default home stays empty); unscoped secret read **raises UnscopedSecretError** under multiplex; launch scope still resolves its own `.env` |
| P3 `p3_ram.py` | PASS | idle 0/2/4/8 profiles: 136.3→136.6 MB (**~0.0 MB/idle profile**); first turn +15.8 MB peak (one-time warmup, +33–40 MB retained); next 4 concurrent turns **~1.1 MB/turn marginal**; FleetTurnQueue default 2 kept |
| P4 `p4_flock_kanban.py` | PASS | flock contends cross-thread (`TurnBusyError target_busy`); fresh `os.open` per acquisition; kanban board+task+claim on probe storage; `dispatch_once` with injected `spawn_fn` (synthetic pid −12345) transitions task→running with `subprocess.Popen` poisoned-never-called; pid≤0 exit-record guard verified |
| P4b `p4b_turn_serialization.py` | PASS (gap) | delivery-vs-delivery serialized by flock (control); delivery-vs-user-chat and delivery-vs-cron **overlap (max 2 in CS)** — GAP CONFIRMED, M9.1a turn gate required; regreen simulation with a shared gate → no overlap |
| P4c `p4c_session_lease.py` | PASS (finding) | in-process DM into live Bot Chat is **QUEUED, never refused**: LIVE+IDLE submits immediately; LIVE+RUNNING queues as next turn (`prompt.submit(queued=True)` → `_handle_busy_submit`); no machine-readable busy refusal exists on that branch |

## Code findings that amend plan assumptions

1. **P1 — no hot-notify listener in the embedded gateway.** `live_default_gateway_pid()`
   and `recorded_served_profiles()` are both None for an embedded (headless) gateway:
   the served-set runtime record and `_notify_multiplexer` hot-serve are desktop-shell
   mechanisms. Multiplex pickup on-device rides the cron ticker's per-cycle
   re-enumeration (`web_server.py` InProcessCronScheduler `profile_homes` lambda →
   `profiles_to_serve(multiplex=True)`), which P1 §2–4 prove picks up new profiles
   without restart. Matches the plan's v1.1 fix (config gate + P1 probe).
2. **P2 — turn scoping enters through `session.create{profile}`, not `prompt.submit`.**
   `prompt.submit` takes only `{session_id, text}` and re-binds scope from the session's
   stored `profile_home`; `session.create` accepts `params['profile']`
   (methods_session.py → server.py `_profile_home`). RN client already matches this
   pattern. Also: `prompt.submit` returns `{"status":"streaming"}` even with no
   provider — failures land in the turn stream, not the RPC result.
3. **P3 — idle profiles are ~free on PC; the 6–8 soft cap is an on-device question.**
   Marginal idle cost ~0.0 MB/profile (upstream evicts idle agents). Turn-path overhead
   (session + failed agent build, no model streaming) is ~1 MB/turn marginal after a
   one-time ~34–40 MB warmup. The FleetTurnQueue default of 2 stays (live-provider
   context/streaming is the dominant unmeasured unknown); the soft profile cap must be
   set by the on-device idle + live-turn sweep, not PC numbers.
4. **P4c — the M9.1a dm_bridge must add its own lease/busy check.** The in-process
   live-session branch of DM delivery always accepts (queueing via `queued=True`);
   `SESSION_NOT_OWNED`/`target_busy` refusals only exist on the subprocess transport
   path. If M9 wants a machine-readable "busy, queued at position N" (the plan's
   session-lease check), dm_bridge implements it against `server._sessions` liveness +
   the `queued_prompt` envelope — upstream gives no refusal to reuse here.
5. **P4 — the M9.1b synthetic-pid shape is confirmed safe**: `dispatch_once` accepts an
   injectable `spawn_fn`; a negative synthetic pid is a no-op in the exit registry
   (pid≤0 guard); the pass never touches `subprocess.Popen`.

## M9.1a stage-1 addendum (2026-10-10, later)

`moch/fleet.py` + `app/python-runtime/tests/test_fleet.py` landed (17/17 unit tests OK;
test_terminal/test_linux_exec regressions still green):

- **TurnGate** (process-global per-profile RLock registry, 30s bounded), **FleetTurnQueue**
  (priority classes, FIFO within class, depth cap → `fleet_busy`, snapshot), **freeze**
  (persisted), **BudgetLedger** (fleet-level SQLite; admission check separate from
  completion-time record — the check does not accumulate, usage records at model-call
  completion), `admission_check` + `install_dispatch_gate`.
- `gateway_server.py` installs the gate flag-gated (MOCH_FLEET=1).
- **P4b regreened against the REAL gate**: delivery-vs-user-chat and delivery-vs-cron
  both serialize (max overlap 1, slots=2) — `results/p4b_turn_serialization.txt`
  section 5.
- **Flag-off contract proven live**: without MOCH_FLEET, the gateway boots with dispatch
  unwrapped and fully functional (`p4b_flagoff_smoke`).
- Stage-2 (next): dm_bridge + spawn_bot + audit jsonl + `moch.*` RPC layer — the
  moch-side turn paths hold the same gate across their whole turn and wait out live
  chat sessions (P4c composition contract).
