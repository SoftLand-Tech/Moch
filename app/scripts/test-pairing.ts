/**
 * C-05 / GitHub #95 — transport privacy gate, offline unit suite.
 *
 * Covers the pure pairing/transport layer with no gateway and no RN:
 *  - parseConnectUrl: the {private, public} × {tls absent, tls=0, tls=1}
 *    matrix → effective tls + tlsExplicit (public hosts now default to TLS)
 *  - isPrivateHost: loopback / RFC1918 edges (incl. IPv6 literals + ports,
 *    and the numeric-IPv4-only rule that keeps `10.example.com` public)
 *  - needsPlaintextConfirm: the truth table of the confirmation gate
 *  - buildConnectUrl ↔ parseConnectUrl round-trips
 *
 * gateway.ts dial() and http.ts httpBase() refusals are NOT covered here:
 * both modules transitively import react-native/expo and cannot load in
 * plain node (same reason wsUrl() lazily requires ./push). Their gate
 * logic shares isPrivateHost/needsPlaintextConfirm, which ARE covered.
 *
 *   npx tsx scripts/test-pairing.ts
 */
import { buildConnectUrl, parseConnectUrl, type PairingInfo } from '../src/lib/pairing'
import { isPrivateHost, needsPlaintextConfirm } from '../src/lib/transportGate'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const TOKEN = 'tok-abcdefghijklmnop'

/** Parse a hermes://connect link with the given host + tls param. */
function parse(host: string, tls?: '0' | '1'): PairingInfo {
  const q = `host=${encodeURIComponent(host)}&token=${encodeURIComponent(TOKEN)}${tls === undefined ? '' : `&tls=${tls}`}`
  return parseConnectUrl(`hermes://connect?${q}`)
}

