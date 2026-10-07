/**
 * MCP connector management — the phone-side of the gateway's `mcp.*` RPCs.
 *
 * Hermes exposes the full connector lifecycle over JSON-RPC (mirrors of the
 * `hermes mcp` CLI and the dashboard REST surface): `mcp.catalog` (curated
 * one-tap installs), `mcp.servers.list` (config summary), `mcp.servers.status`
 * (cached runtime state — never connects), `mcp.servers.add` /
 * `set_api_key` / `test` / `remove`, and `reload.mcp` to push a config change
 * into the running agent. Secrets never travel back: list summaries carry env
 * KEY NAMES only, and API keys are written straight into the machine's .env
 * via `set_api_key`.
 */
import { atom } from 'nanostores'
import { isConnected, rpc } from './gateway'
import { apiFetch } from './http'
import { JsonRpcGatewayError, JSON_RPC_METHOD_NOT_FOUND } from '../protocol/json-rpc-gateway'
import { log } from './log'

/** One configured server — `mcp.servers.list`'s summary (no secret values). */
export interface McpServer {
  name: string
  transport: 'http' | 'stdio' | 'unknown'
  url?: string | null
  command?: string | null
  args?: string[]
  /** Env KEY NAMES only — values live in the machine's .env. */
  env?: string[]
  /** 'oauth' | 'header' | null — how the server authenticates. */
  auth?: string | null
  /** null unless auth==='oauth': false means it still needs `hermes mcp login`. */
  oauth_tokens_present?: boolean | null
  enabled?: boolean
  /** Configured tool allowlist, when the server pins one. */
  tools?: string[] | null
}

/** Cached runtime state — `mcp.servers.status` (never connects/probes). */
export interface McpRuntime {
  name: string
  /** Tool count exposed by the live (or lazily registered) server. */
  tools?: number
  connected?: boolean
  disabled?: boolean
  /** connected | disabled | connecting | failed | lazy | configured */
  status?: string
  error?: string
}

/** A curated catalog entry — dashboard `/api/mcp/catalog` (falls back to the RPC). */
export interface McpCatalogEntry {
  name: string
  description: string
  installed: boolean
  enabled: boolean
  /** Env keys the server needs before it can work (API keys etc.). */
  requires: string[]
  transport: string
  /** Transport details — non-git entries install as a plain config via these. */
  url?: string | null
  command?: string | null
  args?: string[]
  /** True when the entry needs a git bootstrap (installed as a background action). */
  needsInstall?: boolean
}

/** `mcp.servers.test` outcome — a real connect + tools/list, so it's slow. */
export interface McpTestResult {
  ok: boolean
  error?: string
  tools: { name: string; description?: string }[]
  prompts?: number
  resources?: number
  oauth_needed?: boolean
  oauth_tokens_present?: boolean | null
}

export const mcpServers = atom<McpServer[]>([])
export const mcpRuntime = atom<Record<string, McpRuntime>>({})
export const mcpCatalog = atom<McpCatalogEntry[]>([])
/**
 * Last `mcp.servers.list` failure message (non-`-32601`), so the screen can
 * show an error banner with Retry instead of a silent empty list.
 */
export const mcpListError = atom<string | null>(null)
/**
 * True once the gateway answered -32601 for an mcp.* call — the connected
 * hermes predates the connector RPCs, so the screen shows an upgrade hint
 * instead of a bare error.
 */
export const mcpUnsupported = atom(false)
export const mcpLoading = atom(false)
export const catalogLoading = atom(false)

function isMethodNotFound(err: unknown): boolean {
  return err instanceof JsonRpcGatewayError && err.code === JSON_RPC_METHOD_NOT_FOUND
}

/** Config + runtime snapshot in one pass; merges status rows by name. */
export async function loadMcpServers(): Promise<void> {
  if (!isConnected.get()) return
  mcpLoading.set(true)
  try {
    const [list, status] = await Promise.all([
      rpc<{ servers?: McpServer[] }>('mcp.servers.list', {}),
      rpc<{ servers?: McpRuntime[] }>('mcp.servers.status', {}).catch(() => ({ servers: [] })),
    ])
    const servers = list?.servers ?? []
    const runtime: Record<string, McpRuntime> = {}
    for (const row of status?.servers ?? []) runtime[row.name] = row
    mcpServers.set(servers)
    mcpRuntime.set(runtime)
    mcpUnsupported.set(false)
    mcpListError.set(null)
  } catch (err) {
    if (isMethodNotFound(err)) {
      mcpUnsupported.set(true)
      mcpServers.set([])
      mcpListError.set(null)
    } else {
      log('warn', 'mcp', `mcp.servers.list failed: ${String(err)}`)
      mcpListError.set(err instanceof Error ? err.message : String(err))
    }
  } finally {
    mcpLoading.set(false)
  }
}

/**
 * Runtime-only refresh — one `mcp.servers.status` RPC (cached state, never a
 * probe), so a mounted screen can poll it cheaply to keep statuses live.
 */
export async function refreshMcpRuntime(): Promise<void> {
  if (!isConnected.get()) return
  try {
    const status = await rpc<{ servers?: McpRuntime[] }>('mcp.servers.status', {})
    const runtime: Record<string, McpRuntime> = {}
    for (const row of status?.servers ?? []) runtime[row.name] = row
    mcpRuntime.set(runtime)
  } catch (err) {
    log('warn', 'mcp', `mcp.servers.status failed: ${String(err)}`)
  }
}

