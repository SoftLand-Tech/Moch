import { connConfig, type ConnConfig } from './gateway'
import { log } from './log'
import { isPrivateHost } from './transportGate'

export function httpBase(c: ConnConfig): string {
  // C-05 (#95): the session token rides the X-Hermes-Session-Token header —
  // over http:// to a PUBLIC host that is cleartext to every hop. Refused
  // unless the user explicitly confirmed plaintext pairing to this host
  // (same flag the gateway dial enforces). Private hosts (loopback embedded
  // runtime, LAN pairing) keep the documented plaintext flow untouched.
  if (!c.tls && !isPrivateHost(c.host) && !c.plaintextConfirmed) {
    throw new Error(`Refusing unencrypted http:// to ${c.host} — pair over TLS or confirm the plaintext connection.`)
  }
  return `${c.tls ? 'https' : 'http'}://${c.host}`
}

function currentConfig(): ConnConfig {
  const c = connConfig.get()
  if (!c) throw new Error('Not connected')
  return c
}

/**
 * Authenticated REST call to the Hermes dashboard HTTP API.
 * Auth: X-Hermes-Session-Token header (server also accepts Bearer).
 */
export async function apiFetch<T>(
  path: string,
  opts?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const c = currentConfig()
  const ctrl = new AbortController()
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${httpBase(c)}${path}`, {
      method: opts?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Token': c.token,
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`)
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${path}`)
    }
    log('error', 'http', `${path} failed: ${String(err)}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
