# moch-link

> **Legacy stable-v1.0.0 tool.** `moch-link` belongs to Moch's linked/relay-only era. The current development build, **1.0.53-beta.3 (versionCode 58)**, embeds Hermes and can run OpenCode inside Moch Linux. Its standard path needs no Moch account, QR pairing, remote relay or remote gateway. Do not use this page as the current on-device setup guide.

One script exposes your **existing** Hermes install to the legacy Moch mobile app through the remote WebSocket relay. It does not install, configure or modify Hermes: it reads your serve token, dials the relay outbound (working behind NAT without router changes) and prints the pairing QR you scan in a stable-era Moch app.

The instructions below are retained for stable **v1.0.0** compatibility and self-hosted relay use. The remote relay is retired from the current product path. Traffic routed through it crosses a network service; this is not a no-network setup.

## Requirements

- Hermes installed (`moch-link` never modifies it)
- `node` and `npm` on PATH (the relay tunnel needs them)
- `hermes serve` running, or `moch-link` can start it as a systemd user unit

## Legacy install

    curl -fsSL https://moch.softland.tech/install.sh | bash

Other commands: `bash install.sh [qr|status|start|stop|uninstall]`.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `MOCH_LINK_RELAY` | `wss://api.moch.softland.tech` | Legacy relay to dial |
| `MOCH_LINK_HOME` | `~/.moch-link` | Where the link lives |
| `MOCH_LINK_ENV` | unset | Environment file sourced before install |
| `MOCH_LINK_PORT` | unset | Hermes serve port |
| `MOCH_LINK_UNIT_PREFIX` | `moch-link` | systemd user unit prefix |
| `MOCH_LINK_NO_DETECT` | unset | `1` skips detecting a running serve |
| `MOCH_LINK_PROXY_PORT` | `9120` | Local host-rewrite proxy port |

## Uninstall

`bash install.sh uninstall` removes the `moch-link` units and `~/.moch-link` — only the link. Your Hermes install, its data and its config are untouched.

For the current local-first product and real first-run flow, see the [repository README](../README.md). For the separate local CDP browser relay used by current builds, see [SECURITY.md](../SECURITY.md).
