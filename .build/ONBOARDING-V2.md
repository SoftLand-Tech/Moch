# ONBOARDING-V2 — the real first-run

Local-only build. Three steps, one screen each: **agent → environment → you**.
No remote pairing anywhere.

## Step 0 — pick the agent backend

`Thinker = 'moch' | 'opencode'` (persisted: `hermes.thinker.v1`).

- **Moch (full hermes)** — the embedded runtime. Everything works: bots, crew,
  browser, terminal, knocks, automations.
- **OpenCode** — the phone's Linux guest runs `opencode serve` on loopback and
  Moch talks to it over its HTTP API (`/api/session`, `/api/event`). Chat works;
  bots / crew / rooms / automations / browser are **hidden or disabled**, with a
  visible chip in chat and a banner in Settings saying which thinker is active.

Rules:
- OpenCode requires the Linux guest (it is the only place a Node/Bun binary can
  run). If the user picks OpenCode with no guest, send them through the Linux
  install first.
- Switching back to Moch must **stop** the OpenCode server and clear its
  session binding; switching to OpenCode must not touch hermes' sessions.
- Never run both thinkers on one chat. A chat's thinker is fixed at creation
  (`session.thinker` in the client store) and shown in its header.

Wire contract (verified against opencode 2.3.0 on the box, OpenAPI at
`/openapi.json`):
- `POST /api/session {title}` → `{data:{id}}`
- `POST /api/session/:id/prompt {text}` → 200 user message (async; stream over SSE)
- `GET /api/event` → SSE; `session.text.delta` / `session.reasoning.delta` /
  `session.tool.called|success|failed` / `permission.asked` /
  `session.execution.started|succeeded|failed` / `session.idle`
- `GET /api/session/:id/message` → history (`assistant.content[]` with
  `{type:'text'|'reasoning'|'tool'}`)
- `POST /api/session/:id/interrupt` → stop
- `POST /api/session/:id/permission/:requestID/reply {reply:'once'|'always'|'reject'}`
- Auth: HTTP Basic, user `opencode`, password from `OPENCODE_PASSWORD`.
- Model: `POST /api/session/:id/model {model:{providerID, modelID}}`;
  default from `GET /api/model/default`.

Install inside the guest:
```
mkdir -p /usr/local/bin
curl -fsSL https://opencode.ai/update/api/latest/cli/opencode/opencode-linux-arm64.tar.gz | tar xz -C /usr/local/bin
opencode --version
```
Then `OPENCODE_PASSWORD=<random> opencode serve --hostname 127.0.0.1 --port 4096`
(supervised in the guest; port bound to loopback, reached through the same
proot bridge the terminal uses — never 0.0.0.0).

## Step 1 — environment + packages

`LinuxInstall` screen:
1. Distro choice (Ubuntu 24.04 / Debian 12 / None). **Keep the existing
   bootstrap** (`linux_env.bootstrap`), with the proot pin fixed.
2. After the base install, a **categorised package picker** — checkboxes, one
   group per category, each item a real apt package (or npm global):
   - **Languages** — nodejs+npm, python3+pip, php, go, rust, java (openjdk-17)
   - **Databases** — sqlite3, postgresql, redis
   - **Build** — build-essential, cmake, git, pkg-config
   - **CLI** — curl, wget, jq, ripgrep, fd-find, tmux, htop
   - **Media** — ffmpeg, imagemagick
   - **Node tools** — typescript, pnpm, yarn (after node)
3. Install runs `apt-get update && apt-get install -y <selected>` inside the
   guest via `linuxExec`, streaming each package's result. Idempotent: an
   already-installed package is `apt` no-op; failures are reported per item,
   never fatal to the whole set.
4. Estimated size and required time shown up front; the screen stays usable if
   the user skips.

Persist the chosen set (`hermes.linux.packages.v1`) so Settings can re-run it
after a reset.

## Step 2 — about you (memory)

One free-text screen, three short prompts:
- "What should Moch call you?"
- "What do you do?" (job / studies)
- "Anything else Moch should remember?" (preferences, languages, timezone)

Writes to the launch profile's `memories/USER.md` — entries joined by `\n§\n`
(exactly what `MemoryStore` reads; do **not** invent another format). New RPC
`moch.profile.about { name?, about?, extra? }` appends entries idempotently
(trim, skip duplicates), never rewrites the file, never touches MEMORY.md.
The same content is what the wizard's "About me" box shows later in Settings.

## Step 3 — think about the existing provider bug

`model.save_key` and `model.disconnect` in the vendored gateway only touch
disk + env; a **live agent keeps its already-built client**, so "change/delete
the key later" kept answering with the old credential until restart. Fix in the
Moch layer (no vendored diff):

`moch.rpc_thinker.install(tg_server)` (flag-gated) wraps `model.save_key` and
`model.disconnect`:
- after the original handler succeeds, iterate `tui_gateway.server._sessions`,
  and for each live session whose agent's provider == the slug:
  - reload the credential pool (`agent.credential_pool.load_pool(provider)`),
  - re-apply the session's current model through the gateway's own
    `session["pending_model_switch"]` path when the session is busy, else
    `agent.switch_model(...)` with the freshly resolved key/base_url,
  - `_emit_session_info` so the chip follows.
- `model.disconnect`: also clear the session's `model_override` and refuse to
  leave an agent pointing at a now-keyless provider (emit a typed error the UI
  shows as "Reconnect a provider").
- If no live session uses the slug, do nothing (no churn).

Contract: a save/delete is **effective immediately** in the open chat, verified
by a test that builds an agent, saves a key, and asserts the agent's client was
rebuilt (fake client factory).

## Screens / files

- `app/app/onboarding/thinker.tsx` — backend choice
- `app/app/onboarding/environment.tsx` — distro + package picker (replaces the
  old `setup.tsx` steps; `setup.tsx` keeps only model + basics and links here)
- `app/app/onboarding/about.tsx` — memory
- `src/lib/thinker.ts` — thinker + OpenCode client
- `src/lib/linuxPackages.ts` — catalogue + install runner
- `src/lib/aboutMe.ts` — USER.md writer (via RPC)
- `python-runtime/moch/rpc_thinker.py` — provider-refresh + about RPC
- `python-runtime/moch/opencode_server.py` — start/stop the guest server,
  health probe, port/password handoff

## Verification

- tsc + eslint on the app; python unittests for `rpc_thinker` (provider refresh)
  and `opencode_server` (argv/port parsing, health).
- On the AWS box: run the guest, install opencode arm64, start serve, assert
  `GET /api/info` over the proot bridge and one round-trip through
  `/api/session/:id/prompt` with the free `iceman-free` model.
- APK build + chunked page refresh as usual.
