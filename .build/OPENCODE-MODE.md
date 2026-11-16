# OPENCODE-MODE — OpenCode as a first-class thinker (v2 contract)

Build contract for the "OpenCode is a different app surface" slice. Read this
before touching any file listed here. The two transport modules
(`src/lib/opencodeClient.ts`, `src/lib/opencodeChat.ts`) are the **source of
truth**; UI slices consume them, never re-implement the wire.

## Thinker rules

- `thinkerAtom.get() === 'opencode'` gates EVERY branch. Same theme, different
  data: in OpenCode mode nothing may call hermes-only surfaces (bots, crew,
  rooms, automations, browser, hermes model options, hermes projects rail).
- A chat's thinker never changes mid-chat. New chats use the current thinker.
- OpenCode server: guest loopback `http://127.0.0.1:4096`, HTTP Basic
  `opencode:<password>` (`opencodePassword()` from `src/lib/thinker.ts`).
  The phone's RN runtime CAN reach it directly (proot shares the network
  namespace; `usesCleartextTraffic="true"` is set). JSON calls use plain
  `fetch`; the SSE stream uses `fetch` from `'expo/fetch'` (streaming body).

## Wire contract (verified live against opencode 2.3.0)

- `POST /api/session {title}` → `{data:{id,title,...}}`
- `GET  /api/session` → `{data:[{id,title,time:{created,updated},...}]}`
  (newest activity ordering is the caller's job; `time.updated` desc)
- `POST /api/session/:id/prompt {text}` → returns immediately (user message);
  output arrives over SSE.
- `GET  /api/event` → SSE `data: {type, data}` frames. Filter by
  `data.sessionID === ocSessionId`. Event order for one tool call:
  `session.tool.input.started` (has `name`!) → `session.tool.input.ended`
  → `session.tool.called` (`input` object) → `session.tool.progress` (opt)
  → `session.tool.success|failed`. Track tool NAMES from `input.started`
  keyed by `data.id`; `.called` starts the running row; `.success/.failed`
  finish it. Text: `session.text.delta {delta}`. Reasoning:
  `session.reasoning.delta {delta}`. Turn end: `session.execution.succeeded`
  / `session.execution.failed {error}` / `session.idle`. Permission:
  `permission.asked {id, action, resources, message?}`.
- `POST /api/session/:id/interrupt` → stop.
- `POST /api/session/:id/permission/:requestID/reply {reply:'once'|'always'|'reject'}`
- `GET  /api/session/:id/message` → `{data:[...]}` NEWEST FIRST (reverse).
  user: `{type:'user', payload:{text}}`; assistant: `{content:[{type:'text',text}|
  {type:'reasoning',text}|{type:'tool', id,name,state:{status},time}]}`.
- `GET  /api/model` → `{data:[{providerID,modelID,name,capability?...}]}`;
  `GET /api/model/default` → current default; `POST /api/session/:id/model
  {model:{providerID,modelID}}`.
- Integrations (provider auth): `GET /api/integration` → list;
  `POST /api/integration/{integrationID}/connect/key {key}` → connect.
  Free models (e.g. provider `opencode`, model `iceman-free`) need NO key.

## OpenCode thinker = server mode OR one-shot mode

ROOT CAUSE CORRECTED (2026-11-16, on-device A/B tests): the server was
launched via `exec_in_guest` — a THROWAWAY proot per command whose shell
exits right after backgrounding the server. proot traces every guest
process; when the tracer dies, the orphaned tracee's futex syscalls come
back broken and Bun aborts ~30 s later (`The futex facility returned an
unexpected error code`). Proof: the same `opencode serve` survives
indefinitely under a live tracer (an interactive terminal session) and
futex-crashes ~30 s after that session is killed; the one-shot CLI never
orphaned itself, which is why it survived. Earlier "Bun's loop crashes
under proot" testing only ever exercised the throwaway launch. Fix:
`linux_env.spawn_in_guest` starts the server under its own persistent
proot (tracer lifetime == server lifetime, like a terminal session).

One-shot stays as the fallback mode:

- `ocOneShotAtom` (persisted `hermes.opencode.oneshot.v1`) selects the mode.
  Server start failure in onboarding offers "Continue in one-shot mode";
  Settings shows the active mode and can retry server mode.
- Server mode: `runOpencodeTurn` (SSE streaming, permissions, tools).
- One-shot mode: `runOneShotTurn` — one `opencode run --format json [-s id]
  [-m provider/model]` per turn, stdin prompt (base64 pipe, UTF-8 safe).
  JSONL parsed for text/reasoning/session/tools; session id remembered into
  the same AsyncStorage map so `-s` resumes the conversation. No streaming
  (answer lands whole), no interactive permissions, no server history load
  (local transcript persists as usual). Model inventory is `opencode models`
  (CLI); picks persist per chat and ride `-m`.
- Cancellation: flag + guest `pkill -f '[o]pencode run'`; runner owns busy.

## Module contracts (addition)

### `src/lib/opencodeClient.ts` (transport, no UI)
- `ocFetch<T>(path, opts?)` — JSON call, Basic auth, typed error
  `OcError {status, message}`; `OC_BASE` = `http://127.0.0.1:4096`.
- `ocListSessions()`, `ocCreateSession(title)`, `ocHistory(id)`,
  `ocPrompt(id, text)`, `ocInterrupt(id)`, `ocPermissionReply(id, rid, reply)`,
  `ocModels()`, `ocDefaultModel()`, `ocSetModel(id, providerID, modelID)`,
  `ocIntegrations()`, `ocConnectKey(integrationID, key)`.
- `ocStream(handler, signal?)` — SSE pump over `expo/fetch`; `handler(e)`
  with `e = {type, data}`; never throws on normal close, resolves when the
  stream drops (callers own retries/idle timeouts).
- `ocEnsureServer()` — RPC `moch.opencode.ensure` wrapper (gateway rpc).

### `src/lib/opencodeChat.ts` (turn runner + persistence)
- `ocSessionFor(mapKey, title?)` / `ocRememberSession(mapKey, ocId)` /
  `ocForgetSession(mapKey)` — AsyncStorage map `hermes.opencode.map.v1`
  (mapKey = the chat's PERSISTENT handle, hermes storedId in chat.ts, never
  the volatile live sid).
- `runOpencodeTurn({ mapKey, title, text, hooks, isCancelled })`:
  ensures server → ensures oc session → prompt → pump SSE → hooks.
  Resolves when the turn ends (execution.* / idle) or the stream drops
  after a turn-end; a dropped stream WITHOUT a turn-end resolves after a
  15s silence timeout (watchdog) with `complete('', true, 'connection lost')`.
- Hooks (`OcTurnHooks`): `start()`, `text(delta)`, `thinking(delta)`,
  `tool(id, name, phase:'running'|'done'|'failed', preview?, durationS?)`,
  `permission(req)`, `complete(text, failed, error?)`.
- `mapOcHistory(messages)` → `{role,text,ts,tool?}[]` rows for hydration.

## UI slice rules

- chat.tsx: branch the TRANSPORT ONLY. All rendering keeps the existing
  components/atmosphere. OpenCode turns stream through the same
  SessionState atoms via chat.ts's internal reducers passed as hooks.
- Model chip in OpenCode mode: `ocDefaultModel()`/`ocModels()`; picking calls
  `ocSetModel` for the active oc session. NEVER hermes `model.*` RPCs.
- Permission card: reuse the pending-request card visual language; buttons
  Allow once / Always / Deny → `ocPermissionReply`.
- Sidebar in OpenCode mode: rows = OpenCode sessions (title, time.updated);
  hide bots/crew/automations/browser/library sections. Terminal + Settings
  stay.
- Tabs: hide crew, fleet, browser, automations, skills, connectors, inbox,
  agent when thinker is opencode (`href: null` pattern).
- Chat shows a persistent thinker chip: `OpenCode · <modelID>`.

## Copy rules

- "OpenCode" is the product name, always. No "tunnel" wording anywhere.
- Feature reduction is stated positively in onboarding: "Bots, automations
  and the agent browser come with the Moch thinker; OpenCode keeps chat,
  the Linux terminal and its own model picker."
