/**
 * Transport privacy gate (C-05 / GitHub #95): which hosts a PLAINTEXT
 * ws:// / http:// connection may be opened against without an explicit
 * user confirmation. Loopback + RFC1918 (the documented LAN pairing flow)
 * stay open; anything public must be TLS or user-confirmed.
 *
 * This module must stay free of react-native/expo imports: scripts/ runs it
 * in plain node (same rule as attention.ts), and pairing.ts depends on it.
 */

/** Normalize "host[:port]" — accepts bare host, host:port, or full URLs. Throws on garbage. */
export function normalizeHost(raw: string): string {
  let h = raw.trim()
  if (!h) throw new Error('Enter the server address.')
  h = h.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '')
  // strip path/query if user pasted a full URL
  const slash = h.indexOf('/')
  if (slash >= 0) h = h.slice(0, slash)
  const q = h.indexOf('?')
  if (q >= 0) h = h.slice(0, q)
  h = h.trim()
  if (!h || /\s/.test(h)) throw new Error('Invalid server address.')
  // basic hostname:port sanity — letters, digits, dots, dashes, colons (ipv6), brackets
  if (!/^[A-Za-z0-9.\-_:[\]]+$/.test(h)) throw new Error('Invalid server address.')
  if (h.length > 253) throw new Error('Server address too long.')
  return h
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Loopback + RFC1918 (and IPv6 loopback). The old gateway.ts `isLocalHost`
 * logic, generalized: `::1` and bracketed IPv6 now actually match (the bare
 * `'::1'.split(':')[0] === ''` comparison never did), and the RFC1918
 * prefixes apply ONLY to numeric IPv4 literals — a public DNS name like
 * `10.example.com` must not slip through the gate.
 */
export function isPrivateHost(host: string): boolean {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    // bracketed IPv6, maybe with a port: "[::1]" / "[::1]:9119"
    const end = h.indexOf(']')
    h = end >= 0 ? h.slice(1, end) : h.slice(1)
  } else {
    // strip a single ":port" — a bare IPv6 literal keeps its colons
    if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(':'))
  }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
  const m = IPV4.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * The C-05 gate: does opening this connection as plaintext (tls === false)
 * to this host need an explicit user confirmation? True exactly for
 * non-private hosts — a public ws:// carries the pairing token in the URL
 * in clear text, so it must never be silent.
 */
export function needsPlaintextConfirm(host: string, tls: boolean): boolean {
  return tls === false && !isPrivateHost(host)
}
