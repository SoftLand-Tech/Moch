# The Moch relay

> **Legacy remote relay for stable v1.0.0.** This WebSocket relay belongs to Moch's linked/relay-only release. The current development build, **1.0.53-beta.3 (versionCode 58)**, embeds Hermes and can run OpenCode inside Moch Linux; its standard path needs no remote relay or remote gateway. Do not use this page as the current on-device setup guide.

The instructions remain for stable-era compatibility and self-hosting. The remote relay is retired from the current product path. It is unrelated to the local loopback CDP relay that lets current on-device agents control Moch's WebView; see [SECURITY.md](../SECURITY.md).

## What the legacy relay did

A single Node file connected Moch phones to their machines. Phones dialed `wss://<your-relay>/api/ws?token=…`; the relay hashed the token, found the machine registered with that hash and spliced the two WebSockets together. It was designed not to interpret frames and to store only token hashes, not traffic.

This is the code formerly used by `api.moch.softland.tech`. Self-hosting kept the relay hop under the operator's control; it did not make the setup on-device.

## Run your own legacy relay

Requirements: Node 18+ and the `ws` package.

```sh
mkdir moch-relay && cd moch-relay
curl -fsSL https://raw.githubusercontent.com/SoftLand-Tech/Moch/main/relay/moch-relay-server.js -o moch-relay-server.js
npm init -y >/dev/null && npm install ws
node moch-relay-server.js --port 9591 --host relay.example.com
```

Put nginx (or any TLS terminator) in front of it, forwarding `/.well-known/` too if you use Let's Encrypt, e.g.:

```nginx
location / {
  proxy_pass http://127.0.0.1:9591;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
}
```

State (registered machines) lives beside the script in `state.json`; `--state <path>` moves it. `--require-key <key>` switches registration from open to invite-only (only machines started with your key can register). `--max-machines-per-ip` / `--max-pending` tune the abuse limits.

## Point legacy moch-link at it

On each machine you link:

```sh
MOCH_LINK_RELAY=wss://relay.example.com \
  curl -fsSL https://moch.softland.tech/install.sh | bash
```

The QR printed by legacy `moch-link` carries your relay's host; a stable-era app connects to it like another computer address. Health check: `GET /health`.

## Trust model

- The relay is a network hop. Client-to-relay traffic uses TLS, and the relay routes by token hash; it is not an on-device control plane.
- The design stores registration token hashes rather than traffic. That storage policy is not an independent privacy audit.
- TLS terminates at your nginx if you self-host (or at the legacy official relay's terminator if you used it).
- Lost or forgotten machines: delete `state.json` (or prune entries) and restart; each machine re-registers on its next reconnect.

For the current local-first product, see the [repository README](../README.md).
