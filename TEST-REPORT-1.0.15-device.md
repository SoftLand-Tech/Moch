# On-device test report — Moch 1.0.15-browser (versionCode 18)

Date: 2026-10-11 · Device: Xiaomi M2101K7BG (Redmi Note 10), Android 13 / SDK 33,
serial `GE9HDQCEWWSCIRS4` · Serial path: usb
Build under test: `app/android/app/build/outputs/apk/release/app-release.apk`,
87,253,217 bytes — **byte-size identical** to the installed `base.apk`; installed
2026-10-11 13:27. The APK's baked Python was checked directly and carries the
BUG-105 `_pid == os.getpid()` gate and the current `tools/browser_webview.py`.

Everything below was done **on the device through the real UI**, driven over adb.
Raw command-by-command evidence: `.devtest/FINDINGS.md`. Harness:
`.devtest/ui.py` (uiautomator dump + `input` + screencap + tesseract OCR),
`.devtest/gw.sh` (the app's own gateway on `127.0.0.1:9119` via
`adb forward tcp:19119`), `.devtest/wsrpc.py` (raw WebSocket JSON-RPC client for
the app's `/api/ws`).

## Verdict in one screen

| Feature | Verdict | Headline |
|---|---|---|
| **Browser** | ❌ **unusable** | Relay binds `::1` only, every client dials `127.0.0.1` → all browser tools die ("the browser is dead"). Proven by making the next call succeed with an in-namespace IPv4→IPv6 shim. (BUG-106) |
| Browser gate (BUG-105 fix) | ✅ / ⚠️ | Stale-file arming is fixed (verified). But opening the Browser screen arms the tools only after the 30 s tool-cache TTL, and never in an existing chat. (BUG-107) |
| **Terminal** | ✅ **works** | 7/9 runbook steps pass on device (open, echo, streaming, interrupt, history, reattach, kill, retry, agent isolation). One defect: Kill → Retry replays the dead session's scrollback. (BUG-115) |
| **Bots / Fleet UI (M9.2)** | ⚠️ **half** | Create-in-5s, roster, bot-scoped chat, `Bot · <name>` identity, per-bot home + SOUL all pass. Bot detail is dead (BUG-108), delete impossible (BUG-110), active bot silently captures chats (BUG-111), bot chats vanish from the lists after restart (BUG-112). |
| **Fleet runtime / Crew (M9.1, M9.4)** | ❌ **inactive** | `MOCH_FLEET` is never set → `moch.fleet.*`, `moch.kanban.*`, `moch.runs.*` are unknown methods; Crew shows a raw version-skew error, freeze is a silent no-op. (BUG-109) |
| Automations (cron) | ✅ **works** | Job created from the UI, `Run now` and the **scheduled** ticker both executed a real agent turn (`CRON-TICK-OK`, `TICK-TWO-OK`), one-shot completes cleanly, schedule survives a cold restart. |
| Connectors (MCP) | ⚠️ | Screen + add-server flow fine; the Browse catalog ships empty. (BUG-118) |
| Share-in | ⚠️ | Warm share works exactly as documented; **cold share loses the payload**. (BUG-113) |
| Settings / Models / Skills | ✅ mostly | All sections render and work; model picker from Settings shows an internal error banner (BUG-117); About shows `Moch v1.0` (BUG-119). |
| Search (drawer + Chats) | ❌ | Title-only; message-content search finds nothing and the server search API returns `[]` for everything (no FTS5). (BUG-114) |
| i18n EN/AR | ❌ unreachable | No caller of `setLocale`/`loadLocale`, no language row; AR catalog + RTL flag are dead code. (BUG-116) |
| Security | ⚠️ | The loopback gateway serves its own session token unauthenticated on `/`; any app on the phone can read it and then drive the full API. (BUG-120) |

## The two root causes, proven on the device

**1. The relay listens on the wrong loopback family (BUG-106).**
`CdpRelay.start` binds `InetAddress.getLoopbackAddress()`, which is `::1` on
Android; both arming paths build `http://127.0.0.1:<port>/<token>`, which
`requests`/`websockets` dial as IPv4.

```
/proc/net/tcp6  …::1:2476  LISTEN  uid 10319     <- the relay
/proc/net/tcp   (no 9334)                        <- nothing on 127.0.0.1
adb shell 'echo | toybox nc -w 2 127.0.0.1 9334' → nc: connect: Connection refused
adb forward tcp:19334 tcp:9334; curl …/json/version
  → {"Android-Package":"com.hermes.pocket","Browser":"Chrome/154.0.8037.107",…}   (adbd tries ::1 first)
```

Closing the loop: a forwarder was installed **inside the app's own network
namespace** (the Moch Linux guest shares it) listening on `127.0.0.1:9334` and
forwarding to `[::1]:9334` — nothing else changed. The same chat whose call had
just failed answered **"Worked — page title: 'Example Domain'."** and the visible
Moch Browser tab really navigated (tab strip `Example Domain`, URL bar
`https://example.com/`, page body rendered). The whole chain — Kotlin relay →
abstract devtools socket → WebView CDP → snapshot → navigation → visible tab — is
healthy. One address-family line is the whole bug.

**2. The fleet flag is never armed (BUG-109).**
`fleet.py`, `fleet_worker.py`, `dm_bridge.py` and the gateway's install block all
gate on `MOCH_FLEET=1` / `MOCH_EMBEDDED=1`; a grep across `python-runtime/`,
`hermes-src/`, the Kotlin sources and gradle finds only readers, tests and
docstrings — nothing sets it. Consequence measured over the app's own RPC:
`moch.fleet.status`, `moch.fleet.freeze`, `moch.kanban.tasks`,
`moch.runs.timeline`, `moch.profiles.delete` → `-32601 unknown method`.

## Browser — TEST-1.0.15-browser.md, step by step

| doc step | expectation | result |
|---|---|---|
| 1.2 restart precondition | relay.json stale, relay down | ✅ verified (`::1:9334` present before `force-stop`, absent after relaunch, file still on disk) |
| 1.3 chat-first, Browser never opened | agent says it has **no browser tools** | ⚠️ **gate PASS / behaviour FAIL** — the catalog really had no browser tools (4 sources only), but the agent improvised: 5 `terminal` calls trying `/system/bin/am` inside the proot guest, then `Operation interrupted.` — no answer. (BUG-121) |
| 1.4 open Browser, same chat, ask again | tools live immediately, visible tab navigates | ❌ **FAIL** — no browser tools in that chat at all |
| 2 regression, tools advertised | visible tab navigates | ⚠️ only reachable via the shim; with the shim the acceptance passes exactly (`Example Domain`) |
| 3 screen-first order | works | ❌ **FAIL** — a chat created 30 s after the relay came up still had no browser tools |

Timeline that separates the two failures (relay verified up throughout, gate
activation in `agent.log`):

```
15:01:02  Browser screen opened → "moch.browser_gate: gate active http://127.0.0.1:9334/<token>"
15:01:30  NEW chat  → "No browser tool (browser_navigate) exists in my toolset"
15:02:30  NEW chat  → browser_back, browser_click, browser_console, browser_get_images, browser_navigate, …
15:03     navigate  → "the browser relay isn't running"  (BUG-106)
15:05     + IPv4 shim → navigates, "Worked — page title: 'Example Domain'."
```

Existing chats keep the tool list they were created with; the mid-session
`activate()` flip is real (env + `check_fn` cache clear) but only lands after the
registry's 30 s TTL and only for chats created afterwards.

Also verified working: tab strip create/switch/close, URL bar + reload, relay
`/json/list` filtering to exactly the visible tab (one target), and the relay
being token-gated (`/json/version` without the token → 403).

## Terminal — FEATURE-TERMINAL.md, step by step

| # | step | result | evidence |
|---|---|---|---|
| 1 | open, prompt appears | ✅ | `linker64 … proot … /bin/bash -i` + `bash -i` children of the app pid, uid `u0_a319`; `root@localhost:~#` rendered |
| 2 | echo | ✅ | `Linux localhost 6.17.0-moch … aarch64 GNU/Linux`, `PRETTY_NAME="Ubuntu 24.04.4 LTS"` |
| 3 | streaming | ✅ | loop printed `TICK-1..3` at T+2 s with the loop still running, `TICK-1..4` at T+6 s |
| 4 | interrupt | ✅ | `sleep 45` in `ps` before the pad `^C`, gone 1.5 s after, prompt returned |
| 5 | history | ✅ | pad `↑` recalled `echo TERMTEST` onto the input line |
| 6 | reattach | ✅ | same bash pid before/after leaving to Chat and returning, scrollback intact |
| 7 | kill → confirm | ✅ | dialog `Kill terminal session?`, then 0 bash processes, `[session ended]` + `Retry`, composer reads `session ended` |
| 7b | retry boots fresh | ⚠️ | new bash pids (fresh session) but the **old scrollback is replayed** into it (BUG-115) |
| 8 | agent isolation | ✅ | agent ran `echo AGENT-ISOLATION-OK` via its own exec while the terminal was open — terminal bash pid unchanged, its transcript untouched by the agent's output |
| 9 | Reset Linux | ⏸ **not run** — destructive (deletes the 132.5 MB guest, needs a re-download); leaving it to the user's call. Guest inspected first: `/root` holds only `.bashrc`/`.profile`, `/workspace`, `/home`, `/tmp` are empty — no user data at risk. |

Terminal rendering is a real xterm.js WebView: erases/colors/cursor addressing
work (the escalation path from BUG-097/094). OCR of live frames was used to read
the screen because the WebView is not in the accessibility tree — worth knowing
for anyone writing device tests here.

## Bots / Fleet — M9.2 and M9.4

Passing, measured: Fleet roster with runtime status; template creation with zero
typing (`Research` chip → job text + `Suggested name: research-assistant` →
`Create bot` → profile present **5 s** after the tap); per-bot home
`…/.hermes/profiles/research-assistant` with its own `SOUL.md`, `profile.yaml`
and mirrored credentials; bot-scoped chat (`Bot · research-assistant` header,
session `profile: research-assistant`); bot answers through its own profile
(`BOT-OK`); roster + bot survive `am force-stop` and relaunch.

Failing: bot detail blank/silent (BUG-108), no delete (BUG-110), Crew board empty
with a raw version-skew banner + freeze no-op (BUG-109), active-bot capture with
no attribution (BUG-111), bot chats missing from both list surfaces after restart
(BUG-112).

## Automations — end-to-end

`test-cron-tick` (one-shot `in 2m`) and `tick-test-2` (`in 3m`) were created from
the Automations editor. `ticker_heartbeat`/`ticker_last_success` update every
tick. `Run now` produced run `cron/output/6d6867e4b948/2026-10-11_15-19-11.md`
ending in `## Response` → `CRON-TICK-OK`; the scheduled run fired at 15:24:08
(due 15:23:54 — **after** a force-stop and cold restart) producing
`06aa786b01d6/…` → `TICK-TWO-OK`. Both jobs were deleted again through the UI
(confirm dialog → `No automations yet`, `jobs.json` empty) — the app is back to
its pre-test state.

## Things that were checked and are fine

Settings (runtime restart/stop, battery-optimisation deep link into MIUI, Linux
status `Ubuntu 24.04.4 LTS · 132.5 MB`, themes Mocheme/Relay, Skills,
Connectors, computers/pairing, notifications toggle), Models screen (Z.AI/GLM
active, 18 models, 37 providers available, reasoning effort), Skills screen
(127 commands / 0 skills), attachment sheet (photo/video, take photo, file),
slash-command sheet (34 commands, tap-to-fill puts `/new` in the composer),
drawer search filtering, browser tab lifecycle, foreground-service notification
(`channel=hermes_runtime`), app storage layout (`…/.hermes/{sessions,logs,cron,
workspace,profiles,state.db,…}`), and the app's own logs (`.hermes/logs/agent.log`,
`errors.log`) which are far more useful than logcat on this build.

