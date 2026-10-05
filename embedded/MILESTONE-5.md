# Milestone 5 — Tools & filesystem

Status: **host-verified; APK built with the M5 dependency set.** On-device
acceptance is the manual step.

## Workspace model

- New sessions on the embedded gateway are rooted in
  **`files/Moch/workspace`** — hermes treats an explicit, existing `cwd` on
  `session.create` as the session's persistent workspace
  (`tui_gateway/methods_session.py` "explicitly chosen existing workspace").
- `moch/hermes_boot._prepare_home` creates the dir and exports
  `MOCH_WORKSPACE`; `moch.gateway_server.info()` surfaces it; the RN layer
  (`chat.ts embeddedSessionCwd()`) passes `cwd` automatically when the
  active connection is the on-phone gateway. Remote machines are untouched.
- **Security posture**: the Android app sandbox is the hard boundary — the
  hermes process physically cannot read/write outside
  `/data/data/com.hermes.pocket` (kernel-enforced per-UID). Workspace
  rooting keeps its writes tidy; it is not the security perimeter. Broader
  access (SAF grants for user dirs) is a later, explicit feature.

## Known issue: intermittent session.create deadlock (embedded only)

**Symptom**: roughly half of boots, the FIRST `session.create` with a cwd
under HERMES_HOME never answers. The handler completes (verified by
instrumented markers through `after-schedule`), threads are all idle
(faulthandler dump), the WS logs `messages=1, dispatch_crashes=0` — the
response coroutine is suspended forever. Reproducible host-side.

**Ruled out**: os.chdir (deterministic hang — removed), TERMINAL_CWD
(deterministic hang — removed), the M5 dependency pins, the workspace dir
itself. cwd outside the home never hangs; the app flow hangs ~50% of boots.

**Mitigation shipped**: `chat.ts createSessionRpc` — embedded connections
get an 8s timeout and one retry; the abandoned attempt remains a lazy
server-side draft (no DB row until first prompt) and is reaped. Remote
machines are unaffected.

**Follow-up**: root-cause in hermes' dispatch (suspect: response-write race
between the pool worker and the ASGI loop for under-home cwds in hosted
serve mode). Upstream-worthy once minimized.

## M5 dependency additions (all pure-Python except rpds-py)

PyJWT 2.13.0 (dashboard-auth base, no [crypto] extra), Markdown 3.10.2,
croniter 6.0.0 (automations), jsonschema 4.26.0 + **rpds-py 0.30.0 as a
locally built android wheel** (same maturin×NDK×Chaquopy-target recipe as
pydantic-core/jiter), pathspec 1.1.1, ptyprocess 0.7.0 (terminal tool can
at least attempt PTYs on-device), wcwidth 0.6.0.

Deliberately NOT added (documented gaps): Pillow/pillow-heif (native; image
attach + vision tools will fail until an android wheel is built — the next
native-wheel task), mcp+httpx2 (MCP), anthropic SDK (native-provider path),
portalocker/mutagen (MCP loop / voice-note metadata), tiktoken (CLI-only
usage in tree), fire/prompt_toolkit/setproctitle (CLI-only).

## Tool compatibility matrix (updated)

| Feature | Status | Evidence |
| --- | --- | --- |
| Agent loop / LLM APIs | ✅ on-device (user-verified M3/M4) | — |
| Streaming + interrupt | ✅ protocol-verified; device pending final check | M4 |
| Files (read/write/edit/list) | expected works; workspace-rooted | tools.list present host-side |
| Memory / skills / tool_search | expected works | deps pinned; device test |
| Cron/automations | expected works in-process | croniter pinned |
| Shell | degrades (no binaries in sandbox) | ptyprocess present; verdict at device test |
| PTY | unknown → device test | ptyprocess present |
| Browser automation / Docker | blocked (documented) | no chromium/daemon in sandbox |
| Vision (image attach) | ❌ until Pillow android wheel | known gap |
| MCP | deferred | deps not shipped |
| Background tasks | M6 | FGS |

## On-device acceptance

1. Install, pair "Use this phone", start a NEW chat.
2. Ask the agent: *"create a file hello.txt with the text 'hi from moch',
   then read it back"* — both tool calls should stream and succeed; the file
   lands in `files/Moch/workspace/`.
3. Automations tab: create a trivial scheduled job (croniter path).
4. Skills tab: list loads.
5. Image attach: expected to fail with a PIL error — known gap, don't report
   as new.

## Files changed

`moch/hermes_boot.py` (workspace + MOCH_WORKSPACE), `moch/gateway_server.py`
(workspace in info), `chat.ts` (embeddedSessionCwd + createSessionRpc retry),
`hermesRuntime.ts` (workspace field), `requirements-embedded.txt` (+8),
`embedded/build-android-wheels.sh` (+rpds-py), `app/wheels-android/` (+rpds
wheel), vendored `methods_session.py` restored pristine after debugging.
