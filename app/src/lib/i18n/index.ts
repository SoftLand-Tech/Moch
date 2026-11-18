/**
 * i18n catalogs — one flat key→string bundle per locale.
 *
 * Each domain file owns its own keys (four locales each). The legacy catalog
 * (migrated from the pre-redesign strings.ts) is merged first so a domain key
 * of the same name overrides it. Lookup order in translate():
 *   active locale bundle → English bundle → the key itself.
 */
import type { Catalog, Locale, Messages } from './types'
import { LOCALES } from './types'
import { legacy } from './legacy'
import { core } from './core'
import { chrome } from './chrome'
import { chat } from './chat'
import { sessions } from './sessions'
import { inbox } from './inbox'
import { skills } from './skills'
import { agent } from './agent'
import { terminal } from './terminal'
import { browser } from './browser'
import { connectors } from './connectors'
import { fleet } from './fleet'
import { crew } from './crew'
import { bot } from './bot'
import { automations } from './automations'
import { settings } from './settings'
import { setup } from './setup'
import { ocmode } from './ocmode'

/** Every domain catalog, in merge order (later wins on duplicate keys). */
export const DOMAINS: Catalog[] = [
  core,
  chrome,
  chat,
  sessions,
  inbox,
  skills,
  agent,
  terminal,
  browser,
  connectors,
  fleet,
  crew,
  bot,
  automations,
  settings,
  setup,
  ocmode,
]

function merge(): Record<Locale, Messages> {
  const out: Record<Locale, Messages> = { en: {}, ar: {}, zh: {}, fr: {} }
  const sources: Catalog[] = DOMAINS
  const legacyBundles: Partial<Record<Locale, Messages>> = legacy
  for (const loc of ['en', 'ar', 'zh', 'fr'] as Locale[]) {
    if (legacyBundles[loc]) Object.assign(out[loc], legacyBundles[loc])
    for (const domain of sources) Object.assign(out[loc], domain[loc] || {})
  }
  return out
}

/** Merged bundles: the active-locale dictionary used by tr(). */
export const BUNDLES: Record<Locale, Messages> = merge()

/** All English keys (the source-of-truth key set). */
export function allKeys(): string[] {
  return Object.keys(BUNDLES.en)
}

/** Translate a key for a locale with {placeholder} interpolation + EN fallback. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let out = BUNDLES[locale]?.[key] ?? BUNDLES.en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
  }
  return out
}

export { LOCALES }
export type { Locale, Catalog, Messages }
