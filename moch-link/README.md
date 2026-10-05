# moch-link

One script that exposes your **existing** hermes install to the Moch mobile app
through the official relay (`api.moch.softland.tech`). It does not install,
configure or modify hermes — it reads your serve token, dials the relay
outbound (works behind any NAT, no router config), and prints the pairing QR
you scan in the Moch app.

## Requirements

- hermes installed (moch-link never touches it)
- `node` and `npm` on PATH (the relay tunnel needs them)
- `hermes serve` running — or moch-link starts it for you as a systemd user unit

## Install

    curl -fsSL https://moch.softland.tech/install.sh | bash

Other commands: `bash install.sh [qr|status|start|stop|uninstall]`.

## Environment overrides

| Variable                | Default                        | Purpose                              |
|-------------------------|--------------------------------|--------------------------------------|
| `MOCH_LINK_RELAY`       | `wss://api.moch.softland.tech` | relay to dial                        |
| `MOCH_LINK_HOME`        | `~/.moch-link`                 | where the link lives                 |
| `MOCH_LINK_ENV`         | unset                          | env file sourced before install      |
| `MOCH_LINK_PORT`        | unset                          | hermes serve port                    |
| `MOCH_LINK_UNIT_PREFIX` | `moch-link`                    | systemd user unit prefix             |
| `MOCH_LINK_NO_DETECT`   | unset                          | `1` skips detecting a running serve  |
| `MOCH_LINK_PROXY_PORT`  | `9120`                         | local host-rewrite proxy port        |

## Uninstall

`bash install.sh uninstall` removes the moch-link units and `~/.moch-link` —
only the link. Your hermes install, its data and its config are untouched.
