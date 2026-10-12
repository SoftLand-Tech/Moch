import { isPrivateHost, normalizeHost } from './transportGate'

export interface PairingInfo {
  host: string
  token: string
  tls: boolean
  /** C-05: true when the link EXPLICITLY carried a tls= param (0/1/…).
   *  Absent on manually built infos; parseConnectUrl always sets it. */
  tlsExplicit?: boolean
  /** Machine label from the QR (moch-link sends the hostname). Optional —
   *  the app names the entry after the host when absent. */
  name?: string
}

/** hermes://connect?host=..&token=..&tls=1 */
export function buildConnectUrl(p: PairingInfo): string {
  const q = `host=${encodeURIComponent(p.host)}&token=${encodeURIComponent(p.token)}&tls=${p.tls ? '1' : '0'}`
  return `hermes://connect?${q}`
}

export function parseConnectUrl(url: string): PairingInfo {
  const u = url.trim()
  if (!/^hermes:\/\//i.test(u) && !/^\?/.test(u) && u.includes('host=')) {
    // raw query string pasted from terminal
    return parseQuery(u.replace(/^.*\?/, ''))
  }
  const qi = u.indexOf('?')
  if (qi < 0) throw new Error('Not a Mochi pairing link.')
  const path = u.slice(0, qi).toLowerCase()
  if (!path.endsWith('/connect') && path !== 'hermes://connect') {
    throw new Error('Not a Mochi pairing link.')
  }
  return parseQuery(u.slice(qi + 1))
}

function parseQuery(qs: string): PairingInfo {
  const params = new URLSearchParams(qs)
  const hostRaw = params.get('host') ?? params.get('h') ?? ''
  const token = (params.get('token') ?? params.get('t') ?? '').trim()
  // C-05 (#95): the tls param used to default to '0' — a crafted
  // hermes://connect QR silently dials plaintext ws to ANY host with the
  // token in the URL. Now only private hosts (loopback + RFC1918, the
  // documented LAN pairing flow) keep plaintext as the absent-param
  // default; public hosts default to TLS unless the link says tls=0
  // explicitly — and an explicit plaintext link to a public host goes
  // through needsPlaintextConfirm's confirmation dialog before dialing.
  const tlsParam = params.get('tls')
  const tlsRaw = (tlsParam ?? '0').trim().toLowerCase()
  if (!hostRaw.trim()) throw new Error('Pairing code has no host.')
  if (!token) throw new Error('Pairing code has no token.')
  const host = normalizeHost(decodeURIComponent(hostRaw))
  const tls = tlsRaw === '1' || tlsRaw === 'true' || tlsRaw === 'wss' || tlsRaw === 'https'
    || (tlsParam === null && !isPrivateHost(host))
  // Several machines can share one address (the official relay routes by
  // token), so the QR carries the machine's own name for the saved list.
  const name = (params.get('name') ?? '').trim().slice(0, 40)
  return { host, token, tls, tlsExplicit: tlsParam !== null, ...(name ? { name } : {}) }
}

/** Human-friendly one-liner for terminal display / manual typing fallback. */
export function pairingSummary(p: PairingInfo): string {
  return `${p.tls ? 'wss' : 'ws'}://${p.host}`
}
