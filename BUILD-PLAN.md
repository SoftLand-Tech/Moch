# BUILD-PLAN — Moch Browser (feat/browser)

Spec: `FEATURE-BROWSER.md` + `research/` (copied into this worktree). This file
is the build contract and milestone tracker for the branch.

## Architecture decisions (and where they differ from / sharpen the spec)

1. **The CDP relay is Kotlin, not Chaquopy.** The spec's risk #1 was "abstract
   socket connect from Chaquopy unverified". Deleted: `LocalSocket` with
   `Namespace.ABSTRACT` is a documented Android API — the relay connects to
   `webview_devtools_remote_<pid>` from Kotlin (same UID ⇒ SO_PEERCRED passes),
   and Python only ever sees ordinary loopback TCP. B0's unknown is gone.
2. **Zero-patch attach for the common path.** The relay filters `/json/list`
   to the ACTIVE tab only (URL-matched, single-target fallback), so stock
   hermes "attach first page target" lands on the right tab. Tab lifecycle is
   RN-owned (spec-mandated; CDP can't create WebView targets anyway).
3. **Guarded per-page fallback.** WebView may not serve a browser-level target
   (`Target.getTargets`/`attachToTarget`). `_attach_initial_page` gains an
   automatic fallback: if the browser ws path fails/empty, connect the FIRST
   page-target ws from `/json/list` directly (the supervisor already omits
   `sessionId` when none — frames stay valid). Both paths are PC-testable
   against real Chromium (force the fallback with `MOCH_BROWSER_FORCE_PER_PAGE=1`).
4. **Auth by path-prefix token** (`/moch-<token>/...`) because
   `_resolve_cdp_override` builds URLs that cannot carry a query string, and
   `requests` cannot add headers. The token is generated once by Kotlin into
   `<hermesHome>/browser/relay.json` (with the port) — stable per install,
   no dependency on gateway boot order.
5. **Vendored diff is ~40 lines / 3 files** (boot env, install-gate branch,
   supervisor fallback). Everything else is additive app code. Additive per
   the spec's rollback promise: delete the flag/files and the feature vanishes.

## Components

| File | Kind | What |
|---|---|---|
| `android/.../hermes/CdpRelay.kt` | new KT | loopback HTTP+WS relay → abstract devtools socket; /json/list filter+rewrite; token prefix; byte-pump upgrades |
| `android/.../hermes/BrowserRelayModule.kt` (+Package) | new KT | RN surface: relay start/stop/status, activeUrl sync |
| `MainApplication.kt` | +1 line | register BrowserRelayPackage |
| `python-runtime/moch/hermes_boot.py` | +18 py | read relay.json → `BROWSER_CDP_URL` before run_agent import. This ALSO satisfies the tool gate for free: `check_browser_requirements` returns True whenever the CDP override env is set (verified `browser_tool_install.py:307`) — no install-gate patch needed |
| `hermes-src/tools/browser_supervisor.py` | +50 py | proactive Moch-Browser-Level probe → sessionless per-page attach (the ONLY vendored diff) |
| `src/lib/browserRelay.ts` | new TS | bridge accessor + relay ensure + tab store (nanostores) |
| `app/(tabs)/browser.tsx` | new TSX | Browser screen: tab strip, WebView pool (all attached, inactive 0-size), URL bar, Ask-Moch |
| `app/(tabs)/_layout.tsx`, `Sidebar.tsx` | wire | route + drawer entry |
| `chat.tsx` | +few | Ask-Moch prefill (shareIn pattern, never auto-sends) |

## Milestones

- [x] B0a — Kotlin relay implemented — `compileReleaseKotlin` BUILD SUCCESSFUL
- [x] B0b — PC proof, path 1 (per-page attach through the relay's exact wire
      contract — mock relay + real Chromium): sessionless attach, navigate,
      refs snapshot, click-by-ref (state change verified), type-by-ref,
      screenshot → file. `research/browser-proof/run_proof.py` — ALL PASSED
- [x] B0c — PC proof, path 2 (stock browser-level attach): regression clean,
      byte-identical behavior (`Moch-Browser-Level` absent ⇒ stock path)
- [x] B1 — Browser screen (tab strip, WebView pool, relay lifecycle, drawer,
      Ask-Moch prefill through the shareIn inbox)
- [x] B1b — `assembleRelease` green — app-release.apk (87 MB) built with CdpRelay + BrowserRelayModule + modified vendored tree
- [x] B2-lite — snapshot-driven agent loop: full browser toolset routed
      in-process (webview backend = `tools/browser_webview.py`; no agent-browser
      CLI subprocess anywhere in this mode — the on-device executor)
- [ ] DEVICE — physical runbook written (`research/browser-proof/TEST-ON-DEVICE.md`);
      needs the phone on adb — next session with the device attached.

## Honest v1 limits (from the spec, kept)

- Agent binds the ACTIVE visible tab only; SPA-URL-mismatch falls back to
  "exactly one target" (degraded, documented).
- Browser tools require the Browser screen open (WebViews alive); closed
  screen ⇒ structured "no page targets" error.
- No CAPTCHA UX, no domain policy engine, no confirmation cards yet (B3).
- No background/screen-off tasking (B4). Cookies persist via CookieManager;
  explicit flush() on pause is B1 polish.
