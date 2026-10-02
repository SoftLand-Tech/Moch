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

/** A curated catalog entry — `mcp.catalog` (one-tap install via `preset`). */
export interface McpCatalogEntry {
  name: string
  description: string
  installed: boolean
  enabled: boolean
  /** Env keys the server needs before it can work (API keys etc.). */
  requires: string[]
  transport: string
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
  } catch (err) {
    if (isMethodNotFound(err)) {
      mcpUnsupported.set(true)
      mcpServers.set([])
    } else {
      log('warn', 'mcp', `mcp.servers.list failed: ${String(err)}`)
    }
  } finally {
    mcpLoading.set(false)
  }
}

/** Curated catalog — installed flags refresh with it. */
export async function loadMcpCatalog(): Promise<void> {
  if (!isConnected.get()) return
  catalogLoading.set(true)
  try {
    const res = await rpc<{ servers?: McpCatalogEntry[] }>('mcp.catalog', {})
    mcpCatalog.set(res?.servers ?? [])
    mcpUnsupported.set(false)
  } catch (err) {
    if (isMethodNotFound(err)) mcpUnsupported.set(true)
    else log('warn', 'mcp', `mcp.catalog failed: ${String(err)}`)
  } finally {
    catalogLoading.set(false)
  }
}

/**
 * Install a catalog entry (`hermes mcp install <name>`'s RPC twin). The
 * catalog id doubles as the preset id; the server keeps its own name.
 */
export async function installCatalogServer(name: string): Promise<void> {
  await rpc('mcp.servers.add', { name, preset: name })
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

/**
 * Push a config change into the running agent (`/reload-mcp`'s RPC). The
 * caller confirms first — the reload invalidates the agent's prompt cache —
 * so we pass `confirm: true` and never trip the server's confirm round-trip.
 * Safe without a session_id: it refreshes every live session.
 */
export async function reloadAgentMcp(): Promise<void> {
  await rpc('reload.mcp', { confirm: true })
}