## Notes for the next test session

- **Logcat is useless for this app in release**: no `CdpRelay`, no JS logs; only
  platform noise. The doc's `adb logcat -s CdpRelay` diagnostic in
  `research/browser-proof/TEST-ON-DEVICE.md` cannot work. Use
  `…/.hermes/logs/agent.log` + `errors.log` (readable through the gateway) and
  `/proc/net/*` instead. `run-as` is unavailable (release build) so nothing in
  the app sandbox is readable from adb without the gateway.
- The harness taps views by accessibility text; **when the soft keyboard is up,
  uiautomator still reports coordinates of views underneath it**, so taps aimed
  at lower-screen controls land on the IME. Always check
  `dumpsys input_method | grep mInputShown` first (`.devtest/ui.py hidkb`).
- Screenshots of every state are in `.devtest/shots/` (PNG) and
  `.devtest/view/` (downscaled JPEG) — useful because the terminal is a canvas
  WebView with no accessibility text.
- Leftovers from this session: one test bot **`research-assistant`** (cannot be
  deleted in-app — BUG-110; one chat "Bot · research-assistant" with it), and the
  `adb forward tcp:19119/19334` rules. Test jobs, share payloads and the
  IPv4-shim files were all removed.

## Late additions

- **Terminal session lifetime** — guest PTY processes (proot `linker64` + `bash`)
  exist only while the app runs: present with the Terminal open, gone after
  `am force-stop`. "Swipe-killing the app ends it" holds; nothing leaks.
  ✅
- **Voice** — `Record voice` raises the system mic prompt
  (`Allow Moch to record audio?`), declining returns to the app with the inline
  explanation `Allow microphone access to record voice.` No crash, no dead
  control. Nothing was granted or revoked (device left as found). Actual
  recording/STT is **not testable over adb** (no way to inject microphone audio) —
  needs a human.

---

## Terminal runbook step 9 — Reset Linux (run on request, and it found a URGENT bug)

The reset itself behaves as documented: confirm dialog → guest deleted → the
Terminal immediately reports

```
Moch Linux isn't installed yet.
Install it from Settings → Linux environment, then come back.
```

**But the environment could not be reinstalled.** Full chain (BUG-123):

1. `linux/rootfs/{data,workspace}` survive the reset. `workspace` — the bind
   target for the app workspace — is a directory the app's own uid cannot even
   read: `GET /api/fs/list …/rootfs/workspace` → `{"entries":[],"error":"EACCES"}`,
   and `DELETE /api/files …/rootfs/workspace` → `500 [Errno 13] Permission denied`
   (unchanged after an app restart, so it is not a stale mount). `reset()`'s
   strict `shutil.rmtree` therefore raises, leaves the tree half-deleted, and the
   UI shows no error at all.
2. With `rootfs/` still present, `bootstrap()`'s guard `if not rootfs.exists():`
   is false → **the Ubuntu base is never downloaded**. proot/libtalloc/shmem do
   get re-fetched, the stamp is written, `report["ok"] = True`, and `status()`
   then reports **`Linux ready — None · 0 MB on disk`** while the Terminal still
   says not installed. `Update / reinstall environment` is a no-op forever after
   (retried twice, 80 s and 60 s of monitoring: `linux/tmp` never receives a
   partial download, no downloader process appears).
3. Settings also served a stale row: right after the reset it still said
   `Linux ready — Ubuntu 24.04.4 LTS · 132.5 MB` until the screen was re-entered
   (the same cache that made the false-positive state visible).

This is the worst class of device bug found in this pass: a documented Settings
action bricks Moch Linux (Terminal screen, `exec_in_guest`, every guest feature)
and the app both hides the failure and then claims the guest is ready.

### Fix applied and verified (working tree, uncommitted at the time of writing)

`app/python-runtime/moch/linux_env.py`:

