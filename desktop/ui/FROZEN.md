# FROZEN — this UI is legacy and being retired

> **Status as of 2026-10-15: `desktop/ui/` is FROZEN.** Do not add features
> here. Do not do cosmetic work here. This directory is migrated screen by
> screen into the shared core and deleted once the last screen is matched.
>
> Authoritative context: [../ARCHITECTURE.md](../ARCHITECTURE.md) (the
> decision, the hard rule, the roadmap) and
> [../PARITY-BACKLOG.md](../PARITY-BACKLOG.md) (what is still owed, per
> capability).

## What this directory is

A hand-written parallel re-implementation of the phone UI: ~5.8k lines across
8 tabs (`src/tabs/`: Chat, Bots, Crew, Automations, Skills, Models, Browser,
Run). It shares exactly two modules with the real app —
`app/src/protocol/json-rpc-gateway` (`src/App.tsx:9`) and the mascot states
(`src/MochiInteractive.tsx:8`) — and reimplements or omits everything else
(see [../PARITY-BACKLOG.md](../PARITY-BACKLOG.md) for the gap list).

The decision ([../ARCHITECTURE.md](../ARCHITECTURE.md) §1): the desktop now
renders the phone app's REAL screens and `app/src/lib` logic via
react-native-web inside the Tauri window. This fork stops evolving.

## What to do instead

- **New behaviour** (protocol, state, business logic): `app/src/lib` or
  `app/src/components` — BOTH platforms consume it. This is the hard rule.
- **Desktop-only presentation** (nav rail, panes, palette, accelerators,
  dense tables): the desktop presentation layer in the desktop tree, importing
  the shared state/logic modules — never a copy of them.
- **A bug you hit while using the desktop app**: fix it in the shared layer if
  the screen has already been migrated. Only fix it here if the migrated
  replacement does not exist yet AND the bug blocks daily use — and say so in
  the commit; the fix dies with this fork.

## How to tell if something here is unreachable from the new path

1. **The new desktop path never imports this directory.** It mounts the real
   app screens (`app/app/**`) over react-native-web; the only code carried
   over from the fork are the two shared imports above (which point INTO
   `app/`, not out of it) and the desktop presentation concepts that get
   re-implemented fresh.
2. **Search for consumers.** Nothing outside `desktop/ui/` imports from
   `desktop/ui/` — the Vite build in this directory bundles it and the shell
   serves that bundle. If a component here has no import from `app/src/**`,
   nothing in the new architecture will ever load it.
3. **The successor test.** For anything in this fork, ask: does the phone app
   have (or will it grow) this screen or state? If yes, the successor is the
   phone's version mounted in the desktop shell — this fork's implementation
   is redundant. If no (e.g. the right-panel tool-step inspector, the nav
   rail, the local-boot wizard UX), the successor is a desktop-presentation
   re-implementation against shared state — still not this code.
4. **Consequence:** any capability that exists ONLY as code in this directory
   and has no counterpart in `app/src/**` is lost when this directory is
   deleted, unless it is ported to the shared layer or the desktop
   presentation layer first. Check [../PARITY-BACKLOG.md](../PARITY-BACKLOG.md)
   — if the capability is listed there, it lands in the shared module named
   in its row; if it is not listed, raise it before deleting.

## What survives the freeze

- The Rust shell (`../src-tauri/src/lib.rs`) and local runtime
  (`../runtime.py`) — untouched by this freeze; they are the desktop's own
  layers (L4 in [../ARCHITECTURE.md](../ARCHITECTURE.md) §3).
- The design language already matched to the app (Mocheme tokens) and the
  concepts with no phone counterpart — carried forward as designs, not as
  code.
