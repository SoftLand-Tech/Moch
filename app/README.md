# Moch Android app

**Moch — your agent runs on your phone. Your model is your choice.**

**Website:** <https://moch.softland.tech>

Moch is an open-source Android AI workspace built with Expo 57 and React Native. Hermes runs embedded by default; OpenCode can run inside the optional Moch Linux Ubuntu guest. The standard current CI path needs no Moch account, Moch relay or remote gateway.

The current development build is **1.0.53-beta.3, versionCode 58**. Stable **v1.0.0** is a legacy linked/relay-only build without the embedded runtime or OpenCode.

The canonical product contract is in [`PRODUCT.md`](../PRODUCT.md). For the first-run walkthrough, see the [repository README](../README.md) or the [setup guide](https://moch.softland.tech/setup.html).

## How the current app runs

- **Embedded Hermes is the default.** Moch starts a Hermes control plane and loopback gateway on the phone. The app includes the embedded Python runtime and vendored Hermes tree; it is not only a client for a machine elsewhere.
- **OpenCode is optional.** Moch downloads OpenCode from [opencode.ai](https://opencode.ai) into Moch Linux on first selection, then runs it in the Ubuntu/proot guest. OpenCode is not the default thinker and Moch is not the official OpenCode app.
- **You choose the model provider.** Connect a hosted provider or a compatible local model endpoint. Provider accounts, keys and charges are separate from Moch.
- **Stable v1.0.0 keeps the legacy linked flow.** The stable-era QR and WebSocket gateway instructions are documented below for existing v1.0.0 users; current CI builds use the on-device path.

### Network truth

Local-first means the agent/control plane and your workspace live on the phone. Hosted models, OpenCode's free hosted models, Linux/OpenCode downloads, package installation, model catalogs, OTA updates, Expo/FCM push registration, web browsing, web search, remote MCP servers and terminal commands may use the internet. No local model weights are bundled.

OpenCode's free hosted models need no key or account, but they are hosted rather than on-device. Connect a local model for on-device inference.

## First run

1. **Environment:** install Ubuntu 24.04, the default Moch Linux guest, or skip it. OpenCode requires the guest; Hermes can run without it.
2. **Thinker:** choose **Moch (Hermes)**, the default, or **OpenCode**, the optional coding-agent thinker.
3. **Providers:** configure Hermes or OpenCode with a hosted provider or local model.
4. **About you:** finish the profile, notification and battery-permission steps.

Existing chats keep the thinker they were created with. Switching thinker affects new chats.

## Features

### Shared product surfaces

- Streaming chat with thinking and tool activity, subject to thinker differences.
- Projects, multiple sessions, session history and project working directories.
- Terminal tabs and browser control with human takeover.
- Provider/model selection and local notifications.
- English, Arabic with RTL, Chinese and French.
- OTA JavaScript updates and Android CI APK releases.

### Hermes-only surfaces

Hermes mode adds Fleet/bots, Crew, Automations, Skills, Connectors and Inbox. These surfaces are hidden in OpenCode mode. Local automation notifications depend on the runtime or process surviving; they are not guaranteed after the system stops it.

### OpenCode limits

OpenCode mode keeps Chat, Projects/OpenCode sessions, Terminal, Browser and Settings. Its reduced one-shot fallback has no token streaming or interactive permission cards.

## Requirements

- For the current local-first experience, use the current CI beta APK or a native Android development build.
- For source development: Node.js and npm. Expo SDK 57's documented runtime is Node 22.13.x.
- A hosted model provider or compatible local model endpoint for inference.
- Moch Linux is optional for Hermes and required for OpenCode.

No iOS release is currently offered.

### Expo Go is not the current beta app

Expo Go cannot provide the native embedded-runtime bridge. It may load parts of the interface, but it is not equivalent to the current CI beta APK and must not be used to verify the current local-first runtime. Use `npx expo run:android` or a CI APK for that.

Release builds require `android/keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Keep the keystore outside the repository. Debug builds use the standard Android debug keystore; EAS builds inject their own signing credentials.

## Development

```sh
npm install
npm start
npx expo run:android   # native development build
npm run web            # browser preview; not the embedded-runtime release path
```

### Main scripts

| Script | What it does |
| --- | --- |
| `typecheck` | TypeScript checks for the app and scripts projects. |
| `lint` | ESLint checks. |
| `test` | Protocol tests against a fake v7 gateway; no live server needed. |
| `test:imports` | Loads the app's module graph in a test harness. |
| `test:chatlist` / `test:slash` / `test:interactive` | Offline sidebar, command and picker tests. |
| `test:gateway-logic` / `test:pairing` / `test:relay` | Offline gateway, pairing and transport tests. |
| `test:session-recovery` | Offline session-recovery tests. |
| `test:live` / `test:order` | Live suites that require a reachable Hermes gateway. |
| `verify` | Full gate, including live suites; not a docs/site verification command. |
| `pair` / `watch` | Legacy gateway pairing and remote-push helpers. |

For an offline contribution check:

```sh
npm run typecheck
npm run lint
npm run test
npm run test:gateway-logic
npm run test:pairing
npm run test:relay
npm run test:session-recovery
```

The live suites read the dashboard token from `~/.config/hermes-serve.env` and connect to `ws://127.0.0.1:9119`. They create and delete their own sessions. See the script sources before running them against a gateway you care about.

## Legacy gateway compatibility: stable v1.0.0

This section preserves the linked/relay-era setup for existing Hermes machines. It is not required by current CI builds, which boot the embedded on-device gateway.

The app speaks Hermes gateway JSON-RPC **v7** over `ws(s)://<gateway-host>:<port>/api/ws`, plus the dashboard REST audio endpoints. Pairing needs an address, a dashboard session token and a TLS choice.

The token convention used by the repository's helpers is `~/.config/hermes-serve.env` on the gateway host:

```sh
HERMES_DASHBOARD_SESSION_TOKEN=<token>
```

The same token authenticates the WebSocket query parameter and the `X-Hermes-Session-Token` REST header. Pass the real gateway port explicitly; helper defaults differ.

### Print a legacy pairing QR

```sh
# LAN (plain ws):
./scripts/hermes-pair.sh --host <gateway-host> --port <gateway-port> --token <token>

# Tailnet or public host (wss):
./scripts/hermes-pair.sh --host <gateway-host> --port <gateway-port> --token <token> --tls
```

The helper reads `HERMES_DASHBOARD_SESSION_TOKEN` or `HERMES_TOKEN` when `--token` is omitted. It prints the connection summary, `hermes://connect` link and manual values. An ASCII QR appears when `qrcode` or `qrencode` is available.

On **stable v1.0.0**, open Moch and scan the QR, paste the `hermes://connect` link or enter the host, token and TLS setting manually. This QR/paste/manual pairing flow is for stable v1.0.0, not current CI builds. Pairing tokens are stored with `SecureStore`, with an AsyncStorage fallback where SecureStore is unavailable.

### Away from home Wi-Fi

A legacy linked gateway must be reachable from the phone. Use the machine's LAN address on the same network, or a VPN/tailnet with TLS away from home. The remote WebSocket relay used by stable v1.0.0 is a separate retired product path; see [`../moch-link/README.md`](../moch-link/README.md) and [`../relay/README.md`](../relay/README.md).

### Local alerts and optional remote push

Local alerts cover approvals, questions and replies while the runtime/process and connection survive in the background. They are not an app-killed delivery guarantee, and they do not require a gateway watcher.

Current builds still register an Expo/FCM push token. That registration is separate from local alerts and does not make the watcher below part of the current on-device path.

The watcher flow is legacy linked-gateway infrastructure for optional remote delivery when the app is closed. It requires an EAS-linked build and push credentials, plus a watcher on the gateway machine:

```sh
./scripts/hermes-push-watch.sh \
  --host 127.0.0.1:<gateway-port> \
  --token <token> \
  --push-token 'ExponentPushToken[xxxx]'
```

The watcher polls the gateway's replay ring and forwards events through Expo Push. Its default port is `9119`; pass the real gateway address.

## Source layout

- `app/` contains Expo Router routes.
- `src/` contains gateway, chat, session, model, voice, pairing and notification logic.
- `src/protocol/` contains the v7 JSON-RPC/WebSocket client.
- `android/` contains the native bridge, embedded-runtime integration and local CDP browser relay.
- `python-runtime/` contains the embedded Python/fleet runtime.
- `hermes-src/` contains the vendored Hermes tree.
- `wheels-android/` contains the Android Python wheels.
- `scripts/` contains development, pairing and test helpers.

## License

[MIT](LICENSE)
