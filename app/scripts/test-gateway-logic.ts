// Unit tests for the pure dial-transport and local-retry helpers
// (src/lib/dialTransport.ts, src/lib/transportGate.ts) — no gateway, no RN,
// no network. These were extracted from gateway.ts (tracker BH-000028)
// precisely so this surface could be pinned offline: gateway.ts itself loads
// AsyncStorage/SecureStore/react-native at module scope and cannot be imported
// in plain node.
type D = typeof import('../src/lib/dialTransport')

let d: D

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  d = await import('../src/lib/dialTransport')
  const gate = await import('../src/lib/transportGate')
  const target = { host: '127.0.0.1:9119', token: 'sekret-token', tls: false }
  const targetTls = { host: 'box.tailnet.ts.net', token: 'sekret-token', tls: true }

  // ── fnv1a: change-detector hash for push-token fingerprints ───────────
  check('fnv1a empty string is the FNV offset basis', d.fnv1a('') === '811c9dc5')
  check('fnv1a matches the known 32-bit vector for "foobar"', d.fnv1a('foobar') === 'bf9cf968')
  check('fnv1a emits 8-char zero-padded lowercase hex', /^[0-9a-f]{8}$/.test(d.fnv1a('x')) && d.fnv1a('moch').length === 8)
  check('fnv1a is deterministic and input-sensitive', d.fnv1a('abc') === d.fnv1a('abc') && d.fnv1a('abc') !== d.fnv1a('abd'))

  // ── header-mode dial URL: token NEVER on the URL ───────────────────────
  check('header dial without a push token is the bare ws URL', d.buildDialUrl(target, 'headers', null, 'salt') === 'ws://127.0.0.1:9119/api/ws')
  check('header dial with tls uses wss', d.buildDialUrl(targetTls, 'headers', null, 'salt') === 'wss://box.tailnet.ts.net/api/ws')
  const fpUrl = d.buildDialUrl(target, 'headers', 'ExpoPushToken[abc]', 's4lt')
  check(
    'header dial with a push token carries only a fingerprint, never the token',
    fpUrl.startsWith('ws://127.0.0.1:9119/api/ws?pushfp=') && !fpUrl.includes('ExpoPushToken'),
    fpUrl,
  )
  check(
    'the fingerprint is fnv1a(salt + token) and changes with either',
    fpUrl.endsWith(d.fnv1a('s4lt' + 'ExpoPushToken[abc]')) &&
      d.buildDialUrl(target, 'headers', 'ExpoPushToken[abc]', 's4lt') !== d.buildDialUrl(target, 'headers', 'ExpoPushToken[abc]', 'OTHER') &&
      d.buildDialUrl(target, 'headers', 'ExpoPushToken[abc]', 's4lt') !== d.buildDialUrl(target, 'headers', 'ExpoPushToken[xyz]', 's4lt'),
  )

  // ── legacy query dial URL: the documented plaintext fallback ───────────
  check(
    'query dial URL-encodes the session token (legacy contract)',
    d.buildDialUrl(target, 'query', null, 'salt') === 'ws://127.0.0.1:9119/api/ws?token=sekret-token' &&
      d.buildDialUrl({ host: 'h', token: 'a b&c', tls: false }, 'query', null, 'salt').endsWith('token=a%20b%26c'),
  )
  check(
    'query dial appends an encoded push token when held',
    d.buildDialUrl(target, 'query', 'p+tok', 'salt') === 'ws://127.0.0.1:9119/api/ws?token=sekret-token&push=p%2Btok',
  )

  // ── upgrade headers ─────────────────────────────────────────────────────
  check(
    'dial headers carry the session token always, push token only when held',
    d.buildDialHeaders(target, null)['X-Hermes-Session-Token'] === 'sekret-token' && !('X-Hermes-Push-Token' in d.buildDialHeaders(target, null)) &&
      d.buildDialHeaders(target, 'ExpoPushToken[x]')['X-Hermes-Push-Token'] === 'ExpoPushToken[x]',
  )

  // ── handshake refusal detection ─────────────────────────────────────────
  check(
    'refusal matches pre-open closes/errors only — never timeouts',
    d.isHandshakeRefusal(new Error('socket closed during handshake')) === true &&
      d.isHandshakeRefusal(new Error('Error before open: 403')) === true &&
      d.isHandshakeRefusal(new Error('request timed out after 120s: prompt.submit')) === false &&
      d.isHandshakeRefusal(new Error('gateway not connected')) === false,
  )
  check('refusal detection accepts non-Error values', d.isHandshakeRefusal('WebSocket closed during handshake') === true && d.isHandshakeRefusal(null) === false)

  // ── redaction ───────────────────────────────────────────────────────────
  check(
    'redactedUrl never prints the token, keeps scheme+host',
    d.redactedUrl(target) === 'ws://127.0.0.1:9119/api/ws?token=***' &&
      d.redactedUrl(targetTls) === 'wss://box.tailnet.ts.net/api/ws?token=***' &&
      !d.redactedUrl({ ...target, token: '' } as typeof target & { token: string }).includes('sekret'),
  )

  // ── local-only retry host gate ───────────────────────────────────────────
  const loopback = [
    '127.0.0.1', '127.0.0.1:9119', 'localhost', 'LOCALHOST:9119',
    '[::1]', '[::1]:9119', '::1', 'http://127.0.0.1:9119/api/ws',
  ]
  const nonLoopback = [
    '192.168.1.10:9119', '10.0.0.5:9119', '172.16.0.1', '8.8.8.8:443',
    'gateway.example.com:443', 'myserver.tailnet.ts.net', '[2606:4700::6810]:443',
    '127.0.0.1.example.com', 'localhost.example.com',
  ]
  for (const h of loopback) check(`isLoopbackHost(${h})`, gate.isLoopbackHost(h) === true)
  for (const h of nonLoopback) check(`!isLoopbackHost(${h})`, gate.isLoopbackHost(h) === false)
  check('invalid saved host is not retryable', gate.isLoopbackHost('not a host') === false)

  // ── foreground recovery decision (boot backgrounded / half-open) ────────
  check(
    'foreground resumes local boot when connectThisPhone timed out while backgrounded',
    d.decideForegroundAction({
      manualClose: false,
      wantConnection: false,
      wantLocalBoot: true,
      connectionState: 'idle',
      bootConnectInFlight: false,
    }) === 'resume-boot',
  )
  check(
    'foreground does not spawn duplicate boot connect while one is already in flight',
    d.decideForegroundAction({
      manualClose: false,
      wantConnection: false,
      wantLocalBoot: true,
      connectionState: 'idle',
      bootConnectInFlight: true,
    }) === 'none',
  )
  check(
    'foreground retries dial if stalled inside embedded wait loop during dial()',
    d.decideForegroundAction({
      manualClose: false,
      wantConnection: true,
      wantLocalBoot: true,
      connectionState: 'connecting',
      bootConnectInFlight: false,
      dialWaitInFlight: true,
    }) === 'retry-dial',
  )
  check(
    'foreground respects manualClose even when wantLocalBoot was set earlier',
    d.decideForegroundAction({
      manualClose: true,
      wantConnection: false,
      wantLocalBoot: true,
      connectionState: 'idle',
      bootConnectInFlight: false,
    }) === 'none',
  )
  check(
    'foreground probes open socket and retries closed/error sockets',
    d.decideForegroundAction({
      manualClose: false,
      wantConnection: true,
      wantLocalBoot: false,
      connectionState: 'open',
      bootConnectInFlight: false,
    }) === 'probe-open' &&
      d.decideForegroundAction({
        manualClose: false,
        wantConnection: true,
        wantLocalBoot: false,
        connectionState: 'closed',
        bootConnectInFlight: false,
      }) === 'retry-dial',
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-gateway-logic crashed:', err)
  process.exit(1)
})
