# Bot Mode audit — why Moch's bots behaved like sessions, and the native fix

Status: **implemented** on `main` (audit 2026-11-22). Companion docs:
`M9-BOTS.md` (the M9 plan), `app/hermes-src/tools/bot_mode_probe.py` (native Bot
Mode), `app/hermes-src/tui_gateway/methods_profiles.py` (the roster/config RPCs).

---

Build in question: **1.0.48-botmode** (versionCode 51), CI build of the Bot
Mode fix.

## 0. The ask, in one line

Bots must be **persistent, independent agent identities with one canonical Bot
Chat**, following Hermes' actual Bot Mode architecture — not ordinary sessions
with extra prompts, and not a parallel Moch bot system.

## 1. What "Hermes Bot Mode" actually is (verified in the vendored tree)

| Native concept | Where | What it means for the client |
|---|---|---|
| **Identity = profile** | `hermes_cli/profiles.py` | A bot is a Hermes profile: own `HERMES_HOME` with `SOUL.md` (persona/job), `memories/` (`MEMORY.md`, `USER.md`), `config.yaml` (model/provider, toolsets), `skills/`, `cron/`, `sessions/`. "Own model/tools/skills/memory" is per-profile isolation, not app-side records. |
| **Managed marker** | `tools/bot_mode_probe.py::_is_bot_managed` | A profile is Bot-Mode-managed when `profile.yaml` carries `ui_meta['hermes-bots']`; its `title` is the roster display name (`hermes_cli/profiles.py::read_profile_meta` → `bot_title`). A managed install is what makes Hermes inject the **teammate protocol** (`get_bot_mode_protocol_section`) and the **`message_agent` DM tool** into that bot's sessions. |
| **Canonical Bot Chat** | `hermes_state.CANONICAL_BOT_CHAT_TITLE = "Bot Chat"`; `tui_gateway/methods_session.py::_session_list_by_title` | A bot's ONE conversation is the session **titled exactly `Bot Chat`** on its profile — born **hidden**, identity is the NAME (no session-id pointer). Hermes resurrects accidentally archived canonical rows; renames of a hidden `Bot Chat` are refused; a deliberately retired one is replaced on the next create. |
| **Roster resolution** | `tui_gateway/methods_profiles.py::profiles.list` | Every listing already resolves, per profile: `last_session`, `worker_session` and **`canonical_session`** (`id`, `resolved_id` = live compression tip, preview, counts) plus `ui_meta` and `ui_meta_revisions`. Server-side resolution means no client owns a session pointer. |
| **Config write door** | `methods_profiles.py::profiles.configure` | Native, CAS-guarded writes for `ui_meta`, `soul`, `description`, `model`+`provider`, `disabled_skills`, `enabled_toolsets`, `enabled_mcp_servers`. |
| **Continuity** | `methods_session.py::_resume_follow_tip` | Resuming the stored Bot Chat id rebinds to the **compression tip** (`session.resume` follows proven compression edges for `Bot Chat` titles); `session.list {title}` also returns `resolved_id`. Restarts and context compaction are native continuity, not a client cache. |

## 2. Why Moch's bots behaved like ordinary sessions (findings)

1. **Bots were never marked as Bot-Mode-managed.** `fleet.ts::createProfile`
   only called `profiles.create` and `moch.profiles.seed`; nothing wrote
   `ui_meta['hermes-bots']`. Hermes therefore treated every Moch bot as a
   plain profile: no teammate protocol, no `message_agent`, no native roster
   title, and desktop/TUI bots saw no managed profiles on the install.
2. **The app created ordinary sessions *inside* a bot.** `chat.ts::createSession`
   read `getActiveBot()` and sent `session.create { profile: bot, title: 'Bot · <bot>' }`
   — every “new chat” while a bot was selected minted another session in the
   bot's profile. That is exactly “the bot is a session folder/template”.
3. **A failed canonical recovery fell back to an ordinary bot chat.**
   `botChat.ts::recoverBotChat` ended in `deps.newChat()` — a fresh bot-scoped
   session — silently replacing the canonical Bot Chat with a task session.
