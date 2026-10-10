import { normalizeHost } from './gateway'

export interface PairingInfo {
  host: string
  token: string
  tls: boolean
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
  const tlsRaw = (params.get('tls') ?? '0').trim().toLowerCase()
  if (!hostRaw.trim()) throw new Error('Pairing code has no host.')
  if (!token) throw new Error('Pairing code has no token.')
  const host = normalizeHost(decodeURIComponent(hostRaw))
  const tls = tlsRaw === '1' || tlsRaw === 'true' || tlsRaw === 'wss' || tlsRaw === 'https'
  // Several machines can share one address (the official relay routes by
  // token), so the QR carries the machine's own name for the saved list.
  const name = (params.get('name') ?? '').trim().slice(0, 40)
  return { host, token, tls, ...(name ? { name } : {}) }
}

/** Human-friendly one-liner for terminal display / manual typing fallback. */
export function pairingSummary(p: PairingInfo): string {
  return `${p.tls ? 'wss' : 'ws'}://${p.host}`
}
