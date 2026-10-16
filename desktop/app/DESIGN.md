# Moch Desktop — design contract for the full redesign

Source of truth: the operator's reference mock (dark three-column desktop
agent app) + this repo's real engine. Every visual decision follows the
reference's LAYOUT and DENSITY; every color follows the app's own Mocheme
tokens (`src/lib/theme.ts`). No hex literals in TSX. No mock features —
each reference element maps to a real engine capability, listed here.

## Layout

```
┌────────────┬──────────────────────────────────────┬──────────────┐
│ sidebar    │ main column (per screen)             │ inspector    │
│ 248px      │                                      │ (Agent/Coding│
│            │                                      │  only) 340px │
└────────────┴──────────────────────────────────────┴──────────────┘
```

Sidebar (248px, always visible): brand block at top (mascot mark +
"Moch" + "Your Hermes AI Agent"), primary nav (icon + label), a
"WORKSPACE MODES" section header with the four modes (icon + label +
one-line subtitle, active mode = accent-soft pill), and the status card
at the bottom (mascot, "Moch", online dot + text, live provider).

Main column top bar (inside the screen, not global): screen title with
icon, subtitle line where the screen has one, and on the right the
search trigger (opens the palette) + connection dot.

Inspector (right): live run panel — header "Moch is working…" + Live
badge, session title card, progress bar with "N of M · P%", the todo
checklist with per-item timestamps, tab strip (Activity · Tools ·
Terminal · Files), activity feed rows (icon, title, detail, age), and
Tools & Integrations tiles (from mcpState) with "View all" → Connectors.

## Screens and their real backing

| Nav/mode | Screen | Backing (all real) |
| --- | --- | --- |
| Home (mode: Agent) | `src/ui/Home/` | hero composer (drafts store + sendPrompt), example-task cards sourced from the slash catalog (`commandCategories`/`skills`, filtered to actionable items), recent activity from `tools`/`todos` |
| Chats | `src/ui/Sessions/` | sessionRows + open/delete/search |
| Fleet (nav "Agents") | `src/ui/Fleet/` | fleet.ts |
| Files | `src/ui/Files/` | gateway FS REST (`/api/fs/list`, `/api/files/…`) via httpBase — list, folder navigation, text preview |
| Terminal (mode: Coding) | `src/ui/Terminal/` | the PTY bridge |
| Connectors (nav "Tools") | `src/ui/Connectors/` | mcpState |
| Automations | `src/ui/Automations/` | cron.manage |
| Skills | `src/ui/Skills/` | slash catalog |
| Settings | `src/ui/Settings/` | theme/computers/pairing |
| Chat (mode: Chat) | `src/ui/Chat/` | the engine |
| Crew | `src/ui/Crew/` (placeholder until its unit) | — |

Modes: Chat → plain chat. Agent → Home. Coding → Terminal with Files in
the inspector's Files tab. Research → chat with the research starter
drafted. A mode is a preset (screen + optional draft), nothing more.

## Style rules

- Canvas `--moch-bg`, cards `--moch-bg-card` with 1px
  `--moch-border` and 12px radius, hover `--moch-bg-hover`.
- Accent (orange) only for: active nav pill, primary send button,
  progress bar, live badge, selection. Everything else neutral.
- Type scale: 20 screen title, 14 body, 13 secondary, 11 uppercase
  section headers with letter-spacing.
- Row height 40px nav, 32-36px tables. Cards padding 16-20px.
- Status dots: green connected/working, orange connecting, red error.
- Empty states: mascot art + headline + one affordance, never a void.
- Focus: `:focus-visible` 2px accent ring, never removed.

## Rules of engagement

- Presentation only. State comes from the shared stores
  (`app/src/lib/**`); new engine calls (like the FS REST reads) go in
  `src/core/`, not inside components.
- No new npm dependencies. No edits to `vite.config.ts`,
  `tsconfig.json`, `app/src/**`.
- Every screen must render its empty, loading, and error states.