- `bootstrap()` — the rootfs step is gated on the **sentinel**
  `rootfs/etc/os-release` instead of bare `rootfs.exists()`, so a stub tree can
  never satisfy it.
- `status()` — `bootstrapped`/`rootfs_exists` require the same sentinel, so the
  UI cannot report "Linux ready" over an empty directory.
- `reset()` — `shutil.rmtree(..., ignore_errors=True)` plus an explicit stamp
  removal and an honest `{"ok", "removed", "leftovers"}` result; the workspace
  bind target is tolerated and reported instead of raising into the bridge.

`app/python-runtime/tests/test_linux_exec.py` — three regression tests added
(stub rootfs is re-provisioned; status needs a distribution; reset tolerates an
undeletable leftover and clears the stamp). Whole module: **39/39 green**.

The APK was rebuilt and reinstalled over the top (same signing key ⇒ chats,
bots, keys and settings preserved) and the guest was then re-provisioned from
Settings — see "Recovery verification" below.

### Recovery verification (after the rebuild + reinstall)

`adb install -r` over the top → app data intact (`/api/profiles` still lists
`default` + `research-assistant`, 6 sessions, cron run sessions present).

| step | result |
|---|---|
| Settings → Linux row with the fix | `No Linux environment` (the false `Linux ready — None · 0 MB` is gone) |
| `Install Linux environment` | rootfs went from the 2-entry stub to **20 entries in ≤30 s** (`bin boot data dev etc home lib media …`) — the download/extract actually ran |
| Settings after install | `Linux ready — Ubuntu 24.04.4 LTS · 132.5 MB on disk` |
| Terminal screen | live prompt `root@localhost:~#`; `uname -a` → `Linux localhost 6.17.0-moch … aarch64 GNU/Linux`; `head -1 /etc/os-release` → `PRETTY_NAME="Ubuntu 24.04.4 LTS"` |
| Agent `terminal` tool | `echo AGENT-EXEC-OK` → assistant replied `AGENT-EXEC-OK` |

Fix verified end-to-end on the device; BUG-123 is checked off in `bugs.md`.
The three regression tests stay green (39/39 in `tests/test_linux_exec.py`).

**Working-tree state:** `app/python-runtime/moch/linux_env.py` (fix) and
`app/python-runtime/tests/test_linux_exec.py` (3 new tests) are uncommitted, and
the installed APK is that rebuild — `versionCode 18 / 1.0.15-browser` plus the
local BUG-123 fix (the version string was not bumped).

---

## Browser deep test — TEST-ON-DEVICE.md steps 5/6, with the address-family defect worked around

Because BUG-106 blocks every browser call, the feature's real acceptance tests
were run with the in-namespace IPv4→IPv6 forwarder from the root-cause proof
(`/workspace/fwd.pl`, perl, 127.0.0.1:9334 → [::1]:9334) and nothing else changed.

| doc step | prompt | result |
|---|---|---|
| 5a | "Use browser_navigate to open https://example.com …, then browser_snapshot and click the 'More information…' link" | ✅ agent ended at `https://www.iana.org/help/example-domains` (title "Example Domains") after a real snapshot + click — **and the visible tab did move**: tab strip `Example Domains`, URL bar `https://www.iana.org/help/example-domains`, page rendered |
| 5b | "search google for 'hermes agent' and open the first organic result" | ✅ `browser_navigate` → `google.com/search?q=hermes+agent`, then it read the results and picked the first *organic* hit — explicitly skipping the Play-Store ad unit — landing on `https://hermes-agent.nousresearch.com/`. Visible tab: title `Hermes Agent — Open-Source AI Agent That Grows With You \| Nous Research`, URL `https://hermes-agent.nousresearch.com/`, page rendered |
| 6 | sessionless dialog path | not run this pass (no alert page staged) — still open |

The agent's own tool trail (`/api/sessions/20261011_161231_baeb00/messages`,
profile `research-assistant`) is clean: `browser_navigate` → `browser_snapshot` →
click → `browser_console` verification steps, every call `{"success": true}`, no
"No browser page" and no "relay is not running". So attach, navigate, snapshot,
ref-click and console all work on the device; the ONLY thing wrong with the
feature is that the relay listens on `::1` while the clients dial `127.0.0.1`.

Conclusion for the browser surface: **one-line bind fix away from fully working**;
nothing else in the chain (Kotlin relay, abstract devtools socket, WebView attach,
snapshot refs, CDP input, visible-tab sync) is broken.

---

## Background / screen-off tasking (M6/M7 machinery)

Procedure: send a message in a fresh chat, then `input keyevent 3` (HOME) +
`input keyevent 26` (screen off → `mWakefulness=Dozing`), wait 40 s, inspect the
session store and the notification shade, then wake and reopen the app.

| check | result |
|---|---|
| run completes with the screen off and the app backgrounded | ✅ session `20261011_161900_95a4fd` reached 2 messages; assistant reply is exactly `SCREEN-OFF-OK` |
| knock on completion | ✅ a `hermes-alerts` notification (importance 4 = heads-up, brand colour) with `android.title = "Agent replied"` was posted while the screen was off |
| foreground service | ✅ `hermes_runtime` notification present, `android.text = "Mochi is awake on this phone — automations and tasks keep working."` |
| UI consistency on return | ✅ reopening shows the chat title, the user message and `SCREEN-OFF-OK` with the 16:19 timestamp |

So the "works even when the app is closed / screen off" promise holds for the
chat path and the knock fires.

---

## Pairing / "Add computer" (Settings → COMPUTERS)

The screen renders correctly and offers all three paths: `Scan pairing QR`,
`Use this phone as the agent host`, and `More pairing options` → **PASTE PAIRING
LINK** (`hermes://connect?host=…&token=…`) plus a manual `host:port` field with
a `Use TLS (HTTPS/WSS)` checkbox. The working connection to the embedded runtime
(`Connected to This phone · WS · 127.0.0.1:9119`) is untouched by opening or
leaving the screen.

**P-1 (LOW) — a bad pairing link is rejected in complete silence.** Pasting
`hermes://connect?host=127.0.0.1:1&token=bogus` and tapping `Use pairing link`
produced no message, no error, no state change at all — the screen did not move
and `/api/pairing` stayed `{"pending": [], "approved": []}`. A user who mistypes
a host or scans an expired QR has nothing to act on.

