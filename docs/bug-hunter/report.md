# Bug-Hunter Audit Report — Moch (round 1)

**Repository:** https://github.com/SoftLand-Tech/Moch · **Commit:** `3191fe154af7c5b7ed8b87b03412e7bbe94ecb5b` (branch `feat/browser-always-available`, = open PR #61 head)
**Audit window:** 2026-10-12T00:20:49Z → 2026-10-12T00:50:00Z (UTC) · **Working tree:** user's uncommitted versionCode bump preserved untouched; nothing in the repo was modified by the audit (read-only + test-suite runs only).
**Method:** 5 parallel GLM-5.3-Flash investigation agents (A logic, B runtime/integration, C security, D tests/reproduction, E GitHub) + independent challenger (run twice with consistent verdicts) + coverage gap-pass agent + lead verification passes. All raw outputs: `docs/bug-hunter/raw/`.

## Headline numbers

| | |
|---|---|
| Findings recorded | **60** (89 append-only events in `findings.jsonl`) |
| Severity | 10 high · 26 medium · 21 low · 3 informational · 0 critical |
| Status | 44 confirmed · 6 needs-verification · 6 open (known, unresolved) · 3 fixed (awaiting device check) · 1 rejected |
| Verification | 12 findings independently lead-verified; challenger upheld 25/26 challenged (rejected 1); all 14 TS test suites + 10 Python unittest files executed |
| GitHub | 0 issues exist (exhaustive, API-verified); 61 PRs; this checkout is open PR #61's head — BUG-132's fix is present locally but **not on main** |

## Confirmed high-severity (act first)

