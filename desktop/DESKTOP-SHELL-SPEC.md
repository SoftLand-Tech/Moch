# DESKTOP-SHELL-SPEC — Moch Desktop (Tauri 2) shell and presentation layer

Status: implementation-ready spec for the `desktop-tauri` worktree.
Architecture baseline: **one core, two presentations** — the desktop hosts
the REAL app UI (Expo web export, react-native-web) and reuses
`app/src/lib` logic verbatim; the desktop tree owns ONLY the native shell,
the desktop presentation layer (nav rail, panes, palette, accelerators,
dense tables), and the local runtime/packaging. Hard rule: no business or
protocol logic in the desktop tree — new behaviour lands in `app/src/lib`
and both platforms consume it (`app/src/lib/desktopLocal.ts:13-17` states
the same rule).

Every claim about existing code cites `file:line`. Anything not verified is
marked **unverified**. Feasibility of every native API is evidenced in
[`desktop/.tmp/recon/tauri-feasibility.md`](.tmp/recon/tauri-feasibility.md)
(short: `tauri-feasibility.md`), linked per row in section 6.

---

## 1. Purpose and non-goals

**Hero use-case:** run your own hermes agent on this PC — the supervised
local gateway (`desktop/src-tauri/src/lib.rs:239-400` spawns
`desktop/runtime.py`), your conversations, bots, automations, connectors
and terminal, in a keyboard-first desktop window. The phone app is the same
product in your pocket; this shell is the same product at a desk.

