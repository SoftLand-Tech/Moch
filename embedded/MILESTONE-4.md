# Milestone 4 — Streaming responses

Status: **verified at the protocol level on host; content-level proof (live
model deltas) is the on-device step — it requires a provider API key, which
this host environment doesn't have.** No new plumbing was needed, as
predicted in MILESTONE-3.md.

## Why streaming came free

The embedded gateway is hermes' real serve server, and Moch's chat UI was
built against exactly that protocol over the relay. The streaming path
already existed end to end:

- Gateway side: `tui_gateway/ws.py:76` defines the streaming event set
  (`message.delta`, `reasoning.delta`, `thinking.delta`) with token
  coalescing + write deadlines on `WSTransport`.
- App side: `src/lib/chat.ts` handles `message.start` → appends a streaming
  assistant message, `message.delta` → queues text into the live buffer,
  `message.complete` → flushes; `session.interrupt` (contracted in
  `tui_gateway/contracts/sessions.py:530`) is the cancel path, already wired
  to the UI's stop control.

Nothing embedded-specific sits in that path: the frames cross the same
loopback WebSocket as every other event.

## Host verification (done)

Full turn lifecycle through the embedded gateway in a clean venv, fresh
`HERMES_HOME`:

```
session.create       -> sid
prompt.submit        -> accepted
agent loop           -> ran: real provider HTTP call attempted
events               -> message.start / ... / message.complete all flowed back
```

The turn produced no delta content because hermes 0.21.3's keyless default
provider tried `z-ai/glm-5.2` on Hugging Face and got HTTP 400
("model does not exist") — an upstream default-model bug, not an embedded
issue. Two useful proofs fell out anyway:

1. **The auth gate works**: an earlier run that collided with the desktop
   hermes-serve on port 9119 was rejected `HTTP 403` on a wrong token.
2. **Turn error propagation works**: the failed turn surfaced as a clean
   `message.complete` with no content — no hang, no crash, the exact shape
   the app's error/attention UI expects.

## On-device acceptance (your test)

1. Pair "This phone", configure a real provider key (any hermes-supported
   provider — the keyless HF default is broken upstream, see above).
2. Send a message: text must appear progressively (deltas), not in one chunk
   after completion.
3. During a long reply, tap stop: the stream must end promptly
   (`session.interrupt`) and the session must accept a new message after.

## Notes / carried items

- The `z-ai/glm-5.2` upstream default bug: fresh keyless installs get an
  immediate failed turn. If it matters for first-run UX, the fix belongs
  upstream; as a local stopgap the Moch UI already funnels users into
  provider-key setup on first send.
- No M4 code changes were required; this milestone is documentation +
  verification. (If your on-device run shows chunky rendering, the suspect
  is the RN WebSocket event loop under debug builds — retest on release
  before touching code.)
