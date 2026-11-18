/**
 * i18n types. Four locales ship: English, Arabic (RTL), Chinese and French.
 *
 * A feature catalog (`Catalog`) maps every locale to a flat key→string map.
 * Keys are dotted and scoped by domain (`chat.send`, `fleet.empty.title`).
 * `{placeholder}` tokens interpolate from the variables passed to tr().
 */
export type Locale = 'en' | 'ar' | 'zh' | 'fr'

export type Messages = Record<string, string>

/** A complete four-locale catalog — every domain file must fill all four. */
export type Catalog = Record<Locale, Messages>

/** Locale metadata for the Settings language picker (native names). */
export const LOCALES: { id: Locale; native: string; english: string; rtl: boolean }[] = [
  { id: 'en', native: 'English', english: 'English', rtl: false },
  { id: 'ar', native: 'العربية', english: 'Arabic', rtl: true },
  { id: 'zh', native: '中文', english: 'Chinese', rtl: false },
  { id: 'fr', native: 'Français', english: 'French', rtl: false },
]
