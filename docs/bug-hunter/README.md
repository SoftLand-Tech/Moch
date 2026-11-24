# Bug-Hunter Audit Workspace — Moch

Persistent, evidence-backed record of the autonomous repository bug hunt.
Owned by the lead agent; subagents return findings, the lead writes these logs.

- **Repository:** https://github.com/SoftLand-Tech/Moch (verified from `git remote origin`)
- **Branch audited:** `feat/browser-always-available` (up to date with origin at audit start)
- **Commit audited:** `3191fe154af7c5b7ed8b87b03412e7bbe94ecb5b`
- **Working tree at start:** dirty — `app/android/app/build.gradle` (versionCode 17→18, versionName 1.0.15-browser, uncommitted user change, preserved untouched) plus untracked local artifacts (`.devtest/`, test reports, research scripts). None of these were modified by the audit.
- **Audit start (UTC):** 2026-10-12T00:20:49Z
- **Latest audit completion:** 2026-10-12T00:50:00Z (round 1) — 60 findings, 89 events; executive summary in `report.md`.

## What is in here

| File | Purpose |
| --- | --- |
| `README.md` | This file — how the audit works, how to re-run it. |
| `findings.jsonl` | Append-only event log: one JSON object per line, every discovered issue and every status change. Never edit history; append new events. |
| `findings.md` | Human-readable index of all findings with current status, evidence, and remediation. |
| `github-issues.jsonl` | Every relevant GitHub issue/PR discovered, deduplicated by repo + number. |
| `coverage.json` | Audit metadata: modules inspected, tools/tests executed, agent assignments, gaps, limitations. |
| `report.md` | Executive report generated at the end of each audit round. |

## Repository map (established in Phase 1)

Monorepo, five authored surfaces:

1. `app/src/` — Expo 57 / RN 0.86 TypeScript client (65 files: chat, gateway, protocol, sessions, media, voice, terminal, browser relay, fleet/bots UI).
2. `app/python-runtime/moch/` — embedded-runtime Python side (26 files: bootstrap, gateway server, browser gate, fleet, terminal, Linux/proot session, cron knocks, audit).
3. `app/android/app/src/main/java/com/hermes/pocket/` — Kotlin bridge (HermesRuntime, HermesBridgeModule, HermesService, BrowserRelayModule, CdpRelay, CronKnockNotifier, ShareInModule).
4. `moch-link/install.sh` (+ `docs/install.sh` published copy) and `relay/moch-relay-server.js` — linked-mode infrastructure.
5. `app/hermes-src/` — vendored upstream hermes-agent (1711 files, synced wholesale by `embedded/vendor-hermes.sh`, **not** Moch-authored). Audit covers only the integration seams, not upstream internals.

Existing local tracker: `bugs.md` (133 bug IDs, 114 marked fixed, 18 open at audit start). New findings reference it via `related_ids` / the `BUG-xxx` mapping instead of re-reporting known issues.

## Status lifecycle

`discovered → needs_verification → confirmed → fixed → verified_fixed`
plus `rejected`, `duplicate`, `wont_fix`, `blocked`, `open`.

Status changes are appended as new events in `findings.jsonl`; discovery events are never removed.

## Severity levels

- **Critical** — severe security compromise, RCE-class impact under realistic conditions.
- **High** — serious security exposure, major data loss, broad service failure, critical workflow unusable.
- **Medium** — significant functional failure with meaningful workaround.
- **Low** — limited-impact or uncommon edge case.
- **Informational** — missing safeguards / maintainability concerns, not an established bug.

Severity is separate from confidence: a potentially critical finding with weak evidence stays unverified.

## How to re-run

1. Record `git rev-parse HEAD` and confirm the tree state (never overwrite user changes).
2. Read `coverage.json` for the previous round's coverage and `findings.jsonl` for existing IDs — continue numbering from the last `BH-xxxxxx`.
3. Launch the scoped subagents (architecture/logic, runtime/integration, security, tests/reproduction, GitHub history) in parallel with read-only mandates; collect structured findings.
4. Consolidate: dedupe, assign stable IDs, append events, update `findings.md`.
5. Challenger pass to disprove; reproduction pass for high-impact candidates.
6. Coverage review; update `coverage.json` and write `report.md`.
7. Validate every JSONL file parses (`python3 -c "import json,sys; [json.loads(l) for l in open(sys.argv[1]) if l.strip()]" <file>`).

## Known tool restrictions (this environment)

- `gh` CLI authenticated as MamounHisham1 (read-only use; no issue/PR mutation).
- Node 26.8.1, Python 3 available; `app/node_modules` present (offline test runs possible).
- Android SDK/gradle present under `app/android` with `.gradle-home` configured; device/emulator availability not assumed — on-device reproduction is out of scope for the audit itself (existing on-device reports in `TEST-REPORT-1.0.15-device.md` are treated as evidence, not re-run).
- No live third-party systems were contacted; security findings are static-analysis based unless stated otherwise.
