// Build Mochi's notification system on the `notifications` branch.
// Worktree: /home/mamoun/ai/.worktrees/moch-notifications (branch off main,
// node_modules hardlinked — do NOT npm install). Upstream hermes source of
// truth for wire event names: ~/.hermes/hermes-agent.
//
// Registration design (decided): the app appends &push=<expoToken> to its
// WebSocket dial URL; the moch-link proxy extracts it from the handshake
// head's request line (it already rewrites that head) and persists it to
// $LINK_HOME/push-token. No new RPC, re-registered on every connect. The
// proxy then watches SERVER→CLIENT frames (unmasked text opcodes) for the
// events below and POSTs Expo's push service — one sentence each, per the
// user's explicit preference.

interface BuildReport {
  summary: string
  files: string[]
  /** Event names actually matched on the wire, with evidence (file:line in upstream). */
  events: string[]
  risks: string
}

interface ReviewOut {
  problems: Array<{ file: string; problem: string; severity: 'low' | 'medium' | 'high' }>
  verdict: string
}

interface Gate { check: string; passed: boolean; failure: string }
const WT = '/home/mamoun/ai/.worktrees/moch-notifications'
const APP = WT + '/app'
const PUSH_RIG = '/var/tmp/push-rig.mjs'

const APPROVAL_TITLE = 'Mochi needs you'
const APPROVAL_BODY = 'Mochi is waiting for your approval.'
const QUESTION_TITLE = 'Mochi asked something'
const QUESTION_BODY = 'Mochi is waiting for your answer.'
const REPLY_TITLE = 'Mochi replied'
const REPLY_BODY = 'Mochi finished your request.'

phase('Implement the app half of notifications')
const appP = agent('App notification builder', {
  system:
    'You are a careful React Native engineer working ONLY inside ' + APP + ' (a git worktree on branch notifications; node_modules is hardlinked — never npm install, never commit). ' +
    'Use the real Edit tool for every change. Match codebase comment style (constraints, not narration). ' +
    'Run nothing yourself except read-only greps — the script gates your work after you.',
}).ask<BuildReport>(
  `Wire remote push into the app. Files to touch (verify with grep first, adapt to reality):
1. src/lib/push.ts (exists, complete): ensure Android CHANNELS are created at setup —
   'approvals' (IMPORTANCE HIGH, sound+vibrate, name "Approvals") and 'replies'
   (IMPORTANCE DEFAULT, name "Replies"), plus a quiet 'misc' if you need one. Also export
   the current expo push token atom getter (expoPushToken atom exists) and a
   dismissMochNotifications() that dismisses every delivered notification WE sent
   (track our ids when they arrive; expo-notifications dismissNotificationAsync).
2. src/lib/gateway.ts: wsUrl() (or the dial path) appends &push=<token> to the URL
   when an Expo push token is available (import lazily from push.ts — push.ts already
   avoids top-level expo-notifications imports; keep gateway import-safe for node tests:
   gateway is imported by plain-node suites, so the push import must be lazy (require
   inside the function) or type-only. If tests run gateway in node, a static import of
   push.ts would break them — check and guard accordingly).
3. App boot (app/_layout.tsx): kick token acquisition once after the first successful
   connect (void, non-fatal: .catch(log)); on AppState active, call
   dismissMochNotifications() (the app is open — our knocks are stale). Keep the
   existing local-notification paths untouched.
4. Foreground behavior: the existing notification handler should NOT display remote
   pushes while the app is active (in-app toasts already cover it); backgrounded/killed
   delivery is the OS's job and needs no code.
5. Tap routing: remote push data {screen:'chat', storedId?} must land in the EXISTING
   notification-tap path (pendingOpenStoredId / requestOpenSession) — verify and only
   fix if broken.
Notification strings (verbatim, one sentence each — user's explicit preference):
   approval-family: title '${APPROVAL_TITLE}' body '${APPROVAL_BODY}' channelId 'approvals'
   clarify:         title '${QUESTION_TITLE}' body '${QUESTION_BODY}' channelId 'approvals'
   reply finished:  title '${REPLY_TITLE}' body '${REPLY_BODY}' channelId 'replies'
Do NOT touch moch-link/, relay/, or anything under app/app/(tabs) unless a wire above requires it.
Return files touched, summary, and honest risks.`,
)