**Purpose of this spec:** replace the frozen UI fork in `desktop/ui/`
(9 TSX files, 5,612 lines, e.g. `desktop/ui/src/App.tsx:1-7` "3-Column AI
Agent Dashboard") with a thin desktop presentation layer that hosts the
real app screens and adds desktop affordances the phone cannot have:
persistent panes, dense tables, a command palette, accelerators, context
menus, and OS integration (tray, notifications, deep links).

**Non-goals:**

- No second chat implementation, protocol stack, or state machine. The
  fork's private `JsonRpcGatewayClient` wiring (`desktop/ui/src/App.tsx:83-100`)
  dies; the app's own stack (`app/src/protocol/json-rpc-gateway.ts`) is the
  only client.
- No new business behaviour in `desktop/`. Anything both platforms could
  use (PTY web adapter, file-drop attachments, notification dispatch) goes
  to `app/src/lib` first (section 7 lists them).
- No mobile patterns on desktop: no hidden tab bar emulation, no
  pull-to-refresh, no keyboard-avoidance code (the phone's IME machinery —
  `app/AGENTS.md` BUG-133 patterns — is a no-op under react-native-web per
  `FEATURE-DESKTOP-TAURI.md` step-0 findings).
- No theming fork: `app/src/lib/theme.ts` is the single token source
  (section 5).
- Not a goal: pixel-parity with the phone layout. Same content, same
  logic, desktop-shaped chrome.

---

## 2. Window and layout model

### 2.1 Pane topology

```
┌──────┬──────────────┬─────────────────────────────┬────────────┐
│ nav  │ list pane    │ main pane                   │ inspector  │
│ rail │ (per-screen) │ (chat transcript + composer │ (optional, │
│ 56px │ 208–384px    │  or hosted screen)          │ 280–460px) │
└──────┴──────────────┴─────────────────────────────┴────────────┘
```

Exactly four regions, left to right: **nav rail** (56 px, always visible),
**list pane** (collapsible), **main pane** (never collapses), **inspector**
(collapsible). The current shell opens one 1280x840 window with min
960x600 (`desktop/src-tauri/src/lib.rs:729-735`) — the new shell keeps one
window, raises the minimum, and adds the pane chrome inside the web layer.

### 2.2 Dimensions and rules

| Region | Min | Default | Max | Collapse |
| --- | --- | --- | --- | --- |
| Nav rail | 56 px (icons) | 56 px | 200 px (labels, toggle) | never |
| List pane | 208 px | 264 px | 384 px | Ctrl+B, persisted |
| Main pane | 560 px | flexible (all remainder) | — | never |
| Inspector | 280 px | 340 px | 460 px | Ctrl+J; auto-collapses below 1280 px window width |

- **Window**: default 1440x900, minimum **1024x680** (raised from 960x600 —
  below 1024 the three-pane promise cannot hold with a 560 px main; the
  fork clipped content below 566 px inside `.app-body{overflow:hidden}`,
  `desktop/ui/src/styles.css:126`). Persisted geometry restores position
  and size on launch (section 6, window state).
- **Splitter behaviour**: 6 px gutter (4 px visible bar, `C.borderSoft`),
  8 px hit area, `cursor: col-resize`, drag range clamped to the table
  above, double-click resets to default width, focusable
  (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` in
  px) with ArrowLeft/ArrowRight = ±8 px, Home/End = min/max. While
  dragging, `aria-valuenow` updates and the pane contents do NOT reflow
  until pointerup (avoid per-pixel table re-layout).
- **Width behaviour at the four checkpoints** (window widths, logical px):

| Window width | Rail | List pane | Inspector | Main pane | Notes |
| --- | --- | --- | --- | --- | --- |
| 1024 | 56 | 240 (clamped) | collapsed | 728 | inspector auto-collapse keeps main ≥ 560: 1024 − 56 − 240 − 560 = 168 < 280 inspector min, so it must be closed |
| 1280 | 56 | 264 | 320 | 640 | everything docked at defaults |
| 1440 | 56 | 280 | 340 | 764 | default launch width fits exactly |
| 1920 | 56 | 280 (default; user may widen) | 340 | 1244 | transcript column capped at 760 px centered (section 5.4); tables and boards use full main width |

- **Which panes exist per screen** (list pane contents / inspector
  contents). Screens without a list concept collapse the list pane:

| Screen | List pane | Main pane | Inspector |
| --- | --- | --- | --- |
| Chat | sessions table (`sessions.tsx` data) | hosted `chat.tsx` content + docked composer | run details: live tools + todos (from the same `tools`/`todos` stores the phone renders in its run footer, `app/app/(tabs)/chat.tsx:1270-1321`) |
| Crew | none | 4-column kanban | selected task detail + run ledger (`moch.runs.timeline`) |
| Fleet (bots) | profiles table | bot detail (`bot.tsx` hosted) | bot runtime status |
| Automations | jobs table | job editor (form from `automations.tsx`) | run history of selected job |
| Agent (models) | providers list | models of selected provider | reasoning effort + scopes |
| Terminal | none | PTY pane | none |
| Browser | CDP target list | target control surface | target metadata |
| Connectors | your servers table | server detail / catalog | oauth + tools detail |
| Skills | commands/skills list | command detail (desc, args, usage) | none |
| Sessions | full-width sessions table | (no main content — list IS the screen; main shows selected chat preview) | none |
| Settings | settings sections | section body | none |

- **Scroll ownership — exactly ONE scroller per pane.** The fork ships 10+
  nested inner scrollers (`desktop/ui/src/styles.css:197,296,337,347,414,
  551,563,725,765,797,821,831`). Rule: the pane element owns
  `overflow-y:auto`; nothing inside it may scroll — inner lists
  virtualize (FlatList on web) inside the pane's scroller, long text
  clamps with line caps, and the inspector is one column, not a stack of
  mini-scrolls.
- **Composer docking**: the chat composer docks to the BOTTOM of the chat
  main pane, in normal flow — the transcript scroller's viewport ends at
  the composer's top edge. No floating overlay and no fake clearance pad
  (the fork scrolls under a floating composer and pads the transcript
  `90px` to compensate, `desktop/ui/src/styles.css:562-563`; the phone
  app itself already lays the composer out in flow,
  `app/app/(tabs)/chat.tsx:1419-1625`).
- **What persists between launches** (localStorage `moch.shell.v1` unless
  noted): active screen/tab, list-pane and inspector widths, both collapse
  states, rail expanded/collapsed, inspector per-screen open state,
  density setting (section 5.1). Window size/position/ maximized persists
  Rust-side via a hand-rolled geometry file (section 6). Active session
  restore stays with the app layer (`activeStoredId` in
  `app/src/lib/chat.ts` — persistence key **unverified**); the shell never
  stores session ids itself.

---

## 3. Reuse map (phone screen → desktop shape)

Read from the actual phone sources. "Host as-is" = the screen renders
correctly inside a pane via the Expo web export with no code changes
(keyboard-controller/reanimated are web no-ops, and every expo module it
imports ships a `.web.js` — verified in `FEATURE-DESKTOP-TAURI.md` step-0
audit). "Variant" = a desktop presentation component in the desktop tree
that consumes the same `app/src/lib` stores/functions; the phone screen
keeps existing unchanged.

### 3.1 Chat — `app/app/(tabs)/chat.tsx` (1,908 lines) — HOST AS-IS (P2)

What it is: transcript (inverted FlatList, newest-first at offset 0,
`chat.tsx:310-315`), docked composer pill (`chat.tsx:1419-1625`) with
attachments chips, queue strip (`chat.tsx:1421-1506`), steer toggle
(`chat.tsx:1529-1543`), slash palette (`chat.tsx:1338-1389`), question
cards + foreign-question aggregate card (`chat.tsx:1391-1417`), run footer
with live tool rows and todos (`chat.tsx:1265-1321`), starters
(`chat.tsx:86-91`), model chip + bot chip (real pressables opening
`ModelPickerSheet`, `chat.tsx:1635`; chip styles `chat.tsx:1731-1743`).

Desktop shape: none required for P2 — the content column centers with a
760 px measure cap (section 5.4). The phone's pressables already carry
`accessibilityRole`/`accessibilityLabel` (e.g. `chat.tsx:1590,1616`),
which react-native-web maps to ARIA. Desktop-only additions wrap, not
replace: drag-drop onto the composer (section 4.6) and a model/bot chip in
the desktop toolbar that mirrors the same stores (`liveModel`,
`activeBotAtom`, `chat.tsx:140,106`).

### 3.2 Sessions / chats — `app/app/(tabs)/sessions.tsx` (406 lines) — VARIANT: dense table

Phone: FlatList of touch rows (58 px min height, `sessions.tsx:396`),
long-press to delete (`sessions.tsx:331`), pull-to-refresh
(`sessions.tsx:313`), keyboard-aware search (`sessions.tsx:76-77`).

Desktop shape: a **table** (not cards): columns Status (dot from
`rowStatus`, `app/src/lib/attention.ts:25-27`), Title (title else
preview-slice, `sessions.tsx:325`), Source (localized via `sourceLabel`,
`app/src/lib/sessionRowMeta.ts:84-89`), Bot (`SessionRow.profile`,
`sessionRowMeta.ts:39-46`), Msgs (`messageCountText`, honest "—" per
`sessionRowMeta.ts:9-12`), Started (creation-time label, `sessions.tsx:347-349`).
Row height 32 px (density-adjustable), hover = `C.bgHover`, single-click
selects, Enter/Space opens, right-click context menu (Open, Copy title,
Delete via the same detach-then-delete flow `sessions.tsx:197-246`),
keyboard Up/Down/PageUp/PageDown/Home/End, type-to-jump on title initials.
Reuse verbatim: `sessionRows`/`loadSessions`/`refreshRunningSessions`
(`app/src/lib/sessionList.ts:32-58`), `switchToSession`/`newChat`/
`forgetSession`/`busyStoredKey`/`pendingStoredIds` (imports at
`sessions.tsx:10-20`), content search `/api/sessions/search`
(`sessions.tsx:125-162`). Delete-confirm uses the shared
`showAlert` dialog, not a browser confirm.

### 3.3 Crew — `app/app/(tabs)/crew.tsx` (457 lines) — VARIANT: 4 real columns

Phone: tasks grouped by status into a vertically scrolling FlatList with
four section headers (`COLUMNS` ready/working/blocked/done,
`crew.tsx:44-49`), expanded-row actions Complete/Reassign (`crew.tsx:81-83`),
create box (`crew.tsx:76-80`), run ledger (`moch.runs.timeline`,
`crew.tsx:101`), 60 s heal ticker (`crew.tsx:16-22`).

Desktop shape: a real horizontal **kanban board** — four columns side by
side (min 176 px each, so 4x176 = 704 px fits the 728 px main at the
1024 window minimum; the board scrolls horizontally ONLY below that), cards with title/assignee/age, drag between columns =
the same status-write RPC the Complete/Reassign actions use (**exact
move/status RPC name unverified** — the phone only calls
`moch.kanban.tasks`/`moch.kanban.create`/the expanded-row actions at
`crew.tsx:95,101`; confirm before implementing drag). Create box becomes
a modal (title, body, assignee chips — assignee required, frozen bots
refused server-side, `crew.tsx:18-20`), idempotency key reuse
(`crew.tsx:58-60`). Run ledger moves to the inspector. Frozen-bot set from
`fleetStatusAtom` (`crew.tsx:112-115`).

### 3.4 Fleet (bots) — `app/app/(tabs)/fleet.tsx` (466 lines) — VARIANT: table + detail

Phone: feature-detected entry screen (`fleet.tsx:41-45`), inline create box
with starter templates (`fleet.tsx:34-39`) and creation checklist
(`fleet.tsx:57-63`), profile rows with freeze/chat actions.

Desktop shape: **profiles table** (Name, Description, Runtime status from
`fleetStatusAtom`, Frozen flag) + the hosted `bot.tsx` detail (3.12) in
the main pane; create opens a modal with the starter chips and checklist.
Reuse verbatim: `app/src/lib/fleet` (`createProfile`, `freezeProfile`,
`soulDraft`, `refreshFleet`, checklist persistence — imports at
`fleet.tsx:11-28`). Chat hand-off uses the same `botProfile` param path
(`chat.tsx:227-235`).

### 3.5 Automations — `app/app/(tabs)/automations.tsx` (511 lines) — VARIANT: table + editor

Phone: FlatList of expandable job rows (`Job` fields incl. schedule,
next_run_at, last_status/errors, enabled — `automations.tsx:17-33`),
inline add/edit form with dirty-check (`automations.tsx:77-82`).

Desktop shape: **jobs table** (Name, Schedule, Next run (`when()`,
`automations.tsx:40-49`), Last status, Enabled toggle) with the add/edit
form as a panel in the main pane (or modal) reusing the same
`cron.manage` list/add/get/remove/pause/resume calls and the shell-quoted
`slash.exec /cron` run-now/edit path (`automations.tsx:62-66,93`). Row
context menu: Run now, Pause/Resume, Edit, Delete.

### 3.6 Agent (models/providers) — `app/app/(tabs)/agent.tsx` (496 lines) — VARIANT: two-pane browser

Phone: single scrolling form — provider inventory (searchable, collapsed
"not set up" group, `agent.tsx:50-53`), model picker sheet, reasoning
effort pills with global/session scope (`agent.tsx:40-41`), provider key
form.

Desktop shape: **two-pane provider/model browser** — left = provider list
ranked by `rankProviders` (`app/src/lib/modelState.ts:443-447`), right =
models of the selected provider ranked by `rankModels`
(`modelState.ts:449-460`); current model marked; pick writes through the
same session-scoped write guard `liveWriteSid` (`agent.tsx:57-61,101-110`
— never bypass it). Reasoning effort + scope and the provider key form
(`ProviderKeyForm`, `agent.tsx:25`) dock in the inspector. The phone's
`ModelPickerSheet` stays for the composer chip; this screen becomes the
preferences home (same as the phone, `agent.tsx:62-65`).

### 3.7 Terminal — `app/app/(tabs)/terminal.tsx` (639 lines) — VARIANT: real PTY pane

Phone: xterm.js rendered inside a react-native-webview fed raw PTY bytes
through `TerminalController` (`terminal.tsx:112-116`, controller from
`app/src/lib/terminal.ts:22-30`), IME composer state machine
(`terminal.tsx:107-109`), gate states checking/noprobe/noguest/nopty
(`terminal.tsx:33`), kill/clear in the header menu (`terminal.tsx:53,65-87`).

Blocker on desktop: the PTY provider is the Android native module
`NativeModules.HermesBridge` (`app/src/lib/mochiRuntime.ts:39-46`); on web
it is undefined and the screen parks at its `noprobe` gate
(`terminal.tsx:414-419`). Desktop shape: **a real PTY pane rendering
xterm.js directly** (no inner WebView — the pane IS a webview already):
same `TerminalController`, same base64 chunk protocol, resize/kill/clear
actions, but the provider is a gateway-side PTY on this PC. This requires
shared work FIRST (section 7): a provider negotiation in
`app/src/lib/mochiRuntime.ts` (native bridge → gateway RPC fallback) and
a host PTY surface in the runtime. Whether `runtime.py`/the fork gateway
already expose any PTY RPC: **unverified** (no `pty`/`term` match in
`desktop/runtime.py`).

### 3.8 Browser — `app/app/(tabs)/browser.tsx` (439 lines) — VARIANT: CDP control pane

Phone: a multi-tab in-app WebView pool the embedded agent drives over the
CDP relay; tabs stay mounted at 1px when inactive; RN owns tab lifecycle;
"Ask Moch" routes the page into the composer via the share-in inbox
(`browser.tsx:35-51`).

Desktop difference: the agent browser is a real, on-screen Chromium the
runtime spawns with a CDP debug port (`desktop/runtime.py:46-49`,
`desktop/README.md:31-43`); the shell already proxies its target list at
`/cdp/json` (`desktop/src-tauri/src/lib.rs:567-581`). Desktop shape: a
**target list pane** (title, url, live/dead, refreshed ≤3 s over the
existing proxy) + per-target actions (activate/raise the OS window,
close — needs a shell-side POST relay, today only GET `/json` exists,
`lib.rs:567`) + the same "Ask Moch about this page" composer hand-off via
`shareIn` (`browser.tsx:47-50`). Embedding/screencasting the page inside
the pane is explicitly P4 and **unverified** (CDP Page.startScreencast
through webkit2gtk — do not promise). Reuse: `app/src/lib/browserRelay`
stores for tab bookkeeping if a tabbed pane is built later.

### 3.9 Connectors — `app/app/(tabs)/connectors.tsx` (907 lines) — VARIANT: table + detail

Phone: two tabs (yours/browse), server rows with cached runtime status
lines (`connectors.tsx:30-43`), letter-tile avatars with stable hues
(`connectors.tsx:60-66`), OAuth flows, key prompts, add-custom-server
modal; command-transport servers (stdio/uvx/npx) noted to run on the
computer only while paired to it (`connectors.tsx:45-53`).

Desktop shape: **your-servers table** (Name+tile, Status line, Tools
count, Enabled) with detail in the main pane (config, key form, OAuth
button, test result — `testMcpServer`), and the catalog browse as a grid.
Everything from `app/src/lib/mcpState` verbatim (imports at
`connectors.tsx:14-20`); the gateway owns all state
(`connectors.tsx:22-27`). On desktop the stdio caveat disappears — the
gateway IS on this machine — so command servers install and run locally
(no phone-parity limitation to preserve).

### 3.10 Skills — `app/app/(tabs)/skills.tsx` (188 lines) — HOST AS-IS (P2)

Pure catalog screen: commands + skills from the gateway registry
(`skills.tsx:14-18`), filter field, two segment tabs, rows that navigate
to chat with a prefilled `/<name> ` draft (`skills.tsx:74-81`). Renders
unchanged in a pane. P3 option: two-pane (list + detail with description,
argument mode, usage) — data already in `slash.ts` stores.

### 3.11 Settings — `app/app/(tabs)/settings.tsx` (602 lines) — HOST AS-IS with desktop pruning (P2), VARIANT (P3)

Phone sections: gateway connection + saved servers, theme
(`settings.tsx:21`), locale, notifications, embedded runtime controls and
Linux-guest install/reset rows (`settings.tsx:37-114`), diagnostics log.
On web the `HermesBridge` native module is absent so the runtime sections
degrade (`mochiRuntime.ts` guards every call with `if (!bridge)` —
pattern at `mochiRuntime.ts:80-84`). P2: host as-is; the desktop runtime
restart/stop belongs to the shell menu (section 4.2), not this screen. P3
variant: prune phone-only sections, add a Desktop section (version,
update channel, launch-on-login — P4, updater blocked offline per recon
§4).

### 3.12 Bot detail — `app/app/bot.tsx` (247 lines) — HOST AS-IS (P2)

SOUL viewer/editor, description, freeze, chat hand-off, delete wizard
(`bot.tsx:16-21`). `KeyboardAwareScrollView` no-ops on web. Hosted in the
main pane when a Fleet row is selected.

### 3.13 Root pair screen — `app/app/index.tsx` — BYPASS (desktop never shows it)

Returning users auto-redirect to chat (`index.tsx:24-33`); on desktop the
shell-supervised gateway is adopted automatically by
`seedDesktopLocalConnection` (`app/app/_layout.tsx:139-146`,
`app/src/lib/desktopLocal.ts:44-66`), so there is no QR to scan and no
server list to pick. Keep the route reachable only as an explicit
"Pair another computer" action (reusing `add-computer.tsx`, 3.14).

### 3.14 Add computer — `app/app/add-computer.tsx` (49 lines) — HOST AS-IS, low priority (P3)

Pairing form + back button (`add-computer.tsx:21-24`). Reachable from
Settings → Computers. No desktop variant needed.

### 3.15 Setup wizard — `app/app/setup.tsx` (510 lines) — VARIANT (thin)

The phone wizard boots the embedded phone runtime and Linux guest
(`setup.tsx:26-30`) — irrelevant on desktop, where first-run state is the
shell's `.setup.json` gate (`lib.rs:533-554`) and the frozen fork ships
its own `Wizard.tsx` (`desktop/ui/src/tabs/Wizard.tsx`). Desktop replaces
both with ONE onboarding pane: welcome → provider key (reuse
`app/src/components/ProviderKeyForm` + `saveProviderKey`,
`agent.tsx:17-25`) → done (writes `/setup-done`, same endpoint
`lib.rs:542-554`). No new logic in the desktop tree beyond the pane.

### 3.16 Verdict summary

16 routes total (11 tabs + `bot`, `setup`, `add-computer`, `index`, plus
layouts): **5 host as-is** (chat, skills, bot, settings, add-computer),
**9 need a desktop variant** (sessions, crew, fleet, automations, agent,
terminal, browser, connectors, setup), **1 bypassed** (index). Of the 9
variants, 6 are pure re-presentation of existing `app/src/lib` calls
(sessions, crew, fleet, automations, agent, connectors); 3 require shared
work first (terminal PTY provider, browser target relay POST, setup pane's
use of the shell gate — section 7).

---

## 4. Interaction model

### 4.1 Accelerator table

Layer: **W** = web presentation layer (keydown handlers in the shell app);
**M** = Tauri native menu (Rust, `tauri::menu` — muda, available offline,
recon §4). Menu items fire into the web layer via an event/command unless
marked Rust-only.

| Keys | Action | Layer |
| --- | --- | --- |
| Ctrl+K | Open command palette | W |
| Ctrl+T | New chat (`newChat`) | W (menu item too) |
| Ctrl+F | Focus the active list pane's filter | W |
| Ctrl+B | Toggle list pane | W (menu View) |
| Ctrl+J | Toggle inspector | W (menu View) |
| Ctrl+Backslash | Toggle rail labels (56 ↔ 200 px) | W |
| Ctrl+1 … Ctrl+9, Ctrl+0 | Rail screens: 1 Chat, 2 Sessions, 3 Crew, 4 Fleet, 5 Automations, 6 Agent, 7 Terminal, 8 Browser, 9 Connectors, 0 Settings (Skills has no digit — palette/Go menu only) | W |
| Ctrl+, | Open Settings | W (menu) |
| Ctrl+Shift+K | Clear palette query and reopen (fresh) | W |
| Ctrl+. | Stop the running turn (`stopRun`) | W |
| Ctrl+Shift+M | Toggle model picker (same store as the chip, `liveModel`) | W |
| Enter / Shift+Enter | Send / newline in composer (matches phone web path, `chat.tsx:1577-1578`) | W |
| Esc | Close palette/popover, restore focus (section 4.4) | W |
| Alt+Left / Alt+Right | Back/forward in the hosted router | W |
| Menu key / Shift+F10 | Context menu on selected row/card | W |
| F2 | Rename where a rename RPC exists (**none verified** — omit until one lands) | — |
| Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z / Ctrl+Shift+Z | Clipboard + undo over webview text | M (WebKitGTK needs the menu items for these to reach the webview — **known Tauri behavior, verify at runtime**) |
| Ctrl+W / Ctrl+Q | Close window / quit (runs runtime teardown, `lib.rs:742-746`) | M |
| F5 / Ctrl+R | Reload webview (dev aid) | M |
| Ctrl+Shift+I | DevTools (dev builds only, tauri `devtools` feature — recon §4 note) | M |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in/out/reset (webview zoom) | M |
| Ctrl+Alt+M (global, OS-wide) | Quick-ask: summon/focus Moch from anywhere | plugin `tauri-plugin-global-shortcut` 2.4.1 — **blocked offline** (recon §4); P4 |

Rules: no web-layer handler may shadow a focused text input's own keys
(handlers check `e.target` editability first — the fork's single Escape
handler at `desktop/ui/src/App.tsx:252-259` is the cautionary minimum, not
the model). All shortcuts are re-declared in the native menu where they
are window-scoped so they also appear in the menu bar with platform
labels.

### 4.2 Native menu skeleton (Rust)

File / Edit / View / Go / Help. Go lists all 11 screens (the 10 with
digit shortcuts plus Skills). File: New Chat (Ctrl+T), Close (Ctrl+W), Quit (Ctrl+Q). Help:
About, Keyboard Shortcuts (opens a palette-mode list), Diagnostics log
(tails `.dbg.log` via the existing POST `/dbg`, `lib.rs:508-531`).
"Restart runtime" lives here (Rust-only: kill + respawn via the existing
`terminate_runtime`/`start_fork` — refactor only, no new logic).

### 4.3 Command palette (Ctrl+K)

Single input, centered overlay (max 640 px wide, top 15 vh), one column,
virtualized list.

- **Sources**, merged and de-duplicated by id:
  1. Sessions — local title/preview filter over `sessionRows`, then
     gateway content hits (`/api/sessions/search`, same call as
     `sessions.tsx:135-137`), capped 8.
  2. Screens/tabs (11 + Settings).
  3. Slash commands + skills from `commands.catalog` via `loadCatalog` /
     `localCompleteSync` (`app/src/lib/slash.ts:60-69,97-100`) — the
     gateway's own fuzzy rank (`complete.slash`, `slash.ts:9-19`) is the
     scorer, exactly like the composer palette (`chat.tsx:363-385`).
  4. Bots (`fleetProfiles`) — "Chat with <bot>".
  5. Settings sections.
- **Ranking**: exact prefix > gateway fuzzy score (for slash items) >
  recency (`lastActiveByStoredId`, `app/src/lib/sessionList.ts:76-80`) >
  alphabetical. Sessions rank above commands only on prefix or recency
  hits, never on raw substring.
- **Modes typed into the one input**: `/` prefix = slash commands only;
  `>` prefix = screens/settings only; plain = everything.
- **Keyboard**: ↑/↓ move (wrap), Enter execute, Tab complete-in-place
  (fill the command's name + space into the input, cursor at end — same
  fill semantics as the composer palette, `chat.tsx:1364-1367`), Esc
  close, Home/End jump, Ctrl+N/Ctrl+P as vi-style aliases.
- **Executing** a slash item runs the app's own `runCommand` path — never
  a desktop reimplementation; interactive targets (`/model` and
  options/mixed commands) open the app's sheets exactly as the composer
  does (`chat.tsx:395-412`).

### 4.4 Focus management

- Palette and every popover/modal: `role="dialog"`, `aria-modal="true"`,
  focus moves in on open, **Tab cycles inside** (trap), Esc closes, focus
  returns to the exact element that opened it (store
  `document.activeElement` on open).
- Rail items are `aria-current="page"` when active; splitters are
  focusable separators (2.2); context menus are `role="menu"` with
  `menuitemradio`/`menuitem` entries, arrow-key navigable, close on
  click-outside/Esc/Tab.
- One visible focus ring everywhere: `:focus-visible` only, 2 px
  `C.accent`, 2 px offset — never remove it; the fork ships no aria or
  focus-visible at all (audit finding; consistent with the file's
  single-property rule style — a direct `:focus-visible` grep re-check
  was blocked by the shell tooling outage, treat as audit-sourced).

### 4.5 Right-click context menus (per surface)

| Surface | Entries |
| --- | --- |
| Session row | Open; Copy title; Copy id; Delete (shared detach+delete flow, `sessions.tsx:197-246`) |
| Message bubble | Copy; Copy markdown source; Retry (`retryMessage` exists, `chat.tsx:52`); Quote into composer |
| Composer | Paste; Paste as attachment (if clipboard has files); Clear draft |
| Automation row | Run now; Pause/Resume; Edit; Delete |
| Crew card | Complete; Reassign…; Copy title |
| Bot row | Chat; Freeze/Unfreeze; Delete… (bot.tsx wizard) |
| Connector row | Test; Reload agent MCP (`reloadAgentMcp`, `connectors.tsx:17`); Disable; Remove |
| Browser target | Activate (raise OS window); Close (needs shell POST relay, 3.8); Copy URL; Ask Moch about this page |
| Terminal pane | Clear (`killRef`/`clearRef` equivalents, `terminal.tsx:53`); Kill session; Copy; Paste |
| Inspector | Collapse inspector |

Right-click selects the row without activating it; the menu acts on the
selection. Every menu entry must also exist as a keyboard path (menu key)
or visible control — no right-click-only actions.

### 4.6 Drag-and-drop targets

- **OS files → chat pane/composer**: dropped files become
  `PendingAttachment`s through the app's media pipeline
  (`app/src/lib/mediaSend`, `chat.tsx:62-64`); the File→path/uri bridge is
  shared-lib work (section 7). Caps identical to the phone
  (`MAX_ATTACHMENTS`, `ATTACH_MAX_BYTES`, `chat.tsx:62`). Drop highlight:
  2 px `C.accent` inset outline on the pane, "Drop to attach" hint.
- **OS text → composer**: plain insert into the draft.
- **Crew cards → columns**: drag = status change (3.3; RPC unverified).
- **Not in scope**: pane reordering, tab tear-off (P4 at the earliest).

### 4.7 Hover and selection rules

Hover: `C.bgHover` on rows/cards after ≥50 ms (no flicker on pass-through);
row actions fade in on hover AND are always reachable via the menu key.
Selection: one selected row per list pane; selected = `C.bgCard` + 2 px
`C.accent` bar on the rail-leading edge; selection persists while the pane
is focused; focus (keyboard) and selection (click) may differ — focus ring
moves with arrows, selection follows focus only on Enter/Space or click.

---

## 5. Visual rules

### 5.1 Density scale

One `moch.shell.v1.density` setting: `compact | default | comfortable`.

| Metric | compact | default | comfortable |
| --- | --- | --- | --- |
| Table row height | 26 px | 32 px | 38 px |
| Pane padding (x) | 12 px | 16 px | 20 px |
| Vertical rhythm | 4 px | 8 px | 12 px |
| Base font | 13 px | 14 px | 15 px |

8 px spacing grid; control heights 24 (compact) / 28 / 32 px; icons 16 px
in-table, 20 px in chrome.

### 5.2 Table vs card rules

- **Table** when items are homogeneous and scannable: sessions,
  automations, connectors (yours), fleet profiles, CDP targets. Columns
  per 3.2-3.9; sortable by clicking headers (aria-sort), resizable
  columns (same splitter rules), sticky header inside the pane's single
  scroller.
- **Card/kanban** when items are states on a board (crew) or browsable
  catalog entries (connector catalog grid).
- **Detail pane** for the selected item's editable form. Never nest a
  table inside a card.

### 5.3 Theme contract — `app/src/lib/theme.ts` is the only palette

The fork hand-copied Mocheme values into CSS variables
(`desktop/ui/src/styles.css:7-55`) and then drifted. Rules:

1. The desktop build GENERATES its CSS custom properties from the live
   tokens (`C`/`S`, `theme.ts:235-249`) at startup — e.g. reads
   `C.bg`/`C.accent` and writes `--moch-bg`/`--moch-accent` — and
   re-generates on theme switch (subscribe `themeVersion`, `theme.ts:240`).
   No hex literal in desktop CSS/TSX except the token source itself.
2. Both themes must work: Mocheme (`theme.ts:112-152`) and Relay
   (`theme.ts:154-194`). Anything hardcoded to orange fails Relay.
3. **Off-token colors the fork shipped, and their replacements** (from
   `desktop/ui/src/styles.css` and inline TSX):

| Fork literal | Where | Replacement token |
| --- | --- | --- |
| `#60a5fa` (blue-400) | styles.css:671,759,804 | `C.accent` for interactive, `C.textDim` for inert info |
| `#3b82f6` (blue-500) | styles.css:759 | `C.accent` (links/actions) |
| `#a78bfa` (violet-400) | styles.css:676,803 | `C.blush` (secondary emphasis) or `C.textDim` |
| `#8b5cf6` (violet-500) 12% wash | styles.css:632 | `C.accentSoft` |
| `#2dd4bf` (teal-400) | styles.css:673,802 | `C.greenSoft` |
| `#f87171` (red-400) | styles.css:672,801 | `C.red` (text) / `C.redSoft` (wash) |
| `#4ade80` literal | styles.css:674 | `C.greenSoft` (same value — must reference the token so Relay switches) |
| `#e5484d` inline | 6 TSX sites, e.g. `desktop/ui/src/tabs/Chat.tsx:717` | `C.red` |
| `#151220` inline | Chat.tsx (1 site, grep) | `C.bgCard` |
| ad-hoc 12% rgba washes | styles.css:671-676, 801-805 | `C.accentSoft`/`redSoft`/`amberSoft`/`greenTint` (`theme.ts:63-66,137-140`) |

Phone precedent: BUG-017 replaced exactly this class of literal with
tokens (`chat.tsx:1683-1685`). Decorative exception: connector letter-tile
hues (`connectors.tsx:60`) are content identity, not chrome — keep as the
phone defines them.

### 5.4 Typography and measure

- Stack: system UI (the fork's `ui-sans-serif, system-ui…`,
  `styles.css:62`, is fine); monospace for terminal/code (`ui-monospace`).
- Scale: 12 (meta), 13 (secondary), 14 (body/default), 16 (section
  title), 20 (screen title). Line-height 1.45 body, 1.3 titles.
- **Measure caps**: transcript/prose column ≤ **760 px** (≈72-76 chars at
  15-16 px) centered in the main pane at any width; inspector body ≤ 60
  chars; tables may span the pane. Terminal wraps at pane width.
- Max line length in the shell's own source: 100 columns (the fork's
  ~90+ char CSS one-liners, e.g. `styles.css:70,126`, are unreadable in
  review — new desktop code wraps).

### 5.5 Contrast floor

- Text: WCAG AA **4.5:1** minimum against its actual background
  (`textDim` `#B4B1C4` on `bg` `#0A0813` ≈ 12:1; `textFaint` `#86829B` on
  `bgCard` `#151220` ≈ 4.6:1 — faint text is meta only, never body).
- UI boundaries and icons: **3:1** (non-text, WCAG 1.4.11).
- **Disabled states**: the fork shipped `opacity: 0.35` disabled controls
  (`styles.css:230,421,455,607`) ≈ 2.0-2.8:1 — below every floor. Rule:
  disabled = `C.textDim` ink on `C.bgElev` with `C.borderSoft` outline,
  no opacity trickery, ≥3:1 for the label and an explicit
  `aria-disabled`/`disabled` attribute; disabled controls are NOT
  focusable and never carry tooltips promising actions.

### 5.6 Empty, loading, error states

Every pane states all three explicitly (the phone screens already model
this — BUG-021: spinner on first load, error ≠ empty, `sessions.tsx:355-375`):
- Empty: one line of cause + one affordance ("No conversations yet" +
  "Start chatting" button, `sessions.tsx:365-372`). Never a bare void.
- Loading: skeleton rows (table) or centered `ActivityIndicator`
  equivalent (spinner) only until FIRST data; refreshes keep old rows
  visible with a subtle progress hairline at the pane top.
- Error: the error row pattern (`sessions.tsx:294-304`) — message + retry
  action that actually retries; offline is its own state, not an error.
- A control that looks interactive must DO something: the fork's model
  badge is a dead div shaped like a select (`desktop/ui/src/tabs/Chat.tsx:723-726`)
  — banned; if it renders as a chip it opens the picker (the real app's
  chip does, `chat.tsx:1635`).

---

## 6. Native touchpoints (Tauri 2 APIs) + feasibility

Feasibility evidence and probe transcripts:
[`desktop/.tmp/recon/tauri-feasibility.md`](.tmp/recon/tauri-feasibility.md).
Current stack: tauri 2.12.3 (`desktop/src-tauri/Cargo.lock:3091-3095`),
tray-icon 0.25.1 + muda 0.20.0 + libappindicator 0.9.0 already LOCKED
(`Cargo.lock:3598-3602,1840-1844,1684-1695`), no plugins locked, and
crate downloads are network-blocked on this machine (recon §3: index 200,
`static.crates.io` 403 AccessDenied).

| Capability | Tauri 2 API / crate | Cargo change | Capability/permission entries | Offline? |
| --- | --- | --- | --- | --- |
| Native menu + accelerators | `tauri::menu::*` (muda, unconditional dep) | none | none (Rust-side) | **Yes** — vendored |
| Tray icon + close-to-tray | `tauri::tray::TrayIconBuilder` (feature `tray-icon` → `dep:tray-icon`); hide-on-close via `WindowEvent::CloseRequested` + `webview_window.hide()` | add `"tray-icon"` to tauri features in `desktop/src-tauri/Cargo.toml:17` | none (Rust-side) | **Yes** — locked+vendored; icon via `app.default_window_icon()` (avoids the unvendored `image` crate) |
| OS notifications (approvals/questions/turn-end) | `tauri-plugin-notification` 2.7.0 (notify-rust 4.18.x) | new dep — **blocked offline** | `notification:default` in `capabilities/default.json` (today only `core:default`, `desktop/src-tauri/capabilities/default.json:1-9`) | **No** — fallback: hand-rolled `org.freedesktop.Notifications` over vendored `dbus 0.9.12` (Linux), or in-app toasts (P3) |
| Window state persistence | `tauri-plugin-window-state` 2.5.0 (Rust-only, no JS API) | new dep — **blocked offline** | none needed | **No for plugin / Yes hand-rolled**: `WindowEvent::{Moved,Resized}` → JSON file → restore in `setup()`; zero new deps (planned `.win-geometry` is already gitignored) |
| Global quick-ask hotkey | `tauri-plugin-global-shortcut` 2.4.1 (global-hotkey 0.8.0) | new dep — **blocked offline** | `global-shortcut:allow-register`, `allow-unregister`, `allow-is-registered` | **No** (recon §4) — P4 |
| Native file dialogs | `tauri-plugin-dialog` 2.8.3 | new dep — **blocked offline** | `dialog:default` | **No for plugin / Yes for the use-case**: `<input type="file">` opens the GTK chooser in WebKitGTK; use for attach-to-chat (P3), plugin later |
| Drag-drop files into chat | core: `WebviewWindow::on_drag_drop_event` / JS `listen('tauri://drag-drop')`; HTML5 drop fallback | none | `core:event:default` (already in `core:default`) for the JS listener; `withGlobalTauri` must become `true` (`tauri.conf.json:10`) or the JS API package must be added | **Yes** — WebKitGTK file-drop fidelity needs a runtime check (recon §6) |
| Deep links (`moch://`) | `tauri-plugin-deep-link` 2.6.2 | new dep — **blocked offline** | `deep-link:default` | **No for plugin / Yes hand-rolled**: scheme in the `.desktop` file (packaging) + second instance (flock gate `lib.rs:103-137`) drops the URL to a file the primary reads — zero new deps |
| Auto-updater | `tauri-plugin-updater` 2.14.0 | new dep — **blocked offline** (+ needs a signed endpoint) | `updater:default` (+ `allow-check`, `allow-download`, `allow-install`) | **No** (recon §4) — P4 |
| Single instance | already implemented (flock) | none | none | **Yes** — done (`lib.rs:103-137`) |

JS-side note: the app-web UI does not import `@tauri-apps/*`. Keep it that
way — drive plugins from Rust and expose shell commands; if the web layer
must call Tauri, prefer `withGlobalTauri: true` over adding npm packages
(npm registry reachability unverified, recon §6).

Notification triggers (P4 wiring): approvals/questions = the app's
attention machinery (`app/src/lib/attention.ts` attention events; the
phone's push channels mirror this, `app/src/lib/push.ts:212` approvals
channel), turn-end = attention kind `done` (`attention.ts:25`). Dispatch
hook belongs in `app/src/lib` (section 7) so the phone keeps one
attention→notification pipeline.

---

## 7. Phasing

### P2 — Shell (host the real app; desktop chrome)

1. Expo web export hosted in the panes (replaces `desktop/ui/`); desktop
   presentation layer: rail, list pane, main pane, inspector, splitters,
   one-scroller-per-pane, persistence (`moch.shell.v1` + hand-rolled
   window geometry).
2. Sessions table (3.2), chat hosted as-is (3.1), skills + bot + settings
   hosted as-is (3.10-3.12), index bypass verified on desktop
   (3.13).
3. Command palette (4.3) + accelerator set W (4.1) + native menu skeleton
   (4.2, offline: muda) + tray with close-to-tray (feature flag only,
   6).
4. Theme contract pipeline (5.3) — CSS vars generated from live tokens;
   off-token literals eliminated in the new layer.
5. Hand-rolled window state persistence (6).
6. Onboarding pane replacing the fork Wizard (3.15).

### P3 — Parity debt (desktop variants of the list/board screens)

Sessions context menus, crew 4-column board (+drag if the RPC verifies),
fleet table + bot detail flow, automations table + editor, agent two-pane
model browser, connectors table + detail, browser target pane (+shell POST
relay), terminal PTY pane (BLOCKED on 7.1), density setting, drag-drop of
files into chat (BLOCKED on 7.2), focus/ARIA audit pass, contrast audit
pass, empty/loading/error pass over every pane.

### P4 — Native depth

OS notifications (7.3 + plugin, or DBus fallback), global quick-ask
hotkey, deep links (plugin or hand-rolled), auto-updater, browser
screencast embedding (unverified), zoom controls, launch-on-login,
packaging polish (deb/AppImage post-install for scheme + mime).

### Must land in `app/src/lib` FIRST (shared, both platforms consume)

1. **PTY provider negotiation** (`app/src/lib/mochiRuntime.ts`): web
   fallback when `NativeModules.HermesBridge` is absent → gateway RPC
   provider; plus the runtime-side PTY surface. Without it the terminal
   pane cannot exist (3.7).
2. **Web-File attachments** (`app/src/lib/mediaSend.ts` / `media.ts`):
   construct `PendingAttachment` from browser `File` objects (drag-drop,
   clipboard) within the existing caps (3.1, 4.6).
3. **Attention→notification dispatch hook** (`app/src/lib/push.ts`):
   a web-branch bridge that emits a shell event instead of expo push, so
   approvals/questions/turn-end reuse one pipeline (6).
4. **Quick-ask / deep-link open-request contract**: the app already has
   `requestOpenSession` (`app/src/lib/attention.ts`); extend the same
   pattern for shell-originated "open session X / run command Y" intents
   so P4 wiring is a call, not a rewrite.

Nothing in P2 requires network. P3 items 1-2 block on the lib work above;
all plugin-dependent P4 items block on crate downloads (recon §3-4).

---

## Appendix A — Fork defect ledger (what this spec fixes)

| Audit finding | Evidence | Fixed by |
| --- | --- | --- |
| 0 `@media` queries (source and bundle) | `grep -c '@media' desktop/ui/src/styles.css` = 0 | 2.2 breakpoints are pane-math, not media queries; add 2 media queries only for pointer/hover capability |
| Fixed 236 px sidebar, no collapse/resize | `styles.css:129-130` | 2.2 rail 56/200 + resizable list pane |
| Fixed 330 px right panel, no collapse/resize | `styles.css:722-723` | 2.2 inspector 280-460, Ctrl+J, auto-collapse <1280 |
| Content clipped below 566 px in `.app-body{overflow:hidden}` | `styles.css:70,126` | 2.2 min window 1024x680 + min main 560 |
| One keyboard handler total (Escape) | `desktop/ui/src/App.tsx:252-259` | 4.1 full accelerator table, two layers |
| No aria / focus-visible | audit finding; direct re-grep blocked by shell outage (the `@media`=0 count WAS directly verified) | 4.4, 5.5 |
| 10 nested inner scrollers | `styles.css:197,296,337,347,414,551,563,725,765,797,821,831` | 2.2 one scroller per pane |
| Composer floats over transcript, fake 90 px pad | `styles.css:562-563` | 2.2 docked in-flow composer |
| Line length ~90+ chars | e.g. `styles.css:70,126` | 5.4 100-column rule |
| Dead model badge div | `desktop/ui/src/tabs/Chat.tsx:723-726` | 5.6 no inert interactive-looking controls |
| Off-token colors in 17+ places | 5.3 table (styles.css:671-676, 801-805, 632, 759; Chat.tsx:717) | 5.3 generated token contract |
| Disabled states 2.0-2.8:1 | `styles.css:230,421,455,607` (opacity 0.35/0.45) | 5.5 contrast floor |
