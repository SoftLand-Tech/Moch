/**
 * Theme contract: CSS custom properties generated from the live shared
 * tokens (src/lib/theme.ts C object). Re-generated on theme switch — no
 * hex literals anywhere in the desktop UI, so the Relay theme works.
 */
import { C, themeVersion } from '../../../../../app/src/lib/theme'
import { useSyncExternalStore } from 'react'

const THEME_STAMP = 'data-moch-theme-version'

export function cssVarsText(): string {
  return [
    `--moch-bg:${C.bg}`,
    `--moch-bg-card:${C.bgCard}`,
    `--moch-bg-elev:${C.bgElev ?? C.bgCard}`,
    `--moch-bg-hover:${C.bgHover ?? C.bgCard}`,
    `--moch-accent:${C.accent}`,
    `--moch-accent-soft:${C.accentSoft}`,
    `--moch-text:${C.text}`,
    `--moch-text-dim:${C.textDim}`,
    `--moch-text-faint:${C.textFaint ?? C.textDim}`,
    `--moch-border:${C.border}`,
    `--moch-border-soft:${C.borderSoft ?? C.border}`,
    `--moch-red:${C.red ?? '#f87171'}`,
    `--moch-red-soft:${C.redSoft ?? 'rgba(248,113,113,0.12)'}`,
    `--moch-green-soft:${C.greenSoft ?? 'rgba(74,222,128,0.14)'}`,
    `--moch-font:ui-sans-serif,system-ui,-apple-system,sans-serif`,
    `--moch-mono:ui-monospace,SFMono-Regular,Menlo,monospace`,
  ].join(';')
}

function apply(): void {
  let el = document.getElementById('moch-theme-vars') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'moch-theme-vars'
    document.head.appendChild(el)
  }
  el.textContent = `:root{${cssVarsText()}}`
  document.documentElement.setAttribute(THEME_STAMP, String(themeVersion.get()))
}

/** Idempotent: call once at boot; subscribes for theme switches. */
export function installTheme(): () => void {
  apply()
  return themeVersion.subscribe(apply)
}

const noopSubscribe = () => () => {}

/** Reactive version counter for components that need re-render on theme. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    (cb) => themeVersion.subscribe(cb),
    () => themeVersion.get(),
    () => 0,
  )
}

export { noopSubscribe }
