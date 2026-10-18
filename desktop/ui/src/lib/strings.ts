/**
 * Moch Desktop i18n: EN/AR catalogs + tr() + the locale store, ported from the
 * mobile app's src/lib/strings.ts. Catalog data lives in ./strings/, one file
 * per domain — new strings go in your domain's file, never in another unit's.
 * scripts/check-strings.mjs proves the merge, EN/AR parity, and zero drift
 * against scripts/strings-snapshot.json.
 */
import { atom } from 'nanostores'
import * as bot from './strings/bot'
import * as chat from './strings/chat'
import * as context from './strings/context'
import * as create from './strings/create'
import * as crew from './strings/crew'
import * as fleet from './strings/fleet'
import * as settings from './strings/settings'
import * as shell from './strings/shell'

export type Locale = 'en' | 'ar'

const LOCALE_KEY = 'moch.desktop.locale.v1'

function readSavedLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'ar' || saved === 'en') return saved
  } catch {
    // storage unavailable (private mode etc.) — default en
  }
  return 'en'
}

/** Active locale; persisted in localStorage under moch.desktop.locale.v1. */
export const locale = atom<Locale>(readSavedLocale())

/** True when the active locale is RTL (drives [dir="rtl"] + row mirroring). */
export function isRTL(): boolean {
  return locale.get() === 'ar'
}

/** Set <html dir> and lang to match the active locale. Safe to call anytime. */
export function applyDirection(): void {
  const l = locale.get()
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (!root) return
  root.dir = l === 'ar' ? 'rtl' : 'ltr'
  root.lang = l
}

/** Switch locale: update the store, persist, and re-apply document direction. */
export function setLocale(l: Locale): void {
  locale.set(l)
  try {
    localStorage.setItem(LOCALE_KEY, l)
  } catch {
    // best-effort
  }
  applyDirection()
}

type Catalog = Record<string, string>

const EN: Catalog = {
  ...fleet.en,
  ...crew.en,
  ...bot.en,
  ...chat.en,
  ...context.en,
  ...create.en,
  ...shell.en,
  ...settings.en,
}

const AR: Catalog = {
  ...fleet.ar,
  ...crew.ar,
  ...bot.ar,
  ...chat.ar,
  ...context.ar,
  ...create.ar,
  ...shell.ar,
  ...settings.ar,
}

const CATALOGS: Record<Locale, Catalog> = { en: EN, ar: AR }

/**
 * Translate a key in the active locale. {placeholders} interpolate from vars.
 * Falls back to the EN text, then to the key itself (missing keys never crash).
 */
export function tr(key: string, vars?: Record<string, string | number>): string {
  const loc = locale.get()
  let out = CATALOGS[loc]?.[key] ?? EN[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(`{${k}}`, String(v))
    }
  }
  return out
}

// Apply the persisted direction on first import so the very first paint matches.
applyDirection()
