# The Moch relay

A single Node file that connects Moch phones to their machines. Phones dial
`wss://<your-relay>/api/ws?token=…`; the relay hashes the token, finds the
machine registered with that hash, and splices the two WebSockets together —
it never interprets a frame and stores nothing but token **hashes**.

This is the same code `api.moch.softland.tech` runs. Self-hosting it removes
even the pass-through: the whole stack — app, link, relay — is yours.

## Run your own

Requirements: Node 18+ and the `ws` package.

```sh
mkdir moch-relay && cd moch-relay
curl -fsSL https://raw.githubusercontent.com/SoftLand-Tech/Moch/main/relay/moch-relay-server.js -o moch-relay-server.js
npm init -y >/dev/null && npm install ws
node moch-relay-server.js --port 9591 --host relay.example.com
```

Put nginx (or any TLS terminator) in front of it, forwarding
`/.well-known/` too if you use Let's Encrypt, e.g.:

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

State (registered machines) lives beside the script in `state.json`;
`--state <path>` moves it. `--require-key <key>` switches registration from
open to invite-only (only machines started with your key can register).
`--max-machines-per-ip` / `--max-pending` tune the abuse limits.

## Point moch-link at it

On each machine you link:

```sh
MOCH_LINK_RELAY=wss://relay.example.com \
  curl -fsSL https://moch.softland.tech/install.sh | bash
```

The QR moch-link prints then carries **your** relay's host; the app connects
to it like any other computer address. Health check: `GET /health`.

## Trust model

- The relay sees encrypted-in-transit WebSocket frames and routes by token
  hash — it cannot recover tokens, and it stores no traffic.
- TLS terminates at your nginx if you self-host (or at the official relay's,
  if you use ours) — self-hosting makes every hop yours.
- Lost/forgotten machines: delete `state.json` (or prune entries) and restart;
  every machine re-registers on its next reconnect.
