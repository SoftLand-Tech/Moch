/**
 * Model/provider state — the desktop port of the phone's modelState.ts
 * essentials: current provider/model tracking + the picker's data.
 */

import { atom } from 'nanostores'
import { rpc } from './gateway'

export interface ModelOption {
  id: string
  label?: string
}

export interface ProviderOption {
  slug: string
  name?: string
  authenticated?: boolean
  isCurrent?: boolean
  freeTier?: boolean
  models: ModelOption[]
}

export const providers = atom<ProviderOption[]>([])
export const currentModel = atom<{ provider?: string; model?: string; reasoning?: string }>({})
export const modelError = atom<string>('')

interface ModelOptionsResult {
  providers?: Array<Record<string, unknown>>
  model?: string
  provider?: string
  reasoning?: string
}

function normalizeProviders(res: ModelOptionsResult): ProviderOption[] {
  const rows = res.providers ?? []
  return rows.map((p) => {
    const modelsRaw = Array.isArray(p.models) ? p.models : []
    return {
      slug: String(p.slug ?? p.id ?? p.name ?? ''),
      name: typeof p.name === 'string' ? p.name : undefined,
      authenticated: p.authenticated === true || p.connected === true,
      isCurrent: p.is_current === true || p.current === true,
      freeTier: p.free_tier === true || p.freeTier === true,
      models: modelsRaw.map((m) => {
        if (typeof m === 'string') return { id: m }
        const rec = m as Record<string, unknown>
        return { id: String(rec.id ?? rec.model ?? rec.name ?? ''), label: typeof rec.label === 'string' ? rec.label : typeof rec.name === 'string' ? rec.name : undefined }
      }).filter((m) => m.id),
    }
  }).filter((p) => p.slug)
}

export async function refreshModels(): Promise<void> {
  try {
    const res = await rpc<ModelOptionsResult>('model.options', {}, 15000)
    providers.set(normalizeProviders(res))
    // The gateway names the current model at the TOP level (model+provider),
    // not in a nested current object.
    const currentProvider = provs().find((p) => p.isCurrent)
    currentModel.set({
      provider: typeof res.provider === 'string' ? res.provider : currentProvider?.slug,
      model: typeof res.model === 'string' ? res.model : currentProvider?.models[0]?.id,
      reasoning: typeof res.reasoning === 'string' ? res.reasoning : undefined,
    })
    modelError.set('')
  } catch (e) {
    modelError.set(e instanceof Error ? e.message : String(e))
  }
}

function provs(): ProviderOption[] {
  return providers.get()
}
