# "Ask Moch" — OS share target (share-in)

Branch `feat/share-in` · worktree `worktrees/share-in` · 2026-10-07

## Why this feature

Gap analysis against the personal-assistant apps it competes with (researched
2026-10-07): share-sheet entry is a must-have mobile-assistant capability —

- **Gemini**: files/images/text shareable from any app via the Android share
  sheet (since Nov 2024).
- **ChatGPT**: "Share to ChatGPT" share target; shared content opens as a
  pre-filled composer draft, never auto-sent.
- **Grok**: OS entry points (widget, dictation, Shortcuts/assistant hooks).

Moch had **share-out** (`expo-sharing`) but zero share-**in**: no
`ACTION_SEND` intent filter anywhere in the manifest. Voice, memory/automations,
notifications and attachments already existed — the missing must-have was OS
entry. Dot-style check-ins and Muse-style task action are covered by the
embedded Hermes agent itself (automations, tools); widgets are the next gap
after this one.

## What it does

Share text, links, images, videos, audio or PDFs from any Android app to
Moch. Moch opens on the chat tab with the shared text merged into the
composer draft and shared files staged as attachment chips — the user
reviews and taps Send (nothing auto-sends). Works cold (app was killed),
warm (backgrounded), and live (foreground via split-screen etc.). Works for
the embedded on-device runtime and remote gateways identically — chips ride
the existing upload → image.attach/file.attach pipeline.

## How it works

```
Android share sheet ──ACTION_SEND──▶ MainActivity (onCreate / onNewIntent)
                                        │ ShareInRelay.capture()
                                        ▼
                     background thread: copy content:// streams into
                     cacheDir/share-in (≤4 files, ≤8 MB each, names
                     sanitized, extensions inferred from mime) → payload
                                        │ MochShareIn event (nudge only)
                                        ▼
                     src/lib/shareIn.ts — take() pull (cold start +
                     event + AppState-active re-pull; coalesced), normalize,
                     shareInInbox atom
                                        │
                 ┌──────────────────────┴───────────────────────┐
                 ▼                                              ▼
   app/_layout.tsx: route to /(tabs)/chat     chat.tsx: consume once —
                                                text → applySharedToDraft,
                                                files → addAttachment chips
                                                (same 8 MB / 4-file caps and
                                                alerts as picked files),
                                                skipped files → alert
```

- Native: `app/android/app/src/main/java/com/hermes/pocket/sharein/`
  (`ShareInModule.kt` relay+module, `ShareInPackage.kt`), registered manually
  in `MainApplication` next to `HermesBridgePackage` (same pattern).
- Manifest: three hand-added intent filters on `MainActivity` (text/plain;
  image|video|audio|pdf; SEND_MULTIPLE image/*), label **"Ask Moch"**.
  ⚠️ These live in the prebuilt `android/` — a future `expo prebuild` would
  drop them (prebuild is forbidden in this repo; noted in the manifest).
- JS: `src/lib/shareIn.ts` (node-safe pure core, fakes-injectable for
  tests), wired in `app/_layout.tsx` (pipeline boot + routing) and
  `app/app/(tabs)/chat.tsx` (composer consumption).
- Tests: `app/scripts/test-sharein.ts` (21 checks — normalization, draft
  merge, inbox lifecycle, event wiring). Wired into `npm run verify` as
  `test:sharein`.
- Also fixed here (pre-existing breakage found by the verify chain):
  `src/lib/gateway.ts` used `Promise.withResolvers` (ES2024) which fails
  `tsc -p tsconfig.scripts.json` (lib ES2022) — replaced with a hand-rolled
  resolver.

## In-app test procedure (no adb)

Install `app-release.apk` over the existing build (data is kept — same
signing key).

1. **Share text (warm)** — open any app with text (e.g. a browser article),
   long-select a sentence, Share → **Ask Moch**. Moch should open on the
   chat tab with the sentence sitting in the composer (send it; the agent
   should see exactly that text).
2. **Share a link** — Share a URL from the browser → the URL appears in the
   composer.
3. **Share an image (warm)** — from Google Photos, Share one photo → **Ask
   Moch**: an attachment chip appears; add a caption ("what is this?") and
   send — the image must ride the normal upload ladder.
4. **Share multiple images** — select 2+ photos, Share → up to 4 chips
   appear (a 5th would be rejected with the standard limit alert).
5. **Share a PDF** — from a files app, Share a PDF → chip labelled with the
   file name (file.attach path).
6. **Cold share** — swipe Moch away from Recents, then Share a selection
   from another app → Moch cold-boots onto the chat tab with the content
   staged.
7. **Regression sweep** — normal chat, attach via the + sheet, slash
   commands, voice strip: all unchanged.
8. **Over-size guard** (optional) — share a >8 MB non-image file → an alert
   says the share exceeded the limit; text-only shares still land.

## Rollback

The whole feature is additive: remove the three intent filters from the
manifest and nothing else can fire (the relay only sees intents the filters
let in). The worktree branch never touched the main checkout.