phase('Implement the moch-link half of notifications')
const linkP = agent('Link notification builder', {
  system:
    'You are a careful Node/bash engineer working ONLY inside ' + WT + '/moch-link/install.sh (the moch-link installer: one self-contained file with embedded JS heredocs). ' +
    'Use the real Edit tool. The deployed proxy is embedded as the moch-link-proxy.js heredoc inside install.sh. ' +
    'Never run the installer against a real HOME; test via the rig the script runs. Ground every wire-format claim in source.',
}).ask<BuildReport>(
  `Add push notifications to the moch-link proxy (moch-link-proxy.js heredoc in install.sh). Ground truth for event names: read ~/.hermes/hermes-agent (the tui_gateway/contracts + emit sites) and ` + APP + `/src/lib/chat.ts (onServerRequest methods 'approval'|'sudo'|'secret'|'clarify'; the event switch) — record the exact JSON substrings that appear on the wire for: (a) approval/sudo/secret server requests, (b) clarify requests, (c) end-of-turn (candidate: the session.usage event or whatever chat.ts ends busy on — verify).
Implement inside the embedded proxy:
1. REGISTRATION: the proxy already rewrites the first client chunk (the HTTP upgrade head). Parse the request line's query for push=<token> (charset [A-Za-z0-9_:-]); persist to $LINK_HOME/push-token (from env LINK_HOME or the proxy's known home dir — see how env flows in the installer's unit). Token can rotate — just overwrite.
2. WATCHER: server→client WS frames are UNMASKED — add a minimal text-frame reassembler (2-14 byte header, opcodes 0x1 text / 0x0 continuation; ignore ping/pong/binary; handle frames split across chunks) feeding a matcher over complete text payloads. Match the events you grounded above. Extract session ids for deep-link data when present in the payload.
3. SENDER: on match, POST to ${'`'}EXPUSH_URL || https://exp.host/--/api/v2/push/send${'`'} with JSON {to: token, title, body, channelId, data:{screen:'chat', storedId?}, ttl: 604800, collapseKey}. Strings (verbatim, one sentence):
   approval-family: '${APPROVAL_TITLE}' / '${APPROVAL_BODY}' / 'approvals'
   clarify:         '${QUESTION_TITLE}' / '${QUESTION_BODY}' / 'approvals'
   end-of-turn:     '${REPLY_TITLE}' / '${REPLY_BODY}' / 'replies'
4. THROTTLE: per collapseKey, at most one POST per 30s (a turn can emit several matches). Fire-and-forget fetch with a 5s timeout, errors logged not thrown. No node_modules (ws is present in ~/.moch-link/node_modules at RUNTIME but the proxy must stay dependency-free — use raw http.request or global fetch if the system node has it, else https module).
5. Also write a RIG at ${PUSH_RIG}: a node script that (a) starts a stub expo endpoint (http server capturing POST bodies), (b) extracts the new proxy from install.sh (same sed the installer uses, or re-derive via a marker) to a temp file, (c) starts a fake upstream byte-sink serve on a port, (d) opens a raw TCP socket to the proxy and writes an HTTP upgrade head whose request line includes ?token=x&push=RIGTOKEN, then (e) writes CRAFTED unmasked WS text frames — one approval request, one turn-end event, one split-across-two-chunks frame — and (f) asserts: push-token file written, exactly the expected POSTs arrived with the exact one-sentence bodies and correct collapseKeys/ttl. Exit 0/1 with clear output. Node >= 18 available at /usr/bin/env node.
bash -n must pass on install.sh (the script gates it). Return files, the grounded event names with file:line evidence, risks.`,
)

const [appR, linkR] = await Promise.all([appP, linkP])
report(appR); report(linkR)
log('Both halves built. Events grounded: ' + linkR.events.join(' ; '))

phase('Run the gates')
const gates: Gate[] = []
const gate = (check: string, r: { exitCode: number; stdout: string; stderr: string }) => {
  gates.push({ check, passed: r.exitCode === 0, failure: r.exitCode === 0 ? '' : (r.stdout + '\n' + r.stderr).trim().slice(-3500) })
  report(gates[gates.length - 1])
  return r
}
gate('app typecheck', await world.run('bash', ['-c', `cd ${APP} && npx tsc --noEmit`], { timeoutMs: 600000 }))
for (const s of ['test', 'test:order', 'test:chatlist', 'test:queue', 'test:attention', 'test:imports']) {
  gate(`app suite ${s}`, await world.run('bash', ['-c', `cd ${APP} && npm run -s ${s}`], { timeoutMs: 600000 }))
}
gate('installer syntax', await world.run('bash', ['-n', WT + '/moch-link/install.sh']))
gate('push rig (proxy + watcher + sender, live)', await world.run('node', [PUSH_RIG], { timeoutMs: 120000 }))
const failing = () => gates.filter(g => !g.passed)

if (failing().length > 0) {
  phase('Repair what the gates caught')
  const detail = failing().map(g => `${g.check}:\n${g.failure}`).join('\n\n')
  await agent('Notification repairer', {
    system: 'You fix exactly what the failing gates show, inside ' + WT + ' (Edit tool; no installs; no commits). The rig at ' + PUSH_RIG + ' is yours to adjust ONLY if its own harness is wrong — never weaken its assertions to pass.',
  }).ask<string>(`Failing gates:\n${detail}\nFix and reply with what changed.`)
  gate('app typecheck (re-gate)', await world.run('bash', ['-c', `cd ${APP} && npx tsc --noEmit`], { timeoutMs: 600000 }))
  gate('app suite test (re-gate)', await world.run('bash', ['-c', `cd ${APP} && npm run -s test`], { timeoutMs: 600000 }))
  gate('push rig (re-gate)', await world.run('node', [PUSH_RIG], { timeoutMs: 120000 }))
}