4. **The chat list merged every bot profile's sessions.** `sessionList.ts`
   fanned out `session.list` over the Fleet roster (BUG-112) and interleaved
   those rows into the drawer, so bot conversations read as normal chats.
5. **Task sessions could become the bot's face.** `botRosterMeta.ts` rendered
   `last_session.preview` ahead of `canonical_session.preview`, so a newer
   worker/side session stood in for the canonical chat in the roster.
6. **Bot identity was app-local.** Display names were the profile folder id and
   avatars came from a local hash table, while the native title
   (`ui_meta['hermes-bots'].title`) and profile metadata were ignored.

In short: the **identity** was native (a profile) but the **conversation model**
was a parallel, app-side "bot = session scope" system. Hence bots behaved like
normal sessions, and no amount of hiding buttons would change that.

## 3. The fix — reuse the native implementation, delete the parallel one

**Native identity (new `app/src/lib/botMode.ts`)**
- Reads/writes the native marker: `isBotModeManaged(ui_meta)`,
  `readBotModeMeta`, `botDisplayTitle` (marker `title` → `display_name` →
  folder id; launch profile reads `Moch`).
- `markBotModeManaged()` writes through **`profiles.configure`** with
  `ui_meta['hermes-bots'].title` and the roster's **per-key CAS revision**
  (`ui_meta_expected_revisions`); success is the explicit
  `applied.ui_meta === true` verdict (a CAS conflict or a gateway that ignores
  the param is a no-op that retries later).
- `fleet.ts::createProfile` marks every newly created bot. Profiles that
  predate the marker are upgraded **when Moch opens them as a bot**
  (`openBotChat` → `ensureBotModeIdentity`, serialized, best-effort) — never by
  a roster-wide sweep: an unmarked named profile may belong to the desktop or
  CLI, and the marker flips Hermes' global `is_bot_mode_managed` gate.

**Profile-scoped resume (the “session not found” bug)**
- A bot chat lives in THAT profile's `state.db`, but the open path resumed it
  with no `profile` argument — the gateway therefore searched the launch DB
  and answered `session not found` for every bot. The open path now passes the
  bot's profile on `session.resume` (`resumeShared(storedId, { profile })`),
  and every later resume of that stored id (boot paint, notification tap,
  attention hop) resolves the owning profile from a persisted
  `storedId → profile` map (`chat.trackServerOnlySession`). A wrong-profile
  lookup can no longer be mistaken for a dead canonical row (recovery only
  runs on the definitive `session not found`, and a provider/model error
  never deletes anything).

**One canonical Bot Chat (`app/src/lib/botChat.ts`)**
- `fleet.ts::createProfile` calls `ensureBotChat` best-effort right after
  creation, so every bot HAS its canonical Bot Chat from birth; the open path
  re-ensures the same row idempotently (a failed eager create self-heals on
  first open).
- `ensureBotChat(profile)` is now the single resolve-or-create door: native
  exact-title lookup (`session.list { profile, title: 'Bot Chat', include_hidden: true }`),
  then `session.create { profile, title, hidden: true, follow_profile_config: true }`
  + `session.title` claim, adopting the winner on an "already in use" race.
  Single-flighted and **resolve-only** (no screen side effects).
- **`Moch` — the launch/default profile — is the default BOT**, not the shell:
  it gets the same native marker and its own canonical Bot Chat (“Moch” in the
  roster, opened from the Bots rail/switcher like any bot). Ordinary chat
  history lives on the separate **Sessions** surface (the canonical Bot Chat
  is hidden, so it never leaks there; the default bot's screen has no
  task-session card because its ordinary sessions ARE that surface).
- `openBotChat()` = mark identity view → `ensureBotChat()` → `session.resume`
  (which natively follows the compression tip) → recovery that can only mint
  the canonical chat. **The ordinary-chat fallback is gone**; a failure throws
  and surfaces in the UI.
- The launch profile is rejected: it is the assistant, not a bot, and has no
  Bot Chat.

**No ordinary sessions inside a bot (`app/src/lib/chat.ts`)**
- `createSession()` no longer reads the active bot and never sends `profile`
  for a new chat; a new chat always belongs to the launch profile.
