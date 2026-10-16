/**
 * Connectors — model providers (model.options / model.save_key /
 * model.disconnect) and MCP servers (mcp.servers.* / mcp.catalog). The provider
 * save path takes {slug, api_key} on this gateway and {provider, key} on other
 * generations, so both spellings are always sent. Everything is normalized;
 * a malformed row is skipped, never fatal.
 */
import { rpc } from './gateway'

type Rec = Record<string, unknown>

const asRec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []

/** Tool-level failures ride in-band ({error} / {ok:false}) — turn them into throws. */
function check(res: unknown, what: string): Rec {
  const r = asRec(res)
  const err = str(r.error)
  if (err) throw new Error(err)
  if (r.ok === false && str(r.message)) throw new Error(str(r.message) as string)
  if (r.success === false) throw new Error(`${what} failed`)
  return r
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

// ── Model providers ──────────────────────────────────────────────────────────

export interface ProviderInfo {
  slug: string
  name: string
  models: string[]
  /** null = the gateway didn't say. */
  authenticated: boolean | null
  isCurrent: boolean
  freeTier: boolean | null
  warning: string | null
}

function normalizeProvider(raw: unknown): ProviderInfo | null {
  const r = asRec(raw)
  const slug = str(r.slug) ?? str(r.id) ?? str(r.key)
  if (!slug) return null
  return {
    slug,
    name: str(r.name) ?? str(r.label) ?? slug,
    models: strArr(r.models),
    authenticated: boolOrNull(r.authenticated),
    isCurrent: boolOrNull(r.is_current) ?? boolOrNull(r.isCurrent) ?? false,
    freeTier: boolOrNull(r.free_tier) ?? boolOrNull(r.freeTier),
    warning: str(r.warning),
  }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await rpc<unknown>('model.options', {}, 15000)
  const r = check(res, 'model.options')
  const rows: unknown[] = Array.isArray(r.providers)
    ? r.providers
    : Array.isArray(r.items)
      ? r.items
      : Array.isArray(res)
        ? (res as unknown[])
        : []
  return rows.map(normalizeProvider).filter((p): p is ProviderInfo => p !== null)
}

/** Both param spellings travel together: {slug, api_key} (verified) + {provider, key} (spec forks). */
export async function saveProviderKey(slug: string, apiKey: string): Promise<void> {
  check(
    await rpc<unknown>('model.save_key', { slug, api_key: apiKey, provider: slug, key: apiKey }, 30000),
    'saving the key',
  )
}

export async function disconnectProvider(slug: string): Promise<void> {
  check(await rpc<unknown>('model.disconnect', { slug, provider: slug }, 20000), 'disconnecting')
}

// ── MCP servers ──────────────────────────────────────────────────────────────

export interface McpServer {
  name: string
  status: string | null
  connected: boolean | null
  enabled: boolean | null
  tools: string[]
  transport: string | null
  url: string | null
  command: string | null
}

function normalizeTools(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const t of v) {
    if (typeof t === 'string') out.push(t)
    else {
      const n = str(asRec(t).name)
      if (n) out.push(n)
    }
  }
  return out
}

function normalizeServer(raw: unknown): McpServer | null {
  const r = asRec(raw)
  const name = str(r.name) ?? str(r.id)
  if (!name) return null
  return {
    name,
    status: str(r.status),
    connected: boolOrNull(r.connected),
    enabled: boolOrNull(r.enabled),
    tools: normalizeTools(r.tools),
    transport: str(r.transport),
    url: str(r.url),
    command: str(r.command),
  }
}

export async function listMcpServers(): Promise<McpServer[]> {
  const res = await rpc<unknown>('mcp.servers.list', {}, 15000)
  const r = check(res, 'mcp.servers.list')
  const rows: unknown[] = Array.isArray(r.servers)
    ? r.servers
    : Array.isArray(res)
      ? (res as unknown[])
      : []
  return rows.map(normalizeServer).filter((s): s is McpServer => s !== null)
}

export interface McpProbe {
  ok: boolean
  detail: string
}

/** Cheap status first (mcp.servers.status, cached runtime state); fall back to a real connect test. */
export async function probeMcpServer(name: string): Promise<McpProbe> {
  try {
    const r = check(await rpc<unknown>('mcp.servers.status', { name }, 20000), 'mcp.servers.status')
    const rows = Array.isArray(r.servers) ? r.servers : []
    const row = rows.map(asRec).find((x) => str(x.name) === name)
    if (row) {
      const status = str(row.status)
      const connected = boolOrNull(row.connected)
      if (status || connected !== null) {
        const ok = connected !== null ? connected : !/error|fail|disconnected|not connected/i.test(status ?? '')
        return { ok, detail: status ?? (connected ? 'connected' : 'not connected') }
      }
    }
  } catch {
    /* status unsupported or silent — try the heavier test below */
  }
  const t = check(await rpc<unknown>('mcp.servers.test', { name }, 45000), 'mcp.servers.test')
  const ok = asRec(t).ok === true
  return { ok, detail: ok ? `${normalizeTools(t.tools).length} tools reachable` : (str(asRec(t).error) ?? 'test failed') }
}

/**
 * Add a server: {name, config:{url|command,args,env}} on this gateway, flat
 * params on spec forks, optional catalog preset. Throws with the gateway's
 * refusal message when rejected.
 */
export async function addMcpServer(
  name: string,
  config: Record<string, unknown> | null,
  preset?: string,
): Promise<void> {
  const params: Rec = { name }
  if (preset) params.preset = preset
  if (config) {
    params.config = config
    for (const [k, v] of Object.entries(config)) {
      if (k !== 'name') params[k] = v
    }
  }
  check(await rpc<unknown>('mcp.servers.add', params, 20000), 'adding the server')
}

export async function removeMcpServer(name: string): Promise<void> {
  check(await rpc<unknown>('mcp.servers.remove', { name }, 20000), 'removing the server')
}

// ── Installable catalog (best-effort; hidden when unavailable) ───────────────

export interface McpCatalogEntry {
  name: string
  description: string
  installed: boolean
  enabled: boolean
  requires: string[]
}

export async function listMcpCatalog(): Promise<McpCatalogEntry[]> {
  try {
    const res = await rpc<unknown>('mcp.catalog', {}, 15000)
    const r = asRec(res) // catalog failures stay soft
    const err = str(r.error)
    if (err) return []
    const rows: unknown[] = Array.isArray(r.servers) ? r.servers : Array.isArray(r.catalog) ? r.catalog : []
    return rows
      .map((x): McpCatalogEntry | null => {
        const e = asRec(x)
        const name = str(e.name)
        if (!name) return null
        return {
          name,
          description: str(e.description) ?? '',
          installed: e.installed === true,
          enabled: e.enabled === true,
          requires: strArr(e.requires),
        }
      })
      .filter((e): e is McpCatalogEntry => e !== null)
  } catch {
    return []
  }
}

/** Dot class for a server row: green when connected/running, red on error words, gray otherwise. */
export function mcpDotClass(s: McpServer): string {
  const st = (s.status ?? '').toLowerCase()
  if (/error|fail/.test(st)) return 'bad'
  if (s.connected === true || /running|connected|ok/.test(st)) return 'ok'
  if (s.enabled === false) return 'idle'
  return s.connected === false ? 'warn' : 'idle'
}