/** Curated catalog — installed flags refresh with it. */
export async function loadMcpCatalog(): Promise<void> {
  if (!isConnected.get()) return
  catalogLoading.set(true)
  try {
    mcpCatalog.set(await fetchCatalog())
    mcpUnsupported.set(false)
  } catch (err) {
    if (isMethodNotFound(err)) mcpUnsupported.set(true)
    else log('warn', 'mcp', `catalog load failed: ${String(err)}`)
  } finally {
    catalogLoading.set(false)
  }
}

interface RestCatalogEntry {
  name: string
  description: string
  transport: string
  url: string | null
  command: string | null
  args: string[]
  required_env: { name: string }[]
  needs_install: boolean
  installed: boolean
  enabled: boolean
}

/**
 * Catalog with transport details. The dashboard REST surface carries the
 * url/command the install needs; the older RPC `mcp.catalog` is the
 * fallback (its entries install via REST too — the server resolves the
 * entry by name, the app never needs the transport itself).
 */
async function fetchCatalog(): Promise<McpCatalogEntry[]> {
  try {
    const rest = await apiFetch<{ entries?: RestCatalogEntry[] }>('/api/mcp/catalog', { timeoutMs: 20_000 })
    return (rest?.entries ?? []).map((e) => ({
      name: e.name,
      description: e.description ?? '',
      installed: !!e.installed,
      enabled: !!e.enabled,
      requires: (e.required_env ?? []).map((r) => r.name),
      transport: e.transport ?? 'stdio',
      url: e.url,
      command: e.command,
      args: e.args ?? [],
      needsInstall: !!e.needs_install,
    }))
  } catch (err) {
    log('warn', 'mcp', `REST catalog failed, falling back to RPC: ${String(err)}`)
    const res = await rpc<{ servers?: McpCatalogEntry[] }>('mcp.catalog', {})
    return res?.servers ?? []
  }
}

/**
 * Install a catalog entry — the dashboard's official install endpoint (the
 * same one the web dashboard's Install button calls). URL/command entries
 * install synchronously; git-bootstrap entries return `background: true`
 * and land in config a little later.
 */
export async function installCatalogServer(name: string): Promise<void> {
  await apiFetch<{ ok: boolean; background?: boolean }>('/api/mcp/catalog/install', {
    method: 'POST',
    body: { name, enable: true, env: {} },
    timeoutMs: 120_000,
  })
}

export interface CustomServerInput {
  name: string
  /** http(s) URL for remote servers. */
  url?: string
  /** Executable for stdio servers (npx -y …, uvx …, a local binary). */
  command?: string
  args?: string[]
  /** Optional bearer token — persisted to the machine's .env, referenced by header. */
  bearerToken?: string
}

/** Add a custom server by URL or stdio command. */
export async function addCustomServer(input: CustomServerInput): Promise<void> {
  const config: Record<string, unknown> = {}
  if (input.url) config.url = input.url
  if (input.command) {
    config.command = input.command
    if (input.args?.length) config.args = input.args
  }
  const params: Record<string, unknown> = { name: input.name, config }
  if (input.bearerToken) params.bearer_token = input.bearerToken
  await rpc('mcp.servers.add', params)
}

/** Remove a server from the machine's config. */
export async function removeMcpServer(name: string): Promise<void> {
  await rpc('mcp.servers.remove', { name })
}

/** Connect once, list tools, disconnect — can take ~a minute on cold npx. */
export async function testMcpServer(name: string): Promise<McpTestResult> {
  return rpc<McpTestResult>('mcp.servers.test', { name })
}

/** Write an API key into the machine's .env and wire the config reference. */
export async function saveMcpApiKey(name: string, value: string): Promise<void> {
  await rpc('mcp.servers.set_api_key', { name, value })
}

// ── OAuth sign-in (session-backed PKCE) ─────────────────────────────────────

/** `mcp.servers.oauth.start` → `{session_id, auth_url, flow: "pkce"}`. */
export interface McpOauthStart {
  session_id: string
  auth_url: string
  flow: string
}

/** `mcp.servers.oauth.poll` → `{status: pending|approved|error, ...}`. */
export interface McpOauthPoll {
  status: 'pending' | 'approved' | 'error'
  error?: string
}

/**
 * Begin the gateway's session-backed OAuth flow for a server: the phone
 * opens `auth_url` in its own browser, the gateway's loopback callback
 * catches the redirect on the same machine, and the client polls until the
 * flow resolves. (Remote-desktop flows via `client_redirect_uri` relay are
 * deliberately not used here — the embedded gateway is same-device.)
 */
export async function startMcpOauth(name: string): Promise<McpOauthStart> {
  return rpc<McpOauthStart>('mcp.servers.oauth.start', { name })
}

/** Poll an OAuth flow started for this server. */
export async function pollMcpOauth(name: string, oauthSessionId: string): Promise<McpOauthPoll> {
  return rpc<McpOauthPoll>('mcp.servers.oauth.poll', { name, session_id: oauthSessionId })
}

/** Cancel an in-flight OAuth flow, waking the gateway's callback worker. */
export async function cancelMcpOauth(name: string, oauthSessionId: string): Promise<void> {
  await rpc('mcp.servers.oauth.cancel', { name, session_id: oauthSessionId })
}

/**
 * Push a config change into the running agent (`/reload-mcp`'s RPC). The
 * caller confirms first — the reload invalidates the agent's prompt cache —
 * so we pass `confirm: true` and never trip the server's confirm round-trip.
 * Safe without a session_id: it refreshes every live session.
 */
export async function reloadAgentMcp(): Promise<void> {
  await rpc('reload.mcp', { confirm: true })
}
