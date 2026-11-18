/**
 * i18n facade — the app-wide translation API.
 *
 * Four locales ship: English (en), Arabic (ar — RTL), Chinese (zh) and French
 * (fr). The catalogs live in ./i18n (one file per domain, four locales each);
 * this module owns the reactive locale atom, persistence, tr()/useT(), and the
 * direction helpers screens use to mirror their layout for Arabic.
 *
 * Usage in a screen:
 *   const tr = useT()            // or call tr('key') directly when the screen
 *                                // is guaranteed to re-mount on a locale switch
 *   const dir = useDir()         // rtl/row/textAlign/writingDirection/icon
 *   <View style={{ flexDirection: dir.row }}>
 *     <Txt>{t('chat.send')}</Txt>
 */
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { BUNDLES, LOCALES, translate, type Locale } from './i18n'

export type { Locale }
export { LOCALES as LOCALE_OPTIONS }

export const localeAtom = atom<Locale>('en')

const LOCALE_KEY = 'hermes.locale.v1'

const SUPPORTED: Locale[] = ['en', 'ar', 'zh', 'fr']

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED as string[]).includes(v)
}

/** Restore the saved locale. Call once at startup (root layout). */
export async function loadLocale(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(LOCALE_KEY)
    if (isLocale(saved)) localeAtom.set(saved)
  } catch {
    // default en
  }
}

/** Switch and persist the app language. */
export async function setLocale(l: Locale): Promise<void> {
  localeAtom.set(l)
  try {
    await AsyncStorage.setItem(LOCALE_KEY, l)
  } catch {
    // apply anyway for this run
  }
}

/** True when the active locale is RTL (Arabic). */
export function isRTL(): boolean {
  return localeAtom.get() === 'ar'
}

/** Translate a key in the active locale; {placeholders} interpolate from vars. */
export function tr(key: string, vars?: Record<string, string | number>): string {
  return translate(localeAtom.get(), key, vars)
}

/** Subscribe to locale changes and return a bound tr(). */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const loc = useStore(localeAtom)
  return (key: string, vars?: Record<string, string | number>) => translate(loc, key, vars)
}

/** Layout direction helpers — mirror rows/text/icons for Arabic. */
export interface Dir {
  rtl: boolean
  row: 'row' | 'row-reverse'
  textAlign: 'left' | 'right'
  writingDirection: 'ltr' | 'rtl'
  /** Chevron icon names that point "forward"/"back" in this direction. */
  icon: { forward: string; back: string }
}

export function dirOf(locale: Locale): Dir {
  const rtl = locale === 'ar'
  return {
    rtl,
    row: rtl ? 'row-reverse' : 'row',
    textAlign: rtl ? 'right' : 'left',
    writingDirection: rtl ? 'rtl' : 'ltr',
    icon: rtl
      ? { forward: 'chevron-back', back: 'chevron-forward' }
      : { forward: 'chevron-forward', back: 'chevron-back' },
  }
}

/** Subscribe to direction — re-renders the calling component on locale switches. */
export function useDir(): Dir {
  const loc = useStore(localeAtom)
  return dirOf(loc)
}

/** Whether a raw catalog entry is missing (used by the i18n completeness test). */
export function missingKeys(locale: Locale): string[] {
  const en = BUNDLES.en
  const bundle = BUNDLES[locale] ?? {}
  return Object.keys(en).filter((k) => !bundle[k] || !bundle[k].trim())
}
