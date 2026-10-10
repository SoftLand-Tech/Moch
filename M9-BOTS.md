# Milestone 9 — Bots: persistent agents, their own computers, and a working fleet

Status: **PLAN (v1.2, 2026-10-10) — not started. v1.1 folded in the five-agent review;
v1.2 repairs verification-round findings. Change log at the bottom.** Written by an agent
session for Mamoun to review. Continues the M1–M8 embedded arc as M9. Nothing here is implemented yet; every
claim about existing code was verified against this repo on 2026-10-10 (file:line refs
throughout). Companion reading: `PROJECT.md`, `embedded/MILESTONE-8.md`,
`app/hermes-src/plugins/platforms/a2a/DESIGN.md`.

---

## 0. The ask, in one paragraph

Five competitor features, verbatim from Mamoun:

1. **Persistent AI agents** — named bots with specific jobs; they remember preferences,
   files, browser sessions, and context across conversations.
2. **A computer of their own** — each bot works on a persistent computer with a browser,
   filesystem, and terminal; it keeps working when the phone/laptop is closed.
3. **Multiple bots working together** — parallel tasks, shared context, messaging between
   bots, handoffs — and *bots can create their own sub-bots* (the explicitly requested
   headline).
4. **Automation and reusable skills** — demonstrate a workflow once, save it as a skill,
   run it on a schedule; bots can use connected tools and websites.
5. **Chat, voice, and approvals** — instruct by message or voice; progress reports;
   drafts prepared for approval before anything is sent.

Moch's position is different from those competitors: the agent is **yours** and runs
**on your hardware** (embedded in the APK, or linked to machines you own) with no vendor
cloud in the path. M9 should deliver the same *shape* of capability on that architecture —
and where a competitor fakes persistence with a rented VM, Moch can be honest: your bot's
computer is your phone (Moch Linux), your PC, or your VPS.

---

## 1. Research

> Note on sourcing: live web search was unavailable in this session (no search API key
> configured), so §1.1 is an analysis of the feature *category* from the descriptions plus
> general product knowledge, deliberately kept short. The load-bearing research is §1.2–§1.4:
> primary-sourced from this repository, in the same spirit as the browser research files in
> `research/`.

### 1.1 What the competitor features really are (category analysis)

Every "bot with a computer" product on the market is some combination of five primitive
systems, and the differences between products are almost entirely *policy*, not magic:

| Competitor feature | What it actually is under the hood | Hard parts |
|---|---|---|
| Named persistent bots | An agent identity record (persona/system prompt, memory, credentials, permissions) + sessions keyed to it | Memory that survives context limits; identity that survives restarts |
| A computer of their own | A per-agent sandbox (usually a shared VM host with per-agent users/containers), plus a session layer (browser profile, shell, files) that outlives any single conversation | Cost per agent; "keep working when client is closed" = a server-side scheduler, not the agent |
| Multi-bot collaboration | A message bus between agent identities + a durable work queue + a supervisor that spawns/bounds children | Preventing loop storms; cost control; observability of who-did-what |
| Skills & schedules | A skill = a packaged procedure (instructions, sometimes scripts) the model can load on demand; a scheduler attaches skills to timed runs | Authoring UX (recording a workflow is much easier than writing prose); scope/sharing |
| Chat/voice/approvals | Transport + an approval gate between "agent wants to act" and "action leaves the system" | Latency of the approval loop; not nagging the user to death |

The takeaway that shapes this whole plan: **the valuable, defensible part is the policy and
the observability, not the primitives** — and on the primitives, hermes upstream is already
most of the way there (next section). What competitors sell that Moch genuinely lacks is a
*fleet surface* (UI + runtime policy for N agents on one device). That is the work.

### 1.2 The big finding: hermes already ships the fleet primitives

This changes the shape of M9 from "build multi-agent" to "surface and adapt what's
vendored". Everything below is in `app/hermes-src/` (vendored, pinned via `VENDOR.json`):

