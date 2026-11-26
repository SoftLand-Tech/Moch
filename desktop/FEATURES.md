# Moch Desktop feature map

Moch Desktop is **Hermes-only**. It uses a local Hermes control plane and does not integrate OpenCode. No Moch account, pairing flow, Moch relay or remote gateway is required.

Local control plane does not mean offline: hosted providers, downloads, package installation, web browsing, web search, remote MCP servers and terminal commands may use the internet. Providers may require accounts, API keys or payment.

## Architecture

| Area | How |
|---|---|
| Hermes runtime | `desktop/runtime/moch_desktop` boots the vendored `app/hermes-src` tree and the `app/python-runtime/moch` fleet runtime with desktop adaptations. |
| Local control plane | The app spawns or adopts its own gateway on `127.0.0.1` with a dedicated Hermes home. First-run import from `~/.hermes` copies provider configuration locally. |
| No remote relay | There is no pairing UI or remote relay code path. The desktop is the machine running Hermes. |
| State-file adoption | The webview adopts a warm gateway between window re-opens through the desktop runtime state file. |
| Bot-first UI | Four-zone desktop shell (icon rail / context column / focus / stage pane) in the Mocheme palette. |
| Shared agent browser | A dedicated headless Chromium is driven over local CDP by both the user and Hermes, with screencast, input forwarding and takeover. |
| Provider/network boundary | The runtime stays local, while model providers and network-enabled tools send requests over the internet when used. Connect a local model endpoint for on-device inference. |

## Hermes feature map

| Feature | Desktop form | Verification status |
|---|---|---|
| Streaming chat and thinking | v7 event stream, collapsible Thinking with elapsed seconds, Markdown on completion, copy/listen | Verified with a live model |
| Multi-session and attention badges | Sidebar with pin/archive/delete/rename, busy dots and live/stored ID bridging | Verified session list and resume |
| Approvals, clarification, sudo and secret cards | Shared interactive cards inline in chat and in a unified Inbox | Verified approval flow |
| Fleet/bots | Fleet roster home, setup checklist, SOUL editor, provider mirror, freeze/delete, in-character bot chat and recent runs | Verified bot creation and reply |
| Crew board | Four-column kanban and run ledger; tasks dispatch to FleetWorker | Verified dispatch and completion |
| Automations | Plain-language schedules, run-now/pause/edit/delete and local outcome notifications | Verified scheduled job creation |
| Agent browser | Shared Chromium with CDP screencast and agent tools | Verified live browser pane |
| Terminal | Native host PTYs with multiple xterm sessions, Stage dock and workspace working directory | Verified end-to-end shell input |
| Skills and slash commands | Gateway-driven catalog and `/` popup; `/model` opens the picker | Verified live catalog |
| Connectors | Provider key management plus remote MCP server management | Verified provider list; remote MCP may use the network |
| Voice out | TTS through the gateway and shell proxy | Verified audio playback |
| Voice in | MediaRecorder to gateway transcription, reviewed before sending | Needs a real microphone test |
| Media attachments | Drag-drop and clipboard paste, proxied upload and agent-readable files | Verified file attachment |
| Share-in | Desktop drag-drop and paste into the composer | Verified |
| Mochi mascot | Greeting, thinking and connecting states | Verified rendering |
| English and Arabic | Settings picker with Arabic RTL layout | Verified live Arabic layout |
| Notifications | Inbox transitions and automation outcome watcher | Code paths verified; permission prompt required |
| Media delivery | Inline images/audio/video and file cards with reveal/copy-path | Verified image decoding |
| Multi-computer pairing and remote relay | Deliberately absent: the desktop runs Hermes locally | Not applicable |
| OTA app updates | Not applicable: AppImage distribution | Not applicable |
| Camera and QR | Not applicable: nothing to pair | Not applicable |

## Desktop additions

Stage pane (dockable Terminal/Browser beside chat), command palette, view shortcuts, one shared agent browser, links that open in it, network-status display, reconnect with backoff, error boundary and AppImage packaging.

## Verification notes

The historical click-through plan is in [`TEST-PLAN.md`](TEST-PLAN.md). The table above records observed checks; it does not claim benchmark results or independent certification.