async function main() {
  // ── 1. The tls matrix: effective tls + tlsExplicit ─────────────────────
  // Private hosts keep today's behavior: tls absent → plaintext (documented
  // LAN pairing flow), tlsExplicit false.
  const matrix: Array<{ host: string; tls: '0' | '1' | undefined; wantTls: boolean; wantExplicit: boolean }> = [
    // private host (LAN)
    { host: '192.168.1.10:9999', tls: undefined, wantTls: false, wantExplicit: false },
    { host: '192.168.1.10:9999', tls: '0', wantTls: false, wantExplicit: true },
    { host: '192.168.1.10:9999', tls: '1', wantTls: true, wantExplicit: true },
    // public hostname
    { host: 'example.com', tls: undefined, wantTls: true, wantExplicit: false },
    { host: 'example.com', tls: '0', wantTls: false, wantExplicit: true },
    { host: 'example.com', tls: '1', wantTls: true, wantExplicit: true },
    // public IP
    { host: '8.8.8.8', tls: undefined, wantTls: true, wantExplicit: false },
    { host: '8.8.8.8', tls: '0', wantTls: false, wantExplicit: true },
    // loopback stays plaintext-by-default (embedded runtime / LAN)
    { host: '127.0.0.1:9119', tls: undefined, wantTls: false, wantExplicit: false },
    { host: '10.0.0.5:9119', tls: undefined, wantTls: false, wantExplicit: false },
  ]
  for (const c of matrix) {
    const p = parse(c.host, c.tls)
    check(
      `${c.host} tls=${c.tls ?? 'absent'} → tls=${c.wantTls} explicit=${c.wantExplicit}`,
      p.tls === c.wantTls && p.tlsExplicit === c.wantExplicit,
      `got tls=${p.tls} explicit=${p.tlsExplicit}`,
    )
  }

  // The attack from the finding, verbatim: a crafted QR with NO tls param to
  // a remote host must NOT parse as plaintext anymore.
  const crafted = parseConnectUrl(`hermes://connect?host=attacker.example.com&token=${TOKEN}`)
  check('crafted QR (public host, no tls param) parses as TLS', crafted.tls === true)

  // ── 2. isPrivateHost edges ──────────────────────────────────────────────
  const privates = ['localhost', 'localhost:9119', '127.0.0.1', '127.0.0.1:9119', '::1', '[::1]', '[::1]:9119',
    '10.0.0.5', '10.255.255.255', '10.1.2.3:80', '172.16.0.1', '172.20.5.5', '172.31.9.9', '172.31.255.255:443',
    '192.168.1.10', '192.168.0.0:9999']
  const publics = ['8.8.8.8', '8.8.8.8:443', '172.32.0.1', '172.15.0.1', '192.169.1.10', '11.0.0.1',
    'example.com', 'example.com:443', 'sub.10.example.com', '10.example.com', '172.16.example.com',
    '192.168.example.com', 'myserver.tailnet.ts.net', '[2606:4700::6810]:443']
  for (const h of privates) check(`isPrivateHost(${h})`, isPrivateHost(h) === true)
  for (const h of publics) check(`!isPrivateHost(${h})`, isPrivateHost(h) === false, 'got private')

  // ── 3. needsPlaintextConfirm truth table ────────────────────────────────
  check('private + tls=false → no confirm (LAN flow)', needsPlaintextConfirm('192.168.1.10', false) === false)
  check('loopback + tls=false → no confirm', needsPlaintextConfirm('127.0.0.1:9119', false) === false)
  check('private + tls=true → no confirm', needsPlaintextConfirm('192.168.1.10', true) === false)
  check('public + tls=true → no confirm', needsPlaintextConfirm('example.com', true) === false)
  check('public + tls=false → CONFIRM', needsPlaintextConfirm('example.com', false) === true)
  check('public IP + tls=false → CONFIRM', needsPlaintextConfirm('8.8.8.8:443', false) === true)
  // end-to-end through the parser: a QR that explicitly says tls=0 to a
  // public host is exactly the gated case.
  const p0 = parse('example.com', '0')
  check('public tls=0 link needs confirmation', needsPlaintextConfirm(p0.host, p0.tls) === true)
  const pAbsent = parse('example.com', undefined)
  check('public link without tls param needs no confirmation (TLS default)', needsPlaintextConfirm(pAbsent.host, pAbsent.tls) === false)

  // ── 4. buildConnectUrl round-trips (semantics unchanged) ────────────────
  check('buildConnectUrl format unchanged',
    buildConnectUrl({ host: '192.168.1.10:9999', token: TOKEN, tls: true })
      === `hermes://connect?host=${encodeURIComponent('192.168.1.10:9999')}&token=${TOKEN}&tls=1`)
  const rtPriv = parseConnectUrl(buildConnectUrl({ host: '192.168.1.10:9999', token: TOKEN, tls: false }))
  check('round-trip: LAN plaintext stays plaintext + explicit', rtPriv.tls === false && rtPriv.tlsExplicit === true)
  const rtPub = parseConnectUrl(buildConnectUrl({ host: 'relay.example.com', token: TOKEN, tls: true }))
  check('round-trip: public TLS stays TLS', rtPub.tls === true && rtPub.host === 'relay.example.com')
  const rtPubPlain = parseConnectUrl(buildConnectUrl({ host: 'relay.example.com', token: TOKEN, tls: false }))
  check('round-trip: public tls=0 stays plaintext (gate applies)', rtPubPlain.tls === false && needsPlaintextConfirm(rtPubPlain.host, rtPubPlain.tls))

  // ── 5. Other parse paths keep working ───────────────────────────────────
  const raw = parseConnectUrl(`host=10.0.0.5:9119&token=${TOKEN}`) // raw query pasted from a terminal
  check('raw query string (no hermes://) parses; private default plaintext', raw.tls === false && raw.tlsExplicit === false)
  const named = parseConnectUrl(`hermes://connect?host=192.168.1.10&token=${TOKEN}&name=mybox`)
  check('name= survives', named.name === 'mybox')
  let threw = false
  try { parseConnectUrl('hermes://connect?host=example.com') } catch { threw = true }
  check('link without token still rejected', threw)
  threw = false
  try { parseConnectUrl('https://example.com/other') } catch { threw = true }
  check('non-connect link still rejected', threw)

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main()
