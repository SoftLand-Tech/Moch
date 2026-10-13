/**
 * Pure dial-transport helpers (C-02 header-auth dials + legacy query dials).
 *
 * Extracted from gateway.ts so scripts/ can exercise them in plain node —
 * gateway.ts itself pulls AsyncStorage / expo-secure-store / react-native in
 * at module scope and cannot load outside the app runtime (same rule as
 * transportGate.ts). Everything here is a pure function of its inputs: no
 * module state, no storage, no platform. gateway.ts keeps the per-process
 * salt and the lazy push-token read, and calls in with both.
 */

/** Structural slice of gateway's ConnConfig that the dial builders read. */
export interface DialTarget {
  host: string
  token: string
  tls: boolean
}

export type DialTransport = 'headers' | 'query'

/** Tiny FNV-1a — this is a change-detector, not a crypto hash. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Build the WebSocket dial URL.
 *
 * 'headers' carries the session/push tokens in X-Hermes-Session-Token /
 * X-Hermes-Push-Token upgrade headers (they never appear in a URL, so no
 * proxy access log or browser history sees them); the relay routes
 * header-auth phones and rewrites the FORWARDED request line for the home.
 * A short salted fingerprint of the push token rides the query instead of
 * the token itself: the client no-ops a redial to the SAME URL while its
 * socket is open, and the fingerprint changes exactly when the push token
 * does — which is what the push re-advertise path relies on.
 * 'query' is the legacy ?token=&push= form every older peer understands —
 * kept as the fallback dial() retries once on refusal.
 */
export function buildDialUrl(c: DialTarget, mode: DialTransport, pushToken: string | null, pushfpSalt: string): string {
  const base = `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws`
  if (mode === 'headers') {
    if (!pushToken) return base // token/push ride the upgrade headers — see buildDialHeaders()
    return `${base}?pushfp=${fnv1a(pushfpSalt + pushToken)}`
  }
  // Legacy: token on the query, so the backend can knock while the socket is
  // down. Direct gateway connections and pre-header relays still need this.
  let u = `${base}?token=${encodeURIComponent(c.token)}`
  if (pushToken) u += `&push=${encodeURIComponent(pushToken)}`
  return u
}

/**
 * Upgrade-request headers for a header-mode dial: the session token always,
 * the Expo push token when the app holds one (the relay forwards it onto the
 * request line it rebuilds for the home, so the push watcher keeps working).
 */
export function buildDialHeaders(c: DialTarget, pushToken: string | null): Record<string, string> {
  const h: Record<string, string> = { 'X-Hermes-Session-Token': c.token }
  if (pushToken) h['X-Hermes-Push-Token'] = pushToken
  return h
}

/**
 * Auth-shaped dial failure: the peer answered/refused the upgrade (error or
 * close BEFORE open) rather than us timing out — exactly the shape a
 * direct-to-gateway home or an old relay produces for a header-auth dial.
 * Timeouts are deliberately excluded: a second attempt would only double the
 * wait.
 */
export function isHandshakeRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /closed during handshake|error before open/i.test(msg)
}

/** Scrubbed URL safe for logs/UI — never prints the token. */
export function redactedUrl(c: { host: string; tls: boolean }): string {
  return `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws?token=***`
}
