/**
 * Thin data helpers for the onboarding providers step
 * (app/app/onboarding/providers.tsx) — every wire call lives here so the
 * screen stays presentational.
 *
 * Two backends, chosen by the thinker:
 *  - OpenCode (`oc*`) — the guest server's own integration list + key connect
 *    (OPENCODE-MODE wire contract). Its free models need no key at all.
 *  - Moch (`moch*`)   — the embedded gateway's provider inventory and the
 *    `model.save_key` flow, exactly what the Models screen uses. A save takes
 *    effect on live sessions immediately (rpc_thinker refreshes them).
 *
 * No UI imports in this file.
 */
import { ocIntegrations, ocConnectKey, ocModels, OcError } from './opencodeClient'
import { fetchModelOptions, saveProviderKey, rankProviders, type ProviderOption } from './modelState'

export interface OcProviderEntry {
  id: string
  name: string
}

/** The guest server's provider-auth integrations, flattened for row rendering. */
export async function ocProviderCatalog(): Promise<OcProviderEntry[]> {
  const list = await ocIntegrations()
  return (Array.isArray(list) ? list : []).map((i) => ({
    id: i.integrationID ?? i.id,
    name: i.name || i.id,
  }))
}

/** Connect one OpenCode integration with a pasted key. */
export async function ocConnectProvider(id: string, key: string): Promise<void> {
  await ocConnectKey(id, key)
}

/** How many models the guest server offers (free ones need no key). */
export async function ocModelCount(): Promise<number> {
  const models = await ocModels()
  return Array.isArray(models) ? models.length : 0
}

/** True when the OpenCode server itself is unreachable (not an HTTP answer). */
export function ocUnreachable(e: unknown): boolean {
  return e instanceof OcError && e.status === 0
}

/**
 * The gateway's provider inventory for the Moch thinker, picker-ranked.
 * Forced refresh: a cached atom would render stale authentication flags.
 */
export async function mochProviders(): Promise<ProviderOption[]> {
  const opts = await fetchModelOptions(undefined, { force: true })
  return rankProviders(opts.providers)
}

/** Store a provider key for the Moch thinker; returns the updated provider. */
export async function mochSaveKey(slug: string, key: string): Promise<ProviderOption | null> {
  const p = await saveProviderKey(slug, key)
  return p ?? null
}