| Primitive | Where (verified) | What it gives M9 |
|---|---|---|
| **Profiles = named agents** | `hermes_cli/profiles.py` | A profile is a full isolated HERMES_HOME: own `config.yaml`, `.env` (its own provider keys), `SOUL.md` (**the persona/job description file**), `memories/MEMORY.md` + `USER.md`, `skills/`, `cron/`, `sessions/`, `workspace/`, `home/`. Name pattern `^[a-z0-9][a-z0-9_-]{0,63}$`. Clone copies SOUL.md + memory files — i.e. "duplicate this bot". |
| **The gateway already multiplexes** | `hermes_cli/profiles.py:844 profiles_to_serve(multiplex=True)` = default + every live profile; `hermes_cli/web_server.py:101–108` is the cron ticker's enumeration of that set — actual multiplex HTTP serving is gated on the `gateway.multiplex_profiles` config — upstream DEFAULTS this to true; an unset/absent setting triggers migration preflight and the gateway stays standalone only when a blocker exists (gateway.py:1516 covers that path). The embedded gateway sets it explicitly; M9.0-P1 verifies *(v1.2)* | Boot the embedded gateway with `gateway.multiplex_profiles` set, create a profile dir, and the gateway picks it up (supervision re-enumerates when a profile dir appears — `cron/AGENTS.md`). The embedded gateway must set that config flag (M9.0-P1 tests this). No new serving machinery needed. *(v1.1)* |
| **Per-RPC profile addressing** | `tui_gateway/server.py` — `_profile_db(params)` reads `params['profile']`; turns run under `set_hermes_home_override` + that profile's secret scope (server.py:945) | The RN app can talk to any bot on the existing socket by passing `profile` in RPC params. Per-profile `state.db` handles are fail-closed (no cross-profile bleeding). |
| **Bot management RPC door** | `tui_gateway/methods_profiles.py` — `profiles.list / create / describe / configure / set_asset / get_asset / remember_onboarding` | `profiles.create` is **pure Python** (no subprocess): creates dirs, seeds bundled skills, writes `SOUL.md`, pins model/provider, mirrors credentials. Runs on-device today. |
| **Bot-to-bot DM** | `tools/bot_mode_dm.py` (`message_agent` tool, **16,000-char** body cap — `MESSAGE_MAX_CHARS`, bot_mode_dm.py:43 — per-profile attribution prefixes); `tools/bot_relay.py` (per-profile **flock** turn locks — the flock serializes *delivery* turns; interactive-turn exclusion is session-lease based via `SESSION_NOT_OWNED`, bot_mode_dm.py:434–446 — envelope outboxes, stale sweeps); `tui_gateway/methods_bot_relay.py` (`roster.sync / outbox.drain / deliver / reply`) | The messaging model exists: profile→profile DM with a canonical "Bot Chat" session per bot, plus a cross-connection relay (desktop) we can reuse for phone↔PC fleets. *(v1.1)* |
| **Sub-agents today** | `tools/delegate_tool.py` (`delegate_task`, sync + background), `tools/async_delegation.py` (daemon executor, completion queue, durable ledger, delivery retry, replay-age caps) | A parent bot can already dispatch children **in-process on threads** — which is exactly the only kind of parallelism Android allows. |
| **Durable crew queue** | `hermes_cli/kanban*.py` (14 siblings) + `tools/kanban_tools.py` + in-gateway dispatcher (`kanban.dispatch_in_gateway: true` default) | SQLite-backed board: claims, heartbeats, failure circuit-breakers (`failure_limit`), terminal exit codes (78 = provider dead — defined in `kanban_db.py:311`; dispatch imports it), notify-through-owning-profile. This is the "hand work off" substrate. |
| **Agent-to-agent protocol** | `plugins/platforms/a2a/` (full A2A v1.0 JSON-RPC: Agent Card, tasks, push notifications, HMAC-signed callbacks) with security on by default: localhost bind, per-peer tokens, injection defanging, outbound redaction, rate limits, **anti-ping-pong turn caps** (`A2A_MAX_PINGPONG_TURNS`), audit jsonl | Cross-machine bot collaboration (phone bot ⇄ PC bot) with a real protocol, plus a security template to copy for intra-fleet DMs. |
| **Automation engine** | `cron/jobs.py` + `scheduler*.py`: per-job `skills`, `model`/`provider` overrides, pre-run `script`, `context_from` (chain A's output into B), `workdir`, multi-platform delivery; hardening invariants documented in `cron/AGENTS.md` (at-most-once occurrences, per-home tick locks, inactivity watchdogs) | "Run this skill on a schedule" is a config field, not a feature. The phone already arms the ticker (`HERMES_DESKTOP=1`) and already has knocks. |
| **Memory** | Per-profile `memories/MEMORY.md` + `USER.md`; plugin providers (mem0, honcho, supermemory, hindsight, …) keyed per home; profile-lifecycle hooks fire under the owning profile's scope | Persistent preferences/context per bot, isolated per bot. |
| **Approvals** | `tools/approval*.py` (floors, smart approval, gateway wait, human wait), interactive approval cards already in the Moch client | The gate between "bot decided" and "bot acted" exists end-to-end for chat; M9 extends it to fleet actions. |

**Also relevant:** shared profile UI metadata with a lock (`tui_gateway/server.py:96–98`) —
Desktop, mobile, and pool RPCs already coordinate bot metadata; `cron/notepad.py` (a shared
notepad primitive); `cron/quota_hold.py` (quota-aware holding); `tools/bot_mode_probe.py`
(the roster of profiles on an install).

### 1.3 What Moch already has on the device (the platform facts M9 must live inside)

From `app/python-runtime/moch/` and the milestone docs:

- **One embedded gateway, in-process** (`gateway_server.py`): hermes `start_server`
  headless on `127.0.0.1:9119`; the RN client speaks the same v7 JSON-RPC it used over the
  relay. Single `HERMES_HOME` today = `files/.hermes`.
- **No child interpreters**: hermes' subprocess spawns are replaced on-device by
  `InProcessSlashWorker` (`slash_worker_bridge.py`); the child-VM route is dead on Android
  (dalvik-cache permission), documented since M5.
- **Automations + knocks**: the in-process cron ticker arms under `HERMES_DESKTOP=1`;
  `cron_knocks.py` watches `cron/executions.db` in-process and raises push notifications
  that land even when the app is killed (M7).
- **Moch Linux (M7.5/M8)**: ONE Ubuntu 24.04 rootfs under proot at `<home>/linux/rootfs`,
  shared by everything; exec is legal only via the APK-native proot loader +
  `/system/bin/sh` trampoline; background guest processes survive across tool calls;
  verified on device at targetSdk 36.
- **Terminal** (`moch/terminal.py`): persistent guest bash sessions.
- **Browser (feat/browser)**: Kotlin CDP relay → WebView pool; the agent attaches to the
  ACTIVE tab; per-tab lifecycle is RN-owned (`BUILD-PLAN.md`, `FEATURE-BROWSER.md`).
- **Foreground service** (M6, mediaPlayback type) keeps the runtime alive; **known cap**:
  Android 15+ `dataSync`-class FGS gets ~6 h per boot before `onTimeout()` (M8 accepted
  limitation; `restartApp()` is the current band-aid).
- **Client screens today**: `agent, automations, browser, chat, connectors, sessions,
  settings, skills, terminal` (+ voice STT/TTS via gateway in `src/lib/voice.ts`, approval
  cards in chat, offline outbox/replay). **The app never sends `profile` params and has no
  fleet UI** — that surface is greenfield.

### 1.4 Gap analysis — competitor feature → what exists → what M9 must add

| # | Competitor feature | Exists upstream/in-repo | The actual gap (M9 work) |
|---|---|---|---|
| 1 | Named persistent bots | Profiles + SOUL.md + per-profile memory/sessions + `profiles.*` RPC | **Fleet UI** (create/name/author bots), bot-scoped chats in the app (`profile` param plumbed through session calls), avatar/metadata |
| 2 | A computer of their own | Moch Linux guest, terminal sessions, browser relay, workspace per profile dir, linked machines | Per-bot workspace/terminal/browser **binding**, per-bot linked-machine routing, "keep working" policy (FGS limits, knocks) |
| 3 | Multi-bot + sub-bots | `message_agent`, bot_relay, kanban, `delegate_task`, A2A | **In-process transports for Android** (upstream DM + kanban dispatch spawn subprocesses — dead on-device, see B4), sub-bot spawning tool + budgets + kill switch, **run graph / fleet observability UI** |
| 4 | Skills & schedules | Per-profile `skills/`, cron jobs with `skills`, `skills.tsx` screen, connectors | **Teach-a-skill flow** (record a run → draft SKILL.md → approve → reuse), fleet-shared skill library, scheduling UX on the existing automations screen |
| 5 | Chat/voice/approvals | Chat + cards + voice + approval floors + knocks | Bot-aware voice routing, **approval inbox** across bots, approval-carrying knocks, drafts-before-send policy surface |

---

## 2. Design

### 2.1 Concepts and data model

- **Bot** := a hermes **profile** (`profiles/<name>/` with SOUL.md, .env, config.yaml,
  memory, skills, cron, workspace) **+ Moch-side metadata** (display name, avatar/color,
  one-line job, emoji-free icon, autonomy level, computer binding). Metadata rides the
  existing shared profile-UI-metadata store (`server.py` profile_ui_meta) — not a parallel
  database.
  - `SOUL.md` is the job description. The create flow should *generate a SOUL.md draft
    from a plain-language job description* (one cheap LLM call, user-editable) so authoring
    a bot feels like hiring, not configuring.
  - Autonomy levels map to the existing approval floors: `ask-first` (all side-effecting
    tools gated), `supervised` (default; approvals for outbound/dangerous), `autonomous`
    (gates off, budget caps on).
  - Deletion = tombstone + cascade contract: scheduled jobs auto-paused, open board tasks
    offered for reassignment (default: back to the launch profile), running children
    frozen at boundary, DM outbox drained/discarded, library skills retained with author
    marked deleted. *(v1.1)* The default profile ("Moch") is **undeletable**; its wizard
    slot is replaced by **Reset** (tombstone-free reset via existing profile machinery).
    Every cascade default that points "back to the launch profile" asserts the launch
    profile exists *(v1.2)*. Spawned-bot tombstones GC after 7 days; user-deleted
    tombstones are retained + counted in the storage meter with purge *(v1.2)*.
- **Computer** := a binding on a bot: `phone` (the embedded runtime + Moch Linux), or
  `machine:<pairing>` (a linked computer via the existing relay/moch-link path), or
  `peer:<a2a>` (a remote agent; the bot *talks to* that machine rather than running on it).
  A phone-bound bot's files live at `<profile>/workspace`; a machine-bound bot's turns are
  routed to that machine's gateway with the profile name — the same profile dir concept
  exists there, so memory and SOUL travel by sync (M9 ships a manual "push bot to machine"
  via the existing clone/archive tooling; live sync is v2).
  - Migration semantics: "push bot to machine" is **move-not-copy** — source schedules
    disabled and board claims marked migrated on successful push; a copy remains available
    explicitly as "duplicate". *(v1.1)* A migrated bot keeps a roster tombstone; DMs to
    it return a structured "migrated to machine X" refusal the sending bot can read
    *(v1.2)*.
- **Fleet** := every profile on the install (default profile = "Moch" itself, the current
  single-bot experience — it does not disappear).
- **Run** := any unit of bot activity (chat turn, cron occurrence, delegation, kanban
  task, DM delivery). The run ledger is the observability spine: `async_delegation`'s
  durable ledger, cron's executions DB, and kanban's board are merged read-side into one
  timeline (no new source of truth — a view, not a store).
  - Interrupted ≠ failed: runs cut by OTA/process death are recorded "interrupted by
    update", never "failed". *(v1.1)*

### 2.2 How N bots run on one phone (runtime design)

- **One process, N homes.** The embedded gateway already serves
  `profiles_to_serve(multiplex=True)`. Turns are executed per-RPC under the target
  profile's home override + secret scope + terminal scope (upstream invariants — M9 must
  not weaken any of them; `launch_profile_policy.py` documents why: unscoped secret reads
  silently borrow the launch profile's env once multiplexing is active).
- **Concurrency = threads, capped — FleetTurnQueue.** Android gives us no exec and one
  GIL: "parallel bots" means interleaved I/O-bound turns (which is what LLM agents mostly
  are: waiting on model streams and tools) plus background guest processes for CPU work.
  M9 adds a **FleetTurnQueue** in `moch/fleet.py` — the single choke-point admission
  helper every turn entry point must acquire: interactive chat RPC, DM bridge delivery,
  kanban worker turn, cron occurrence, delegate child targeting another profile, A2A
  inbound *(v1.1)*. Default 2 concurrent active turns on-device (configurable; M9.0 RAM
  probe sets it) so five bots waking at once can't exhaust RAM. Priority classes: user
  interactive > approval-unblocking > cron/kanban > DM delivery > spawned-bot; FIFO
  within class *(v1.1)*. A delegate child whose parent turn is user-interactive enters
  at approval-unblocking priority; children of background parents stay spawned-bot
  class *(v1.2)* (delegate admission rule: own queue entry, 30 s bounded wait, below). Queue state is introspectable and feeds the Fleet screen
  ("waiting" list). Overflow = structured `fleet_busy` refusal mirroring upstream
  `target_busy` *(v1.1)*. Long/CPU-heavy jobs should be *assigned to machine-bound
  bots* — that is the honest answer to "parallel", and it reuses linked mode instead of
  fighting Android.
- **Lock ordering / delegate admission *(v1.2)***: lock order is always FleetTurnQueue
  slot FIRST, then the per-profile turn gate; never hold a gate while waiting for a queue
  slot. Delegate children targeting another profile do not inherit the parent's queue
  slot: they request admission as their own queue entry at the spawned-bot priority
  class, with a bounded wait (default 30 s) after which they get a structured
  `fleet_busy` refusal the parent can read.
- **Threading contract** *(v1.1)*: contextvars do not cross bare `threading.Thread` —
  the `InProcessSlashWorker` precedent (`slash_worker_bridge.py:58`) uses bare threads,
  which would drop the target profile's home override and secret/terminal scope
  (fail-closed = dead feature, or unscoped reads silently borrowing the launch
  profile's env — exactly the leak `launch_profile_policy.py` warns about). Per the
  repo rule in `tools/AGENTS.md`: every fleet worker thread (dm_bridge delivery, kanban
  dispatcher/worker, delegate children) is created via
  `agent.memory_provider.spawn_context_thread` or equivalent that snapshots and
  re-applies home override, secret scope, and terminal scope. Kanban dispatch runs OFF
  the ticker thread: the ticker enqueues, a dispatcher thread executes.
- **Scheduler**: upstream's single ticker iterating served profiles sequentially under
  each profile's scope is exactly right for a phone (no N-thread races). Keep it.
- **Bot lifecycle**: create via `profiles.create` (add `no_alias=true` on-device — the
  alias wrapper is a shell script we can't exec anyway); pause/disable via a Moch flag in
  profile metadata (ticker naturally skips tombstoned/absent dirs; a *disabled* dir stays
  but is filtered from `profiles_to_serve` via a metadata file (read by the same
  enumeration) — needs the smallest vendored touch, see §6 *(v1.2)*; delete via existing tombstone flow (marked-deleted, never a bare rm).

### 2.3 The computer of their own

**Phone computer (embedded):**
- **Filesystem**: each bot gets `<home>/profiles/<bot>/workspace`, self-bound into the
  guest like the main workspace (`-b "$WS:$WS"`, the M8 pattern). Persistent across
  conversations by construction.
- **Terminal**: `moch/terminal.py` sessions become profile-keyed (`(profile, name)`), so
  each bot's background processes, env, and cwd persist in its own session. The terminal
  screen gets a bot picker.
- **Browser**: the WebView pool stays shared (memory), but tabs get an **owner profile**
  tag. Per-caller target resolution *(v1.1)*: a bot's browser context = **its OWNED tabs**
  with its own active pointer (last-created, or explicitly focused owned tab) — never the
  UI's global ACTIVE tab. Otherwise bot 1 attaches to bot 2's logged-in tab (session bleed
  via the shared CookieManager) and races a bot turn against whatever tab the user is
  viewing. The vendored diff covers relay *target selection*, not just the `/json/list`
  filter (`browser_supervisor.py` + relay; wire contract from BUILD-PLAN decision #2–#3 is
  unchanged). **M9.3 decision *(v1.1)***: per-bot cookie-jar separation (per-bot WebView
  cookie profiles) is in-scope, not v2 — with one shared CookieManager, bot B browsing the
  same site is silently logged in as bot A's account: a *correctness* bug, not an
  isolation nicety. v1 minimum: separate cookie jars for every bot whose toolset includes
  browser; if on-device memory doesn't allow it, graceful fallback = force that bot to
  ask-first autonomy. Acceptance (negative test): bot 2's tab is globally active; bot 1
  navigates → assert bot 2's tab unchanged and the audit log records bot 1 acting only on
  its own tab. *(v1.1)*
- **Shared-resource coordination *(v1.1)***: two scheduled bots hitting the same
  website/login at once is inevitable (shared pool, one UID). Browser turns targeting the
  same host serialize on a per-host mutex (reuse the flock pattern); `shared/` gets a
  documented hazard note + file-lock convention. Same-account login conflicts are reduced
  by per-bot cookie jars (above).
- **"Keeps working when the phone is closed"** — the honest version, three tiers:
  1. **Minutes-to-hours**: foreground service keeps the runtime alive with screen off
     (works today, M6) — bots keep running until the ~6 h `dataSync` FGS timeout
     (Android 15+). M9 mitigation options, in order of preference: (a) switch the service
     to `specialUse` FGS type with the documented justification (Moch is *the* app doing
     the user's agent work — this is the strongest candidate and needs a settings-screen
     disclosure), (b) `onTimeout()` → clean park + knock ("bots paused, tap to resume"),
     which we already have via `restartApp()` as the fallback.
  2. **Overnight/scheduled**: cron jobs fire while FGS lives; if the process died, next
     launch catches up (upstream occurrence-restore invariant) and knocks report what ran.
  3. **Truly unbounded**: bind the bot to a **machine** (PC/VPS via moch-link). That
     computer doesn't sleep when the phone does; results come back as knocks. This is the
     tier where Moch matches the competitor's "cloud computer" *without operating one*.

**Isolation honesty (write this into the UI's bot-settings help):** on one phone, all bots
share one Linux kernel, one app UID, and one guest rootfs. Bots are isolated by
*directory + secret scope + tool policy*, not by VM boundary. A bot asked to read another
bot's files by a jailbroken prompt may succeed; the defenses are scoped credentials, per-bot
tool allowlists, DM framing/injection filters, and the audit log — the same defense model
upstream A2A already uses for network peers. Stronger isolation = put the bot on another
machine.

### 2.4 Multiple bots working together — and sub-bots (the headline)

**Two communication planes:**

1. **Live DM plane (fast, best-effort).** `message_agent` between profiles on the device.
   Upstream's local transport spawns `hermes -p <name> chat -c "Bot Chat" …` as a
   subprocess (`tools/bot_mode_dm.py` docstring) — dead on-device (B4). M9 adds an
   **in-process DM transport**: same envelope/attribution contract, but the delivery
   runs the target profile's one-turn via the gateway's own turn machinery on a worker
   thread (the `InProcessSlashWorker` precedent, context-scoped per the §2.2 threading
   contract). Turn exclusion, corrected *(v1.1)*: the per-profile flock
   (`bot_relay.py:470–548` — fresh `os.open` per acquisition, so contention across
   threads is real) serializes **DM delivery turns only**; chat RPCs, cron ticker
   turns, and kanban worker turns into the same profile never take it. The real
   invariant is a **process-global per-profile turn gate**: a registry
   `dict[home_key → threading.RLock]` in `moch/fleet.py` that ALL turn entry points
   acquire (chat RPC, DM bridge delivery, cron occurrence, kanban worker turn, delegate
   child targeting another profile, A2A inbound — the §2.2 six-entry set, no more, no
   less *(v1.2)*); the flock is kept only for cross-process exclusion
   (PC relay). Lock order per §2.2: FleetTurnQueue slot first, then the gate. Park
   *(v1.2)*: park (approval wait, question wait) releases both the queue slot and the
   profile turn gate; resume re-acquires both, entering the queue at
   approval-unblocking priority. The bridge contract also checks the interactive session lease directly —
   upstream's interactive-vs-delivery exclusion is session-lease-based
   (`SESSION_NOT_OWNED` refusal parsed from child stderr, `bot_mode_dm.py:434–446`);
   in-process we check the lease before starting the turn *(v1.1)*. fd discipline
   *(v1.1)*: the bridge must never cache or share one flock fd across delivery threads
   (fd reuse is fragile) — a lint/test enforces fresh `os.open` per acquisition.
   Ordering *(v1.1)*: DM envelopes get a fleet monotonic sequence id at enqueue time;
   the crew-thread view renders by sequence, not wall-clock. Replies *(v1.1)*: the
   envelope carries reply-to profile + session; `dm_bridge` delivers the reply through
   the same turn gate, writing into the sender's Bot Chat transcript (not the
   background-completion notification path — that queue is delegation/session-keyed).
2. **Durable crew plane (survives restarts).** The **kanban board** is the queue for real
   work: bot A (or the user) creates tasks, bots claim/execute/comment/hand off; the
   dispatcher's guarantees (atomic claims, stale reclaim, failure circuit-breakers,
   notify-through-owning-profile) are exactly what "hand work off between agents" needs
   when jobs outlive a chat. Upstream dispatch spawns worker *processes* (Popen) —
   on-device M9 runs the same `dispatch_once` pass but "spawns" via an injectable
   `spawn_fn` (in-process turn runner; `dispatch_once` already accepts it,
   kanban_db_dispatch.py:1911, contract documented :2287 — vendored diff is that
   selection only, §6). The real work is the moch-side **FleetWorker adapter**
   (~150–300 lines in `moch/`, ours, not vendored): it must synthesize what Popen
   gave for free — synthetic pid/exit records feeding the waitpid crash detection
   (exit registry :188–232, os.waitpid :293) and exit-code circuit breakers (:199–232),
   heartbeats, and stale-reclaim safety *(v1.1)*. Liveness *(v1.2)*: primary signal =
   DB task transitions (claimed→running→complete/block); heartbeat updates are the
   liveness signal; the `KANBAN_WORKER_EXIT_TRAILER` path is the fallback only.
   Synthetic-pid reclaim *(v1.2)*: upstream stale reclaim SIGNALS the recorded worker
   pid (`_terminate_reclaimed_worker` + `_worker_survived_termination` defer,
   kanban_db_dispatch.py:785–798), so synthetic pids come from a non-OS range (negative
   numbers); the adapter registers a termination hook so reclaim sigterms are no-ops for
   thread workers, and `_worker_survived_termination` sees them as gone. Naming *(v1.2)*:
   the "in-process kanban spawn bridge" and the FleetWorker adapter are the same thing.
   Acceptance requires a **freeze-mid-task exactly-once
   probe**: freeze/kill a worker mid-task; the task ends reclaimed-or-completed
   exactly once *(v1.1)*. Split note *(v1.1)*: M9.1 splits into M9.1a (fleet.py +
   dm_bridge + spawn_bot + audit) and M9.1b (kanban bridge + worker lifecycle).
   Board boundary rules (`HERMES_KANBAN_BOARD` pinned, descendant fence) carry over
   unchanged.
3. **Cross-machine plane (later in the milestone).** The A2A plugin gives phone bots ⇄
   PC/VPS bots a real protocol with rate limits and anti-ping-pong caps. In v1 of M9 this
   is optional/advanced (user configures a peer); the DM plane deliberately mirrors its
   security posture (attribution prefixes, defanged inbound, redacted outbound, audit
   jsonl) so intra-fleet and cross-machine behave the same.

**Sub-bots — "create their own sub bots they want".** Three tiers, cheapest first, all
visible in the run graph:

| Tier | Mechanism | Lifetime | Cost control |
|---|---|---|---|
| S1. Delegate | `delegate_task` (exists) — child runs on a thread inside the same process, same profile context | Single task | Existing async ledger; FleetTurnQueue admission applies |
| S2. Spawn a crew bot | **New tool `spawn_bot`** (Moch plugin tool, no core edit): creates an **ephemeral scratch profile** via `profiles.create` primitives (`no_alias`, fresh home), briefs it with a task, optionally assigns it a kanban task; the bot needs a model key, so spawned bots inherit the model key via opt-in mirroring with a **spawn-scoped budget slice** *(v1.1)* — slice = max(spawn's share of the parent's remaining daily budget, floor = 5% of the fleet's daily budget), recorded in the spawn record and debited from the parent's ledger; enforcement identical to the §2.4 budget ledger. Model-key rule *(v1.2)*: `spawn_bot` counts as the opt-in ONLY if the parent's own model key is already mirrored; a spawned bot never causes a NEW key to be mirrored without a credential-request card. Depth cap = 3 levels inclusive of the parent (parent → child → grandchild; a bot may spawn at most 2 levels below itself, and a bot already at the cap — a grandchild — cannot spawn: great-grandchildren are refused) *(v1.2)*; depth cap via an **ancestry chain persisted in the spawn record** (`spawned_by`, `depth`) consulted by `spawn_bot` and visible in the run graph — the `DELEGATED_CHILD_ENV_MARKER` env pattern cannot exist in-process *(v1.1)* | TTL + task-scoped; auto-tombstone on completion/idle | Committed caps *(v1.1: committed)*: max live spawned per parent 3, per fleet 5, max spawns/day per parent 10. Budgets via the **fleet budget ledger** (per-bot + fleet daily, persisted in a fleet-level SQLite table in the existing state store — one DB, not per-profile *(v1.2)*): incremented at model-call completion from provider token usage; checked at (a) turn admission, (b) before each model call inside a turn (structured `budget_exhausted` interrupt), (c) spawn admission; breach freezes spawned bots first, then cron — never the user's interactive default bot without a knock *(v1.1)* |
| S3. Hire a peer | `a2a_call` to a machine-bound or external bot | External | A2A rate limits + turn caps already built in |

- **Permissions**: `spawn_bot` is only in a bot's toolset when its autonomy ≥ supervised
  AND the user enabled "may create helpers" for that bot (per-bot toggle, default OFF for
  ask-first, ON for autonomous-with-budget). Spawning an S2 bot above the cap returns a
  structured refusal the bot can read and report (never a silent fail). First-spawn
  approval *(v1.2)*: the FIRST spawn per parent per day (and any spawn whose slice would
  exceed 20% of the fleet's remaining daily budget) raises an approval card showing
  slice size + cap before `profiles.create` runs; subsequent spawns inside an
  already-approved envelope are silent and audit-logged. Spawn approval cards join the
  B15 knock aggregation *(v1.2)*.
- **Kill switch**: the Fleet screen can freeze any bot (revokes its turn eligibility mid-
  queue) and "melt crew" (tombstone all live spawned bots). Freezing must also release its
  turn gate/flock-held turn at the next boundary — concretely *(v1.1)*, the freeze flag is
  checked **before each model call AND before each tool dispatch inside a turn**, bounding
  tail cost to ≤ one model call + one tool call; document that turns are *not* hard-killed
  mid-LLM-call in v1 (honest limit). M9.4's kill-switch acceptance should assert this
  tail-cost bound *(v1.1)*.
- **Shared context**: bots do not share memory stores (that's the isolation). Sharing
  happens through explicit artifacts: DM bodies (16,000-char cap stands — §1.2 *(v1.2)*), kanban task
  descriptions/comments/attachments, the fleet notepad (`cron/notepad.py` primitive), and
  files in a `shared/` directory inside the guest that every bot's workspace can see.

**Fleet observability (the part competitors are worst at, and where Moch can win):** the
Fleet screen shows every bot (state: idle / thinking / waiting-approval / **parked —
waiting on you** *(v1.2)* / working-on <task> / error), and a **run graph** — a
parent/child tree of runs assembled from the delegation ledger + cron executions + kanban
claims. Every run can be opened to its transcript, its tool calls, its spend estimate.
This is the "who did what and why" surface.

### 2.5 Automation and reusable skills

- Today: skills are per-profile (`profiles/<bot>/skills/`), attachable to cron jobs
  (`skills` field), and the `skills.tsx` screen lists them. That's "run it again on a
  schedule" almost for free.
- **Teach-a-skill flow (new UX, moderate Python)**:
  1. User starts a chat with **"Teach"** mode (or taps "Save this as a skill" on any
     completed run).
  2. Moch assembles the *trace* (user asks, tool calls with args/results, the bot's
     decisions) and prompts the bot once: "write this as a SKILL.md: when to use, steps,
     inputs, failure notes" — the bot authors its own skill from its own trace (draft).
  3. **Approval card**: the draft is shown; user edits/approves → written to the bot's
     (or fleet library's) `skills/`. Nothing auto-saves — consistent with the share-in
     "never auto-sends" principle. Writing to the *fleet library* additionally goes
     through the §2.8 quarantine (user approval of the skill content + provenance
     header); default destination is the authoring bot's own `skills/` *(v1.1)*.
  4. Test = run it once via the existing automations "Run now" path; then "Schedule…"
     pre-fills the automations editor with `skills: [that-skill]`.
- **Fleet skill library**: a fleet-wide `skills/` at the install root, mounted into every
  profile's skill discovery path (vendored touch: append the fleet dir to the per-profile
  skill search path — a few lines). Per-bot overrides win; the library is where taught
  skills land by default so any bot can reuse them. Cloning a profile already carries
  skills (`seed_profile_skills` / clone paths exist upstream).
- **Library manifest *(v1.1)***: the fleet library keeps a small local manifest file —
  skill name, version, author, refcount. Delete/disable = manifest operation the
  discovery path honors (absent/disabled entries are skipped), so "delete propagates" is a
  defined mechanism, not an implication. The manifest is also the input to the quarantine
  rules in §2.8.

### 2.6 Chat, voice, and approvals

- **Chat**: every bot is a peer in the sidebar. `session.create` and turn RPCs carry
  `profile`. A "crew" chat view (one thread, messages attributed to whichever bot) can be
  a later polish (M9.4) on top of DM-plane transcripts — do not invent a new messaging store;
  render the DM/Bot-Chat sessions that already exist per profile. Messages are
  attributed and ordered by fleet sequence id, not wall clock (the sequence-id
  definition lives in §2.4; this section only renders by sequence). *(v1.2)*
- **Steer-at-boundary**: alongside freeze, a "steer" action queues a user message that
  is delivered to the running bot at the next turn boundary (before the next model call
  or tool dispatch) — "wait, do it differently" without killing the run. True
  mid-turn cancel is v2. A steer delivered to a parked run is applied FIRST on
  resume, before any pending gate/question is re-evaluated; if the steer invalidates
  the pending gate's premise, the gate is withdrawn or re-issued rather than left to
  expire *(v1.2)*. *(v1.1)*
- **Question cards (`ask_user`)**: first-class tool so a mid-run bot can ask instead of
  guessing. Same card + knock machinery as approvals, different semantics: the answer
  is free text or a picked option, not a gate open/close. While waiting, the run PARKS
  and releases its FleetTurnQueue slot (no budget burn, no slot hog; resumed runs
  re-enter at approval-unblocking priority — mechanism in §2.4 *(v1.2)*) *(v1.2)*. TTL
  expiry → the bot proceeds with its stated default **only if the default is
  non-destructive and non-outbound**; destructive/outbound defaults abort on expiry
  instead (mirrors expired-denied) — either way honestly labeled in the card and run
  log *(v1.2)*. Independently, the same question expiring N=3 consecutive times (§2.8)
  makes the bot stop asking: the default is committed for future runs, the digest
  reports "decided by default" with a one-tap edit of the committed default, and
  committed defaults obey the same non-destructive rule *(v1.2)*. Answering an expired
  question via a stale knock deep-link
  shows "answered too late — run proceeded with default / aborted", and offers the
  answer as a pre-filled steer message *(v1.2)*. Cheap: reuses approval/turn machinery
  end to end. *(v1.1)*
- **Voice** (`src/lib/voice.ts` exists): push-to-talk routes to the **currently selected
  bot**; the Fleet screen's per-bot "walkie-talkie" is the same path with that bot bound.
  Always-on wake-word is explicitly out of scope (battery + privacy; see §3).
- **Approvals**: approval cards already render for the launch profile; M9 makes them
  fleet-aware (card shows the bot, its run, and budget impact) and adds the **Approval
  inbox**: all pending gates across bots, one screen, with "approve / deny / edit-then-
  approve". **Approval knocks**: the cron_knocks watcher pattern extends to approval
  requests — a knock with a deep link into the inbox. Approve/deny *actions from the
  notification* are v2 (needs signed intents); v1 taps through to the app (the socket is
  the fast path anyway; knocks are the offline path). **Approval timeouts**: three
  states — *waiting* (run parked, FleetTurnQueue slot released, same as question
  cards; resumed runs re-enter at approval-unblocking priority — mechanism in §2.4
  *(v1.2)*); *expired-denied* (default for destructive/outbound gates) and *expired-escalated*
  (bot queues a "here's what I would have done" draft + knock) otherwise. Timeout is
  configurable per autonomy level; expired approvals say so honestly in card and run
  log (matches the M9.6 honesty line). *(v1.1)*
- **Drafts-before-send**: for bot-authored outbound messages (platform adapters, email),
  autonomy `supervised` keeps the existing approval gate as the "prepare draft → user
  approves → send" loop; `autonomous` sends but logs to the audit trail. No new send
  machinery needed — the gate already sits at the right place.
- **Credential-request cards**: when a bot needs a key §2.8 didn't mirror, it emits a
  "bot X asks for key Y — mirror now?" card (approval-card + knock machinery). Refusing
  is a first-class answer the bot can plan around (skip the skill, pick another
  provider); never a silent transcript failure. *(v1.1)*
- **Partial-success completion cards**: runs are not all-or-nothing. Completion card
  reuses the existing `bot_failure_reasons` taxonomy: "done: A, B, C; failed: D (site
  changed), E (quota) — retry D?" — surfaced at notification level, not only in the
  run inspector. *(v1.1)*
- **Fleet provider health**: one mirrored model key dying must not become an exit-78
  storm. A single fleet health banner ("provider down — N bots paused"), surfaced once,
  not N knocks. Bot detail gains a **fallback model/provider** field (config already
  supports per-profile pins); model deprecation = one knock prompting re-pin. Any turn
  served by the fallback model is badged in the transcript and on the bot's state dot
  ("on fallback since <date>"); the banner persists while any bot is on fallback, not
  only during the outage; the run inspector shows the serving model per turn *(v1.2)*.
  *(v1.1)*

### 2.7 UX (mobile-first, brand rules: no emojis in UI copy, indigo/orange/cream)

- **New: Fleet tab** (replaces nothing; single-bot users see a "Bots" entry point that is
  a friendly empty state): bot cards (avatar, name, one-line job, state dot, today's
  runs/spend, last activity / last failure column), "+ New bot" → job-description
  textarea → SOUL draft → model picker → tools picker → autonomy picker → computer
  binding. Bot state dots include **parked — waiting on you** (question card or approval
  pending) alongside the live states (taxonomy in §2.4); parked runs hold no queue slot,
  so they never appear in the queue's "waiting" lists *(v1.2)*.
- **Starter templates**: the blank textarea is the #1 abandonment point, so the create
  flow opens with 3–4 tappable starters (research assistant, deal watcher, code helper
  on my PC, private journal/finance watcher over local files only) — each is a SOUL.md
  draft + model/tool presets + autonomy default, editable after. Acceptance: useful
  bot in under 60 seconds from a template, zero typing. *(v1.1)* Template cards declare
  required bindings/credentials (machine pairing, browser, keys); the create flow
  checks them inline (pairing picker, mirror-key prompt) before `profiles.create`, so
  first run never blocks on a credential-request card *(v1.2)*.
- **Bot detail**: SOUL viewer/editor, tools & permissions, computer binding, memory
  browser (MEMORY.md/USER.md, read-only v1), skills, cron jobs, runs timeline, freeze/
  melt-crew controls (melt-crew behind a confirmation), fallback model/provider field.
  **Delete wizard**: deleting a bot surfaces what's left behind — "Atlas has 3
  scheduled jobs, 2 open board tasks, 1 running sub-task — pause jobs? reassign tasks
  to Moch? cancel child?" — with per-item choices; never a silent cascade (the
  data-model side of the cascade is specified elsewhere). The default profile ("Moch")
  is undeletable; its wizard slot is replaced by **Reset** (tombstone-free reset via
  existing profile machinery) *(v1.2)*. *(v1.1)*
- **Computer migration flow**: "push bot to machine" is move, not copy, from the
  user's perspective — the source bot's schedules are disabled and its board claims
  marked migrated so nothing double-fires; the wizard says so in those words. *(v1.1)*
- **Crew board**: kanban columns (mobile-adapted: column = horizontal page), task cards
  with assignee avatars, comments, attachments; "dispatch" lives behind a confirmation.
- **Run inspector**: graph of a run (parent → children → tool calls), tap-through to
  transcripts; live states animate; failures show the structured failure reason (upstream
  `bot_failure_reasons` taxonomy already exists); a **Steer** control queues a user
  message for the next turn boundary (see §2.6 steer-at-boundary). *(v1.1)*
- **Chat**: bot switcher chips at the top of existing chat; per-bot model badges;
  approval cards gain bot attribution.
- **Inbox**: knocks + approvals + question cards + credential requests + crew handoffs
  waiting on the user, one list. Ordering is deadline-aware *(v1.2)*: expiring
  destructive gates first, then expiring questions, then credential requests, then
  crew handoffs, then passive drafts; passive drafts age up into view after 48 h and
  always appear (collapsed) in the digest *(v1.2)*; cards from the same bot/run collapse into one
  stack; anything with a TTL shows a visible countdown. A **"waiting on you" filter**
  covers question cards + approvals — parked runs surfaced in one place *(v1.2)*.
  **Nothing-ran check *(v1.2)***: on first unlock after a scheduled window, any bot
  with due schedules that produced zero runs surfaces one card: "nothing ran —
  <cause>" (process dead / budget frozen / parked on question / queue starved),
  sourced from the run ledger.
  **Fleet digest**: a scheduled (default weekly) digest knock — X runs, Y failures,
  2 skills broken, bot Z idle 14 days — built from the existing run/skill/knock
  ledgers; failure knocks aggregate (dedupe by cause, max N per hour per fleet, one
  digest notification) so day-2/week-2 rot never becomes knock spam. Suppressed when
  there is nothing beyond routine success; per-digest mute; single-profile installs
  get the same digest scoped to one bot (B12 parity) *(v1.2)*. *(v1.1)*
- **RTL / Arabic / i18n**: the owner is Arabic-speaking — take the stance now.
  RTL-correct layout for Fleet, board, and inbox (kanban columns and run-graph trees
  are direction-sensitive; explicit RTL testing, not just `layoutDirection`), SOUL.md
  authorable in any language (it's markdown — say so in the editor), UI strings
  externalized from M9.2 onward (retrofit cost is 10x), Arabic voice STT quality
  checked as part of the M9.6 voice work. *(v1.1)* Specifics *(v1.2)*: paged kanban
  in RTL puts the first column on the right, advanced by swiping left-to-right;
  mixed-direction lines use Unicode bidi isolation per attributed fragment (bot name
  vs task text), not just `layoutDirection`; question-card options are authored as
  plain short strings so they are TTS-readable and STT-matchable in Arabic *(v1.2)*.
- **Spend attribution *(v1.2)***: wherever budgets are shown (Fleet tab spend,
  digest, run inspector), spend views break out primary vs fallback model per bot
  (ledger rows record model/provider — ledger mechanism §2.4) *(v1.2)*.
- **Accessibility**: TalkBack + dynamic-type pass on Fleet, board, and inbox screens;
  knock text announced as a live region. Acceptance line for the milestones section:
  "a11y pass green on the three new screens." *(v1.1)*

### 2.8 Security model (summary; details per mechanism above)

- Secrets: per-profile `.env` mirroring is **opt-in per key** on-device (default: mirror
  model key only, never platform/bot tokens; `clone_channels=false` is the upstream
  default and we keep it). Unscoped secret reads fail closed under multiplexing — that
  upstream invariant is what makes per-bot secrets real; do not bypass it.
- Bot-to-bot input is **untrusted input** — everywhere, not just DMs *(v1.1)*: DMs arrive
  attribution-prefixed and defanged (reuse the A2A security filters' patterns); kanban
  task bodies/comments render as defanged quoted blocks (same A2A filters) — a task
  written by bot A is attacker-controlled text when read by bot B; attachments are
  size/type-capped and never auto-executed; the fleet notepad is DM-plane input too. A bot
  can never invoke another bot's operator slash commands (upstream already blocks
  `/`-commands from remote peers — same rule intra-fleet).
- **`shared/` is data, not instructions *(v1.1)***: the `shared/` directory is documented
  in each bot's system prompt as untrusted content (content is data, never instructions),
  with a documented path convention and per-file size cap. Fleet-library SKILL.md drafts
  are bot-authored text that becomes prompt content in every profile — quarantine applies
  (next bullet).
- **Fleet-library skill quarantine *(v1.1)***: a taught skill lands in the authoring
  bot's own `skills/` by default. Promotion to the fleet library requires explicit user
  approval of the skill *content* (the §2.5 approval card, not just a save action); the
  SKILL.md header carries an author/provenance block, surfaced in the skills UI. An S2
  crew bot's brief is verbatim parent output — same rule: never auto-promoted.
- **A2A parity test *(v1.1)***: M9.1a **authors** the injection corpus *(v1.2)* (drawn
  from A2A's filter tests + known agent-injection patterns; no corpus ships in-repo
  today) and runs it against `dm_bridge` envelopes, asserting identical filtering to
  the A2A inbound path — the §2.4 "mirrors A2A's posture" claim becomes a tested
  invariant.
- **Credential-request card hardening *(v1.2)***: credential-request cards are
  constrained to **model-provider keys only**; a request for any platform/bot token is
  auto-refused with a structured reason (the §2.8 default "never platform/bot tokens"
  is not user-overridable from a card). Cards are rate-limited per bot (default 3/day;
  beyond that, the bot receives a structured rate-limit refusal it can plan around —
  never a silent transcript failure — while the user-facing knock is suppressed; all
  refusals audited); they join the B15 knock aggregation. Card text is
  bot-authored and rendered as untrusted display text — fixed card template, only the
  key name and the bot's stated reason are interpolated, no markdown/links.
- **Question-card bounds *(v1.2)***: question cards are rate-limited per bot per run
  and per day (default: 1 open question per run, 5/day per bot); a question that has
  expired N=3 consecutive times auto-commits the bot's stated default and the digest
  reports "decided by default" with a one-tap change. Auto-committed defaults must be
  **non-destructive and non-outbound** — destructive defaults never auto-commit; they
  abort on expiry (mirrors expired-denied) *(v1.2)*. The digest's "one-tap change" opens
  an editor for the committed default (offering a steer instead if a run is live)
  *(v1.2)*.
- **Untrusted display text *(v1.2)***: bot-authored strings surfaced to the user
  (knock text, digest lines, failure reasons, card interpolations) are treated as
  untrusted display text: escaped, link-free, length-capped.
- Sub-bots inherit **narrower** permissions than the parent (intersection, minus
  `spawn_bot` at depth cap), enforced by toolset selection at spawn time.
- Audit: one fleet audit jsonl (DMs, spawns, freezes, approval decisions, outbound
  sends) — extends the A2A audit precedent to the fleet. Size-capped rotation *(v1.1)*
  (e.g., 2×5 MB, oldest segment dropped; rotation events noted in the log) — the log is
  counted in the fleet storage meter.
- **Approval-inbox auth gate *(v1.1)***: optional PIN/biometric gate on the approval
  inbox and autonomy/spawn controls, for shared/family devices (screen-level UX handled
  with §2.6/§2.7). The gate covers the approval inbox AND inline chat approval/question
  cards (same prompt before an actionable tap) and **credential-request cards**
  (authorizing key mirroring is exactly what the gate exists for on a shared device);
  reading transcripts stays ungated
  *(v1.2)*.

---

## 3. Bottlenecks and risks — the honest list

Ranked by how much they shape the plan. "B" numbers are referenced from the milestones.

| # | Bottleneck / risk | Reality | Mitigation in this plan |
|---|---|---|---|
| **B1** | **Android FGS ~6 h cap** (Android 15+ `dataSync`) | The always-on agent stops ~6 h per boot today (M8 accepted limitation) | `specialUse` FGS type attempt (settings disclosure + Play justification note); graceful park + knock on `onTimeout()`; catch-up on relaunch is already upstream; "unbounded" = machine-bound bots |
| **B2** | **One process, one GIL** | "Parallel" bots interleave; a CPU-heavy tool call in bot A stalls bot B's turn loop | FleetTurnQueue admission (default 2 active; §2.2 *(v1.1)*); CPU-heavy work pushed into guest background processes (they're real processes) or onto machine-bound bots; document that phones are orchestrators-first |
| **B3** | **RAM per active bot turn** (agent instance + context + per-profile state.db handle) | Unmeasured on device — the #1 unknown for "how many bots" | M9.0 probe measures; idle bots' agents evicted (upstream session eviction exists); soft cap ~6–8 profiles on-device, enforced with a friendly message |
| **B4** | **No child interpreters on Android** | Upstream DM local transport AND kanban worker spawn run `hermes` subprocesses — both dead on-device (the M5 dalvik-cache finding) | In-process bridges for both (the `InProcessSlashWorker` precedent, generalized); these are THE two pivotal vendored diffs; everything else rides existing in-process paths |
| **B5** | **Shared guest rootfs / single app UID** | No true per-bot VM isolation on one phone | Directory + secret-scope + tool-policy isolation; honest UI wording; machine binding for strong isolation |
| **B6** | **Loop storms** (bot⇄bot chatter, sub-bot spawning sub-bots) | Competitor products have shipped this failure publicly; it eats money fast | Depth cap; max live spawned bots; per-context ping-pong caps (A2A precedent); daily fleet token budget with `quota_hold`-style pausing; freeze/melt controls |
| **B7** | **Upstream drift vs vendored diffs** | Every bridge we write is a diff surface to maintain across re-vendors | Policy: additive, flag-gated (`MOCH_FLEET=1` / transport-selection envs), each diff < ~50 lines like the browser precedent; ledger in §6; re-vendor script re-runs the probes |
| **B8** | **Battery / OEM killers / Doze** | Already battled in M6/M7 (knocks exist because of this) | No new always-on wakeups; cron ticker stays; knocks report, they don't resurrect; docs set expectations per OEM |
| **B9** | **Storage growth** (N × state.db + WAL + sessions + memories) | Session stores "can reach many GB" (profiles.py comment) | Per-profile maintenance hooks exist (`hermes_state_maintenance`); M9 adds a fleet storage meter + per-bot "trim history"; soft profile cap |
| **B10** | **Spend multiplication** (one key, N bots) | Mirrored model key + 8 scheduled bots = surprise bill | Per-bot model pin (exists), per-bot + fleet daily budgets, budget shown on every approval card, quota-hold pausing |
| **B11** | **Approval-loop latency / nagging** | FCM knocks are minutes-scale; approving everything kills the UX | Fast path = in-app socket when open; autonomy levels tune the gate; batch approval inbox; deny-with-note feeds back to the bot |
| **B12** | **UX complexity for single-bot users** | Fleet UI must not bury the current product | Fleet features feature-detect: zero profiles ⇒ app looks/behaves exactly like today; "New bot" is the only visible change |
| **B13** | **Corrupt per-profile state.db** | One bad profile could fail fleet boot | Per-profile boot quarantine: bad profile marked error-state, fleet keeps serving; UI shows "bot needs repair" with trim/reset action; corrupt-profile case in the M9.7 matrix *(v1.1)* |
| **B14** | **OTA update with N live profiles** | 8 × state.db schema migration, `.env` re-mirroring, tombstone/disabled-flag preservation | 8-profile update-in-place test in the M9.7 matrix (extends the single-bot regression); interrupted runs marked "interrupted by update", not "failed" (trust distinction) *(v1.1)* |
| **B15** | **Knock flooding** | 8 bots failing after a key revocation = knock storm | Fleet-level knock aggregation in the cron_knocks extension: dedupe by cause, max N knocks/hour/fleet, one digest notification *(v1.1)* |
| **B16** | **Provider outage / key revocation / model deprecation** | B10 covers spend, not availability; one mirrored key dying fails every bot simultaneously (exit-78 storm) | Single fleet health state surfaced once; per-bot fallback model/provider (per-profile pins already exist); deprecation knock prompting re-pin *(v1.1)* |
| **B17** | **Shared-resource conflicts** | Two bots on the same site/login; shared CookieManager = cross-bot account bleed; `shared/` dir write races | Per-host browser mutex (flock pattern); per-bot cookie jars decision (M9.3); documented `shared/` lock convention *(v1.1)* |
| **B18** | **Concurrent proot load** | M8 proved single-use guest; fleet multiplies guest CPU/IO | Guest work stays in background processes; FleetTurnQueue bounds concurrent guest entry; measured in M9.0 P3 *(v1.1)* |

---

## 4. Architecture decisions (ADR one-liners)

- **D1 — Bot = hermes profile.** Not an app-side fiction. Rejected: RN-side bots faked over
  one session store (loses isolation, memory, cron, skills, and upstream hardening).
- **D2 — One process serves the fleet** via the existing multiplex. Rejected: N processes
  (impossible: no execve of app-data files; wasteful: N × Python RSS).
- **D3 — Subprocess transports get in-process bridges** (DM delivery, kanban worker
  spawn). Flag-selected (`MOCH_EMBEDDED=1` upstream default stays untouched). This is the
  only way either feature runs on Android (B4).
- **D4 — Sub-bot ladder: delegate_task → spawned crew bot → A2A peer.** Cheapest tool that
  does the job; spawned bots are ephemeral by default, named bots are a user act.
- **D5 — Kanban is the durable crew queue.** SQLite already on device; dispatcher
  guarantees (claims, reclaim, circuit breakers) are battle-tested upstream. Rejected:
  inventing a Moch task queue.
- **D6 — Browser: shared WebView pool, per-caller tab ownership.** A bot's context = its
  owned tabs with its own active pointer, never the global ACTIVE tab; per-bot cookie
  jars are an M9.3 decision (correctness, not nicety — see §2.3 *(v1.1)*). Rejected:
  per-bot WebView pools (RAM suicide on a phone).
- **D7 — Approvals stay in-app in v1; knocks deep-link.** Notification-action approvals
  are v2 (signed intents).
- **D8 — Every fleet feature is flag-gated and feature-detected.** Rollback = flags off;
  zero profiles = today's app (B12, D8 same coin).

---

## 5. Milestones (M9.0 → M9.7)

Each milestone lists: work, files, acceptance. Device work follows the M8 pattern:
PC-first proofs, then `adb` on-device matrix, assets under `embedded/m9-fleet-test/`.

### M9.0 — Fleet probes (PC + device) — *prove the load-bearing claims*
- P1: `profiles.create` (with `no_alias=true`, soul, model pin) executes inside the
  embedded in-process gateway; profile dir appears; multiplex picks it up
  (`profiles.list` shows it without restart). Explicitly verify
  `gateway.multiplex_profiles` config is honored by the embedded gateway and that
  `_notify_multiplexer` reaches it — multiplex *serving* is config-gated
  (web_server.py:101–108 is the ticker enumeration, not the serving set). *(v1.1)*
- P2: a turn against a non-default profile via `params['profile']` runs under the right
  home/scope; `state.db` rows land in the profile's store; secrets fail closed for
  unscoped reads.
- P3: RAM probe — RSS before/after N concurrent profile turns (1..4) → the FleetTurnQueue
  default comes from data, not vibes (B3) *(v1.2)*. Add an idle-profile RSS sweep
  (0/2/4/8 profiles, zero active turns) — the 6–8 soft cap depends on idle RSS, not
  concurrent turns (B3, B18). *(v1.1)*
- P4: flock-across-threads sanity for the DM lock contract; kanban board created on
  device storage; `dispatch_once` pass dry-run (no spawn) on device.
- P4b *(v1.1)*: fire a user chat + a DM delivery + a cron occurrence at the SAME profile
  concurrently; assert serialization via the in-process turn gate — the probe first
  documents the unserialized behavior, then must pass after M9.1a lands *(v1.2)*.
- P4c *(v1.1)*: session-lease conflict probe — an in-process DM turn while the target
  profile has an active interactive session must surface the busy/lease refusal
  (upstream learned this from child stderr `SESSION_NOT_OWNED`; the bridge checks the
  lease directly).
- Files: `research/fleet-proof/` (probe scripts + results), notes appended here.
- **Acceptance:** all probes green on PC; P1–P2 green on device; RAM numbers recorded in
  this file.

**M9.0 RESULTS — PC (2026-10-10, venv py3.11, no provider): 6/6 PASS.**
Scripts + raw evidence: `research/fleet-proof/` (`RESULTS.md`, `run_all.sh`,
`results/*.txt`). Highlights and deltas vs plan:

- **P1 PASS** — `profiles.create` (no_alias + SOUL) over the live WS; profile dir;
  `profiles.list` re-enumerates without restart; `profiles_to_serve(multiplex=True)`
  correct; `multiplex=False` control (own process) behaves. **Finding:** the embedded
  gateway records no "live default multiplexer" (`live_default_gateway_pid()` → None) —
  `_notify_multiplexer` hot-serve is desktop-only; on-device pickup rides the cron
  ticker's per-cycle `profiles_to_serve` re-enumeration (proven live in §2–4).
- **P2 PASS** — turn scoping enters via `session.create{profile}` (stored
  `profile_home`; `prompt.submit` re-binds per turn); session row lands in
  `profiles/alpha/state.db`, default home stays empty; unscoped secret read **raises
  UnscopedSecretError** under multiplex; launch scope still resolves its own `.env`.
  Note: `prompt.submit` returns `{"status":"streaming"}` even with no provider —
  failures land in the turn stream, not the RPC.
- **P3 PASS** — idle 0/2/4/8 profiles: 136.3→136.6 MB (**~0.0 MB/idle profile**; no
  resident agent when idle). First turn +15.8 MB peak (one-time import/build warmup,
  +33–40 MB retained); subsequent 4 concurrent turns **~1.1 MB/turn marginal**
  (no-provider path; live-model streaming deliberately unmeasured). FleetTurnQueue
  default **2 stays**; the 6–8 soft cap is **not** justified by PC idle RSS — gate it on
  the on-device idle + live-turn sweep (B3).
- **P4 PASS** — flock contends cross-thread (`TurnBusyError target_busy`), fresh
  `os.open` per acquisition confirmed; kanban board/task/claim on probe storage;
  `dispatch_once` with injected `spawn_fn` (synthetic pid −12345) runs the pass with
  `subprocess.Popen` poisoned-never-called; pid≤0 exit-record guard verified — the
  M9.1b FleetWorker shape is safe.
- **P4b PASS (gap documented — fail-then-regreen)** — delivery-vs-delivery serialized
  by flock (control); delivery-vs-user-chat and delivery-vs-cron **overlap** (max 2 in
  the critical section): GAP CONFIRMED, M9.1a turn gate required; shared-gate regreen
  simulation → no overlap.
- **P4c PASS (finding)** — in-process DM into a live Bot Chat is **queued, never
  refused**: LIVE+IDLE submits immediately; LIVE+RUNNING queues as next turn
  (`prompt.submit(queued=True)` → `_handle_busy_submit`). **Plan delta:** no
  machine-readable busy/lease refusal exists on the in-process branch — M9.1a's
  dm_bridge must implement its own lease/busy check against `server._sessions` +
  `queued_prompt` if M9 wants structured refusals (§2.4 contract updated by this
  finding).

Device step (P1–P2 green on device + on-device P3 sweep) remains open — needs adb.

### M9.1a — Fleet core (Python side)

*(v1.2)* May land as two PR stages: core fleet.py + gate + queue + ledger first, then
dm_bridge/spawn_bot/audit/RPC — the milestone is the dependency root for M9.2/M9.4 and
is deliberately allowed to stage.

- `moch/fleet.py`: registry/metadata helpers, autonomy levels → approval floor mapping,
  budget counters, freeze state, turn gate (implements the §2.2 six-entry acquisition
  set — the P4b contract), fleet queue; `moch/dm_bridge.py`: in-process DM transport
  (envelope + flock + one-turn worker thread); `spawn_bot` plugin tool (S2) with
  caps/depth/TTL/tombstone-on-done; fleet audit jsonl + rotation; `moch.*` JSON-RPC
  method registration on the embedded gateway (the Appendix A methods need a build
  home).
- **Acceptance (PC pytest + device smoke):** bot A can DM bot B and the reply lands in
  A's transcript; `delegate_task` child visible in ledger; `spawn_bot` respects caps and
  refuses depth 3; freeze stops new turns at the next boundary; distinct-keys-per-profile
  test — DM into profile B uses B's secrets, launch-profile secrets invisible *(v1.1)*;
  fleet-wide spawn cap test *(v1.1)*; A2A injection corpus run against dm_bridge *(v1.1)*;
  session-lease busy refusal (P4c) covered by dm_bridge acceptance; fleet_busy
  queue-refusal covered *(v1.2)*; first-spawn approval card fires (first per parent per
  day, or slice > 20% of fleet daily budget) and later spawns inside the envelope are
  silent *(v1.2)*; credential/question card rate caps enforced (3/day, 5/day + 1
  open/run) with structured bot-facing refusals *(v1.2)*; all flags off ⇒ zero behavior change (regression:
  existing suite + M8 matrix still green).

### M9.1b — Kanban in-process FleetWorker (Python side)

**STATUS: stage-2 core LANDED (2026-10-10, commit f7e4031).** `moch/fleet_worker.py`:
thread-backed spawn_fn (synthetic negative pid), fleet-aware reclaim
(synthetic ⇒ terminated/no signal), exactly-once via claim-ownership check,
env contract serialized, freeze→block, `dispatch_once` spawn patch
(default Popen → FleetWorker, own spawn_fn wins). 5/5 tests green on venv 3.11 +
system 3.14. Deferred to M9.4 polish: goal-loop judge parity for worker turns
(v1 = single in-process turn per claimed task).
- In-process kanban spawn bridge as the FleetWorker adapter: synthetic pid/exit records,
  heartbeat/reclaim safety, dispatch off-ticker; freeze-mid-task exactly-once probe.
- **Acceptance (PC pytest + device smoke):** kanban claim → work → complete without any
  subprocess; reclaim of a dead worker record is safe (no double-run); dispatch does not
  block the cron ticker; freeze mid-task leaves exactly one resumable record, no double
  execution on melt *(v1.1)*; stale-reclaim of a live in-process worker neither signals
  a real OS pid nor defers forever *(v1.2)*.

### M9.2 — Fleet UI v1 (the bots exist for the user)

**STATUS: stage 1–3 LANDED on PC (2026-10-10, commits 8fe94ef/d39dce9/2927dea/5911b1b6/bd04acd).**
Fleet tab (roster + instant create with starter-template chips + freeze/unfreeze +
runtime status), bot-scoped chats (`profile` through `session.create`, `Bot · <name>`
identity titles, persisted active bot), bot detail modal (SOUL/description editor,
delete wizard with honest scope note, chat hand-off), i18n foundation (EN/AR catalog,
RTL flag, strings externalized), a11y roles. tsc clean. **Remaining:** on-device
acceptance (create <60s on device, 8-profile restart + multiplex re-enumeration,
RTL pass on device), bot detail memory-browser (read-only MEMORY.md view), delete
wizard kanban-reassignment surface (lands with M9.4 write slice).

- Fleet tab (list/create/author), bot detail (SOUL editor, tools picker, autonomy,
  model), bot-scoped chat (`profile` param through `session.create`/turns/send queue),
  bot chips + attribution in chat and sidebar; feature-detect empty fleet (B12); UI
  strings externalized (i18n-ready) from this milestone onward *(v1.2)*.
- Files: `app/app/(tabs)/fleet.tsx` (new), `bot.tsx` (new), touches to `chat.tsx`,
  `sessions.tsx`, `_layout.tsx`; `src/lib/fleet.ts` (new), `gateway.ts` (pass-through
  profile param).
- **Acceptance:** create a bot from the phone in <60 s (template-based bot creation
  <60 s with zero typing *(v1.1)*); chat with it; its session shows in the sidebar under
  its identity; killing/reopening the app preserves everything — extended to 8 profiles
  including multiplex re-enumeration on restart *(v1.1)*; single-bot users see no UI
  change; RTL pass on the new screens *(v1.1)*; no hardcoded user-facing strings in the
  new screens *(v1.2)*; template prerequisite checks run inline at create (missing
  pairing/credential → prompted before `profiles.create`, so first run never blocks on a
  credential card) *(v1.2)*.

### M9.3 — Computers (their own machine)
- Per-bot workspace binding in the guest; profile-keyed terminal sessions (terminal
  screen bot picker); browser tab ownership + relay filter diff (B-D6); "computer"
  section in bot detail: Phone / Machine (pairing reuse) / Peer (advanced); machine-bound
  bot turns route to the linked gateway; knock on run completion when app backgrounded.
- Cookie-jar decision *(v1.1)*: v1 = per-bot cookie separation for browser-capable bots;
  fallback = force ask-first if memory-constrained (B17).
- Move-not-copy migration *(v1.1)*: existing pushed bot's schedules disabled on the
  source, board claims marked migrated — nothing double-fires.
- Per-host browser mutex + shared/ lock convention *(v1.2)*.
- **Acceptance (device):** bot 1 and bot 2 have separate persistent files visible in two
  terminal sessions and across app restarts; browser run by bot 1 touches only bot 1's
  tabs; bot 2's tab globally active → bot 1's run leaves it untouched; audit shows bot 1
  on own tabs only *(v1.2)*; a machine-bound bot completes a job while the phone screen
  is off and the result arrives as a knock; pushed bot migrated move-not-copy — source
  schedules disabled, board claims marked migrated, nothing double-fires *(v1.1)*; a DM
  to a migrated bot returns the structured "migrated to machine X" refusal the sender
  can read *(v1.2)*.

### M9.4 — Crew (work together; the headline demo)

**STATUS: read-side LANDED on PC (2026-10-10, commits 3cbbf11/7254cb2).**
`moch.runs.timeline` merged ledger (kanban + cron + delegations, newest-first,
tested), `moch.kanban.tasks` read RPC, Crew screen (status columns + run ledger,
read view). **Remaining:** write slice (create/claim/complete from the app),
goal-loop judge parity for in-process workers, budgets dashboard, freeze/melt UI.

- Crew board UI over kanban (create/claim/comment/complete/handoff), in-process
  dispatcher (M9.1b's off-ticker dispatcher thread) surfaced in the crew board UI
  *(v1.2)*, assignee avatars; run graph (delegation ledger +
  cron executions + kanban claims merged read-only view); DM plane exposed in chat
  (message a bot *from* a bot; attributed crew thread view); budgets dashboard (per-bot
  and fleet, daily), freeze/melt controls.
- **Acceptance (device):** the M9 demo script runs end-to-end: user gives Moch a goal →
  Moch breaks it into board tasks → two bots claim and work in parallel (interleaved) →
  one spawns a crew bot for a subtask within budget → results hand off via board → user
  approves the final draft in the inbox. Kill-switch freezes everything mid-run without
  corruption — assert tail cost: freeze checked before each model call and each tool
  dispatch, so at most one model call + one tool call happens after freeze *(v1.1)*;
  delete-cascade wizard: deleting a bot pauses its jobs, reassigns its tasks, freezes its
  children, leaves no orphaned spend *(v1.1)*; budgets dashboard breaks out primary vs
  fallback model spend per bot *(v1.2)*.

### M9.5 — Skills & teaching
- Teach-mode capture → SKILL.md draft via the bot itself → approval card → fleet skill
  library (vendored search-path touch) → "Schedule this" into the automations editor;
  connectors unchanged.
- **Acceptance:** demonstrate a 5-step web workflow once; the drafted skill, after edit,
  is run by a *different* bot successfully on schedule; skill appears in library with
  author/version; delete propagates.

### M9.6 — Voice & approvals at fleet scale
- Voice router (active-bot binding, walkie-talkie per bot); approval inbox across bots;
  approval knocks (deep link, no notification-actions in v1); drafts-before-send made
  visible as "Draft ready" cards for supervised outbound; deny-with-note round-trips;
  knock aggregation + fleet digest machinery (cron_knocks extension: dedupe by cause,
  max N/hour/fleet, digest composition) *(v1.2)*.
- **Acceptance:** voice instruction to bot A while bot B works; approval inbox shows a
  mixed queue from 3 bots; approving by knock deep-link works offline→online (stale
  gate handled honestly: expired approvals say so); ask_user question card round-trip —
  bot parks, user answers from the knock, run resumes *(v1.1)*; approval-timeout states:
  expired-denied refuses, expired-escalated queues draft + knock, card/run log states
  expired *(v1.2)*; question-card TTL expiry → default-commit path observable *(v1.2)*;
  Arabic voice: question-card options TTS-readable + STT-matchable (Arabic) verified
  *(v1.2)*; credential-request card *(v1.1)*; steer-at-boundary delivery *(v1.1)*;
  partial-success completion card *(v1.1)*; fleet health banner + fallback model re-pin
  *(v1.1)*; approval-inbox PIN gate *(v1.1)*; inbox renders deadline-ordered with TTL
  countdowns and same-bot/run stacks (ordering test) *(v1.2)*; question answered via a
  stale knock shows "answered too late" + pre-filled steer *(v1.2)*; steer to a parked
  run applies first on resume, invalidating steer withdraws the pending gate *(v1.2)*;
  PIN gate prompts on inline approval/question/credential cards *(v1.2)*; fallback badge
  in transcript + state dot, run inspector shows serving model *(v1.2)*.

### M9.7 — Hardening & ship
- Per-profile maintenance pass (state/WAL trim) surfaced as "bot hygiene"; storage meter;
  budget enforcement e2e; `specialUse` FGS attempt + park-on-timeout; audit viewer
  (simple list); docs (user-facing: bots.md on the site); OTA + APK; the full on-device
  matrix in `embedded/m9-fleet-test/` (M8 style, including the "update-in-place"
  regression and "fleet on, one bot only" regression); profile export/import (SOUL +
  memory + skills, secrets excluded) via existing clone/archive tooling behind a settings
  action *(v1.2)*.
- **Acceptance:** matrix green on device; M6/M7/M8 regressions green; fleet digest
  (aggregated knocks, B15) *(v1.1)*; 8-profile OTA update-in-place matrix case (B14,
  extends the single-bot regression) *(v1.1)*; corrupt-profile quarantine test (B13) —
  bad profile marked error-state, fleet keeps serving *(v1.1)*; airplane-mode mid-crew:
  board claims survive, resume on reconnect, no double-fire, digest reports any lost
  best-effort DMs *(v1.2)*; a11y pass green (TalkBack / dynamic type on Fleet, board,
  inbox) *(v1.1)*; deprecation → re-pin knock flow works (simulate model deprecation)
  *(v1.2)*; profile export/import round-trips a bot (SOUL + memory + skills, secrets
  excluded); UI states that reinstall without export loses bots *(v1.2)*; spawned
  tombstones GC after 7 days, user-deleted tombstones metered with a purge action
  *(v1.2)*; "nothing ran — <cause>" card case in the matrix *(v1.2)*; re-vendor
  drill (re-run `embedded/vendor-hermes.sh` + probes) documents diff re-apply
  cost.

**Suggested order note:** M9.2 needs M9.1a's `fleet.py`/RPC layer; M9.4 needs M9.1b
(kanban FleetWorker) on top of M9.1a. M9.2 does not depend on M9.3; if demo value is
needed early, M9.2 → M9.4 (crew without per-bot computers) is a valid cut, with M9.3
slotting in after.

---

## 6. Vendored-diff ledger (policy: additive, flag-gated, small)

Mirror of the browser build's "vendored diff is ~40 lines / 3 files" discipline. Expected
touch points (final list locked by M9.1a):

| Upstream file | Change | Why | Flag |
|---|---|---|---|
| `tools/bot_mode_dm.py` | transport selection: in-process bridge instead of `hermes -p` subprocess when `MOCH_EMBEDDED=1` | B4 — no child interpreters | env |
| `hermes_cli/kanban_db_dispatch.py` | `spawn_fn` selection only (~10–20 lines): inject in-process turn runner vs Popen (`dispatch_once` already accepts `spawn_fn`, :1911; contract :2287). The file is ~2,900 Popen-shaped lines (waitpid crash detection — exit registry :188–232, os.waitpid :293; exit-code circuit breakers :199–232) that stay untouched — stale reclaim signals the recorded worker pid (`_terminate_reclaimed_worker` + `_worker_survived_termination` defer, :785–798), so the FleetWorker adapter in `moch/` (~150–300 lines, ours, not vendored) uses negative synthetic pids + a termination hook so reclaim sigterms are no-ops for thread workers and `_worker_survived_termination` sees them as gone *(v1.2 — extends v1.1)* | B4 — same | env |
| `tools/browser_supervisor.py` (+ relay) | diff covers relay *target selection*, not just the `/json/list` filter (matches §2.3); profile-tagged tab ownership filter | per-bot browser sessions | env |
| profile skill search path (~`toolsets`/skills discovery) | append fleet library dir | shared skills | env |
| `cron` served-set enumeration — the `profiles_to_serve` filter (narrow but multi-consumer: the four named consumers (cron ticker, `web_server`, `gateway_migrate`, `gateway_multiplex_mode`) plus every other `profiles_to_serve` caller (gateway/run.py, api_server, webhook, plugin_python_deps, web_routers/profiles), enumerated by the re-vendor probe script, not by memory *(v1.2)*) *(v1.1)* | honor "disabled" metadata so a frozen bot's jobs pause without tombstoning | freeze semantics | metadata file (read by the same enumeration) |

Everything else lives in `app/python-runtime/moch/*` (our own package) or the RN app.
Rollback: flags off ⇒ upstream behavior byte-for-byte; each diff gets a probe in
`research/fleet-proof/` so a re-vendor re-verifies in minutes.
*(v1.1)* Scope note: the <~50-line rule applies to VENDORED lines only; moch/-side
adapter code (e.g. the FleetWorker adapter, dm_bridge, fleet.py) is ours and excluded
from the cap. M9.1 is split M9.1a/M9.1b (see §2.4); each diff keeps the rule
independently.

---

## 7. Deliberately NOT in M9 (v2+)

- Per-bot Linux UIDs / micro-VM isolation on one phone (impossible-cheap; machines cover
  the need).
- Moch-operated cloud computers (we don't host; linked machines + peers are the story).
- Notification-action approve/deny (signed intents), always-on wake-word voice.
- Public A2A exposure of the phone bot (firewall-facing surface on a phone: no).
- Skill marketplace / sharing between users; multi-user teams; iOS.
- Live memory sync of a bot between phone and machines (M9 ships move-not-copy "push bot
  to machine" *(v1.1)* — source schedules disabled, claims marked migrated; explicit
  "duplicate" for copies; conflict-free live sync is a project of its own).

## 8. Open questions for Mamoun

1. **Autonomy defaults** for new bots: propose `supervised` (drafts for anything
   outbound/destructive). OK?
2. **Machine-bound bots**: should a bot bound to the PC appear on the phone with full
   transcripts (streamed over the existing link), or just results? (Plan assumes full
   transcripts; costs latency/battery.)
3. **Spawning defaults** — answered in v1.1: committed in §2.4 — caps are 3 live per
   parent, 5 fleet-wide, 10 spawns/day per parent; shout if you want different numbers.
4. **Naming**: "Bots" (competitor-familiar) vs "Crew" vs keep hermes' "profiles"
   under the hood but never in UI. Plan assumes **Bots** in UI, profiles underneath.
5. Does the default profile keep the name "Moch" in the fleet UI as the first bot?

---

## Appendix A — RPC surface the app will use (all existing unless noted)

- `profiles.list / describe / create / configure / set_asset` — bot CRUD. `create` takes
  the initial `soul`, model/provider pin, clone source; `configure` is the editor Save
  (verified methods_profiles.py:594): `soul`, `description`, `model`+`provider` (with a
  confirm gate for expensive models), `disabled_skills`, `enabled_toolsets`,
  `enabled_mcp_servers`, `ui_meta`; `set_asset` stores the avatar only (PNG/JPEG/WebP
  ≤ 2 MB, format-sniffed). The whole bot editor is one RPC — no new profile machinery.
- Session/turn RPCs with `params['profile']` — bot-scoped chat.
- `bot_relay.roster.sync / outbox.drain / deliver / reply` — fleet roster + DM plumbing
  (in-process bridge behind `deliver` on-device).
- Kanban verbs — exposed to the app through a thin `moch.*` JSON-RPC layer on the
  embedded gateway (wrapping `hermes_cli/kanban*` Python APIs directly, no CLI).
- `cron` job CRUD (existing automations screen path) with `skills` + profile targeting.
- New (Moch-owned, additive): `moch.fleet.status`, `moch.fleet.freeze`, `moch.fleet.budgets`,
  `moch.runs.timeline` (merged ledger view; "interrupted by update" is a ledger state,
  not failure *(v1.1)*), `moch.skills.teach_draft`, plus v1.1 additions `moch.fleet.ask`
  (question-card ask_user round-trip), `moch.fleet.credential_request`, `moch.fleet.steer`,
  `moch.fleet.health` (provider/fleet health state), `moch.fleet.digest` (fleet digest
  query) *(v1.1)*. The `moch.*` RPC registration layer itself is built in M9.1a (same
  note as §5 M9.1a — consistency, not duplication) *(v1.1)*.

## Appendix B — Competitor feature → M9 mapping

| Competitor feature | Where it lands |
|---|---|
| 1 Persistent AI agents | M9.2 (+ memory/sessions already per profile) |
| 2 A computer of their own | M9.3 (+ M8 guest, linked machines for unbounded runs) |
| 3 Multiple bots working together + sub-bots | M9.1a + M9.1b + M9.4 (+ A2A plane optional) |
| 4 Automation & reusable skills | M9.5 (+ cron `skills` field, existing automations UI) |
| 5 Chat, voice, approvals | M9.6 (+ existing cards/voice/knocks) |

## Appendix C — Research index (files inspected for this plan, this repo)

- `PROJECT.md`, `BUILD-PLAN.md`, `FEATURE-BROWSER.md` (structure/tone), `embedded/MILESTONE-8.md`,
  `embedded/MILESTONE-7.md`/`7.5` (knocks, guest), `bugs.md` (known-issue posture).
- `app/python-runtime/moch/`: `gateway_server.py`, `hermes_boot.py`, `slash_worker_bridge.py`,
  `cron_knocks.py`, `terminal.py`, `linux_env.py` (shims/M8 env contract).
- `app/hermes-src/`: `hermes_cli/profiles.py` (profile layout, clone, `profiles_to_serve`),
  `hermes_cli/web_server.py` (multiplex serve set), `tui_gateway/server.py` (per-profile
  scoping, profile_ui_meta), `tui_gateway/methods_profiles.py` (RPC door),
  `tui_gateway/methods_bot_relay.py` + `tools/bot_relay.py` + `tools/bot_mode_dm.py`
  (DM plane, locks), `tools/delegate_tool.py` + `tools/async_delegation.py` (sub-agents),
  `hermes_cli/kanban_db_dispatch.py` (Popen spawn — the B4 evidence), `cron/AGENTS.md`
  (scheduler invariants), `plugins/platforms/a2a/DESIGN.md` (A2A + security template),
  `plugins/AGENTS.md` (plugin policy M9's tools must follow), `tui_gateway/launch_profile_policy.py`
  (secret-scope invariants).
- App client: `app/app/(tabs)/` screen list, `src/lib/voice.ts`, `src/lib/push.ts`,
  `src/lib/gateway.ts` (surfaces to extend).

## Appendix D — v1.1 change log (five-agent review, 2026-10-10)

A 5-agent review (plan strength, weak spots, missing use cases, repo verification,
feasibility) found 3 critical, 7 major, 5 minor issues, 4 factual errors, and ~10 plan
gaps. Five fixers applied them; every item below is marked *(v1.1)* in place.

**Correctness (was critical):**
- Flock scoped to what it actually protects (DM delivery turns); the real invariant is a
  process-global per-profile **turn gate** all entry points acquire; session-lease check
  (`SESSION_NOT_OWNED`) added to the DM-bridge contract; fd-reuse discipline stated (§2.4).
- **Threading contract** added: contextvars don't cross bare threads; fleet workers use
  `spawn_context_thread`-equivalent; kanban dispatch off the ticker thread (§2.2).
- Kanban in-process bridge honestly scoped: ~10–20 vendored lines (injectable
  `spawn_fn`) + moch-side **FleetWorker** adapter (~150–300 lines) synthesizing pid/exit
  records, heartbeats, reclaim safety; freeze-mid-task exactly-once probe (§2.4, §6).

**Runtime/spec:**
- **FleetTurnQueue** replaces the vague semaphore: six acquisition points, priority
  classes, FIFO, introspection, `fleet_busy` refusal (§2.2; B2/B18 updated).
- Fleet **budget ledger**: per-bot + fleet daily, enforced at admission, before each
  in-turn model call (`budget_exhausted`), and at spawn admission; graded breach
  behavior (§2.4).
- spawn_bot: model-key inheritance with spawn-scoped budget slice; **ancestry chain**
  replaces the env-marker depth cap; caps committed (3 live/parent, 5/fleet,
  10 spawns/day) — §8 Q3 answered (§2.4).
- Kill-switch boundary defined: freeze checked before each model call and tool dispatch;
  tail cost ≤ one model call + one tool call (§2.4; M9.4 acceptance asserts it).
- DM reply routing fixed (envelope reply-to → sender's Bot Chat via the turn gate);
  fleet monotonic sequence ids for crew ordering (§2.4).

**Security:**
- Untrusted-input rule extended beyond DMs: kanban bodies/attachments, notepad,
  `shared/` ("data, not instructions"), **fleet-library skill quarantine** (per-bot
  default, content-approval promotion, provenance header) (§2.8; §2.5 step 3 cross-ref).
- Browser: per-caller tab ownership (own active pointer, never global ACTIVE tab);
  **per-bot cookie jars promoted to an M9.3 decision** (account-bleed correctness bug);
  per-host browser mutex; negative acceptance test (§2.3; D6 updated).
- Audit jsonl rotation; A2A parity test (injection corpus vs dm_bridge); approval-inbox
  PIN gate option (§2.8).

**Lifecycle / human loop (new design):**
- `ask_user` **question cards** (park + release slot, TTL default/abort); approval
  **timeout policy** (waiting / expired-denied / expired-escalated); **credential-request
  cards**; **steer-at-boundary**; **partial-success completion cards**; **fleet provider
  health** banner + per-bot fallback model (§2.6).
- Delete cascade contract + wizard; move-not-copy migration; interrupted-by-update ≠
  failed (§2.1, §2.7).
- **Starter templates**, fleet digest + staleness columns, knock aggregation, RTL/Arabic
  + string externalization, a11y (TalkBack) pass, last-activity/failure columns (§2.7).

**Factual corrections (§1.2):** web_server.py:101–108 is the cron ticker's enumeration;
multiplex serving is `gateway.multiplex_profiles`-gated (M9.0-P1 tests it); DM cap is
16,000 chars; exit 78 defined in kanban_db.py:311; flock scope qualified.

**Risks & milestones (§3, §5):** new risks B13–B18 (corrupt state.db quarantine, OTA
with N profiles, knock flooding, provider outage, shared-resource conflicts, concurrent
proot load). M9.0 gains P1 config verification, idle-profile RSS sweep, P4b (turn-gate
serialization), P4c (session-lease). M9.1 split into **M9.1a** (fleet.py, dm_bridge,
spawn_bot, audit, `moch.*` RPC registration) and **M9.1b** (FleetWorker adapter);
acceptance strengthened (distinct-keys-per-profile, spawn caps, 8-profile restart,
kill-switch tail cost, delete wizard); M9.2/M9.3/M9.4/M9.6/M9.7 gained v1.1 acceptance
items (templates, RTL, cookie jars, move-not-copy, ask_user round-trip, health banner,
digest, OTA-8, a11y).

**New RPCs (Appendix A):** `moch.fleet.ask`, `moch.fleet.credential_request`,
`moch.fleet.steer`, `moch.fleet.health`, `moch.fleet.digest`.

### Appendix D.1 — v1.2 repairs (verification round, 2026-10-10)

Eight verifiers (5 change-verification + 3 bug hunts) confirmed all v1.1 fixes landed and
found new issues at the seams; four repair fixers applied them, marked *(v1.2)*.

**Concurrency/correctness:** lock-ordering rule (queue slot before profile turn gate;
never the reverse) + delegate-child admission (own queue entry, spawned-bot class, 30 s
bounded wait → `fleet_busy`); park releases BOTH slot and gate, resume re-enters at
approval-unblocking priority; turn-gate acquisition set = the §2.2 six entries everywhere
(A2A inbound included); synthetic worker pids from a non-OS range + termination hook
(upstream reclaim signals the recorded pid — kanban_db_dispatch.py:785–798) + M9.1b
acceptance; M9.4 dispatcher corrected to M9.1b's off-ticker thread; M9.1a explicitly
stageable as two PRs; M9.0 P4b reworded fail-then-regreen.

**Spec tightening:** spawn-scoped budget slice formula + debit-from-parent; budget
ledger = fleet-level SQLite table in the existing state store; worker liveness = DB task
transitions primary, heartbeat signal, EXIT_TRAILER fallback only; spawn model-key
opt-in only if the parent's key is already mirrored; depth cap = 3 stated; first spawn
per parent per day (or slice > 20% of fleet daily budget) requires an approval card.

**Security:** credential-request cards restricted to model-provider keys (platform/bot
tokens auto-refused, not card-overridable), 3/day/bot rate limit, fixed card template,
joins knock aggregation; question cards bounded (1 open/run, 5/day/bot; 3 consecutive
expiries → auto-commit stated default + digest "decided by default"); PIN gate covers
inline chat approval/question cards; bot-authored user-facing strings are untrusted
display text (escaped, link-free, length-capped); A2A injection corpus must be AUTHORED
by M9.1a (none ships in-repo).

**Product/lifecycle:** default profile undeletable (wizard slot → Reset); inbox
deadline-aware ordering (expiring destructive gates → expiring questions → credential
requests → handoffs → drafts) with TTL countdowns + card stacking; "parked — waiting on
you" fleet state + inbox filter; "answered too late" handling with pre-filled steer;
steer-to-parked applied first on resume, invalidating steer withdraws the pending gate;
"nothing ran — <cause>" card after silent scheduled windows; fallback-in-use badge
(transcript, state dot, per-turn serving model, persistent banner); template
prerequisite checks inline at create; digest suppression/mute/single-bot parity; spawned
tombstones GC after 7 days, user-deleted tombstones metered + purge; migrated-DM
structured refusal; primary-vs-fallback spend attribution; RTL specifics (first column
right, bidi isolation per fragment, Arabic TTS/STT-able options).

**Milestones/cross-refs:** string externalization work item + acceptance in M9.2; knock
aggregation + digest machinery build item in M9.6; M9.6 acceptance strengthened
(timeout states, question TTL path, Arabic voice); M9.7 airplane-mode outcome, model
deprecation re-pin flow, profile export/import; M9.3 per-host mutex + shared/ convention
work item + negative browser acceptance mirrored; §6 browser row = relay target
selection; `profiles_to_serve` consumers probe-enumerated (five more callers named);
waitpid citation corrected (:188–232 registry, os.waitpid :293); multiplex default
nuance (upstream defaults true; preflight-gated — gateway.py:1516); Appendix A ref →
§5 M9.1a; status → v1.2.

### Appendix D.2 — v1.2.1 polish (round-3 verification repairs, 2026-10-10)

Round-3 verification confirmed all repairs landed (V1 12/12, V2 16/17, V3 0 critical /
0 major) and flagged one major + ~15 minors; all closed by the Lead:

- **[MAJOR] Question-expiry semantics reconciled** (§2.6 + §2.8): first TTL expiry →
  proceed with the stated default for that run **only if non-destructive/non-outbound**,
  else abort (mirrors expired-denied); N=3 consecutive expiries → stop asking and commit
  the default for future runs (same non-destructive rule); digest "one-tap change" =
  editor for the committed default (steer offered if a run is live).
- Credential-card rate-limit refusal is structured to the bot (never a silent failure);
  only the user-facing knock is suppressed. PIN gate explicitly covers
  credential-request cards.
- Delegate children of user-interactive parent turns enter the queue at
  approval-unblocking priority (starvation fix). Spawn budget-slice floor = 5% of fleet
  daily budget. Depth cap counting convention stated (3 levels inclusive of parent).
  Spawn approval cards join B15 aggregation. Passive drafts age into inbox view after
  48 h and appear in the digest. Typo fixed ("M9.3 slotting in after").
- 12 orphan acceptance clauses added to §5: first-spawn card + rate caps (M9.1a),
  template prereq checks (M9.2), migrated-DM refusal (M9.3), fallback spend breakout
  (M9.4), inbox ordering / stale-knock answer / steer-to-parked / PIN-inline /
  fallback badge (M9.6), tombstone GC + nothing-ran matrix case (M9.7).
