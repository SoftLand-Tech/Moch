# Moch

**Moch — your agent runs on your phone. Your model is your choice.**

An open-source AI workspace with Hermes built in and OpenCode inside an optional Ubuntu Linux guest. No Moch account, relay or remote gateway required.

[![Current CI beta: 1.0.53-beta.3, versionCode 58](https://img.shields.io/badge/dev-1.0.53--beta.3-8250DF)](https://github.com/SoftLand-Tech/Moch/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform: Android](https://img.shields.io/badge/platform-Android-3DDC84)](https://moch.softland.tech/Moch.apk)

**[Download the current beta](https://moch.softland.tech/Moch.apk)** · [Setup guide](https://moch.softland.tech/setup.html) · [Build history and checksums](https://github.com/SoftLand-Tech/Moch/releases)

## Local-first, honestly

Local-first means the agent and your workspace live on the phone. Hosted models, OpenCode's free hosted models, downloads, OTA updates, web browsing and optional services can still use the internet. Connect a local model for on-device inference.

The standard current CI path boots an embedded loopback gateway on the phone. It does not need a Moch account, a Moch relay or a remote gateway. Model providers are a separate choice: they may require their own accounts, API keys or payment. No local model weights are bundled.

## Set up on your phone

1. **Download the current beta.** Use the button above, or choose a current `ci-*` pre-release from [GitHub Releases](https://github.com/SoftLand-Tech/Moch/releases). The current development build is **1.0.53-beta.3, versionCode 58**.
2. **Open the app and choose an environment.** Ubuntu 24.04 is the default **Moch Linux** guest: a little Ubuntu computer inside the app. You can skip Linux, but OpenCode needs it. Hermes can run without the guest.
3. **Choose a thinker.** A thinker is the brain that answers. **Moch (Hermes)** is the default. **OpenCode** is an optional coding-agent thinker that Moch downloads from [opencode.ai](https://opencode.ai) into Moch Linux on first selection.
4. **Connect a provider or local model.** Hermes can use a hosted provider with your key or a compatible local endpoint. OpenCode can use its free hosted models, another hosted provider or a local model. OpenCode's free hosted models need no key or account, but they use the network.
5. **Finish the About you steps**, then review notification and battery settings and start chatting.

Expo Go is not equivalent to the current CI beta APK: its native embedded-runtime bridge is unavailable. No iOS release is currently offered.

## Choose your thinker

### Moch (Hermes): the default

Hermes runs embedded in the app and provides the broader Moch feature set: chat, projects, Fleet/bots, Crew, Automations, Skills, Connectors, Terminal, Browser and Inbox.

### OpenCode: optional inside Moch Linux

OpenCode runs inside the optional Ubuntu/proot guest, with its own on-device control plane. It is a selectable thinker, **not the default** and **not the official OpenCode app**. It is integrated rather than bundled in the APK; Moch downloads it into Moch Linux on first use.

OpenCode mode keeps Chat, Projects/OpenCode sessions, Terminal, Browser and Settings. Hermes-only surfaces such as Fleet, Crew, Automations, Skills, Connectors and Inbox are hidden. Its reduced one-shot fallback has no token streaming or interactive permission cards.

Existing chats keep the thinker they were created with. Switching thinker affects new chats.

## Current build and stable release

- **Current development build:** **1.0.53-beta.3, versionCode 58**. Current CI builds contain the embedded Hermes runtime and can run OpenCode inside Moch Linux. CI publishes Android APKs as pre-releases, and the website's `/Moch.apk` points to the current beta.
- **Stable release:** **v1.0.0** is a legacy linked/relay-only build. It does not contain the embedded runtime or OpenCode. Do not present it as the current local-first download.
- **Beta status:** current CI features can change between builds. Check the release notes for the exact build you install.

## Features

- **Streaming chat with thinking and tool activity** — replies, reasoning blocks, approvals and session history, with details that vary by thinker.
- **Projects and multiple sessions** — keep conversations and project working directories together.
- **Terminal tabs and Moch Linux** — Ubuntu 24.04 under proot inside the app, with package installation, compilers and servers available on-device.
- **Browser control and human takeover** — the agent can work in the visible browser while you keep control.
- **Hermes-only automation surfaces** — Fleet/bots, Crew, Automations, Skills, Connectors and Inbox are hidden in OpenCode mode.
- **Four app languages** — English, Arabic with RTL, Chinese and French.
- **Local notifications and OTA JavaScript updates** — local notification delivery depends on the runtime or process surviving; OTA and other network features still use the internet.

## What is in the repository

| Path | What it is |
| --- | --- |
| [`app/`](app/) | The Expo 57 React Native Android app, embedded CPython runtime, vendored Hermes tree, Android wheels, Kotlin bridge, Moch Linux/proot environment and optional OpenCode integration. |
| [`desktop/`](desktop/) | An experimental **Hermes-only** desktop workspace with its own local control plane. It does not integrate OpenCode. |
| [`embedded/`](embedded/) | Design notes and historical milestone reports for the embedded runtime and Moch Linux. |
| [`moch-link/`](moch-link/) | Legacy installer for linking an existing Hermes install to the stable-v1.0.0 relay path. |
| [`relay/`](relay/) | Legacy remote WebSocket relay used by stable-v1.0.0 linked setups. It is not part of the standard current CI path. |
| [`docs/`](docs/) | Static website source, served at [moch.softland.tech](https://moch.softland.tech). |

## Development

The Android app uses Node.js and npm. Expo SDK 57's documented runtime is Node 22.13.x.

```sh
cd app
npm install
npm run typecheck
npm run lint
npm test            # protocol tests against a fake gateway
```

Use a native development build rather than Expo Go when testing the embedded runtime. The website in `docs/` is static HTML/CSS/vanilla JavaScript with no build step. The served installer at [`docs/install.sh`](docs/install.sh) must stay byte-identical to [`moch-link/install.sh`](moch-link/install.sh). See [`app/README.md`](app/README.md) for app scripts, legacy gateway compatibility and test requirements.

## Legacy stable v1.0.0: moch-link and QR pairing

This section is only for the stable **v1.0.0** linked/relay-era setup. Current CI builds run on-device and do not use this QR flow.

1. On the Linux machine that already runs Hermes:

   ```sh
   curl -fsSL https://moch.softland.tech/install.sh | bash
   ```

   `moch-link` does not install, configure or modify Hermes. It reads the serve token, starts `hermes serve` if needed, dials the legacy remote relay outbound and prints a pairing QR. You need `node` and `npm` on PATH.

2. On your phone, download **Moch 1.0.0** from the [stable v1.0.0 release](https://github.com/SoftLand-Tech/Moch/releases/tag/v1.0.0). This is the legacy APK, not the current local-first beta.

3. Scan the QR printed by the installer. To print it again, run `bash install.sh qr` in the `moch-link` directory.

The legacy relay carries traffic between the phone and the machine and stores registration token hashes. It is a network hop, not a no-network setup, and it is retired from the current product path. Historical instructions and environment overrides remain in [`moch-link/README.md`](moch-link/README.md); self-hosted relay instructions remain in [`relay/README.md`](relay/README.md).

If you are rebuilding a stable-era machine from scratch, first install Hermes from its upstream project:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Then run `hermes` once to configure its provider and tools, and use the legacy `moch-link` command above. The [setup guide](https://moch.softland.tech/setup.html) also keeps legacy instructions separate from the current on-device path.

## Credits and license

- The Moch app and this repository's packaging are **MIT, © 2026 Mamoun Hisham** — see [LICENSE](LICENSE).
- Moch integrates [Hermes](https://github.com/NousResearch/hermes-agent) by Nous Research (MIT).
- OpenCode is a separate optional project from [opencode.ai](https://opencode.ai); Moch is not the official OpenCode app.

Issues and pull requests are welcome.
