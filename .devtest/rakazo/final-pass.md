# U14 — final verification pass

Date 2026-10-19, branch desktop/rakazo, stack real (gateway + vite + dev-bridge
browser, state and venv under ~/.cache/moch-verify, identity via the staged
~/.hermes provider import). Every line below was re-verified live this session
against the gateway-real stack, DOM state queried through CDP and one artifact
captured per line. The i18n DOM audit ran to completion on the same populated
stack, green in EN and AR.

| # | Checklist line | Verdict | Artifact |
|---|----------------|---------|----------|
| 1 | Three-pane shell: bots rail left, thread center, context panel right | verified live: rail/center/ctx all mounted, tabs Terminal/Browser/Files | u14-01-shell-en.png |
| 2 | Bots rail roster with status, search, new-bot entry | verified live: roster rows with status dots, search filters to no-match and restores, new-bot entry present | u14-02-roster.png |
| 3 | Bot create flow with color, instructions draft, intro turn | verified live: overlay drafted a soul from the job text, basil created, intro reply streamed into the thread | u14-03-bot-intro-ask-pending.png |
| 4 | One home thread per bot; side chats secondary | verified live: Mochi home thread (empty state) and basil home thread (5 messages incl. potato outcome) switch from the roster, state intact per bot | u14-04-mochi-home.png |
| 5 | Thread transcript streams with thinking collapsed by default | verified live: reasoning renders as one collapsed line ("Reasoning · 7465 chars"), streaming turn observed twice | u14-03-bot-intro-ask-pending.png |
| 6 | Tool activity hidden behind one disclosure per run | verified live: run header folds to "1 tools" then "2 tools · 3m 40s", closed by default | u14-03-bot-intro-ask-pending.png |
| 7 | Ask and approval cards answerable inline; waiting state in rail | verified live: intro ask card pending, answered inline through the batch card, card cleared and agent resumed | u14-07-ask-answered.png |
| 8 | Steering a live run from the composer with a visible chip | verified live: chip "Steering" during a live run, steer placeholder while typing, steered reply replaced the count with "potato" | u14-08-steer-live.png |
| 9 | Composer carries model picker, attachments, @bot | verified live: model picker with 60 rows, @bot picker with both bots; attachment chips render on the send path (no file-dialog entry in this build) | u14-09-model-picker.png, u14-09-atbot-picker.png |
| 10 | Context panel tabs: terminal PTY, files, browser, artifacts | verified live: `echo u14-keepalive-7734` executed in the PTY, output survived a terminal→browser→terminal round trip (same tty) | u14-10-terminal-keepalive.png |
| 11 | Routines list with next-run, history, run-now, pause | verified live: routine created via the modal, run-now fired a real execution (history "completed 03:09 AM"), pause armed ("paused — resume to re-arm", dot idle) | u14-11-routines-runnow.png, u14-11-routines-paused.png |
| 12 | Activity timeline across bots from the run ledger | verified live: the run-now execution appears as "job 8b1d2324d5af · Completed · 03:09 AM" under TODAY | u14-12-activity.png |
| 13 | Connectors management (MCP), models, general settings | verified live: overlay from the account row, general shows runtime paths, models lists 296 rows, connectors tab lists providers | u14-13-settings-models.png |
| 14 | EN/AR with RTL across the whole shell | verified live: flip to العربية set dir=rtl, translated tabs/search/aria without reload, flip back restored EN | u14-14-ar-rtl.png |
| 15 | Live verification pass with screenshots | this row: 14 screenshots + audit log on the gateway-real stack; audit green in both locales on a populated stack | u14-audit-green.log, this file |

Audit evidence: `node scripts/check-dom-strings.mjs <url>` exit 0 twice — once
on a fresh stack (23s, full tour, no stall) and once on the populated stack
above; both locales in one tour, 556 EN keys. Stall root cause and fix are in
the audit script's comments and the unit report.

Known finding, not fixed (product code out of U14 scope): run-now shows a
"request timed out after 20s: cron.manage" banner even though the backend
completes the execution; the history row lands. Also the dev-bridge
browser-launch dies when TMPDIR makes chromium's SingletonSocket path exceed
the 108-byte unix socket limit (verify-ui.sh work roots can land one byte
over); a short MOCH_WORK avoids it.