phase('Independent review of both halves')
const review = await agent('Notification reviewer', {
  system: 'You are a skeptical senior engineer. Read the diffs (git -C ' + WT + ' diff) and the surrounding code. Hunt for: privacy leaks (what the push token exposes, where tokens are written), the node-test import hazard (gateway statically importing expo modules), watcher false-positives (substring matches firing on user text containing the pattern), proxy crash paths, and notification spam loops. Do NOT edit; do not rerun suites (already gated).',
}).ask<ReviewOut>(`Review the uncommitted diff on branch notifications. Key invariants: relay still sees nothing new (push token rides the same dial URL as the pairing token); pushes carry one-sentence metadata only; the app suppresses remote pushes while foregrounded; proxy failures can never kill the byte pipe. Report real problems with file+why; an empty list is valid.`)

phase('Commit on the notifications branch')
const G = (name: string, r: { exitCode: number; stdout: string; stderr: string }) => gate(name, r)
G('commit', await world.run('git', ['-C', WT, 'add', '-A'], { timeoutMs: 300000 }))
G('commit', await world.run('bash', ['-c', `cd ${WT} && git commit -m "notifications: Mochi knocks — remote push through the moch-link proxy

App: Expo push token acquired after first connect and re-registered on
every dial (&push= on the WS URL — no new RPC); channels 'approvals'
(high, sound) and 'replies'; remote pushes suppressed while foregrounded
(toasts own that); our delivered notifications dismissed on app open;
tap deep-links into the chat.

moch-link: the proxy extracts &push= from the handshake head and
persists the token; a minimal unmasked-frame reassembler watches
server→client text frames for approval/clarify/turn-end events and
POSTs Expo's push service — one sentence each, 7-day TTL (offline
phones get queued pushes on reconnect), 30s collapse throttle, and the
byte pipe survives any watcher/sender failure by construction."`], { timeoutMs: 300000 }))
G('push branch (NOT merged)', await world.run('git', ['-C', WT, 'push', '-u', 'origin', 'notifications'], { timeoutMs: 600000 }))

const still = failing()
phase('Write the delivery report')
const md = [
  '# Mochi knocks — notifications on the `notifications` branch',
  '',
  `Built on branch \`notifications\` (off main ${'`c839b4b`'}), pushed, NOT merged. Connectors WIP was committed separately on \`connectors\` (${'`44e3f08`'}) and left unmerged as instructed.`,
  '',
  '## App half', appR.summary, ...appR.files.map(f => `- ${f}`), '', '## Link half', linkR.summary,
  'Grounded wire events:', ...linkR.events.map(e => `- ${e}`),
  '', '## Gates', ...gates.map(g => `- ${g.passed ? 'PASS' : 'FAIL'} — ${g.check}${g.failure ? ': ' + g.failure.slice(0, 160) : ''}`),
  '', '## Review verdict', review.verdict, ...review.problems.map(p => `- [${p.severity}] ${p.file}: ${p.problem}`),
  '', '## Risks', `- app: ${appR.risks}`, `- link: ${linkR.risks}`,
  '', '## What is NOT in this branch', '- A new APK (notification *icon* art is a native asset — needs the next EAS build; everything else is OTA-live JS)', '- any deploy: the installer was not pushed to the VPS and the live ~/.moch-link was not touched — test on this machine first',
].join('\n')
try { await artifact.markdown('notifications-report', md, { title: 'Mochi notifications — build report', description: 'Both halves, gates, review, and what is deliberately not deployed yet.', primary: true }) } catch { /* return carries it */ }

return {
  conclusion: still.length === 0
    ? `Notifications built end-to-end on branch 'notifications' (pushed, not merged): app registers its Expo push token on every dial, the moch-link proxy watches the wire and pushes one-sentence Mochi notifications (${APPROVAL_BODY} etc.) with 7-day offline TTL. All gates green including a live rig through a stub Expo endpoint.`
    : `Built but ${still.length} gate(s) failed — see findings; branch state is committed as-is.`,
  findings: [...review.problems.map(p => ({ where: p.file, what: p.problem, evidence: 'independent review', status: 'unconfirmed' as const, severity: p.severity })), ...still.map(g => ({ where: 'gates', what: g.check + ' failed', evidence: g.failure.slice(0, 500), status: 'verified' as const, severity: 'high' as const }))],
  verified: gates.filter(g => g.passed).map(g => g.check),
  notCovered: ['on-device push receipt (needs the user\'s phone — Expo push is real only in a dev/prod build, not Expo Go)', 'installer deploy to VPS + local moch-link update (deliberately untouched)', 'notification icon art (needs next APK build)'],
}
