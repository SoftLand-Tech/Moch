# Findings Index — Moch Bug-Hunter Audit (round 1)

Generated from `findings.jsonl` (94 events, 63 findings). 
Historical discovery events are preserved in the JSONL; this index reflects **current** statuses.

**Severity mix:** High 10 · Medium 27 · Low 23 · Informational 3

**Status mix:** confirmed 46 · fixed 3 · needs_verification 7 · open 6 · rejected 1

| ID | Sev | Conf | Status | Title | File |
|---|---|---|---|---|---|
| BH-000004 | high | high | fixed | long chats open at top, require repeated scrolling to bottom (PR #50 merged; on-device check pending) | `app/app/(tabs)/chat.tsx>124` |
| BH-000017 | high | high | open | keyboard opens over inputs app-wide — focused input and bottom content must rise above the keyboard | `app/app/(tabs)/chat.tsx>1029` |
| BH-000018 | high | medium | confirmed | inflightCreate shared across provisional windows — send in a SECOND new-chat window lands in the FIRST window' | `app/src/lib/chat.ts>1184` |
| BH-000020 | high | high | confirmed | BUG-036 confirmed at HEAD — 120s timeout double-submit, and flushOutbox automates the duplicate on the next fl | `app/src/protocol/json-rpc-channel.ts>252` |
| BH-000021 | high | high | confirmed | BUG-086 confirmed at HEAD — server requests for untracked sessions are unanswerable and show no dot on any scr | `app/src/lib/chat.ts>2096` |
| BH-000027 | high | high | confirmed | test:order mislabeled offline — dials live gateway ws://127.0.0.1:9119 and tests a MIRROR of sessionList.ts | `app/scripts/test-session-order.ts>35` |
| BH-000028 | high | high | confirmed | 17 src/lib modules have no test suite (push 509 lines, mediaSend 343, mediaCache 281, pairing.parseConnectUrl  | `app/src/lib>1` |
| BH-000029 | high | medium | needs_verification | BUG-132 native fixes (commits 122d6bf, 0155696) have zero test coverage at any level | `app/android/app/src/main/java/com/hermes/pocket/hermes/BrowserRelayModule.kt>1` |
| BH-000033 | high | high | needs_verification | browser tools absent from the callable kit after cold start — fix present in this checkout (open PR #61 head)  | `app/hermes-src/model_tools.py>283` |
| BH-000046 | high | medium | confirmed | Always-on runtime runs as a dataSync foreground service with no onTimeout handling — 6-hour hard limit on Andr | `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesService.kt>206` |
| BH-000002 | medium | high | fixed | tray header long titles ellipsize under right-side buttons (PR #48 merged; on-device check pending) | `app/src/components/ScreenShell.tsx>172` |
| BH-000003 | medium | high | fixed | steer chip below composer lifts input off screen bottom (PR #49 merged; on-device check pending) | `app/app/(tabs)/chat.tsx>176` |
| BH-000005 | medium | high | confirmed | terminal Kill -> Retry replays dead session's scrollback into fresh shell | `app/src/lib/terminal.ts>226` |
| BH-000006 | medium | high | confirmed | model picker opened from Settings shows an internal error banner | `app/app/(tabs)/settings.tsx>349` |
| BH-000008 | medium | high | confirmed | loopback gateway hands out its own session token without auth on / — any app on the phone can read it and driv | `app/python-runtime/moch/gateway_server.py>161` |
| BH-000009 | medium | high | confirmed | browser gate failure mode — agent improvises (curl/terminal) instead of saying browser tools are unavailable | `app/hermes-src/tools/tool_search.py>365` |
| BH-000012 | medium | medium | open | browser_console answers 'JavaScript evaluation is not supported by this browser backend. agent-browser CLI not | `app/hermes-src/tools/browser_tool.py>432` |
| BH-000013 | medium | medium | open | 'No browser page' while relay is up and tab loaded — attachment lost across CDP navigation; only fresh navigat | `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt>442` |
| BH-000015 | medium | high | confirmed | Settings -> 'Stop runtime' does nothing — app keeps running, gateway keeps serving, failure swallowed | `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesService.kt>52` |
| BH-000016 | medium | high | confirmed | session list rows carry no running marker (upstream REST rows expose none; client maps none) | `app/src/lib/sessionList.ts>493` |
| BH-000019 | medium | high | confirmed | pinned offline send from a provisional chat resolves ensureSession() against the ACTIVE chat at flush time | `app/src/lib/chat.ts>1757` |
| BH-000026 | medium | high | confirmed | lint gate fails at HEAD — rules-of-hooks false positive on PairForm useThisPhone (npm run verify red) | `app/src/components/PairForm.tsx>141` |
| BH-000030 | medium | high | confirmed | moch.* fleet RPC layer effectively untested here — test_rpc_fleet 4/4 skipped (hermes server deps unavailable) | `app/python-runtime/tests/test_rpc_fleet.py>98` |
| BH-000034 | medium | high | confirmed | Relay treats knowledge of tokenHash as machine identity — no proof-of-possession of the raw token at /control | `relay/moch-relay-server.js>183` |
| BH-000035 | medium | high | confirmed | Raw pairing token travels in relay URL query strings on both legs — lands in reverse-proxy access logs; 'relay | `relay/moch-relay-server.js>308` |
| BH-000036 | medium | high | confirmed | Relay registration is open by default; unauthenticated /control sockets have no lifecycle cap | `relay/moch-relay-server.js>61` |
| BH-000037 | medium | medium | confirmed | Release builds silently fall back to the publicly tracked debug.keystore; the keystore itself is committed | `app/android/app/build.gradle>95` |
| BH-000045 | medium | high | confirmed | In-process CdpRelay.stop() leaves a pid-valid relay.json and an armed browser gate — tools advertised against  | `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt>127` |
| BH-000047 | medium | high | confirmed | HermesRuntime boot chain is single-shot and single-try: any gateway failure silently disables cron knocks for  | `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesRuntime.kt>30` |
| BH-000050 | medium | high | confirmed | Setup wizard offers Debian 12 but its pinned rootfs URL is dead (misspelled GitHub org) — provisioning always  | `app/python-runtime/moch/linux_env.py>51` |
| BH-000080 | medium | high | confirmed | Fleet create/freeze failures are silently swallowed (no catch, unhandled rejection) | `app/app/(tabs)/fleet.tsx>57` |
| BH-000081 | medium | high | confirmed | Bot detail Save and Delete swallow RPC errors — Save shows nothing, Delete leaves the bot alive with no feedba | `app/app/bot.tsx>58` |
| BH-000082 | medium | medium | needs_verification | Automation edit pre-fills the prompt from prompt_preview and writes it back — truncated preview can overwrite  | `app/app/(tabs)/automations.tsx>188` |
| BH-000084 | medium | medium | needs_verification | AgentBrowserHost gives up permanently if the first relay boot fails — no retry for the whole process lifetime | `app/src/components/AgentBrowserHost.tsx>36` |
| BH-000086 | medium | high | confirmed | Settings -> Install Linux environment swallows all bootstrap errors (the BUG-016 pattern fixed in setup.tsx bu | `app/app/(tabs)/settings.tsx>62` |
| BH-000087 | medium | medium | needs_verification | Keyboard-avoidance mandated by AGENTS.md is missing on several input surfaces (plain ScrollView / no kbPad) | `app/app/index.tsx>44` |
| BH-000091 | medium | medium | needs_verification | AgentBrowserHost's resident WebView has no onRenderProcessGone/onError recovery — a killed renderer silently k | `app/src/components/AgentBrowserHost.tsx>50` |
| BH-000001 | low | high | open | raw server strings in UI (item.source verbatim, delete-failure alerts, optimistic '0 msgs' row) | `app/src/lib/sessionList.ts>120` |
| BH-000007 | low | high | confirmed | About shows 'Moch v1.0', not the installed build | `app/app/(tabs)/settings.tsx>266` |
| BH-000010 | low | medium | open | SQLite WAL-reset vulnerability warning on every boot with non-actionable advice | `app/hermes-src/hermes_state.py>369` |
| BH-000011 | low | medium | confirmed | rejected pairing link gives no feedback at all | `app/app/add-computer.tsx>402` |
| BH-000014 | low | high | open | data: URLs refused with the wrong reason (_url_policy_error -> _is_safe_url mismatch) | `app/hermes-src/tools/browser_tool.py>460` |
| BH-000022 | low | low | rejected | steerRun falls through to session.steer on unrecognized session.redirect status — potential double-apply of st | `app/src/lib/chat.ts>1958` |
| BH-000023 | low | high | confirmed | isKnownSlashCommand returns true on empty catalog — offline/boot any '/…' text errors as 'Command failed' inst | `app/src/lib/slash.ts>266` |
| BH-000024 | low | high | confirmed | migrateV1Transcript interim-key early return skips legacy live-keyed v1 cleanup — AsyncStorage blobs stranded | `app/src/lib/chat.ts>624` |
| BH-000025 | low | medium | confirmed | batch clarify Send enabled without per-question answers — unanswered qids silently omitted from answers map | `app/src/lib/chat.ts>2064` |
| BH-000031 | low | high | confirmed | BUG-102/BUG-103 UI fixes have no regression tests (layout logic not extractable-tested today) | `app/app/(tabs)/chat.tsx>1` |
| BH-000038 | low | high | confirmed | usesCleartextTraffic=true app-wide, and pairing links default tls=0 — a crafted hermes://connect QR silently d | `app/android/app/src/main/AndroidManifest.xml>23` |
| BH-000039 | low | high | confirmed | WebView debugging enabled process-wide in release builds — resident agent WebView holds browsing session, cook | `app/src/components/AgentBrowserHost.tsx>50` |
| BH-000040 | low | high | confirmed | Executable bootstrap artifacts (proot loader .deb, Ubuntu rootfs, QR renderer) downloaded with no checksum pin | `app/python-runtime/moch/linux_env.py>37` |
| BH-000041 | low | high | confirmed | docs/install.sh (the publicly served copy) has diverged from canonical moch-link/install.sh | `docs/install.sh>474` |
| BH-000048 | low | high | confirmed | gateway_server never sets _STATE['starting']=True — getGateway reports running=false during the entire cold bo | `app/python-runtime/moch/gateway_server.py>33` |
| BH-000051 | low | high | confirmed | linux_session.run timeout desynchronizes the persistent guest shell (orphaned sentinel/rc lines poison the nex | `app/python-runtime/moch/linux_session.py>106` |
| BH-000055 | low | medium | confirmed | moch-link install.sh checks node/npm but never systemctl — dies mid-install on hosts without a systemd user se | `moch-link/install.sh>334` |
| BH-000083 | low | high | confirmed | Deep-link pairing error toast (linkMsg) is never dismissed — sticks on screen for the rest of the session | `app/app/_layout.tsx>351` |
| BH-000085 | low | high | confirmed | Content-search hit rows in Chats always render '0 msgs' — constructed SessionRow omits message_count | `app/app/(tabs)/sessions.tsx>120` |
| BH-000088 | low | medium | needs_verification | Reasoning-effort writes pass the raw active sid — a provisional (unsent) chat id goes to config.set and fails, | `app/app/(tabs)/agent.tsx>89` |
| BH-000089 | low | high | confirmed | Crew board: pull-to-refresh spinner can never show and offline renders as an indistinguishable empty board | `app/app/(tabs)/crew.tsx>59` |
| BH-000092 | low | high | confirmed | automations modal uses RNKC KAV behavior='height' on Android (the pattern AGENTS.md rejects on-device); ModelP | `app/app/(tabs)/automations.tsx>316` |
| BH-000093 | low | high | confirmed | browser relay-failure state has no retry — recovery requires leaving and re-entering the screen | `app/app/(tabs)/browser.tsx>66` |
| BH-000032 | informational | high | confirmed | GitHub issue tracker is empty (0 issues, API-verified exhaustive) — all bug history is PR titles + local bugs. | `bugs.md>1` |
| BH-000042 | informational | high | confirmed | CdpRelay loopback token compared with non-constant-time !=; token is 128-bit random and loopback-only | `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt>201` |
| BH-000043 | informational | high | confirmed | Secret-file hygiene verified clean on the tracked-tree side; debug keystore + google-services.json are the onl | `app/android/app/google-services.json>1` |


## BH-000004 — long chats open at top, require repeated scrolling to bottom (PR #50 merged; on-device check pending)

- **Severity:** high · **Confidence:** high · **Status:** fixed · **Source:** existing_tracker
- **Location:** `app/app/(tabs)/chat.tsx` line ~124
- **Related:** BUG-103
  - Evidence: bugs.md:124 tracker entry (unchecked, 'fixed in PR #50 — on-device check pending')
  - Evidence: PR #50 merged (agent E)
  - Evidence: no regression test exists (agent D-06)
- **Resolution:** merged_pr — https://github.com/SoftLand-Tech/Moch/pull/50 (code fix merged; on-device confirmation pending)

## BH-000017 — keyboard opens over inputs app-wide — focused input and bottom content must rise above the keyboard

- **Severity:** high · **Confidence:** high · **Status:** open · **Source:** existing_tracker
- **Location:** `app/app/(tabs)/chat.tsx` line ~1029
- **Related:** BUG-133
  - Evidence: bugs.md:1029 tracker entry (NEW, WIP)
  - Evidence: user report 2026-10-12; keyboard-avoidance audit in progress in worktrees/keyboard-avoidance (per tracker)
  - Repro: Focus any TextInput with keyboard open — input stays under keyboard (user report)

## BH-000018 — inflightCreate shared across provisional windows — send in a SECOND new-chat window lands in the FIRST window's session

- **Severity:** high · **Confidence:** medium · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~1184
  - Evidence: chat.ts:1184 'if (inflightCreate) return await inflightCreate' — no per-window keying
  - Evidence: chat.ts:1187-1191 single module-global promise
  - Evidence: chat.ts:1755-1760 sendPrompt provisional branch resolves ACTIVE window's create
  - Evidence: chat.ts:1247-1250 activeLiveId same defect
  - Evidence: chat.ts:1271-1302 newChat() mints a second provisional freely
  - Repro: Tap New, send (create in flight), tap New again, send — second message lands in chat 1 (timing-dependent)

## BH-000020 — BUG-036 confirmed at HEAD — 120s timeout double-submit, and flushOutbox automates the duplicate on the next flush

- **Severity:** high · **Confidence:** high · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/protocol/json-rpc-channel.ts` line ~252
- **Related:** BUG-036
  - Evidence: json-rpc-channel.ts:252-258 timeout rejects client promise only; frame already sent, no cancellation
  - Evidence: chat.ts:1847-1863 prompt.submit carries no idempotency key
  - Evidence: chat.ts:852-862 flushOutbox re-enqueues on submit-phase failure
  - Evidence: chat.ts:1896-1915 retryMessage resubmits same text
  - Evidence: bugs.md:212 tracker entry (unchecked) — same bug, merged here
  - Repro: Throttle link so prompt.submit ack >120s; row fails but server runs the turn; retry or next flush duplicates the turn

## BH-000021 — BUG-086 confirmed at HEAD — server requests for untracked sessions are unanswerable and show no dot on any screen

- **Severity:** high · **Confidence:** high · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~2096
- **Related:** BUG-086
  - Evidence: chat.ts:2096-2100 rebind fails for untracked sessions
  - Evidence: chat.ts:232-236 pendingRequest computed over activeSession never matches untracked key
  - Evidence: chat.ts:255-264 pendingStoredIds drops entries with no live->stored map
  - Evidence: bugs.md:120 tracker entry (unchecked) — same bug, merged here
  - Evidence: TEST-REPORT device evidence (approvals unanswerable from phone)
  - Repro: Start automation/CLI session on the host; let it raise an approval — phone shows no card and no dot until deadline

## BH-000027 — test:order mislabeled offline — dials live gateway ws://127.0.0.1:9119 and tests a MIRROR of sessionList.ts

- **Severity:** high · **Confidence:** high · **Status:** confirmed · **Source:** agent_D
- **Location:** `app/scripts/test-session-order.ts` line ~35
  - Evidence: test-session-order.ts:6-8 reads ~/.config/hermes-serve.env token, connects live
  - Evidence: test-session-order.ts:35 '/** Mirrors src/lib/sessionList.ts */' local copy
  - Evidence: no suite imports the real sessionList module
  - Repro: Run test:order on a machine without a gateway — exits 1 'no token'

## BH-000028 — 17 src/lib modules have no test suite (push 509 lines, mediaSend 343, mediaCache 281, pairing.parseConnectUrl untested, gateway dial/backoff state machine only incidentally covered)

- **Severity:** high · **Confidence:** high · **Status:** confirmed · **Source:** agent_D
- **Location:** `app/src/lib` line ~1
  - Evidence: import-grep across scripts/test-*.ts enumerates covered modules (agent D)
  - Evidence: pairing.parseConnectUrl never fuzzed despite parsing untrusted deep links
  - Repro: grep -n 'src/lib' app/scripts/test-*.ts; diff against ls app/src/lib

## BH-000029 — BUG-132 native fixes (commits 122d6bf, 0155696) have zero test coverage at any level

- **Severity:** high · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_D
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/BrowserRelayModule.kt` line ~1
- **Related:** BUG-132
  - Evidence: git show --stat: only BrowserRelayModule.kt touched, no tests
  - Evidence: test_browser_boot_gate.py covers only pid-staleness
  - Evidence: BUG-132 still open/WIP (bugs.md:975)
  - Repro: git show 122d6bf --stat; grep -n '120|retry' app/python-runtime/tests/test_browser_boot_gate.py — none

## BH-000033 — browser tools absent from the callable kit after cold start — fix present in this checkout (open PR #61 head) but unmerged and end-to-end acceptance pending

- **Severity:** high · **Confidence:** high · **Status:** needs_verification · **Source:** agent_E
- **Location:** `app/hermes-src/model_tools.py` line ~283
- **Related:** BUG-132, BH-000030
- **GitHub:** https://github.com/SoftLand-Tech/Moch/pull/61
  - Evidence: bugs.md:975,1011,1040,1067 rounds 31-34 (WIP)
  - Evidence: model_tools.py:283-284 cache key now carries MOCH_BROWSER_RELAY + BROWSER_CDP_URL (fix present at HEAD; agent E verified)
  - Evidence: BrowserRelayModule.kt:68 gate-arm retry; AgentBrowserHost.tsx present; tests/test_browser_cache_key.py present
  - Evidence: HEAD 3191fe1 IS open PR #61's head — fix NOT on main
  - Evidence: PR author: on-device acceptance interrupted (USB dropped)
  - Evidence: round 33 probe: agent answered 'No browser tool in my kit' and improvised with fetch
  - Repro: Build from main: cold boot, new chat, ask to open example.com — browser_* absent (tracker round 33)
  - Repro: On this branch: complete the interrupted fresh-boot acceptance
- **Annotation (corroboration_and_evidence):** B-10 (agent B, independent): Verified present and mutually consistent: native relay start before Python boot (MainApplication.kt:70-75, writes pid-valid relay.json at process creation), 120x1s arm-retry loop polling Python.isStarted (BrowserRelayModule.kt:51-68), pre-serve relay.json re-arm (gateway_server.py:141-153), pid-gated boot arming + cache invalidation in browser_gate.activate (browser_gate.py:31-96). Per bugs.md round 34, however, the on-device callable kit is exactly the 6 deferred/bridge tools — no browser_*, no file/memory tools — so none of these arming paths can fix the symptom; the suspects live in hermes-src toolset selection (_get_platform_tools/_select_tool_names with an empty config.yaml).

## BH-000046 — Always-on runtime runs as a dataSync foreground service with no onTimeout handling — 6-hour hard limit on Android 15+ devices

- **Severity:** high · **Confidence:** medium · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesService.kt` line ~206
- **Failure scenario:** Manifest declares HermesService with android:foregroundServiceType="dataSync" (AndroidManifest.xml:39) and onStartCommand promotes it with FOREGROUND_SERVICE_TYPE_DATA_SYNC. On devices running Android 15 (API 35)+, dataSync FGS instances are capped at 6 hours per 24h: the system calls Service.onTimeout(int), and if the service does not stop itself the system throws ForegroundServiceDidNotStopInTimeException (process crash) after the grace period. HermesService has no onTimeout override, no type rotation, and the whole product premise ('Mochi is awake on this phone', START_STICKY automations) dies ~6h into every heavy day on those devices — taking the embedded gateway, cron-knocks watcher and FleetTurnQueue with it.
  - Evidence: AndroidManifest.xml:39 — <service ... foregroundServiceType="dataSync"/>
  - Evidence: HermesService.kt:207-208 — startForeground(NOTIFICATION_ID, notification, FOREGROUND_SERVICE_TYPE_DATA_SYNC)
  - Evidence: HermesService.kt — grep: no onTimeout(short/int) override anywhere under app/android/app/src/main
  - Repro: On an Android 15+ device, keep the app alive with the foreground service across >6h cumulative runtime in a 24h window
  - Repro: Observe onTimeout -> unhandled -> ForegroundServiceDidNotStopInTimeException (logcat) and runtime death
- **Remediation:** Override onTimeout(int) to stopSelf cleanly (and notify/persist), or move to a type without the 6h cap that Moch legitimately qualifies for (e.g. specialUse with a justification).

## BH-000002 — tray header long titles ellipsize under right-side buttons (PR #48 merged; on-device check pending)

- **Severity:** medium · **Confidence:** high · **Status:** fixed · **Source:** existing_tracker
- **Location:** `app/src/components/ScreenShell.tsx` line ~172
- **Related:** BUG-101
  - Evidence: bugs.md:172 tracker entry (unchecked, 'fixed in PR #48 — on-device check pending')
  - Evidence: PR #48 merged 2026-10-10 (agent E)
- **Resolution:** merged_pr — https://github.com/SoftLand-Tech/Moch/pull/48 (code fix merged; on-device confirmation pending per tracker)

## BH-000003 — steer chip below composer lifts input off screen bottom (PR #49 merged; on-device check pending)

- **Severity:** medium · **Confidence:** high · **Status:** fixed · **Source:** existing_tracker
- **Location:** `app/app/(tabs)/chat.tsx` line ~176
- **Related:** BUG-102
  - Evidence: bugs.md:176 tracker entry (unchecked, 'fixed in PR #49 — on-device check pending')
  - Evidence: PR #49 merged (agent E)
  - Evidence: no regression test exists (agent D-06)
- **Resolution:** merged_pr — https://github.com/SoftLand-Tech/Moch/pull/49 (code fix merged; on-device confirmation pending)

## BH-000005 — terminal Kill -> Retry replays dead session's scrollback into fresh shell

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/src/lib/terminal.ts` line ~226
- **Related:** BUG-115
  - Evidence: bugs.md:341 tracker entry (unchecked)
  - Evidence: TEST-REPORT-1.0.15-device.md: terminal verdict '7/9 steps pass; one defect: Kill -> Retry replays scrollback' (on-device)
  - Evidence: python side clears chunks on respawn (terminal.py ~200: _state.chunks.clear()) — replay buffer is client-side (terminal.ts:226-250)
  - Repro: Device: open terminal, run cmd, Kill, Retry — old scrollback reappears in fresh shell (TEST-REPORT runbook)
- **Annotation (corroboration_and_evidence):** B-08 (agent B, independent): _close_locked() and kill() clear _state.chunks but nothing ever clears _state.replay (the 64KB reattach buffer banked by _bank()); start() clears chunks only as well. Kill -> Retry therefore serves replay() with the previous (dead) shell's last 64KB as the fresh session's initial screen — the exact tracker symptom.

## BH-000006 — model picker opened from Settings shows an internal error banner

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/app/(tabs)/settings.tsx` line ~349
- **Related:** BUG-117
  - Evidence: bugs.md:349 tracker entry (unchecked)
  - Evidence: TEST-REPORT-1.0.15-device.md: 'model picker from Settings shows an internal error banner (BUG-117)'
  - Repro: Device: Settings -> open model picker — internal error banner (TEST-REPORT)

## BH-000008 — loopback gateway hands out its own session token without auth on / — any app on the phone can read it and drive the full API

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/python-runtime/moch/gateway_server.py` line ~161
- **Related:** BUG-120
  - Evidence: bugs.md:361 tracker entry (unchecked)
  - Evidence: TEST-REPORT-1.0.15-device.md security row: 'loopback gateway serves its own session token unauthenticated on /; any app on the phone can read it' (on-device proof)
  - Evidence: gateway_server.py:161-181: binds 127.0.0.1, stable per-install token minted at :52-76 (lead verified)
  - Evidence: Android loopback is shared by all apps in the same network namespace context for unauthenticated reads — preconditions: malicious app co-installed on the phone
  - Repro: Device: curl http://127.0.0.1:9119/ from any app context — token returned (TEST-REPORT)
- **Annotation (impact_amplification):** Agent C confirms BUG-120 still accurate and amplifies impact: the leaked loopback token reaches gateway RPC -> HermesBridge -> linux_session.run()/terminal.write() — a full agent-controlled guest shell over proot (binds: workspace, scratch, /dev, /proc only; no /system or /data bind). Practical impact is guest-shell access inside app-private storage, not just transcript reads. No RCE-beyond-app-UID path found in Moch-authored code.

## BH-000009 — browser gate failure mode — agent improvises (curl/terminal) instead of saying browser tools are unavailable

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/hermes-src/tools/tool_search.py` line ~365
- **Related:** BUG-121, BH-000019
  - Evidence: bugs.md:365 tracker entry (unchecked)
  - Evidence: TEST-REPORT-1.0.15-device.md browser verdict + BUG-132 rounds 31-34: agent improvises with terminal when tools absent
  - Repro: Fresh boot, ask agent to open a URL before tools arm — agent uses terminal/curl (bugs.md round 33 probe)

## BH-000012 — browser_console answers 'JavaScript evaluation is not supported by this browser backend. agent-browser CLI not found (cached)' in WebView mode

- **Severity:** medium · **Confidence:** medium · **Status:** open · **Source:** existing_tracker
- **Location:** `app/hermes-src/tools/browser_tool.py` line ~432
- **Related:** BUG-126
  - Evidence: bugs.md:432 tracker entry (unchecked)
  - Evidence: negative result cached — console backend check in browser_tool.py

## BH-000013 — 'No browser page' while relay is up and tab loaded — attachment lost across CDP navigation; only fresh navigate recovers

- **Severity:** medium · **Confidence:** medium · **Status:** open · **Source:** existing_tracker
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt` line ~442
- **Related:** BUG-127
  - Evidence: bugs.md:442 tracker entry (unchecked)
  - Evidence: CdpRelay.kt:256+ implements /json/list active-tab filter (pages.filter url.startsWith(prefix)) — per-page attach identity changes on navigation (lead read)
  - Evidence: upstream per-page attach in browser_supervisor.py (vendored)

## BH-000015 — Settings -> 'Stop runtime' does nothing — app keeps running, gateway keeps serving, failure swallowed

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesService.kt` line ~52
- **Related:** BUG-129
  - Evidence: bugs.md:469 tracker entry (unchecked)
  - Evidence: lead verified at HEAD: HermesBridgeModule.stop() -> HermesService.stop() (:52-54) only calls stopService; Python gateway thread keeps running (no python-side stop exists — 'stop/restart deferred to Milestone 6' per gateway_server.py docstring :18-19); real teardown is shutdownProcess (process exit) wired only to the notification Stop action
  - Evidence: TEST-REPORT device evidence
  - Repro: Settings -> Stop runtime; observe foreground service notification gone but gateway still answers on 127.0.0.1 (tracker/TEST-REPORT)
- **Annotation (corroboration_and_evidence):** B-09 (agent B, independent): HermesBridgeModule.stop() calls HermesService.stop() which is just context.stopService(...). The Chaquopy interpreter, the loopback gateway (127.0.0.1:9119, holding the session token) and the cron-knocks watcher all live in the main app process and keep running; shutdownProcess() (the only real teardown) is reachable solely from the notification's Stop action.

## BH-000016 — session list rows carry no running marker (upstream REST rows expose none; client maps none)

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/src/lib/sessionList.ts` line ~493
- **Related:** BUG-131
  - Evidence: bugs.md:493 tracker entry (unchecked)
  - Evidence: lead: sessionList.ts row mapping consumes no running/busy field; upstream hermes_cli/web_routers/sessions.py list rows expose none
  - Evidence: TEST-REPORT device pass: no running markers observed

## BH-000019 — pinned offline send from a provisional chat resolves ensureSession() against the ACTIVE chat at flush time

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~1757
- **Related:** BUG-008
  - Evidence: chat.ts:1799 enqueueOffline pins to pseudo 'new:…' storedId
  - Evidence: chat.ts:832-834 flushOutbox pins send to provisional temp key
  - Evidence: chat.ts:1757-1760 ensureSession() ignores 'pinned', reads activeSession
  - Evidence: violates pinned-delivery invariant documented for BUG-008 (fixed)
  - Repro: Offline: New -> type -> send; switch chats; reconnect — message submits to currently active chat
- **Annotation (confidence_raised):** Challenger raised A-02 confidence medium->high: sendPrompt's pinned-provisional branch calls ensureSession() which reads activeSession, not the pinned chat; the misdelivery via pseudo 'new:…' storedId is plainly readable at chat.ts:1757.

## BH-000026 — lint gate fails at HEAD — rules-of-hooks false positive on PairForm useThisPhone (npm run verify red)

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_D
- **Location:** `app/src/components/PairForm.tsx` line ~141
  - Evidence: npm run lint exit 1 (agent D run)
  - Evidence: PairForm.tsx:65 plain async function named use*; :141 called in onPress callback
  - Evidence: 32 warnings also present
  - Repro: cd app && npm run lint — exit 1

## BH-000030 — moch.* fleet RPC layer effectively untested here — test_rpc_fleet 4/4 skipped (hermes server deps unavailable)

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_D
- **Location:** `app/python-runtime/tests/test_rpc_fleet.py` line ~98
  - Evidence: test_rpc_fleet.py:98 skipTest('hermes server deps unavailable')
  - Evidence: run output: Ran 4 tests, OK (skipped=4)
  - Repro: cd app/python-runtime && python3 tests/test_rpc_fleet.py — 4 skipped

## BH-000034 — Relay treats knowledge of tokenHash as machine identity — no proof-of-possession of the raw token at /control

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `relay/moch-relay-server.js` line ~183
- **Failure scenario:** handleRegister authenticates a machine by tokenHash alone. Anyone who learns a machine's sha256(token) (the only value the relay persists in state.json) can register as that machine's id, or re-pair the hash away from a currently-offline legitimate machine (lines 192-203 explicitly delete the offline twin), then receive {t:'conn'} knocks and open /tunnel legs. They still cannot answer the phone's handshake (the home gateway would 401), but they occupy the machine slot, receive connection metadata, and can blackhole/DoS the pairing; combined with C-02's raw-token exposure paths any hash leak becomes a full machine-takeover primitive.
  - Evidence: relay/moch-relay-server.js:183-190 — registration validates only id shape, tokenHash shape, optional relay key; never the raw token
  - Evidence: relay/moch-relay-server.js:192-203 — offline twin holding the same tokenHash is deleted ('re-pairing token hash from offline machine')
  - Evidence: relay/moch-relay-server.js:146 — state.json reload restores tokenHash as the sole credential
  - Evidence: preconditions: Attacker has read access to the relay state file (/root/.moch/relay-service/state.json on the VPS — root compromise, backup leak, or misconfigured perms) or any other hash disclosure, plus network reachability to /control. The legitimate machine must be offline for the takeover path (line 197 refuses a live holder).
  - Repro: On any host, open ws /control to the relay
  - Repro: Send {t:'register', machine:'m-x', tokenHash:<hash read from state.json>} — accepted unless the hash holder is live
  - Repro: Phone dials /api/ws?token=<real token>; relay routes the conn to the attacker's socket
- **Remediation:** Require the raw token (or an HMAC over a server nonce) at /control registration, exactly as /tunnel already does; keep only the hash at rest.

## BH-000035 — Raw pairing token travels in relay URL query strings on both legs — lands in reverse-proxy access logs; 'relay never sees the token' comment is false

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `relay/moch-relay-server.js` line ~308
- **Failure scenario:** The phone dials /api/ws?token=<raw pairing token> (app/src/lib/gateway.ts:149); the relay reads the raw token and hashes it locally (line 312), and moch-tunnel dials /tunnel/<id>?key=<raw token> (moch-link/install.sh:223). TLS terminates at nginx on the VPS, so the relay operator (and anyone reading nginx access logs, which by default log the full query string) obtains the raw gateway pairing token. That token IS the full session credential: with it one can dial /api/ws directly and drive the user's entire hermes gateway (sessions, transcripts, file r/w, exec approval flow) whenever the home machine is online. The header comments at relay:9-12 and install.sh:40-44 ('the relay never sees the pairing token, only its sha256') are incorrect.
  - Evidence: relay/moch-relay-server.js:308-312 — token taken from url.searchParams.get('token') before hashing
  - Evidence: relay/moch-relay-server.js:377-381 — /tunnel?key=<raw token>
  - Evidence: app/src/lib/gateway.ts:148-149 — token embedded in the WS dial URL (query string, not header)
  - Evidence: app/src/lib/push.ts advertisement: push token also on the query string (gateway.ts:158)
  - Evidence: moch-link/install.sh:222-223 — raw token as the tunnel-leg key in a URL
  - Evidence: preconditions: Position: any reader of VPS logs (nginx access.log, journal) or the relay process memory/operator. No exploit needed — standing exposure by design of the URL transport.
  - Repro: nginx on the relay VPS logs GET /api/ws?token=… verbatim (default log format)
  - Repro: grep the access log → recover the pairing token → dial wss://api.moch.softland.tech/api/ws?token=… and speak JSON-RPC as the user
- **Remediation:** Move the phone token to the X-Hermes-Session-Token header (already supported by the relay, line 305-309, and by the app's REST path) and have the WS client send it in a header too; send the tunnel key in a header as well. Fix the misleading comments.

## BH-000036 — Relay registration is open by default; unauthenticated /control sockets have no lifecycle cap

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `relay/moch-relay-server.js` line ~61
- **Failure scenario:** --require-key defaults to empty (line 61), so any internet host that can reach the relay port may register up to --max-machines-per-ip (20) machines with arbitrary ids and arbitrary tokenHashes. Registration is permanent (persisted to state.json), enabling: (a) state.json pollution/persistence on the VPS; (b) socket-flooding /control before register — sockets that never register get no heartbeat and no timeout, so idle connections hold server resources indefinitely; (c) /health (line 433) leaks online-machine and live-connection counts unauthenticated. A remote attacker cannot evict another IP's machines (eviction at lines 217-227 is same-IP only), so impact is abuse-of-service and reconnaissance, not session hijack.
  - Evidence: relay/moch-relay-server.js:61 — requireKey: '' default
  - Evidence: relay/moch-relay-server.js:183-266 — no auth path when requireKey empty
  - Evidence: relay/moch-relay-server.js:268-287 — connection handler sets no idle timeout for never-registering sockets
  - Evidence: relay/moch-relay-server.js:433-436 — unauthenticated /health returns counts
  - Evidence: relay/moch-relay-server.js:498 — server.listen(cfg.port) binds all interfaces (no host arg)
  - Evidence: preconditions: Network reachability to the relay port. PROJECT.md puts the relay behind nginx on api.moch.softland.tech; if the raw port (9591) is firewalled and nginx only proxies specific paths, exposure shrinks accordingly — config not in repo.
  - Repro: Open N idle /control WebSocket connections; send nothing — none are ever reaped
  - Repro: Register 20 machines with random hashes from one IP; they persist across restarts via state.json
- **Remediation:** Default --require-key on (or auto-generate a key at deploy), add a register-timeout for unauthenticated control sockets, and gate /health counts behind the key.

## BH-000037 — Release builds silently fall back to the publicly tracked debug.keystore; the keystore itself is committed

- **Severity:** medium · **Confidence:** medium · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/android/app/build.gradle` line ~95
- **Failure scenario:** signingConfigs.release is populated only when keystore.properties exists (gitignored); otherwise buildTypes.release signs with signingConfigs.debug, whose keystore is tracked in the repo at app/android/app/debug.keystore with the universal 'android' passwords. PROJECT.md documents local ./gradlew assembleRelease as the routine test path, and the GitHub-hosted v1.0.0 APK predates the EAS flow. If any distributed APK is signed with this key, anyone with the repo can build a malicious 'update' that Android installs over it (same signature → silent upgrade path with all permissions, including RECORD_AUDIO, SYSTEM_ALERT_WINDOW, and the embedded agent runtime).
  - Evidence: app/android/app/build.gradle — release block: signingConfig keystorePropertiesFile.exists() ? signingConfigs.release : signingConfigs.debug
  - Evidence: git ls-files — app/android/app/debug.keystore is tracked; passwords 'android' hardcoded in build.gradle
  - Evidence: PROJECT.md:82-85 — local gradle release builds are the norm for testing
  - Evidence: preconditions: A released/sideloaded APK actually signed by the debug key (v1.0.0 release signing not verifiable in-repo), plus attacker knowledge of the repo (public).
  - Repro: git clone the repo; assembleRelease with no keystore.properties → APK signed with the committed key
  - Repro: If a published APK shares that signature, adb install -r the malicious APK upgrades it in place
- **Remediation:** Make release builds fail (not fall back) when keystore.properties is absent; remove debug.keystore from git or accept it for debug variant only.

## BH-000045 — In-process CdpRelay.stop() leaves a pid-valid relay.json and an armed browser gate — tools advertised against a dead relay

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt` line ~127
- **Related:** BUG-105
- **Failure scenario:** User opens the Browser screen and taps Stop (BrowserRelayModule.stop -> CdpRelay.stop). stop() only sets running=false and closes the accept ServerSocket: it never deletes/updates <home>/browser/relay.json (still holding pid=myPid, port, token), never terminates live WS pump tunnels, never resets the Python gate. The app pid is unchanged, so hermes_boot._arm_browser_gate_from_relay_file (hermes_boot.py:182 'if _port>0 and _token and _pid == os.getpid()') considers the file LIVE and arms BROWSER_CDP_URL+MOCH_BROWSER_RELAY on the next boot re-check or pre-serve re-arm (gateway_server.py:146-153), and browser_gate._STATE.active stays True. A new chat then gets browser_* tools whose every call dials 127.0.0.1:9334 -> connection refused / 'relay is not running'.
  - Evidence: CdpRelay.kt:127-132 — stop() body: running.set(false), server.close, nothing else
  - Evidence: CdpRelay.kt:176-188 — writeStateFile writes pid=myPid; nothing removes the file
  - Evidence: hermes_boot.py:180-184 — arming condition is pid == os.getpid(), which still holds after an in-process stop
  - Evidence: browser_gate.py:31-38 — activate() sets active=True; no deactivate path exists anywhere
  - Repro: Open Browser screen, start relay (relay.json now has live pid)
  - Repro: Tap the relay Stop control (src/lib/browserRelay.ts:121 -> BrowserRelayModule.stop)
  - Repro: Start a new chat and ask the agent to browse — tools are in the kit (gate still armed) but every call fails against the dead port
- **Remediation:** In CdpRelay.stop(): delete relay.json (or rewrite with pid:0), close any live tunnel sockets, and call moch.browser_gate deactivate/status reset via Python when started.

## BH-000047 — HermesRuntime boot chain is single-shot and single-try: any gateway failure silently disables cron knocks for the whole process life

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/HermesRuntime.kt` line ~30
- **Failure scenario:** HermesRuntime.start() guards with bootAttempted.compareAndSet(false,true) and runs selftest -> hermes_boot.boot -> gateway_server.start -> cron_knocks.start inside ONE try/catch that only logs. gateway_server.start blocks up to 90s waiting for the port and can raise (port 9119 occupied, start_server import failure, uvicorn bind error). If it raises — or if anything between selftest and cron_knocks throws — the catch logs 'python boot failed' and cron_knocks.start is never reached; bootAttempted stays true so no retry is possible until process death. Result: every automation completion is silent forever — the exact 'no knock' failure class the watcher was built for, with nothing in the UI distinguishing it.
  - Evidence: HermesRuntime.kt:28 — bootAttempted.compareAndSet(false, true) one-shot
  - Evidence: HermesRuntime.kt:38-43 — gateway start precedes cron_knocks.start in the same try block
  - Evidence: gateway_server.py:44-49,161-206 — start() waits up to _READY_TIMEOUT_S=90s; _port_accepts can race a foreign listener on the fixed port 9119
  - Repro: Hold 127.0.0.1:9119 open (or make start_server throw) before the app boots
  - Repro: Launch app; logcat shows 'python boot failed' once
  - Repro: Create an automation and let it run — it completes with no notification, permanently (until full process restart)
- **Remediation:** Arm cron_knocks FIRST (it is independent of the gateway), and/or put each stage in its own try/catch; consider resetting bootAttempted on gateway failure so a later getGateway() can retry start().

## BH-000050 — Setup wizard offers Debian 12 but its pinned rootfs URL is dead (misspelled GitHub org) — provisioning always fails for that choice

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/python-runtime/moch/linux_env.py` line ~51
- **Failure scenario:** ROOTFS_URLS['debian-12'] points at github.com/debuerreumaker/docker-debian-artifacts (the real org is 'debuerreotype'); the code comment itself admits 'this URL is DEAD (HTTP 404...)' and defers the fix. Meanwhile app/app/setup.tsx:122 still offers 'Debian 12 — smaller base, rock solid' in the wizard. Choosing it makes bootstrap() fail at the rootfs download step — a user-facing dead option shipped in release.
  - Evidence: linux_env.py:58 — 'debuerreumaker' org in ROOTFS_URLS['debian-12']
  - Evidence: linux_env.py:53-57 — comment: 'this URL is DEAD (HTTP 404 ...) fix is a tracked follow-up'
  - Evidence: app/app/setup.tsx:122 — { id: 'debian-12', name: 'Debian 12', ... } offered in the wizard
  - Evidence: bugs.md — no BUG entry mentions debian (grep: 0 hits)
  - Repro: Run setup wizard -> choose Debian 12 -> download fails 404; wizard shows install failed
- **Remediation:** Correct the org to debuerreotype (dist-arm64v8 branch) or hide the debian-12 row until verified.

## BH-000080 — Fleet create/freeze failures are silently swallowed (no catch, unhandled rejection)

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/(tabs)/fleet.tsx` line ~57
- **Failure scenario:** User taps Create bot (or freeze/unfreeze) while the connection blips. createProfile()/freezeProfile() await rpc('profiles.create'/'moch.fleet.freeze') which rejects; fleet.tsx's create()/toggleFreeze() have try/finally with NO catch, and the Pressable handlers don't catch either -> unhandled promise rejection, setJob('')/setCreating(false) skipped for create, and NO error shown anywhere (fleetError is only set inside refreshFleet's own list read, which never runs because the create RPC threw first). The form just sits there; the user cannot tell why nothing happened.
  - Evidence: app/app/(tabs)/fleet.tsx:57-68 — create(): try { ... } finally { setBusy(null) }, no catch
  - Evidence: app/app/(tabs)/fleet.tsx:70-78 — toggleFreeze(): same shape
  - Evidence: app/src/lib/fleet.ts:106-116 — createProfile await rpc throws propagate; only refreshFleet's internal reads are caught
  - Evidence: app/src/lib/fleet.ts:119-122 — freezeProfile: bare await rpc
  - Repro: Open Fleet, tap Create with a job text while the gateway is unreachable (or kill the gateway mid-submit)
  - Repro: Tap Create — spinner flashes, form stays filled, no error appears; logcat shows an unhandled rejection
- **Remediation:** Wrap create()/toggleFreeze() bodies in try/catch and surface via the existing fleetError atom or showAlert, mirroring agent.tsx's doDisconnect.
- **Annotation (independent_corroboration):** A second, independent gap-pass run over the same components+routes scope (8d55cd88) delivered after the audit report: 10 findings, CONSISTENT with the original gap-pass — same strongest loci (AgentBrowserHost no-retry BH-000084, fleet silent failures BH-000080, bot save/delete BH-000081, settings install BH-000085, provisional-sid config.set BH-000088). It additionally examined MochiSurface native/web variants (narrowing the reported coverage gap) and self-rejected two hypotheses with sound reasoning (terminal applyFieldChange diffing is a working safeguard; browser.tsx opacity-vs-CDP-frames unverifiable read-only). Original findings stand unchanged; this event records the corroboration.

## BH-000081 — Bot detail Save and Delete swallow RPC errors — Save shows nothing, Delete leaves the bot alive with no feedback

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/bot.tsx` line ~58
- **Related:** BUG-110
- **Failure scenario:** On the bot editor, save() has try/finally without catch: if profiles.configure fails (timeout, offline), 'Saved' never appears and no error renders — the user believes it saved if they leave. doDelete() same shape: if moch.profiles.delete fails, router.back() is skipped, deleting resets, and the user sees the armed delete button silently do nothing (the BUG-110 comment fixed the double-tap guard but left the error path unhandled).
  - Evidence: app/app/bot.tsx:58-68 — save(): try { await rpc('profiles.configure'...) ; setSavedAt(...) } finally { setSaving(false) } — no catch
  - Evidence: app/app/bot.tsx:97-108 — doDelete(): no catch; on rejection router.back() never runs and nothing surfaces
  - Repro: Open a bot, go offline (airplane mode with loopback dead), edit SOUL, tap Save — no Saved, no error
  - Repro: Tap Delete twice — spinner ends, bot still in the list, no error
- **Remediation:** Add catch blocks showing showAlert('Save failed'/'Delete failed', message), matching connectProvider() in the same file (bot.tsx:70-88).

## BH-000082 — Automation edit pre-fills the prompt from prompt_preview and writes it back — truncated preview can overwrite the real cron prompt

- **Severity:** medium · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_G
- **Location:** `app/app/(tabs)/automations.tsx` line ~188
- **Failure scenario:** openEdit() seeds the form's prompt with j.prompt_preview ?? ''; saveForm() then always sends --prompt ${shq(prompt)} via /cron edit (line 173). If the gateway's prompt_preview is a truncated/normalized preview (its name and the 2-line clamp in the card at line 271 both say preview), editing only the schedule of a long-prompt job silently rewrites the job's prompt to the truncated text — silent data-loss corruption of scheduled automations. The user changed nothing about the prompt.
  - Evidence: app/app/(tabs)/automations.tsx:189 — prompt: j.prompt_preview ?? ''
  - Evidence: app/app/(tabs)/automations.tsx:171-173 — edit path always passes --prompt with the form value
  - Evidence: app/app/(tabs)/automations.tsx:271 — the same field renders as a 2-line preview
  - Repro: Create an automation with a multi-paragraph prompt (via /cron add on desktop)
  - Repro: On the phone, open Edit, change only the schedule, Save
  - Repro: Compare the job's prompt server-side — if prompt_preview is truncated, the prompt is now the truncated preview
- **Remediation:** Either fetch the full prompt before editing (a cron.manage detail/show action), or omit --prompt from the edit command when the user didn't touch the prompt field.

## BH-000084 — AgentBrowserHost gives up permanently if the first relay boot fails — no retry for the whole process lifetime

- **Severity:** medium · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_G
- **Location:** `app/src/components/AgentBrowserHost.tsx` line ~36
- **Related:** BUG-132
- **Failure scenario:** The host's one-shot boot effect sets booted.current=true before await; if ensureBrowserRelay() rejects (transient native error, service not yet up at cold start) or resolves with st.running===false, ready stays false and the component returns null forever. The booted ref guarantees no retry on any later render/remount, and the failure is swallowed (.catch(() => {})) — browser tools stay dead until the user force-restarts the app, with no signal anywhere. The BUG-132 placement bug (early-return unmount) IS fixed — the host is child 0 in both _layout returns (_layout.tsx:263,290) — but the retry half of the chain has this silent permanent-give-up path.
  - Evidence: app/src/components/AgentBrowserHost.tsx:36-44 — booted ref latches on first attempt; catch(() => {}) and non-running both leave ready=false
  - Evidence: app/src/components/AgentBrowserHost.tsx:46 — 'if (!ready) return null' with no retry affordance
  - Evidence: app/app/_layout.tsx:263,290 — host mounted in both branches (BUG-132 cause 5 addressed)
  - Repro: Simulate a failed first boot (e.g. deny the foreground-service start or race the bridge before HermesService binds so ensureBrowserRelay resolves running=false)
  - Repro: Browser tab shows 'Browser relay unavailable' at best; agent sessions report no browser tools for the rest of the process, even after the native side becomes healthy
- **Remediation:** Retry ensureBrowserRelay with backoff while !ready (or expose a retry tied to AppState foreground), and log/relay the failure instead of the empty catch.
- **Annotation (independent_corroboration_and_nuances):** Full retry JSON (raw/agent_G_retry.json): R-G-01 corroborates BH-000084 (AgentBrowserHost one-shot) at severity HIGH vs the original's medium — dissent recorded, canonical severity kept at medium pending challenger review (the retry's sharper scenario: the Browser screen's own ensure fixes the native relay but the host never re-checks). R-G-03 extends BH-000080 (create also ignores ok:false — server-side failure clears the form as if created). R-G-05 extends BH-000085 (linuxReset also fire-and-forget). R-G-08 sharpens BH-000089 (offline RefreshControl spinner runs forever). R-G-04/06/10 corroborate BH-000081/088/083 unchanged. Three NEW findings filed as BH-000091..BH-000093.

## BH-000086 — Settings -> Install Linux environment swallows all bootstrap errors (the BUG-016 pattern fixed in setup.tsx but not here)

- **Severity:** medium · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/(tabs)/settings.tsx` line ~62
- **Related:** BUG-016
- **Failure scenario:** The install row runs void linuxBootstrap('ubuntu-24.04').finally(() => setBusy(false)) — no catch. linuxBootstrap rejects on failure (setup.tsx:99-112 catches its errors, proving the contract), so a failed download in Settings yields an unhandled rejection, the row flips back with no message, and the 60s status poll keeps stale data. Users installing from Settings get a dead button with zero feedback.
  - Evidence: app/app/(tabs)/settings.tsx:62-66 — no catch/error surface
  - Evidence: app/app/setup.tsx:99-112 — same call is try/catch'd with setBootErr
  - Repro: Settings -> Install Linux environment with a doomed download
  - Repro: Row spinner stops, no error anywhere
- **Remediation:** Catch and showAlert('Install failed', message), mirroring EnvStep in setup.tsx.

## BH-000087 — Keyboard-avoidance mandated by AGENTS.md is missing on several input surfaces (plain ScrollView / no kbPad)

- **Severity:** medium · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_G
- **Location:** `app/app/index.tsx` line ~44
- **Related:** BUG-133
- **Failure scenario:** Per the repo's own rule (app/AGENTS.md, BUG-133), every input needs explicit JS-side avoidance because adjustResize is inert. These surfaces still use a plain RN ScrollView (not KeyboardAwareScrollView) with no kbPad on the list: index.tsx:44 + add-computer.tsx:17 (PairForm host/token/pairing-link inputs), setup.tsx:50 (wizard inputs incl. ProviderKeyForm), bot.tsx:131 (SOUL/desc inputs), agent.tsx:212 (provider search field with results below), sessions.tsx:222-244 / skills.tsx / connectors.tsx (top search fields whose result lists have no kbPad). On the forms the focused input can sit under the IME; on the search screens results are covered. Distinct mechanism from the tracked app-wide issue: these are uncovered surfaces lacking the mandated pattern.
  - Evidence: app/app/index.tsx:44 — ScrollView wrapping PairForm inputs (rule #3 requires KeyboardAwareScrollView)
  - Evidence: app/app/add-computer.tsx:17 — same
  - Evidence: app/app/setup.tsx:50 — same for the multi-step input wizard
  - Evidence: app/app/bot.tsx:131 — ScrollView around TextInput edits
  - Evidence: app/app/(tabs)/agent.tsx:212 — ScrollView; provider search + list, no kbPad
  - Evidence: app/app/(tabs)/sessions.tsx:222-278 — search field + FlatList, no kbPad on the list container
  - Repro: Open Add a computer -> More options -> focus the token field with the keyboard up
  - Repro: On a small device the field/results sit behind the IME
- **Remediation:** Swap the form ScrollViews to react-native-keyboard-controller's KeyboardAwareScrollView, and add the kbPad list-container pattern to sessions/skills/agent/connectors search screens, per AGENTS.md patterns 3 and 4. Verify on-device per the rule.

## BH-000091 — AgentBrowserHost's resident WebView has no onRenderProcessGone/onError recovery — a killed renderer silently kills the agent's browser tab

- **Severity:** medium · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_G_retry
- **Location:** `app/src/components/AgentBrowserHost.tsx` line ~50
- **Related:** BUG-132, BUG-127
- **Failure scenario:** Android kills background WebView renderers under memory pressure (hazard documented+handled in MochiSurface.native.tsx:29-38). The always-on host WebView handles neither callback — after renderer death the relay has no live tab while tools stay advertised: every browser verb returns 'No browser page...' until app restart. Browser screen's visible tabs DO handle it (browser.tsx:267-269).
  - Evidence: AgentBrowserHost.tsx:50-69 no onRenderProcessGone/onError
  - Evidence: MochiSurface.native.tsx:29-38 hazard+recovery documented
  - Evidence: browser.tsx:267-269 visible tabs remount on renderer death

## BH-000001 — raw server strings in UI (item.source verbatim, delete-failure alerts, optimistic '0 msgs' row)

- **Severity:** low · **Confidence:** high · **Status:** open · **Source:** existing_tracker
- **Location:** `app/src/lib/sessionList.ts` line ~120
- **Related:** BUG-074
  - Evidence: bugs.md:270 (tracker entry, unchecked)
  - Evidence: sessionList.ts:120 optimistic row stuck at '0 msgs'
  - Evidence: TEST-REPORT-1.0.15-device.md device pass observed raw strings

## BH-000007 — About shows 'Moch v1.0', not the installed build

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/app/(tabs)/settings.tsx` line ~266
- **Related:** BUG-119
  - Evidence: bugs.md:357 tracker entry (unchecked)
  - Evidence: settings.tsx:266 and :478 hard-code string 'Moch v1.0' (lead verified at HEAD)
  - Evidence: TEST-REPORT-1.0.15-device.md device observation
  - Repro: Read app/app/(tabs)/settings.tsx:266,478 — literal 'Moch v1.0'

## BH-000010 — SQLite WAL-reset vulnerability warning on every boot with non-actionable advice

- **Severity:** low · **Confidence:** medium · **Status:** open · **Source:** existing_tracker
- **Location:** `app/hermes-src/hermes_state.py` line ~369
- **Related:** BUG-122
  - Evidence: bugs.md:369 tracker entry (unchecked)
  - Evidence: errors.log warning emitted by hermes_state on every boot (tracker)

## BH-000011 — rejected pairing link gives no feedback at all

- **Severity:** low · **Confidence:** medium · **Status:** confirmed · **Source:** existing_tracker
- **Location:** `app/app/add-computer.tsx` line ~402
- **Related:** BUG-124
  - Evidence: bugs.md:402 tracker entry (unchecked)
  - Evidence: lead: PairForm.tsx surfaces errors on every in-form catch path (:38-59,:83,:98,:111, rendered :224) — the no-feedback locus is the external deep-link (hermes://connect) entry, which bypasses the form's error surface
  - Evidence: device/user report per tracker wave
  - Repro: Open a hermes://connect link with a bad token from outside the app — no error surfaced (tracker repro)

## BH-000014 — data: URLs refused with the wrong reason (_url_policy_error -> _is_safe_url mismatch)

- **Severity:** low · **Confidence:** high · **Status:** open · **Source:** existing_tracker
- **Location:** `app/hermes-src/tools/browser_tool.py` line ~460
- **Related:** BUG-128
  - Evidence: bugs.md:460 tracker entry (unchecked)

## BH-000022 — steerRun falls through to session.steer on unrecognized session.redirect status — potential double-apply of steer text

- **Severity:** low · **Confidence:** low · **Status:** rejected · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~1958
  - Evidence: chat.ts:1958-1965 only 'redirected'|'queued' short-circuit
  - Evidence: chat.ts:1968 fallback session.steer runs after fall-through
  - Evidence: server status vocabulary unverified (limitation)

## BH-000023 — isKnownSlashCommand returns true on empty catalog — offline/boot any '/…' text errors as 'Command failed' instead of being sent

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/slash.ts` line ~266
- **Related:** BUG-042
  - Evidence: slash.ts:266-267 empty-catalog short-circuit returns true
  - Evidence: chat.tsx:620-623 send() routes to runSlash
  - Evidence: chat.tsx:425-461 runSlash failure alerts 'Command failed', message not sent
  - Evidence: contradicts BUG-042 intent (unknown slash-text = normal message)
  - Repro: Fresh install/offline: send '/etc/hosts — summarize this' — error alert, nothing delivered

## BH-000024 — migrateV1Transcript interim-key early return skips legacy live-keyed v1 cleanup — AsyncStorage blobs stranded

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~624
  - Evidence: chat.ts:624-629 early return precedes cleanup
  - Evidence: chat.ts:637-645 legacy removal loop only on non-interim path
  - Repro: Upgrade path: open chat hydrated via interim v1; inspect AsyncStorage — hermes.transcript.<liveId>.v1 keys remain

## BH-000025 — batch clarify Send enabled without per-question answers — unanswered qids silently omitted from answers map

- **Severity:** low · **Confidence:** medium · **Status:** confirmed · **Source:** agent_A
- **Location:** `app/src/lib/chat.ts` line ~2064
  - Evidence: chat.tsx:1245-1250 Send button lacks validation
  - Evidence: chat.ts:2064-2070 answers map forwarded as-is
  - Evidence: backend tolerance for partial answers unverified (limitation)

## BH-000031 — BUG-102/BUG-103 UI fixes have no regression tests (layout logic not extractable-tested today)

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_D
- **Location:** `app/app/(tabs)/chat.tsx` line ~1
- **Related:** BUG-102, BUG-103
  - Evidence: commits 012a3e6 (BUG-103), 3fcea0a (BUG-102) touched no test files
  - Evidence: no suite imports chat.tsx
  - Repro: git show --stat 012a3e6 3fcea0a

## BH-000038 — usesCleartextTraffic=true app-wide, and pairing links default tls=0 — a crafted hermes://connect QR silently dials plaintext ws to a remote host with the token in the URL

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/android/app/src/main/AndroidManifest.xml` line ~23
- **Failure scenario:** The manifest allows cleartext for the whole app. Pairing defaults to tls=false whenever the tls parameter is absent or not '1' (app/src/lib/pairing.ts:37-41), and the only guard for a non-local plaintext dial is a log warning (app/src/lib/gateway.ts:559-561) plus an unencrypted fetch path (http.ts:5). A malicious or mistyped pairing QR/link therefore pairs a remote host over plaintext — token and the entire chat stream (provider-key-gated model output, file contents, exec approvals) are readable by any on-path listener.
  - Evidence: AndroidManifest.xml:23 — android:usesCleartextTraffic="true"
  - Evidence: app/src/lib/pairing.ts:37 — tlsRaw default '0'
  - Evidence: app/src/lib/gateway.ts:559-561 — warn-only for plain ws:// to non-local host
  - Evidence: app/src/lib/http.ts:5 — httpBase mirrors tls=false to http://
  - Evidence: preconditions: User scans/accepts a pairing link whose host is off-device and tls omitted; attacker positioned on the network path (or running the named host).
  - Repro: Craft hermes://connect?host=<remote>&token=t (no tls param) as a QR
  - Repro: Victim scans and connects in a café Wi-Fi; attacker sniffs the ws frames and the token
- **Remediation:** Default tls=1 for non-private addresses, or require an explicit user confirmation dialog before any non-local plaintext dial; scope cleartext to 127.0.0.1 via networkSecurityConfig.

## BH-000039 — WebView debugging enabled process-wide in release builds — resident agent WebView holds browsing session, cookies readable over adb

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/src/components/AgentBrowserHost.tsx` line ~50
- **Failure scenario:** AgentBrowserHost mounts an always-alive WebView with webviewDebuggingEnabled (and BrowserRelayModule.kt:117-123 calls WebView.setWebContentsDebuggingEnabled, documented there as process-wide). Functionally required for the CdpRelay/CDP toolchain, but release builds ship with WebView debugging on for EVERY WebView. Anyone with brief USB/adb access to the phone attaches chrome://inspect to the agent WebView and the gateway dashboard WebView and extracts cookies, logins, and page content — browserRelay.ts notes logins live in the WebView profile.
  - Evidence: app/src/components/AgentBrowserHost.tsx:53 — webviewDebuggingEnabled on the permanent offscreen WebView
  - Evidence: app/android/.../BrowserRelayModule.kt:22,117-123 — process-wide setWebContentsDebuggingEnabled(true)
  - Evidence: app/src/lib/browserRelay.ts:19 — 'logins live in the WebView profile (CookieManager)'
  - Evidence: preconditions: Physical/adb access to the unlocked device (or a compromised adb chain). No root needed.
  - Repro: Enable developer options/USB debugging, attach Chrome DevTools, select the Moch WebView, read cookies/storage
- **Remediation:** Gate setWebContentsDebuggingEnabled on BuildConfig.DEBUG when possible, or document the trade-off; consider a separate, non-debuggable WebView for any authenticated surface.

## BH-000040 — Executable bootstrap artifacts (proot loader .deb, Ubuntu rootfs, QR renderer) downloaded with no checksum pinning

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/python-runtime/moch/linux_env.py` line ~37
- **Failure scenario:** First Linux bootstrap downloads proot_*.deb and libtalloc .deb from the Termux repo and the ubuntu-base tar.gz from cdimage.ubuntu.com over TLS, but verifies no hash (_download, linux_env.py:379, streams straight to disk; the stamp records only the URL). A compromised upstream, repo mirror, or any TLS-bypassing middlebox with a trusted CA yields arbitrary code: proot's loader is exec'd (via linker64) inside the app's UID on every guest command, and a malicious rootfs plants files the agent then executes. Same pattern in moch-link/install.sh:22,1044 — qrcodegen.py is fetched from raw.githubusercontent pinned only by commit hash.
  - Evidence: app/python-runtime/moch/linux_env.py:37,43,52 — TERMUX_BASE/PROOT_URL/ROOTFS_URLS, no sha256 anywhere in the file (grep: zero hashlib/checksum hits)
  - Evidence: app/python-runtime/moch/linux_env.py:379-391 — _download writes bytes with no verification
  - Evidence: moch-link/install.sh:22,1043-1044 — VENDOR_URL commit-pinned, curl -fsSL, no checksum
  - Evidence: mitigating: _safe_extract/_check_member (linux_env.py:300-346) blocks path traversal and relative-symlink escapes in the rootfs
  - Evidence: preconditions: Attacker controls the package repo/CDN response or holds a CA trusted by the device, at the moment of first bootstrap (or a pin change, which wipes and re-downloads, linux_env.py:519-528).
  - Repro: Serve a modified proot_*.deb at the pinned URL (or intercept TLS)
  - Repro: Victim runs Linux bootstrap; the swapped binary is chmod 0755 and exec'd per guest command inside the app UID
- **Remediation:** Pin sha256 for the proot/libtalloc debs and the rootfs tarball; publish checksums for qrcodegen.py alongside the installer.

## BH-000041 — docs/install.sh (the publicly served copy) has diverged from canonical moch-link/install.sh

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `docs/install.sh` line ~474
- **Failure scenario:** The two installer copies differ by ~430 lines: docs/install.sh ships the OLD moch-link-proxy (plain host-rewrite only) while moch-link/install.sh embeds the push-watcher/receipt proxy and all later fixes; PROJECT.md:70-73 mandates 'Always cmp the copies'. Users installing from the website get the stale tunnel/proxy behavior, and future security fixes applied only to the canonical copy will silently miss the public one.
  - Evidence: diff moch-link/install.sh docs/install.sh — large divergence starting at the proxy heredoc
  - Evidence: PROJECT.md:70-73 — sync rule explicitly requires cmp
  - Evidence: preconditions: Any user following the website install path (https://moch.softland.tech/install.sh).
  - Repro: cmp moch-link/install.sh docs/install.sh → differ
- **Remediation:** Re-copy canonical → docs (and VPS), or make docs/install.sh a build artifact of moch-link/install.sh in CI.
- **Annotation (corroboration_and_evidence):** B-05 (agent B, independent): The published installer embeds a stale moch-link-proxy: it is missing the entire v2 notification layer of the canonical script (Expo push registration via ?push=, the passive server->client WS frame watcher for approval/clarify/sudo/secret and message.complete, push receipts checking, the no-phone-attached session mirror), and its env file omits LINK_HOME (moch-link/install.sh:932-933 writes it; docs copy does not), which the canonical proxy requires as its cwd/token-file base. A user who installs from the docs URL gets a relay that connects chat but never knocks the phone on approvals or turn completions.

## BH-000048 — gateway_server never sets _STATE['starting']=True — getGateway reports running=false during the entire cold boot

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/python-runtime/moch/gateway_server.py` line ~33
- **Failure scenario:** _STATE is initialized with starting:False and no code path ever sets it True. During the up-to-90s cold boot inside start(), info() returns running = started or starting = False, so the RN client polling getGateway() (mochiRuntime.ts:68) sees a not-running runtime that is actually mid-import, and connection attempts during that window fail with no 'starting' signal to key UI state or retry logic on.
  - Evidence: gateway_server.py:33 — {"started": False, "starting": False, ...}
  - Evidence: gateway_server.py:178-206 — start() spawns the thread and only ever writes starting:False
  - Evidence: gateway_server.py:209-220 — info(): running = started or bool(_STATE["starting"])
  - Repro: Cold-start the app and poll getGateway() during the first minute: running=false while the gateway thread is importing/binding
- **Remediation:** Set _STATE['starting']=True (under _LOCK) before spawning the thread in start().

## BH-000051 — linux_session.run timeout desynchronizes the persistent guest shell (orphaned sentinel/rc lines poison the next command)

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_B
- **Location:** `app/python-runtime/moch/linux_session.py` line ~106
- **Failure scenario:** run() frames each command as '(cmd) ; echo SENTINEL ; echo rc'. On TimeoutError the branch returns {'ok':False,'error':'command timed out'} WITHOUT killing the shell: the previous payload keeps executing and its SENTINEL+rc lines arrive later, where the next run() reads them as the new command's output and exit code (garbage stdout, wrong exit status), and the new command is written while the old one still owns the shell. Other exception paths kill the shell for restart; the timeout path — the most likely one for long commands — does not.
  - Evidence: linux_session.py:118 — wrapped command appends sentinel+rc after the payload
  - Evidence: linux_session.py:141-142 — TimeoutError: return without proc.kill() (contrast :144-147 which kills on other exceptions)
  - Evidence: linux_session.py:121-139 — next run() reads the leftover sentinel as its own
  - Repro: run('sleep 300', timeout_s=2) -> times out; immediately run('echo hello') -> output/exit belong to the dead command
- **Remediation:** On timeout, kill and null the shell (same as the generic exception path), or drain until sentinel before the next write.

## BH-000055 — moch-link install.sh checks node/npm but never systemctl — dies mid-install on hosts without a systemd user session

- **Severity:** low · **Confidence:** medium · **Status:** confirmed · **Source:** agent_B
- **Location:** `moch-link/install.sh` line ~334
- **Failure scenario:** cmd_install validates 'command -v node'/'npm' but calls 'systemctl --user daemon-reload' unconditionally (set -e) when it becomes the serve launcher (also :967, :1091 for the proxy/tunnel units). On WSL-without-systemd, containers, or minimal servers, the script dies at daemon-reload after having already written env/unit files, leaving a half-installed state with no diagnostic.
  - Evidence: install.sh:334-335 — only node/npm are probed
  - Evidence: install.sh:412,967,1091 — unconditional systemctl --user calls under set -e
  - Repro: MOCH_LINK_NO_DETECT=1 install on a non-systemd host -> dies at daemon-reload after files were written
- **Remediation:** Add 'command -v systemctl' (and a --user session probe) to the preflight with a clear die message.

## BH-000083 — Deep-link pairing error toast (linkMsg) is never dismissed — sticks on screen for the rest of the session

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/_layout.tsx` line ~351
- **Related:** BUG-124
- **Failure scenario:** A rejected hermes://connect link sets linkMsg (line 158), which renders a bottom toast. Nothing ever clears it: no timeout, no tap-to-dismiss, not reset on a subsequent successful connect or route change. After one bad link the error text stays overlaid above the composer/tabs indefinitely (renders in both the !cfg branch line 267 and the main branch line 351), and a later successful pairing leaves the stale 'Bad pairing link' message up. Errors DO surface now (unlike the original BUG-124 report), but the surface is a permanent scar.
  - Evidence: app/app/_layout.tsx:157-159 — setLinkMsg on parse/connect failure
  - Evidence: app/app/_layout.tsx:242 — second setLinkMsg (stale pendingOpen) — also never cleared
  - Evidence: app/app/_layout.tsx:351-353 — toast render; grep shows no setLinkMsg(null) anywhere
  - Repro: Activate a malformed hermes://connect link
  - Repro: See the toast; navigate anywhere, pair successfully — the error toast is still on screen until app restart
- **Remediation:** Auto-clear linkMsg after ~6s (timed effect) and clear it in handleUrl's success path and on pendingOpen consumption.

## BH-000085 — Content-search hit rows in Chats always render '0 msgs' — constructed SessionRow omits message_count

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/(tabs)/sessions.tsx` line ~120
- **Related:** BUG-114
- **Failure scenario:** BUG-114's server content search maps each hit to a SessionRow carrying only id/title/preview/started_at/profile; message_count is never set, and the row renderer prints item.message_count ?? 0 + ' msgs' (line 308). Every server content hit displays '· 0 msgs' even for long conversations. Also these rows sort AFTER title matches by construction, which is fine, but the count mismatch reads as data loss to users.
  - Evidence: app/app/(tabs)/sessions.tsx:124-132 — rows.push({...}) without message_count
  - Evidence: app/app/(tabs)/sessions.tsx:306-311 — {item.message_count ?? 0} msgs
  - Repro: Chats tab, search a phrase that exists only inside message bodies
  - Repro: Result rows show '0 msgs'
- **Remediation:** Map message_count when the payload carries it and render '— msgs' when undefined, or omit the count for hit rows.

## BH-000088 — Reasoning-effort writes pass the raw active sid — a provisional (unsent) chat id goes to config.set and fails, though reads are guarded

- **Severity:** low · **Confidence:** medium · **Status:** needs_verification · **Source:** agent_G
- **Location:** `app/app/(tabs)/agent.tsx` line ~89
- **Related:** BUG-013
- **Failure scenario:** refresh() deliberately skips session-scoped reads for provisional chats (BUG-013 guard, line 54), but setAndSave (line 94) and toggleReasoning (line 113) pass the raw sid into applyReasoning/config.set without the guard or an ensureSession() — unlike ModelPickerSheet.apply(), which resolves via ensureSession() first. On a brand-new chat whose session.create hasn't landed, tapping an effort pill (or flipping Show reasoning) sends config.set with a placeholder session_id -> gateway 'session not found' -> the optimistic pill snaps back with a failure alert, and the reasoning toggle silently reverts.
  - Evidence: app/app/(tabs)/agent.tsx:54 — provisional guard applied to reads only
  - Evidence: app/app/(tabs)/agent.tsx:94 — applyReasoning({ ..., sessionId: sid }) — no guard, no ensureSession
  - Evidence: app/app/(tabs)/agent.tsx:113 — rpc('config.set', { ..., ...(sid ? { session_id: sid } : {}) })
  - Evidence: app/src/components/ModelPickerSheet.tsx:151 — the picker's apply path calls ensureSession() before config.set (the contrast)
  - Repro: Start a brand-new chat, immediately open Models (before first send), tap a reasoning-effort pill
  - Repro: Error alert 'Failed to save'; pill reverts
- **Remediation:** Apply the same provisional skip (fall back to scope 'global' or ensureSession({create:true})) in setAndSave/toggleReasoning.

## BH-000089 — Crew board: pull-to-refresh spinner can never show and offline renders as an indistinguishable empty board

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_G
- **Location:** `app/app/(tabs)/crew.tsx` line ~59
- **Failure scenario:** loading is set true only at mount; refresh() (also used as onRefresh) never re-sets it, and the RefreshControl is bound to loading — so pull-to-refresh silently updates (or fails) with no spinner. When offline, refresh() early-returns without setting err, so the board shows the stale/empty columns with the neutral 'read-only' hint and zero indication the data is dead — unlike every other screen which has an offline row.
  - Evidence: app/app/(tabs)/crew.tsx:59-75 — refresh(): 'if (!online) return' before setErr; setLoading(false) but no setLoading(true) path after mount
  - Evidence: app/app/(tabs)/crew.tsx:95-103 — 'loading && online ? spinner : FlatList' with RefreshControl refreshing={loading}
  - Repro: Load Crew once, pull to refresh — no spinner
  - Repro: Go offline, reopen Crew — board shows 'Read-only' hint with no offline/error state
- **Remediation:** Track a separate refreshing state for the RefreshControl (like sessions.tsx) and render an offline row when !online.

## BH-000092 — automations modal uses RNKC KAV behavior='height' on Android (the pattern AGENTS.md rejects on-device); ModelPickerSheet uses RN-core KAV (Android no-op)

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_G_retry
- **Location:** `app/app/(tabs)/automations.tsx` line ~316
- **Related:** BUG-133, BH-000087
- **Failure scenario:** AGENTS.md pattern 2 mandates behavior='padding' and explicitly rejects 'height' ('parent-relative frame math — rejected on-device, MIUI undershoot'). automations.tsx:316 uses behavior={ios?'padding':'height'}. Sibling: ModelPickerSheet.tsx:10,192 imports KeyboardAvoidingView from react-native CORE with behavior undefined on Android — a literal no-op for its key-entry form.
  - Evidence: automations.tsx:316
  - Evidence: app/AGENTS.md pattern 2 rejection
  - Evidence: ModelPickerSheet.tsx:10,192 core KAV behavior undefined

## BH-000093 — browser relay-failure state has no retry — recovery requires leaving and re-entering the screen

- **Severity:** low · **Confidence:** high · **Status:** confirmed · **Source:** agent_G_retry
- **Location:** `app/app/(tabs)/browser.tsx` line ~66
- **Related:** BUG-132
- **Failure scenario:** Mount runs ensureBrowserRelay once; on failure the 'Browser relay unavailable' branch renders status.lastError with no retry control, and the status atom only changes on an ensure/stop call — a transient bind failure strands the user on a dead-end error screen. Parallel affordances elsewhere are tappable retry rows (ScreenShell BUG-046, sessions BUG-022).
  - Evidence: browser.tsx:66-76 one-shot mount effect
  - Evidence: browser.tsx:148,158-163 no Pressable in relayBad branch
  - Evidence: browserRelay.ts:101-117 atom only updated by ensure/stop

## BH-000032 — GitHub issue tracker is empty (0 issues, API-verified exhaustive) — all bug history is PR titles + local bugs.md; external users cannot report bugs

- **Severity:** informational · **Confidence:** high · **Status:** confirmed · **Source:** agent_E
- **Location:** `bugs.md` line ~1
  - Evidence: gh api search/issues type:issue total_count=0
  - Evidence: gh issue list --state all -> []
  - Evidence: 61 PRs each name BUG-xxx ranges (full map in raw/agent_E.json)

## BH-000042 — CdpRelay loopback token compared with non-constant-time !=; token is 128-bit random and loopback-only

- **Severity:** informational · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/android/app/src/main/java/com/hermes/pocket/hermes/CdpRelay.kt` line ~201
- **Failure scenario:** segs.firstOrNull() != token is timing-sensitive, but the token is a fresh 122-bit UUID, the listener binds 127.0.0.1 only, and a cross-app timing oracle over loopback with a single boolean check is not practically exploitable at this entropy. The relay itself uses crypto.timingSafeEqual correctly (relay:98-102,190,381). Hardening note.
  - Evidence: CdpRelay.kt:92-95 — 127.0.0.1 literal bind (BUG-106 note)
  - Evidence: CdpRelay.kt:167 — UUID.randomUUID token
  - Evidence: CdpRelay.kt:201 — plain string != for auth
  - Evidence: preconditions: Another on-device app able to open many loopback connections and measure sub-microsecond timing differences — no realistic recovery path.
  - Repro: n/a — hardening note
- **Remediation:** MessageDigest.isEqual(byte[], byte[]) if touched again; otherwise leave.

## BH-000043 — Secret-file hygiene verified clean on the tracked-tree side; debug keystore + google-services.json are the only committed credential-adjacent files

- **Severity:** informational · **Confidence:** high · **Status:** confirmed · **Source:** agent_C
- **Location:** `app/android/app/google-services.json` line ~1
- **Related:** BUG-071
- **Failure scenario:** Verified without printing contents: root firebase-service-account.json exists UNTRACKED and gitignored (mode 0600) with zero commit history — the admin credential never entered git. Root google-services.json and app/android/app/google-services.json are tracked — normal Firebase client config (identifiers, not secrets), root copy redundant. debug.keystore tracked (see C-04). SecureStore primary with AsyncStorage fallback now logs a warning (gateway.ts:206-215, known BUG-071); logs scrubbed via redactedUrl (gateway.ts:163-166); log.ts mirrors to console only in __DEV__. allowBackup=true with expo-secure-store rules — plaintext-AsyncStorage-fallback tokens WOULD ride device backups.
  - Evidence: .gitignore:6 — firebase-service-account.json ignored; mode 0600; zero git history
  - Evidence: git ls-files — google-services.json x2 and debug.keystore tracked
  - Evidence: app/src/lib/gateway.ts:163-166,206-215 — redaction + warned plaintext fallback (BUG-071)
  - Evidence: relay state: machines Map persists tokenHash only (relay:157-171)
  - Evidence: preconditions: n/a — posture summary.
  - Repro: n/a
- **Remediation:** Drop the redundant root google-services.json from tracking if unused; keep firebase-service-account.json untracked and consider moving it out of the repo dir entirely.