Not tested, and not testable over adb: an actual pairing (needs a second machine
printing its QR — the phone's camera cannot be fed an image). The manual-entry
fields and the TLS toggle are present and reachable; the fail path is the part
that is broken.

## Round summary — everything exercised this pass

Browser (deep tool test with the address-family workaround) · background and
screen-off tasking with the completion knock · pairing screen and its failure
path · plus everything from the previous pass (terminal 9/9, fleet/bots, crew,
automations incl. the scheduled ticker, connectors, share-in warm/cold, settings,
models, skills, search, i18n, voice permission flow).

Two device-only root causes proven, one URGENT bug found → fixed → rebuilt →
verified (BUG-123), and one blocking defect (BUG-106) isolated to a single line
with the whole rest of the feature chain proven healthy around it.

---

## Browser round 3 — refs, console, attachment lifetime, URL policy

Deep pass on the agent-facing primitives (all with the IPv4 workaround in place,
so every failure below is above the address-family layer).

| probe | result |
|---|---|
| `browser_snapshot` on a fresh page | ✅ `[e1] text` / `[e2] submit "Search"` with URL/title/scroll header |
| `browser_type` with ref **`@e1`** (the ref exactly as printed, with the model's habitual `@`) | ❌ `{"success": false, "error": "stale ref @e1 — re-snapshot"}` — twice, across two fresh snapshots. **BUG-125** |
| `browser_type` with ref **`e1`** + `browser_click` with ref **`e2`** | ✅ both succeed; the typed text really lands in the visible DuckDuckGo field and the click submits the form |
| `browser_console` evaluating JS on google.com (16:12) | ✅ worked, repeatedly (read result links) |
| `browser_console` on a plain https page (16:30) | ❌ `JavaScript evaluation is not supported by this browser backend. agent-browser CLI not found (cached)` — evaluation never ran. **BUG-126** |
| `browser_navigate` to a `data:` URL | ❌ refused as `Blocked: URL targets a private or internal address` — right refusal, wrong reason. **BUG-128** |
| `browser_snapshot` minutes after a successful navigate+type+click | ❌ `No browser page. Call browser_navigate first…` while the screen was open, the tab loaded and the relay healthy; a fresh `browser_navigate` re-attached it instantly. **BUG-127** |
| sessionless dialog path (step 6) | ⏸ **not exercised** — see below |

Why the dialog path stayed untested: the agent's URL policy refuses `data:` and
every private/loopback host (verified: `http://127.0.0.1:9119/` → *"Blocked: URL
targets a private or internal address"*), so a locally hosted alert page cannot
be reached by the tool; the public "try it" alert demos are iframe-based; and the
`browser_console` route to raise the alert is blocked by the console backend
error above. Raising a real `Page.javascriptDialogOpening` needs either a public
page that alerts from the top frame or a relaxed URL policy for loopback test
pages — worth adding to the device runbook.

Net: the *primitives* are mostly right (snapshot, bare-ref click/type, navigate,
visible-tab sync, console when it works) but three of them have failure modes
that look like "the browser is dead" to a user: stale-ref-on-format, a console
backend error naming a CLI that cannot exist on the phone, and a lost attachment
after a navigation.

## Runtime lifecycle — "Restart runtime" works, "Stop runtime" is dead

- **Restart runtime** ✅ — tapped from a fresh dump: the app exited immediately
  (pid gone, launcher focused) and a relaunch came back clean on a new pid with
  the gateway answering `200` on `127.0.0.1:9119`.
- **Stop runtime** ❌ — no dialog, no toast, no exit: same pid, app still in the
  foreground, the gateway still serving ten seconds later, no crash in logcat.
  The neighbouring Restart row proves the tap lands, so this is the handler, and
  `settings.tsx:130` hides any error with `.catch(() => {})`. **BUG-129**

(The final relaunch left the app on a fresh `New chat` chat, connected.)

---

## Attachments / vision, and the busy state (round 4)

**Attachment + vision — PASS.** Created a 640×400 PNG on the PC reading
`MOCH TEST IMAGE 42`, pushed it to `/sdcard/Download/moch-test.png`, picked it
through the composer's `+` → `File` → Downloads (the system photo picker shows
the user's gallery — deliberately avoided), sent it with *"Read the exact text
written in this image. Reply with only that text."* The chip rendered as
`Image: moch-test.png · 39.5 kB` and the agent answered exactly
`MOCH TEST IMAGE 42` — upload ⇒ attach ⇒ vision is intact end to end. Test file
removed from Downloads afterwards.

(Picker note for the runbook: `Photo or video library` opens the Google photo
picker over the *user's own* gallery, and a freshly pushed file is not in it —
use `File` → `Show roots` → `Downloads` for a controllable fixture.)

**Busy state — FAIL (BUG-130).** With a turn in flight for 20–40 s (a `terminal`
call to `sleep N; echo …`, timings later confirmed from the message timestamps)
the chat screen reported idle at every sample: the composer slot showed
`Record voice` instead of `Stop`, the placeholder stayed `Ask Mochi…` instead of
the queued variant, and the drawer row showed no working dot. The server knew —
one mid-run detail fetch returned `last_activity_description: "receiving stream
response"` — but `session.list` rows expose no running flag, and `busy` is what
gates the Stop button (`chat.tsx:1469`). Net effect: **a long or looping run
cannot be stopped from the phone.**

### Round-4 note: one probe was inconclusive (harness, not app)

A try at "send a second message while a turn is genuinely in flight" failed on my
side: the fast tap sequence skipped the IME check, so the text went nowhere and the
send tap submitted an empty composer (nothing appeared in the UI *or* the session
store). Recorded here so the next session does not read it as a lost message — the
earlier "send while busy" attempt in the same round also landed just after the turn
ended (transcript timestamps confirm), so **queued-send / steer-while-running is
still untested** and is the natural follow-up to BUG-130: with `busy` false the
client cannot queue, so whatever the user types mid-run goes straight at
`prompt.submit` (or, per this round, nowhere at all if the composer was not
focused).

## Round summary (round 4 of the on-device campaign)

- **Attachments + vision**: PASS end-to-end (pushed PNG → composer `+` → File →
  Downloads → chip → the agent read the exact text out of the image).
- **BUG-130 (new, HIGH)**: a running turn shows no busy state anywhere in the UI —
  no Stop button (it is gated on `busy`), idle placeholder, no drawer dot — while
  the server is mid-turn; `session.list` rows carry no running marker, so a client
  cannot recover the state. A long/looping run cannot be stopped from the phone.
- **BUG-129 (from the previous round)**: `Stop runtime` is a silent no-op while its
  sibling `Restart runtime` exits the app properly.
- Harness lesson for the runbook: with the soft keyboard hidden, `input tap` on the
  composer does not focus it and `input text` is silently dropped — always assert
  `mInputShown=true` (`.devtest/ui.py ime`) before typing.

---

## CORRECTION (round 5) — the "no busy state" finding was an instrument failure

The round-4 entry "Busy state — FAIL (BUG-130)" is **wrong as written** and is
corrected here and in `bugs.md`.

What actually happens: with a turn provably in flight (a `terminal` call to
`sleep 600`, transcript 17:08:28 → still holding 10 minutes later), a screenshot of
the composer band reads **"Steer"** — and `chat.tsx:1414` renders that chip *only*
when `busy` is true. So the app does track the run; the Stop button
(`chat.tsx:1469`, same `busy` gate) is rendered too.

What misled me: **the composer's accessibility subtree goes stale during a run.**

- `uiautomator` lists **no** `Steer mode` node although the chip is on screen, and
  keeps reporting the composer slot as `Record voice` instead of the `Stop` button
  that `busy` renders there. The rest of the tree (transcript bubbles,
  `Thought · Ns`) updates normally, so it is the composer subtree specifically.
- The composer `EditText` node's `text` freezes at the last **submitted** prompt
  (`"Run exactly this with your terminal tool: sleep 600…"`) while the real field
  holds later typing — a screenshot after typing shows `TESTFOCUS123 ZZTOP999` in
  the box minutes after the node stopped changing, both mid-run and after.

Consequence: screen-reader users cannot reach Stop/Steer, and any
accessibility-driven automation (this campaign's included) reads an idle-looking
composer with the wrong text. Everything in this report that sampled "Record voice
/ Ask Mochi…" through the a11y tree during a run should be read with that in mind —
the earlier samples are not evidence of a missing busy state.

**Lesson for the harness:** never trust the a11y tree alone for composer state
during a run — pair every dump with a screenshot/OCR (`.devtest/ui.py ocr`), which
is what finally caught this.

## Round 5 additions

- **BUG-131 (new, MEDIUM)**: `/api/sessions` list rows carry **no running marker**
  (`running`/`active`/`busy` all `null`) for a session whose own detail endpoint
  says `last_activity_description: "receiving stream response"` at the same
  instant — so a reconnecting client, a chat switch, or a second device can never
  learn from a list refresh that a chat is working (`chat.ts:1095` has a
  `res.running` branch no list payload can satisfy).
- **Attachments + vision**: PASS (see round 4).
- The 10-minute holding turn was ended by restarting the app; guest processes are
  clean again, profiles/chats intact, gateway healthy.

### Stop control — verified working (round 5)

Fresh chat, prompt *"Run exactly this with your terminal tool: sleep 300; echo
STOPTEST …"* → screenshot of the composer band 8 s later reads:

```
Steer
Reply — queued until it finishes
```

i.e. the busy UI (`busy === true`) with the Steer chip and the queued placeholder.
Tapping the slot that `busy` swaps to **Stop** (847,2276) ended the run:

- the chip and the queued placeholder disappeared (band blank on the next capture),
- no `sleep 300` process ever appeared in the guest,
- the transcript (`20261011_172542_680ee0`) shows the user message at 17:25:43 and
  the server's cancellation answer at 17:26:02:
  *"Your request was not processed. Send it again if you still want me to carry it
  out."*

So the Stop control is real, reachable and effective — the round-4 "cannot stop a
run" claim was purely an accessibility-tree artefact (see the correction above).
The genuine defect that remains is **BUG-130 as corrected**: those busy-only
controls are invisible to screen readers (and to a11y-driven automation), which is
also why the harness misread the state.

---

## Steer-while-running, and long-command backgrounding — both PASS (round 6)

Sequence on device, one chat, `terminal` call holding a turn open:

1. Prompt: *"Run exactly this with your terminal tool: `sleep 180; echo STEER-BASE` …"*
   → the tool call **yielded to the background**:
   `{"output": "", "exit_code": null, "status": "yielded_to_background", "session_id": "proc_97bc934d95be", "pid": 15886}`
   (17:27:29) — a long command does not block the turn.
2. Busy UI confirmed by screenshot (not a11y): `Steer` chip + placeholder
   *"Reply — queued until it finishes"*.
3. Tapped the chip (540, 2122 — located by OCR TSV, since the chip has no a11y node):
   the placeholder switched to *"Steer the running task…"*, i.e. steer mode armed.
4. Typed the steer instruction and tapped send. The transcript shows it delivered
   **mid-turn** (17:28:22):
   `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history] STEER-INJECT also say the word STEERED in your final answer`
   and the UI rendered it as a normal user bubble; steer mode reset itself afterwards
   (placeholder back to the queued variant).
5. The agent adapted mid-turn (`tool_describe`, `process_manage`), the background
   command completed at 17:30:30 with `{"status": "exited", "exit_code": 0, "output": "STEER-BASE"}`
   and the final answer at 17:30:41 was **`STEER-BASE  STEERED`** — it honoured both
   the original instruction and the injected one.

Two features verified here that had no device evidence before: **steer (out-of-band
mid-turn injection)** and **automatic backgrounding of long terminal commands with a
completion result**. Together with the verified Stop control, all three controls in
the busy composer are functional — the only defect in that area is the
accessibility one (BUG-130).

### Busy-controls trio — final tally (round 6)

| control | result | evidence |
|---|---|---|
| **Steer** (mid-turn injection) | ✅ PASS | chip toggled by pixel-located tap; message delivered as `[OUT-OF-BAND USER MESSAGE …]` mid-turn at 17:28:22; final answer `STEER-BASE  STEERED` honoured both instructions |
| **Stop** (pre-tool) | ✅ PASS | run cancelled before the tool call; server answer *"Your request was not processed…"*; no guest process ever appeared (two separate runs) |
| **Backgrounding** of long terminal commands | ✅ PASS | `yielded_to_background` at 17:27:29 → completion result at 17:30:30 `{"status":"exited","exit_code":0,"output":"STEER-BASE"}` |
| **Stop mid-tool-execution** | ⏸ **not established** | my sequence confounded it: one Stop tap landed while the composer was already idle, i.e. on the *voice* slot, which starts recording — the following prompt then came back instantly as *"Your request was not processed"*. A clean follow-up send 30 s later worked normally (`AFTERSTOP-OK`, 17:33:12 → 17:33:23), so there is **no** "post-stop sends are broken" bug; the interrupt test simply needs the Stop slot confirmed by screenshot before tapping. |
| **Send after a Stop** | ✅ PASS | see above |

Harness rule that came out of this: because BUG-130 hides the busy-only controls
from a11y, the only reliable way to know whether the composer slot is **Stop** or
**Record voice** is a screenshot (`Steer` chip present ⇒ `busy` ⇒ Stop). Tapping it
blind while idle starts a voice recording.

---

## POST-FIX VERIFICATION — BUG-106 and BUG-125 fixed, browser works with no workaround

Applied (working tree, uncommitted at the time of writing) and rebuilt
(`assembleRelease` BUILD SUCCESSFUL, installed with `adb install -r`; chats, bots,
keys and settings intact):

- `app/android/.../hermes/CdpRelay.kt` — bind `InetAddress.getByName("127.0.0.1")`
  for both the preferred port and the ephemeral fallback (was
  `getLoopbackAddress()` → `::1` on Android). **BUG-106**
- `app/hermes-src/tools/browser_webview.py` — new `_normalize_ref()` wrapper used by
  `_ref_js`: strips `@`, `[…]`, and whitespace; the miss message now reads
  `unknown ref e1 — refs are the bare ids the snapshot prints ([e1] → e1); …`.
  **BUG-125**

### Evidence, all with the shim gone

```
nc 127.0.0.1 9334                      → IPV4-REACHABLE            (was: Connection refused)
/proc/net/tcp6 | grep 2476             → ::ffff:127.0.0.1:9334 LISTEN
browser_navigate example.com           → {"success": true, "title": "Example Domain"}
browser_navigate lite.duckduckgo.com   → {"success": true, "title": "DuckDuckGo Lite…"}
browser_snapshot                       → [e1] text / [e2] submit "Search"
browser_type  {"ref":"@e1"}            → {"success": true, "typed": true}
browser_click {"ref":"@e2"}            → {"success": true, "clicked": "e2"}
```

The **visible tab** followed every call: after the type+click the tab strip read
`moch fixed at DuckDuckGo`, the page's search box held the typed query and results
rendered — the user-facing acceptance for the whole feature, now on the shipped
build with no forwarder, no reconstruction.

`browser_click({"ref":"@e1"})` on a page whose snapshot has **no** refs
(example.com returns only `URL/Title/Scroll`) now fails honestly:
`unknown ref e1 — refs are the bare ids the snapshot prints ([e1] → e1)`. Before
the fix that exact call said `stale ref @e1`, which is what sent the model
re-snapshotting in circles.

### Runbook re-run after the fix

| step | result |
|---|---|
| 1.3 restart → chat-first, Browser never opened | ✅ relay down, catalog has **no** browser tools (`["skill_view","skills_list","terminal","tool_search","tool_describe","tool_call"]`) — BUG-105's fix holds |
| 1.4 open Browser → ask again | ❌ still no browser tools in a chat created 60 s later (**BUG-107**, unchanged by these fixes) |
| 2/3 navigate + click/type, visible tab | ✅ works (table above) |

**New in the 1.4 failure:** today's three session catalogs were 22 / 8 / 6 tools
wide, and the narrow ones look like the *deferred* surface (`tool_search`,
`tool_describe`, `tool_call`) rather than "browser gate off". The only 22-tool
session was created in an app run that had **not** been restarted since the
install (gate armed at 17:49:50), while the 6- and 8-tool sessions came after a
restart. Recorded in BUG-107 as the next thing to look at: how the embedded
gateway chooses a session's catalog (deferred vs full), because the browser gate
alone does not explain it.

---

## BUG-107 FIXED — opening the Browser screen now arms the tools mid-session (round 14)

Root cause, read out of the source: `moch/browser_gate.activate()` cleared only
`tools.registry._check_fn_cache`, but the list the model actually receives is
memoized one layer up in `model_tools._tool_defs_cache`, keyed by
`(enabled_toolsets, disabled_toolsets, skip_tool_search_assembly)` with the
browser verdict already baked in. Nothing on the browser path cleared that memo
(only `tools/mcp_tool_agent.py::reprobe_tool_availability()` does, for the same
reason when an MCP server appears). Any catalog assembled while the relay was down
therefore replayed browser-less for the rest of the process — which is exactly the
18:01 (6 tools) / 18:03 (8 tools) pair, and why one earlier run produced a 22-tool
session.

Fix applied (`app/python-runtime/moch/browser_gate.py`): `activate()` now clears
**both** caches — `invalidate_check_fn_cache()` and
`model_tools._clear_tool_defs_cache()` — each best-effort, mirroring the MCP
helper. (Also settled while digging: all 18 `browser_*` names are in
`toolsets._HERMES_CORE_TOOLS`, so Tool Search can never defer them — that
hypothesis is dead, not the cause.)

Rebuilt, installed, and verified on device in one process with no restart:

| step | catalog |
|---|---|
| chat created **before** opening Browser | **6** tools, no `browser_*` (gate correctly off) |
| open Browser screen (`gate active`, relay socket up) | — |
| **new chat** after the flip | **21** tools incl. all ten `browser_*` |
| *"open example.com in the visible tab"* in that chat | agent used `browser_navigate`, answered **"Example Domain"**; Browser screen tab strip `Example Domain`, URL bar `https://example.com/` |

**TEST-1.0.15-browser.md step 1.4 now passes as written.** With BUG-106 and
BUG-125 also fixed this session, the whole runbook is green on the shipped-style
build: restart → gate off (1.3 ✅) → open Browser → tools live in the next chat
(1.4 ✅) → navigate/click/type drive the visible tab (2/3 ✅).

---

## BUG-109 + BUG-110 FIXED — the bots feature is live on the device (round 15)

**BUG-109 (`MOCH_FLEET` never armed).** `gateway_server._run_server` now sets
`MOCH_FLEET=1` (setdefault) just before the existing flag-gated install block —
the embedded-gateway arm the module docstring always claimed existed. 47/47 PC
fleet tests green. On device, one process, no restart:

| check | before | after |
|---|---|---|
| `moch.fleet.status` | `-32601 unknown method` | `{"fleetEnabled": true, "queue": {"slots": 2, "active": 0, "waiting": []}}` |
| `moch.kanban.tasks` | `-32601` | `{"tasks": []}` |
| `moch.runs.timeline` | `-32601` | real merged ledger (cron job runs + a delegation) |
| Crew screen | raw `unknown method … run hermes update` banner over empty columns | banner gone; **Run ledger** shows `job 06aa786b01d6 · completed`, `delegation completed · @default`, `job 6d6867e4b948 · completed` |
| Freeze | silent no-op | `research-assistant: frozen False → True`, button becomes `Unfreeze …` |
| frozen bot receives a chat | — | refused with **"bot is frozen (fleet kill switch)"** |
| ordinary chat through the armed admission gate | — | unchanged (`GATE-OK`) |

**BUG-110 (bot delete).** Two independent causes. The first was BUG-109 (the
`moch.profiles.delete` RPC did not exist). The second — found by testing the
first fix on the phone — is in `app/app/bot.tsx`: `doDelete()` began with
`if (confirmDelete < 2 || deleting) return`, but the second tap calls it from the
render where `confirmDelete` is still `1`, so the guard always returned and the
button sat on "deleting…" forever. Guard removed (the armed tap is the
confirmation; only `deleting` gates). Rebuilt, installed, verified: create a
throwaway bot → `Delete this bot` → `Tap again to confirm deletion` → gone from
`/api/profiles`, roster refreshed, screen returned to Fleet. **The user confirmed
the delete now works on their own device.**

Still open in this area: **BUG-108** — the bot detail editor calls
`profiles.describe` / `profiles.configure` with `{profile: …}` while that family
resolves `params["name"]`, so the SOUL/description editor loads blank and Save is
a silent no-op (probed earlier today: `4063 name required`). Two argument names;
not touched this round.

---

## BUG-108 FIXED — the bot detail editor loads and saves (round 16)

`app/app/bot.tsx` called `profiles.describe` / `profiles.configure` with `{profile: bot}`;
that RPC family resolves `params["name"]` (`tui_gateway/methods_profiles.py::_resolve_profile`,
4063 otherwise) — only the `moch.*` family takes `profile`. `fleet.ts`'s `profiles.create`
already used `name`, which is why creating a bot always worked while editing it never did.
Both call sites now send `{name: bot}`; `tsc` clean; rebuilt and installed.

| check | before | after |
|---|---|---|
| Job/description field | placeholder `What is this bot for?` | `Research assistant: read my saved sources daily and brief me on what changed.` |
| SOUL editor | empty | `# research-assistant …` |
| Save | silent no-op | edited to `Research assistant (device test edit)` → `profiles.describe {name}` returns exactly that |
| SOUL integrity across Save | — | intact (`startswith("# research-assistant")`) — worth noting the pre-fix path would have written an EMPTY soul over a real `SOUL.md` on the first Save, so this was data-loss-shaped |
| restore | — | original description written back through the same Save path and re-verified |

That closes the M9.2 bots feature on device: create ✅ (5 s, template), chat identity ✅,
roster/persistence ✅, **detail + SOUL/description editing ✅**, freeze/unfreeze + kill switch ✅,
delete ✅, Crew board + run ledger ✅.

---

## BUG-111 FIXED — the active bot is now visible and one tap from off (round 17)

Repro on the pre-fix build (fresh install): `Fleet → Chat with research-assistant` (arms the
persisted active bot) → New chat from the Chat tab → the session lands in the bot's profile
(`research-assistant -> Exact reply CAPTURE-PROBE request`) while the header shows only the title.
Nothing in the UI said a different profile — different memory, skills, credentials, routing — was
serving the chat.

Fix (`app/app/(tabs)/chat.tsx`): a bot chip in the chat header, rendered from `activeBotAtom`
(the same atom that decides new-chat scoping), next to the model chip. Tap → plain-language
explanation + **Stay** / **Switch back** (`setActiveBot(null)`). `tsc` clean, rebuilt, installed.

| check | result |
|---|---|
| chip present after `Fleet → Chat with <bot>` | ✅ (`research-assistant`, accent chip beside `glm-5.3-flash`) |
| survives an app restart | ✅ (active bot is persisted) |
| tap explains the scoping | ✅ *"New chats go to research-assistant — This bot runs on its own profile: its own memory, skills and credentials…"* with Stay / Switch back |
| `Switch back` clears it | ✅ chip gone |
| next New chat lands in `default` | ✅ `default -> Reply with SWITCHED-BACK` (pre-fix: the bot profile) |

Design remainder recorded rather than "fixed": M9.2 wants a *persisted* active bot, so it stays on
until switched back — but it can no longer capture chats silently, and leaving takes one tap.

---

## BUG-112 FIXED — bot chats survive a restart and show up with their identity (round 18)

`sessionList.loadSessions` asked `session.list` for the active profile only, so a bot's
conversations vanished from both list surfaces once the optimistic local row was gone (restart, or
any other device). Fix: `withOtherProfiles()` fans out over the Fleet roster (bounded to 8,
best-effort per profile, failures skipped), tags rows with `SessionRow.profile`, and interleaves by
recency so the default profile's ordering is preserved among its own rows. The roster is primed once
with `refreshFleet()` when empty — the missing half of the first attempt, since without it a cold
start has no profile names to ask for. The drawer prefixes a bot row with its profile
(`research-assistant · <title>`) unless the title already contains the name.

Verified on the installed build, **cold start with no Fleet visit**:

```
Open Reply with SWITCHED-BACK                                  ← default
Open research-assistant · Exact reply CAPTURE-PROBE request     ← bot, back after restart
Open Reply with ATTRIB-PROBE                                   ← default
Open research-assistant · Reply with GATE-OK                    ← bot
Open research-assistant · Reply exactly with POSTGATE-OK        ← bot
Open research-assistant · Reply exactly BASELINE-OK             ← bot
```

The Chats screen lists the same merged set (present, without the drawer's prefix). `tsc` clean.

**M9.2 bots feature status on device: complete** — create, scoped chat with identity, roster +
persistence, detail/SOUL editing, freeze/kill-switch, delete, Crew board + run ledger, and now the
sidebar identity surviving restarts.

---

## BUG-113 FIXED — cold share reaches the composer (round 19)

Reproduced on the current build first (`am force-stop` → `ACTION_SEND text/plain`): the app
cold-booted to `New chat` with an empty composer. Root cause, in the client: the share effect ran
before the screen owned a session, so `draftFor(storedId)` was called with `storedId === ''` —
which returns `''` by contract — the payload was written under the empty draft key, the inbox was
acked, and when the new session landed `setInput(draftFor(newStoredId))` re-read that session's own
(empty) draft and cleared the composer. Warm shares never hit it because a session already existed.

Fix (`app/(tabs)/chat.tsx`): the effect holds the share in the inbox while `storedId` is empty and
takes `storedId` as a dependency, so it fires once the session exists and lands text (and attachment
chips) in the right draft. `tsc` clean, rebuilt, installed.

| check | result |
|---|---|
| cold share (`am force-stop` → SEND) | ✅ composer holds `cold-share-fixed-19` on a fresh `New chat` |
| warm share (SEND while running) | ✅ merged into the draft beside the first (`cold-share-fixed-19 warm-share-19`, screenshot-verified) |

---

## BUG-116 FIXED — the EN/AR switch exists and works (round 20)

The M9.2 catalog shipped with `setLocale()` / `loadLocale()` and **zero callers**, so the Arabic
strings and the RTL flag were unreachable. Two wires added: `loadLocale()` at boot
(`app/_layout.tsx`) and a **Language** row in Settings → APPEARANCE bound to `localeAtom`
(`app/(tabs)/settings.tsx`), offering English / العربية through the app's own sheet and stating in
the subtitle what the choice affects. `tsc` clean, rebuilt, installed.

| check | result |
|---|---|
| pick العربية | ✅ Fleet screen switches live: `الأسطول` · `تحديث الأسطول` · `وقت التشغيل · 0/2 مهام` |
| Settings row | ✅ `العربية — fleet screens are right-to-left` |
| survives a restart (`force-stop` + relaunch) | ✅ still `الأسطول` — the boot `loadLocale()` works |
| back to English | ✅ `Fleet` / `Refresh fleet` (app left in English, as found) |

Scope is stated in-app rather than pretended: only the fleet surfaces are catalogued today (per the
`strings.ts` scope note), so switching shows mixed languages — the retrofit of the rest of the app
remains the documented later pass.

---

## BUG-114 — server search fixed and verified; the UI wire is still missing (round 21)

`hermes_state_search.py::search_messages` answered `[]` for every query when the interpreter has no
`fts5` module — the Android embedded runtime — and it returned before reaching the LIKE fallback
that sits directly above it for the stale-index case. Fix: use that same fallback (and the same
finalisation) on the no-FTS path. Rebuilt, installed, and verified on device:

```
GET /api/sessions/search?q=reachable from my side   → 1 result, real snippet   (was [])
q=relay → 1     q=GATE → 3     q=SWITCHED → 1
q=GATE-OK → 0   ← hyphenated queries miss; the FTS5 query sanitizer mangles `-` and the LIKE path inherits it
```

**What is still missing for the user-visible fix:** the app never calls session search. `grep` over
`src/` and `app/` finds no `sessions/search` / `session.search` call — the drawer (`Sidebar.tsx:430`)
and the Chats screen both filter the loaded rows client-side, so only titles can match no matter how
well the backend works. The remaining work is a UI wire: call the server search when the query is
non-empty, render matches as a grouped section (conversation title + snippet), and open the session
on tap. Recorded in BUG-114 with that plan rather than claimed as done.

---

## BUG-114 FIXED — content search works from the phone (round 22)

Finishing the pair started last round: the server side (LIKE fallback when the interpreter has no
`fts5`) plus the missing client wire. `app/(tabs)/sessions.tsx` now queries
`/api/sessions/search?q=…&limit=12` as you type (300 ms debounce, best-effort), maps hits
(`session_id`/`title`/`started_at`/`profile` → `SessionRow`) and merges them after the local
title matches, deduped. The local filter still runs, so an unreachable search RPC degrades to the
old behaviour instead of an empty screen. `tsc` clean, rebuilt, installed.

| check | result |
|---|---|
| `reachable from my side` (body-only phrase) | ✅ lists **`List available tools #2`** — previously `No matches` |
| `zzqqxx-no-such-thing` | ✅ `No matches` (no false positives) |
| server probe (previous round) | ✅ `q=relay` → 1, `q=GATE` → 3, `q=SWITCHED` → 1 |

Polish noted, not hidden: the matched row shows its normal meta line (`0 msgs · started 6h ago`)
rather than the returned snippet, since the row only falls back to `preview` when the title is
empty; surfacing "why it matched" is a follow-up, as is the hyphenated-query nit.

---

## BUG-118 — MCP catalog plumbing fixed and proven end-to-end (round 23)

`mcp_catalog._catalog_root()` passes the source-checkout `optional-mcps/` path as the resolver's
*default*, and `_packaged_dir` only falls back to `<HERMES_HOME>/optional-mcps` when no default is
given — so inside the app the non-existent checkout path won and the catalog was always empty. Fix
without touching vendored code: `hermes_boot._prepare_home` creates `<HERMES_HOME>/optional-mcps` and
sets `HERMES_OPTIONAL_MCPS` to it.

Proof, in order, on the installed build:

| step | result |
|---|---|
| catalog dir after boot | ✅ `<home>/optional-mcps` exists |
| drop a valid `manifest_version: 1` manifest (`filesystem`, stdio, npx) | ✅ `GET /api/mcp/catalog` → `entries: 1`, `installed: false`, no diagnostics |
| Connectors → Browse | ✅ renders `filesystem` with an **Install filesystem** action |
| remove the fixture | ✅ API back to `entries: []` — app left as found |

Stated plainly: **no curated manifests ship**, so the tab is still empty in a fresh install — that is
a content decision (which third-party servers to endorse), now a drop-in rather than a code change.
Also found: the client caches the catalog per app session (the deleted entry lingered and a
screen remount did not refresh it), recorded as a follow-up.

---

## Whole-tree verification of the fix set (round 24)

The phone was in use (Telegram in the foreground), so this round verified the *tree* instead of
driving the device — the campaign has 17 modified files and no full-suite run until now.

| check | result |
|---|---|
| `python3 -m unittest discover` over `app/python-runtime/tests` (browser attach, boot gate, fleet, fleet worker, rpc fleet, spawn bot, linux exec, terminal) | ✅ **109 tests, OK** (4 skipped) — no regressions from `linux_env.py`, `hermes_boot.py`, `browser_gate.py`, `gateway_server.py` or the new gate test |
| `tsc --noEmit` (whole app) | ✅ clean |
| `eslint` over the seven touched app files | ✅ **0 errors**; 2 warnings, both in `_layout.tsx` at lines 246/254 on untouched code — the file's diff is only the `loadLocale` import and the 5-line boot call, so they are pre-existing |
| diff review (`git diff --stat`) | ✅ 17 files, +901/−34 (mostly `bugs.md`): `CdpRelay.kt`, `browser_webview.py`, `browser_gate.py`, `gateway_server.py`, `hermes_boot.py`, `linux_env.py` + tests, `hermes_state_search.py`, and the app-side `chat.tsx`, `sessions.tsx`, `settings.tsx`, `_layout.tsx`, `bot.tsx`, `sessionList.ts`, `ScreenShell.tsx` |
| `app/android/app/build.gradle` | the only change is the shipped version bump `1.0.14-bots` → `1.0.15-browser` (code 18) — the build under test, untouched by this campaign |

Untracked artifacts, all intentional: `.devtest/` (device harness + screenshots), this report,
`TEST-1.0.15-browser.md`, `app/python-runtime/tests/test_browser_boot_gate.py` (the new regression
test), plus pre-existing user files (`M9-BOTS.v1.pre-m9.bak`, `brag-output/`,
`chat-session-audit-report.md`, `research/browser-proof/run_bug105_proof.py`, `skills/`).

---

## BUG-114 regression test + suite green (round 25, phone in use)

New: `app/python-runtime/tests/test_search_no_fts.py` (4 tests) pins the behaviour fixed last rounds —
search must find message **content** when the interpreter has no `fts5` module. It builds a real
`SessionDB` in a temp dir, forces `_fts_enabled=False` / `_fts_stale=False` (the stale branch is a
*different* path and must not mask this one) and asserts the LIKE fallback returns the conversation;
a real miss stays empty; the indexed path is checked where fts5 exists.

Verified as a genuine guard rather than a tautology: with the fix temporarily reverted the two
content tests fail (`FAIL: test_content_is_found_without_fts`,
`FAIL: test_multiple_words_from_the_body_are_found`) while the miss/indexed tests still pass — then
restored and 4/4 green.

Suite: **113 tests OK** (4 skipped) over `app/python-runtime/tests` — the campaign's Python surface
now has a regression test for each of its non-UI fixes (linux exec/reset, browser boot gate, search
without fts5, fleet runtime).

**Post-round device smoke (installed build, phone free for a moment):** one chat turn asked the
agent to run `echo SMOKE-R25` in its terminal — it thought for 19 s and answered exactly
`SMOKE-R25`, i.e. the guest terminal path is still healthy after every change in this campaign.

---

## BUG-130 re-diagnosed — the composer is IDLE while a turn runs (round 26)

Previous rounds framed this as an accessibility-tree freeze. A careful single-dump sample on the
installed build says otherwise: **during an active turn the composer renders its idle state**, so
Steer and Stop are not in the tree because they are not rendered.

One `uiautomator dump`, 4 s after sending *"Count slowly from 1 to 60 in your thinking, then reply
only DONE-R26"* (20:15:40):

```
transcript (busy, live)   Expand thinking / TextView "Thought · 3s"
composer (same dump)      EditText "Ask Mochi…"    ← idle placeholder
                          Add attachment / Record voice / Send message
                          (no Steer, no Stop)
```

A screenshot of the same moment shows the same composer row (`+ Ask Mochi... ( )`), so both channels
agree — unlike the earlier "a11y-only" observation. User impact: **a running turn cannot be stopped
or steered from the phone**, which is exactly the M6 affordance the runbook exercises.

Follow-up (next round): why `agentBusy` does not reach the composer during a run — `chat.ts` sets it
on send and derives it from `res.running`, while the composer's busy gates sit at
`app/(tabs)/chat.tsx` ~1414-1478.

### BUG-130 root cause narrowed to one state, with the writer table (round 27)

Steer (`chat.tsx:1451`) and Stop (`chat.tsx:1500`) are both `{busy ? …}` gated, as is the busy
placeholder — so the whole symptom is `agentBusy === false` during a run. Writers: `chat.ts:1820`
(the only place a run is marked live), `:1095` (resume payload), `:1877/:1888` (send failed), `:1932`
(explicit stop), `:2347` (`session.reclaimed`), `:2577` (`background.complete`), and
**`:2592-2596` — `status.update {busy:false}` clears busy on the payload alone**, with no check
against a turn the client just started. Last one is the prime suspect and matches the timing
(false within 4 s of send).

Not patched blind on purpose: a wrong guard leaves a stuck Stop button, which is worse than the
current defect. The next device session captures which event actually lands in those 5 s, then the
guard follows the evidence.

### BUG-130: `status.update` identified by elimination (round 28)

Controlled run: send at 20:16:57, app log shows the turn ending 20:17:39 (42 s). At ~14 s in — mid-run
— the composer was idle (`Ask Mochi…`, no Steer, no Stop). Scanning the log for the whole window: 52
lines, **0** matches for `background complete` / `session reclaimed` / `busy`, and the send succeeded —
so `session.reclaimed`, `background.complete` and the send-failure path are all eliminated. The only
remaining writer is the silent `status.update {busy:false}` handler (`chat.ts:2592-2596`), which
clears busy from the payload alone with no corroboration.

Fix approach (next round, evidence-based): make that handler corroborate — don't clear a busy state the
client started seconds ago unless the session really is idle (deferred check or event pairing), while
keeping a genuine finish clearing promptly. A blind guard would risk a stuck Stop button, which is
worse than the present defect.

### BUG-130: the `status.update` guard was built, device-tested, and reverted — negative result (round 29)

Implemented the corroborating guard (activity proof per session from send/deltas/tool events; the
heartbeat's clear deferred while that proof is fresh, rescheduled rather than dropped). `tsc` and
eslint clean; rebuilt and installed. Device result: **the symptom is unchanged** — composer idle at
+2 s into a 40 s turn, and at +10/+11 s sampling both a fresh session (log: 20:23:25 → 20:24:16, 51 s)
and an established one.

That timing is the useful part: the guard would have deferred any `status.update {busy:false}` by 4 s,
so idle at +2 s **falsifies the round-28 elimination** — `status.update` is not the clearing path.
Leading hypothesis now: `busy: true` never reaches the entry the composer reads (the send path patches
`sessionsById[sid]` while the composer follows `activeSession`; a stored/live id or placeholder/entry
mismatch would leave the composer idle for the whole run).

Reverted the guard — real clear timing changed with no verified benefit, and an unproven behaviour
change does not belong in the tree. Note: **the APK currently installed on the phone was built with
that guard** (behaviourally identical in every test above); the next `assembleRelease` will match the
tree again.

### BUG-130: closed list of writers; `message.complete` is the last one standing (round 30)

Auto-extracted every `busy: false` site with its handler and ruled them out one by one against the
device evidence: initial state, send-failure, explicit stop, `session.reclaimed` (no log line),
`background.complete` (no log line), `status.update` (falsified by round 29's +2 s sample), `error`
(the turn completed normally). What remains is **`message.complete` (`chat.ts:2493`)** — it clears
`busy` and marks every running tool `done`, unconditionally.

The source check that reframes it: `tui_gateway/contracts/events.py:190` defines `message.complete` as
*"The turn ended"*, and `prompt_turn.py:985` is the true parent-turn emitter — but the gateway emits
the same event from **four** sites, including the subagent mirror (`agent_callbacks.py:77`, text-only)
and two error paths. Treated as "this session's turn is over", any of those ends the composer's busy
state mid-turn: idle composer, no Steer/Stop, and a prematurely frozen tool list — the exact
observable. The send-side patch is unconditional and correct (`chat.ts:1806-1821`), so a missed *set*
is not required to explain it.

Next: capture the raw `message.complete` payloads for one slow turn on the phone (a mirror payload is
`{text}` with no `usage`/`status`; a real completion carries them), then gate the clear on a genuine
parent-turn completion.

### BUG-130 round 31: an instrumentation correction (and why it matters)

`src/lib/log.ts::log()` writes to an in-app ring buffer only (Settings → "Copy diagnostics"); release
builds emit no console output. **No client log line can appear in `agent.log`** — so round 28's
"elimination by log" (no `background complete` / `session reclaimed` lines ⇒ those handlers did not
fire) reasoned about an empty channel and is **retracted**. Round 29's behavioural falsification of
`status.update` stands (idle at +2 s while the guard would have deferred it).

Also proven: the gateway does **not** stream turn events to a second client. The new
`.devtest/eventwatch.py` (dependency-free WS watcher: submits a prompt, prints every notification with
its payload keys) got **zero notifications in 20 s** on its own socket — the capture must run in-app.

Staged for the next round: a temporary diagnostic in the client's `message.complete` handler (payload
keys, `status`, `usage` presence, text length, `busyBefore`), shipped in the installed build, symptom
unchanged (0 Steer/Stop nodes 14 s into a 45 s turn). It is readable via Settings → Copy diagnostics,
so the next step is to surface that text where a dump can read it (paste into the composer) and pin the
emitter — a subagent-mirror payload is `{text}` with no `usage`/`status`.
