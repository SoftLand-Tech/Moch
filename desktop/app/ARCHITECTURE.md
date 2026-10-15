# Moch Desktop — dedicated app architecture

The desktop app is a **dedicated Vite + React + TypeScript DOM application**
in `desktop/app/`. It does not host the phone's screens. It shares ONE thing
with the phone: the protocol core.

## The reuse line (the rule that prevents fork-death)

Import these shared modules directly — they are the protocol core and are
UI-agnostic (storage is injected via the shims below; they were built to run
outside React Native):

- `../../../app/src/protocol/*` — JSON-RPC v7 channel, gateway client, replay
- `../../../app/src/lib/gateway.ts` — connection lifecycle, reconnect, saved computers
- `../../../app/src/lib/chat.ts` — the entire session/event/stream engine (nanostores atoms)
- `sessionList.ts`, `sessionRowMeta.ts`, `slash.ts`, `modelState.ts`, `fleet.ts`,
  `attention.ts`, `strings.ts`, `desktopLocal.ts`, `transportGate.ts`, `dialTransport.ts`,
  `backendIdentity.ts`, `sendQueue.ts`, `drafts.ts`, `mediaSend.ts` (media unit),
  `voice.ts` (voice unit)

NEVER copy or reimplement any of them. NEVER add protocol/business logic in
`desktop/app/src/ui/**` — UI reads shared stores and calls shared functions.
A capability the shared layer lacks goes into `app/src/lib` first.

## The shim boundary (how the engine compiles on desktop)

The engine imports React Native packages at module scope. `vite.config.ts`
aliases them to `src/shim/*`:

- `@react-native-async-storage/async-storage` → localStorage adapter
- `expo-secure-store` → localStorage-backed key store (loopback origin,
  single user; OS keyring later)
- `expo-file-system`, `expo-image-manipulator`, `expo-audio`, `expo-image` →
  typed stubs that throw on call; desktop media/voice units replace the call
  sites with fetch/blob implementations
- `react-native` (and `react-native/*` deep imports) → AppState/Platform/
  I18nManager/NativeModules desktop answers

## Single-copy rule (breaks hooks and stores silently)

`react`, `react-dom`, `react/jsx-runtime`, `nanostores`, `@nanostores/react`
are ALL aliased to the phone app's installed copies
(`app/node_modules/...`). Two copies of react break hooks with
`null is not an object (evaluating 'useRef')`; two copies of nanostores make
every atom read empty. If you add a dependency that imports react or
nanostores, it must resolve through the same alias.

## The beacon channel

With `MOCH_DEV=1`, `fetch('/dbg', { method: 'POST', body })` appends to
`desktop/.dbg.log`. The WebKit webview has no devtools console; beacons are
the debug channel. Boot steps beacon their stages; render code may beacon
state. Do not beacon per-frame.

## Style and tokens

All colors come from `src/lib/theme.ts` tokens (the shared C object) via a
generated CSS-variables module — no hex literals in UI code, or the Relay
theme breaks. Layout: rail 56 px + list pane 208-384 px + main pane (min
560) + optional inspector (280-460). One scroller per pane. Composer docks
in flow. Transcript measure ≤ 760 px. Density via CSS var. Focus rings:
`:focus-visible`, 2 px accent, never removed.

## Screens (each `src/ui/<Name>/`)

Chat · Sessions · Browser (CDP: the agent's Chromium on :9222) · Terminal
(PTY bridge served by runtime.py) · Models · Automations · Fleet ·
Connectors · Skills · Settings. The shell (`src/ui/shell/`) owns the rail,
panes, palette, accelerators, and persistence (`moch.shell.v1`).

## Build and run

`npm run build` in `desktop/app` → `desktop/app-desktop-web/` → the shell
serves it (embeds at `cargo build` — rebuild the shell after a UI build).
`verify-desktop.sh --mode served|shell` is the acceptance gate. Beacons +
`grim` + `tesseract` are the on-device evidence tools.