| ID | Bug |
|---|---|
| BH-000046 | **dataSync foreground service with no `onTimeout` — Android 15+ kills the always-on runtime after 6h/24h** (`HermesService.kt`, manifest:39; START_STICKY can't beat the rolling quota). The "agent in your pocket" premise dies on modern devices. |
| BH-000018 | **`inflightCreate` shared across provisional windows** — a send in a second new-chat window lands in the first window's session (`chat.ts:1184`, race; challenger- and lead-verified mechanism). Shares a root cause with BH-000019. |
| BH-000019 | **Offline send composed in a new-chat window is delivered to whichever chat is active at flush** (`chat.ts:1756-1758` ignores `pinned`; confidence raised to high by challenger). |
| BH-000020 | **BUG-036 at HEAD: 120s timeout double-submit — and `flushOutbox` automates the duplicate** on the next reconnect flush (no idempotency key on `prompt.submit`). |
| BH-000021 | **BUG-086 at HEAD: approvals for sessions started elsewhere (automation/CLI/other device) are unanswerable — no card, no dot, until backend deadline.** |
| BH-000033 | **BUG-132: browser tools absent from the callable kit after cold start.** All four shipped arming fixes are present and consistent in this checkout, but the tracker's round-34 root cause (6-tool deferred kit / toolset selection under empty config) is untouched, the fix is unmerged (PR #61 open), and E2E acceptance is pending. |
| BH-000027 | **`test:order` is mislabeled offline — dials a live gateway and tests a local mirror**, not `sessionList.ts`; can stay green while shipped sorting diverges. |
| BH-000028 | **17 `src/lib` modules have no test suite** — incl. `gateway.ts` reconnect state machine (historically the richest URGENT-bug source), `mediaSend`, `push` (509 lines), `pairing.parseConnectUrl`. |
| BH-000029 | BUG-132's native fixes (122d6bf, 0155696) have **zero test coverage** at any level. |
| BH-000017 | BUG-133 (known, WIP): keyboard opens over inputs app-wide. |

## Security findings (all preconditions stated; none exploited)

Confirmed (challenger-upheld, medium): **BH-000034** relay `/control` authenticates machines by tokenHash knowledge alone (hash leak ⇒ machine-slot takeover while legit machine offline); **BH-000035** raw pairing token rides URL query strings on both relay legs — nginx access-log exposure, and the relay's "never sees the token" comment is demonstrably false (header transport already exists in-repo for REST); **BH-000036** open relay registration by default + never-reaped idle control sockets + unauthenticated `/health`; **BH-000037** release builds silently fall back to the **tracked** `debug.keystore` (stock RN template default — fail the build instead); **BH-000008** (known BUG-120, device-proven) loopback gateway token reachable by any on-device app — impact amplified to full guest-shell access.
Lower/unverified: cleartext + `tls=0` pairing default (BH-000038), WebView debugging process-wide in release (BH-000039), unpinned bootstrap downloads (BH-000040), `docs/install.sh` drift (BH-000041, confirmed). Secrets posture verified clean (admin Firebase credential never entered git). No critical/RCE-class finding; no exploitation performed.

## New findings the tracker missed (highlights)

- **BH-000082 (G-03):** automation edit can silently overwrite a cron job's prompt with the truncated `prompt_preview` — schedule-only edits rewrite the prompt. Potential data loss.
- **BH-000045 (B-01):** in-process `CdpRelay.stop()` leaves a pid-valid `relay.json` → gate stays armed against a dead relay (BUG-105's same-process half).
- **BH-000047 (B-03):** single-shot boot chain — any gateway-start failure permanently disables cron knocks for the process life, silently.
- **BH-000050 (B-06):** setup wizard offers Debian 12 whose rootfs URL is dead (misspelled org; the code comment admits it).
- **BH-000080/81/85 (G-01/02/07):** silent error swallowing on fleet create/freeze, bot save/delete, and Settings Linux install (the BUG-016 pattern fixed in `setup.tsx` but not elsewhere).
- **BH-000084 (G-05):** `AgentBrowserHost` permanently gives up if the first relay boot fails (BUG-132's retry half).
- **BH-000026 (D-01):** `npm run verify` is red at HEAD — lint gate fails on a false-positive `rules-of-hooks` error (`PairForm.tsx:141`). Lead-reproduced twice.
- BH-000023/24/25/48/51/55/86-89: slash empty-catalog misroute, v1-transcript migration leak, batch-clarity validation, `starting` flag never set, install.sh `systemctl` preflight, search-row counts, provisional-sid `config.set`, crew refresh state.

## Fixed / rejected / merged

- **Fixed in checkout (device confirmation pending):** BUG-101 (BH-000002), BUG-102 (BH-000003), BUG-103 (BH-000004) via merged PRs #48/#49/#50.
- **Rejected:** BH-000022 (A-05 steer double-apply) — challenger proved the server's redirect status vocabulary is closed; every fall-through path is a not-applied outcome. Discovery preserved; optional cosmetic hardening noted.
- **Merged duplicates:** tracker BUG-036/086/132 folded into agent findings (BH-000020/021/033); B-05/B-08/B-09/B-10 recorded as corroborations on BH-000041/005/015/033; E-01 folded into BH-000033. C-08 + B-05 drift estimates reconciled (1095 vs 661 lines).

## Tests / tools executed

Typecheck clean; **lint FAILS (1 false-positive error)**; 14/14 TS offline suites pass (~433 checks, incl. boundary/adversarial cases); 10/10 Python unittest files pass standalone (pytest absent in env; `test_rpc_fleet` 4/4 env-skipped). `test:live` skipped (needs live gateway). No gradle builds, no device runs, no network.

## Coverage gaps (honest limits)

Un-audited: `app/src/components/media/*` (8 files), `MochiSurface.native/web` + generated states, vendored `hermes-src` internals beyond moch-authored seams — notably the **toolset-selection chain** (`_get_platform_tools`/`_select_tool_names`), which is BUG-132's suspected root cause; protocol frame-parser DoS tracing; VPS/nginx deployment reality. Relay security findings assume code-as-deployed. A duplicate gap-pass run (8d55cd88) was still in flight at report time — supplementary only.

## Recommended next actions

1. **Fix BH-000046** (onTimeout override or FGS type change) — product-premise threat on Android 15+.
2. **Make `npm run verify` green** (rename `useThisPhone`); CI cannot pass today.
3. Key `inflightCreate`/`ensureSession` to the provisional window — closes BH-000018+019 together.
4. Complete BUG-132: trace toolset selection under empty config (tracker round-34 next step), finish PR #61's E2E acceptance, merge, add the cache-key regression to CI.
5. Idempotency key for `prompt.submit` (BH-000020 client half; server dedupe is the real fix).
6. Move relay tokens to headers on both legs; fix the false comment; default `--require-key` on (BH-000035/034/036).
7. Fail release builds without `keystore.properties` (BH-000037); re-sync `docs/install.sh` + CI check (BH-000041).
8. Add catch/error surfaces to fleet/bot/settings-install flows (BH-000080/81/85); guard automation edit against prompt-preview write-back (BH-000082).
9. Re-run this audit after fixes: see README "How to re-run" — numbering continues from BH-000090.
