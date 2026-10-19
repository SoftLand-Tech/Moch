# Moch Desktop — Test Plan (the user-testing campaign)

Run when execution is back (see `.devtest/recover.sh` to restore the stack).
Goal: test EVERYTHING like a user — click it all, use it long, break it, fix it.

## 0. Environment gates (before any clicking)

- [ ] `cd desktop/ui && npx tsc --noEmit` — strict TS clean
- [ ] `cd desktop/ui && npm run build` — vite build green
- [ ] `cd desktop/src-tauri && cargo check` — Rust clean
- [ ] `.devtest/recover.sh` ran; gateway log shows `HERMES_BACKEND_READY`
- [ ] Window opens in < 3s from a warm start; splash never flashes white
- [ ] Statusbar: `local runtime` (green) + `1 bot` + workspace
- [ ] Import path: gateway home has the imported config (`.env` from ~/.hermes)
      — `moch_desktop --import-from ~/.hermes` before first boot

## 1. Chat (the core loop)

- [ ] Empty state renders: avatar, "What can you do?", 4 suggestion chips
- [ ] Type a message → local echo in cream bubble → send
- [ ] Reply streams token-by-token; Thinking block collapses/expands with
      elapsed seconds; markdown renders on completion (bullets, code blocks,
      tables, links orange)
- [ ] copy + listen actions appear on hover; listen plays TTS audio
- [ ] Tool rows: spinner while running, ✓/failed after, click expands
      args/output detail
- [ ] Todos strip appears when the agent plans
- [ ] New chat button → fresh session; two sessions both stream independently
- [ ] Session list: search filters; pin toggles; archive hides to section;
      delete asks confirm and removes
- [ ] Rename via header → server-side title sticks after reload
- [ ] Interrupt (stop chip) mid-stream halts politely
- [ ] Steer mode: toggle → message queued → delivered at boundary
- [ ] Slash: typing `/` opens the popup with catalog entries; arrows+Tab
      navigate; `/model` opens the picker; a catalog command executes
- [ ] Model chip in composer → picker → switch persists (config.set)
- [ ] Attach: paperclip → pick an image → chip shows → send → agent sees it
- [ ] Voice: mic → level meter pulses → stop → transcript lands in composer
      (never auto-sends)
- [ ] Reconnect: kill the gateway process → banner/offline state → restart
      → auto-reconnects and continues

## 2. Approvals / interactive cards

- [ ] Ask the agent to run a command needing sudo/approval → card renders
      (title, body, Approve/Deny or input) inline in chat AND in Inbox
- [ ] Approve → turn continues; Deny → refusal path visible
- [ ] sudo card masks input; secret card; clarify card with options
- [ ] Inbox badge count in the rail updates live; Ctrl+J opens Inbox
- [ ] request.cancel (timeout) withdraws the card everywhere

## 3. Fleet (bots)

- [ ] Fleet opens on the roster: default bot shows as "Mochi"
- [ ] Empty state: 4 capability cards; clicking one prefills the wizard
- [ ] Create bot: job text → live slug suggestion → checklist (USER.md on,
      skills picker) → create → roster updates, bot selected
- [ ] Bot detail: description + SOUL.md editors, Save persists (re-open shows)
- [ ] "Use my provider" mirror path when no provider (amber box)
- [ ] Freeze/unfreeze reflects in roster + fleet status row
- [ ] Chat button on roster row → switches active bot → composer + chip say
      the bot name; new chat title "Bot · <name>"; sidebar rows show avatar
- [ ] Two-tap delete with honest scope text; default bot undeletable
- [ ] @-mention a bot in Cmd+K palette → "Chat with @bot"

## 4. Crew

- [ ] Board renders 4 columns side-by-side; counts per column
- [ ] New task modal: title/body/assignee chips; create lands in Ready
- [ ] Task expand: Complete moves to Done; reassign chips move assignee
- [ ] Run ledger below shows kanban/cron/delegate entries with icons,
      failures red
- [ ] Polling keeps the board fresh while visible; hidden tab pauses

## 5. Browser (the hero feature)

- [ ] Browser view: first-run "Launch" → Chromium spawns (statusbar port)
- [ ] Pane streams the page (screencast); URL bar shows current URL
- [ ] Type a URL → navigates; back/forward/reload work; https lock icon
- [ ] Click links with the mouse — input forwarding hits the right elements
- [ ] Scroll with wheel; type in page inputs via keyboard
- [ ] Tabs: + New tab, switch (list + pane follow), close
- [ ] Ask an agent in chat to browse something → the SAME browser moves live
      in the pane (one browser, two drivers) — THE demo
- [ ] Open in system browser button
- [ ] Stop browser → statusbar reflects; tools disarm (agent told honestly)

## 6. Terminal

- [ ] Terminal view: shell opens in the workspace; prompt works
- [ ] Multiple sessions: + New terminal; tabs keep state while hidden
- [ ] Resize window → terminal reflows (fit)
- [ ] Stage pane: toggle from statusbar; terminal docked next to chat
- [ ] vim/htop-style TUI apps render correctly (binary-safe stream)
- [ ] Close tab kills the shell (no process leak — check `ps` after)

## 7. Automations

- [ ] List loads (empty state with 3 template cards otherwise)
- [ ] Create via modal (schedule text + prompt) → appears with next-run
- [ ] Run now fires → run ledger/status updates
- [ ] Pause/resume toggles; edit prefills full prompt (action get); delete 2-tap

## 8. Skills / Connectors / Settings

- [ ] Skills list from gateway; open folder reveals the dir
- [ ] Connectors: providers list; connect with a key; disconnect
- [ ] MCP: add server (JSON config); status dots; test; remove
- [ ] Settings: paths + Reveal buttons; version shown; Restart gateway works
      (window survives, reconnects); runtime logs collapsible shows lines

## 9. Long-run / soak

- [ ] 30+ min of continuous use: multiple chats, a browser task, a cron fire
- [ ] Memory: no runaway (watch the process)
- [ ] Reconnect after gateway restart mid-turn (replay/intake consistent)
- [ ] Rapid view switching, palette spam, resize extremes (1120px min width)

## 10. Performance budgets

- [ ] Window cold open (binary cached): < 2s to interactive
- [ ] Gateway adopt path: statusbar green < 1.5s after spawn
- [ ] Message send → first token: comparable to phone (< network latency)
- [ ] Screencast: scrolling a page stays > ~20fps feel; no frame backlog

## Notes

- The dev-bridge browser track (vite :5173) exercises everything except PTY
  (mocked error) — use it for fast DOM-level user testing via browser-use.
- The Tauri window is the real track: grim screenshots + hyprctl for layout,
  gateway log + devtools console for errors.
- Every failure found → file in bugs.md style: DESK-### with repro + fix.

## Round-9 verification additions (all PASS, live)

- Slash execution: `/save` dispatched via slash.exec — the agent ran a dozen
  tool calls executing it.
- Steer mid-turn: counting turn steered to "stop at 5, say DONE-STEERED" →
  the agent's very next output was exactly `1 2 3 4 5 DONE-STEERED`.
- Fleet kill switch: task create AND reassign to a frozen bot both refused
  with 4071 "assignee is frozen (fleet kill switch)"; freeze/resume round-trips.
- Crash resilience: gateway SIGTERM'd mid-story → statusbar honestly offline →
  gateway back → auto-reconnected within 3s → new message answered.
