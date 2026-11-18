/**
 * The OpenCode command registry (issue 16): the official opencode slash
 * commands, fetched from the server (GET /api/command) — never hardcoded.
 *
 * Cache contract: ~60 s TTL, force-refreshed after the OC server (re)starts
 * (opencodeChat's ensure path calls loadOcCommands({force:true})), and it
 * NEVER throws — callers get the last known list (possibly empty) so a
 * downed server can't break the palette or a send.
 *
 * This module is imported lazily by lib/slash.ts (behind a dynamic import,
 * like ./gateway) so the plain-node slash tests never load opencodeClient's
 * RN/expo transport chain.
 */
import { atom } from 'nanostores'
import { ocCommands, type OcCommand } from './opencodeClient'
import { log } from './log'

/** The cached official command list (empty until the first successful load). */
export const ocCommandListAtom = atom<OcCommand[]>([])

const CACHE_TTL_MS = 60_000
let lastLoad = 0
let inFlight: Promise<OcCommand[]> | null = null

/** Tolerant of `{data:[...]}` vs `[...]` on the wire (ocFetch already
 *  unwraps the `{location, data}` envelope; belt-and-braces for the rest). */
function normalize(list: unknown): OcCommand[] {
  const raw = Array.isArray(list)
    ? list
    : list && typeof list === 'object' && Array.isArray((list as { data?: unknown }).data)
      ? (list as { data: unknown[] }).data
      : []
  const out: OcCommand[] = []
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      const { name, description } = item as { name: string; description?: unknown }
      out.push({ name, ...(typeof description === 'string' ? { description } : {}) })
    }
  }
  return out
}

/**
 * Load (or refresh) the command registry. Concurrent calls share one flight;
 * failures keep the previous cache and are logged, never thrown.
 */
export async function loadOcCommands(opts?: { force?: boolean }): Promise<OcCommand[]> {
  if (!opts?.force) {
    if (inFlight) return inFlight
    if (lastLoad && Date.now() - lastLoad < CACHE_TTL_MS) return ocCommandListAtom.get()
  }
  inFlight = (async () => {
    try {
      const cmds = normalize(await ocCommands())
      ocCommandListAtom.set(cmds)
      lastLoad = Date.now()
      return cmds
    } catch (e) {
      // Empty list on failure — but keep whatever was cached before so a
      // transient blip mid-session doesn't wipe the palette.
      log('info', 'opencode', `command list failed: ${e instanceof Error ? e.message : String(e)}`)
      return ocCommandListAtom.get()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Cached commands whose name starts with the typed prefix (no slash). */
export function filterOcCommands(prefix: string): OcCommand[] {
  const p = prefix.toLowerCase().replace(/^\/+/, '')
  const list = ocCommandListAtom.get()
  if (!p) return list
  return list.filter((c) => c.name.toLowerCase().startsWith(p))
}

/** True when `name` (with or without the leading slash) is a known OC command. */
export function isOcCommandName(name: string): boolean {
  const bare = name.toLowerCase().replace(/^\/+/, '')
  if (!bare) return false
  return ocCommandListAtom.get().some((c) => c.name.toLowerCase() === bare)
}

/** One-shot mode has no server and no command registry — commands are moot. */
export function ocCommandsAvailable(): boolean {
  return ocCommandListAtom.get().length > 0
}

/**
 * The per-turn command payload for a leading-slash text: `{name, rest}` when
 * the first token is a KNOWN OC command (and the registry has loaded — an
 * empty cache honestly says "unknown", so the text goes out as a plain
 * prompt). Null otherwise.
 */
export function ocCommandTurnPayload(text: string): { name: string; text: string } | null {
  if (!text.startsWith('/') || !ocCommandsAvailable()) return null
  const body = text.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
  const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
  if (!name || !isOcCommandName(name)) return null
  return { name, text: rest }
}