- `newChat()` and `switchToSession()` clear the bot view marker (a fresh chat
  or a saved ordinary chat is the launch identity, not a bot).
- `activeBot` is now only a **view marker** for the chat surface (pill/avatar).

**Bots are not session folders (`app/src/lib/sessionList.ts`)**
- The per-profile fan-out (BUG-112) is removed: the drawer is the launch
  profile's conversation list. Bots are reached through the Bots roster /
  bot screen, which opens the canonical Bot Chat.

**Canonical is the face (`app/src/lib/botRosterMeta.ts` + UI)**
- Roster rows are profiles, named by the native marker title; the preview is
  the canonical Bot Chat's preview only — a newer task/worker session on the
  same profile can no longer stand in for it (`worker_session` still drives the
  busy dot; it is not the bot's conversation).
- `canonicalResolvedId` is carried for surfaces that need the live tip.
- Chat pill/switcher, Fleet cards, Crew assignee chips and the bot screen
  header display the native title; RPCs keep using the profile folder id.

**Restarts, pruning and legacy data**
- The launch-profile session list can no longer prove anything about a bot's
  sessions, so reconciliation (`sessionRows.subscribe`) skips sessions opened
  through a non-launch profile (`chat.trackServerOnlySession`): a Bot Chat the
  user leaves is not evicted, and its cached transcript is not deleted.
- Stale-handle recovery is gated on Hermes' definitive `session not found`
  shape (4001/4007) — a provider/model 404 can no longer be mistaken for a dead
  canonical row and delete it.
- The bot screen lists the bot's Hermes-side **task sessions** separately
  (`botRosterMeta.taskSessionRows` + `chat.openServerSession`), so pre-existing
  `Bot · <bot>` side conversations (and any worker/side session) stay
  reachable while remaining visibly NOT the canonical Bot Chat. They open as
  ordinary chats with a banner naming the bot; they never reset the Bot Chat.

## 4. Unchanged on purpose

- **`moch.fleet.*`** (freeze, turn gate, budgets, queue) stays — it is Moch's
  runtime policy for N agents on one device, not a second bot identity.
- **`moch.profiles.seed` / `mirror_model_key` / `delete`** stay — Hermes' ws
  API has no equivalents; they operate on the same native profile.
- **Per-profile data** (`SOUL.md`, memories, skills, config, sessions, cron) is
  untouched: existing sessions and bots are preserved. Pre-existing ordinary
  bot-profile sessions remain in the bot's `state.db` as Hermes-side task
  sessions (kept, never reset by this change) but are no longer surfaced as
  chats; their data is intact.

## 5. How this is tested

- `app/scripts/test-bot-chat.ts` (79 checks) — native canonical contract
  (including profile-scoped resume for named AND default bots):
  existing row opens with no create; missing row creates + titles with the
  exact wire params; title conflict adopts the winner; lookup failure mints
  nothing; a second `ensureBotChat` after a simulated restart reuses the same
  row and its compression tip; a failed canonical create/restore **throws** and
  never mints an ordinary `Bot · <name>` session; a provider/model error is not
  treated as a stale session (canonical row survives); the launch profile is
  rejected; the identity marker is set only after a successful open.
- `app/scripts/test-bot-mode.ts` (50 checks) — marker shape/CAS/merge, explicit
  `applied` verdict, identity precedence, `markBotModeManaged` idempotence,
  roster mapping (one row per profile, native title, canonical-only preview,
  DM envelope stripping) and task-session flattening (canonical filtered, wire
  + typed shapes, cap).
- `npm run typecheck`, `npm run lint`, `npm run test:imports`, and the offline
  protocol suites (`npm test`) run in CI and locally. Both bot suites are now
  part of `npm run verify`.

## 6. Follow-ups (not required for the Bot Mode fix)

- Avatar: `profiles.set_asset/get_asset` is the native per-bot avatar door; the
  app still uses local mochi profiles keyed by name (fallback is fine, but the
  native asset should win when present).
- The bot editor still exposes only SOUL/description; native
  `profiles.configure` also supports model/provider, disabled skills,
  enabled toolsets/MCP servers — adopting those is a UI follow-up.
