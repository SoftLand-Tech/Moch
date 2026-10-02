/**
 * Design tokens + theme system.
 *
 * Two themes ship: `mocheme` (default — Mochi's palette and the mochi shape
 * language) and `relay` (the classic cyan-on-teal palette with the flat
 * ChatGPT shapes this app shipped with).
 *
 * NAMING: Mochi is the assistant, Moch is the app, Mocheme is the theme.
 *
 * HOW SWITCHING WORKS: `C` (colors) and `S` (shape/string tokens) are MUTATED
 * in place by `applyTheme`. Styles must therefore never be snapshotted at
 * module scope — every screen builds its StyleSheet through `useStyles`, which
 * subscribes the component to `themeVersion` and re-runs the factory on
 * switches, so a theme change restyles the whole running app without a
 * reload. Components that branch on shapes at render time use `useShape`.
 *
 * Palette notes (mocheme): extracted from Mochi — cream body #F8EFE5, visor
 * navy #2B283B, sprout orange #F79236, blush #FA9B6A. Surfaces derive from
 * the visor navy kept near-black, the sprout orange is the single accent
 * reserved for primary actions, and every neutral is hue-locked to the navy
 * band. Anything sitting on the accent uses `onAccent` — dark ink — because
 * white fails contrast (2.3:1) on this lightness of orange. The user's bubble
 * is Mochi's cream with visor-navy ink (`userText`).
 *
 * Palette notes (relay): brand cyan #39CADB on dark teal #0E181B, neutrals
 * hue-locked to the same 186–194° band.
 */
import { useMemo } from 'react'
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type ThemeId = 'mocheme' | 'relay'

export interface Palette {
  // Surfaces
  bg: string
  bgCard: string
  bgElev: string
  bgHover: string
  inputBg: string
  scrim: string

  // Text
  text: string
  textDim: string
  textFaint: string

  // Accent — reserved for primary actions. `onAccent` is the ink that sits on it.
  accent: string
  accentDark: string
  onAccent: string

  // Status
  green: string
  greenSoft: string
  red: string
  amber: string

  // Derived soft tints — translucent washes (12% of the parent ink);
  // accentSoft doubles as the code_inline background so cards and chat prose
  // render inline code identically. No component hardcodes an rgba of a token.
  accentSoft: string
  redSoft: string
  amberSoft: string
  greenTint: string

  border: string
  borderSoft: string

  // Messages — the assistant is unboxed (relay) or a soft blob card
  // (mocheme); the user sits in a bubble whose ink is `userText`.
  userBubble: string
  userText: string
  assistantBubble: string

  // Mochi accents — blush warms the thinking dots and swatches; thinkBorder
  // outlines the dashed thinking pill (transparent = no outline, relay);
  // btnTint washes the composer's round buttons (transparent = plain, relay).
  blush: string
  thinkBorder: string
  btnTint: string
}

export interface Shape {
  radiusCard: number
  radiusBubble: number
  /** The user bubble's bottom-right corner — the speech-bubble tail. */
  radiusBubbleTail: number
  radiusComposer: number
  radiusChip: number
  composerBorder: number
  sendSize: number
  /** Assistant replies sit in a soft card instead of running unboxed. */
  assistantCard: boolean
  /** A small Mochi avatar hangs beside every assistant reply. */
  assistantAvatar: boolean
  /** The top bar becomes a floating rounded tray. */
  trayHeader: boolean
  /** The thinking pill gets its dashed outline. */
  dashedThinking: boolean
  /** The drawer panel gets a rounded right cap. */
  drawerRoundedCap: boolean
  /** The header model chip washes with accentSoft. */
  modelChipTint: boolean
  /** Core UI glyphs render from Mochi's hand-drawn set (mochi-icons/) instead
   *  of Ionicons — Icon.tsx falls back per-name for unmapped glyphs. */
  mochiIcons: boolean
  askPlaceholder: string
}

const MOHEME_PALETTE: Palette = {
  // Surfaces — hue-matched to Mochi's visor navy, kept near-black.
  bg: '#0A0813',
  bgCard: '#151220',
  bgElev: '#1A1727',
  bgHover: '#272535',
  inputBg: '#1A1727',
  scrim: 'rgba(0,0,0,0.55)',

  // Text
  text: '#FFFFFF',
  textDim: '#B4B1C4',
  textFaint: '#86829B',

  // Accent — Mochi's sprout orange.
  accent: '#F79236',
  accentDark: '#C56F1F',
  onAccent: '#2E1A08',

  // Status
  green: '#10A37F',
  greenSoft: '#4ADE80',
  red: '#FF5A5A',
  amber: '#F5A524',

  accentSoft: 'rgba(247,146,54,0.12)',
  redSoft: 'rgba(255,90,90,0.12)',
  amberSoft: 'rgba(245,165,36,0.12)',
  greenTint: 'rgba(74,222,128,0.12)',

  border: 'rgba(248,239,229,0.11)',
  borderSoft: 'rgba(248,239,229,0.06)',

  userBubble: '#F6ECE1',
  userText: '#2B283B',
  assistantBubble: 'transparent',

  blush: '#FA9B6A',
  thinkBorder: 'rgba(248,239,229,0.25)',
  btnTint: 'rgba(248,239,229,0.06)',
}

const RELAY_PALETTE: Palette = {
  // Surfaces — hue-matched to the logo cyan, kept near-black.
  bg: '#060D0F',
  bgCard: '#121B1D',
  bgElev: '#162022',
  bgHover: '#233134',
  inputBg: '#162022',
  scrim: 'rgba(0,0,0,0.55)',

  // Text
  text: '#FFFFFF',
  textDim: '#AEBDBF',
  textFaint: '#829396',

  // Accent — the Relay logo cyan.
  accent: '#39CADB',
  accentDark: '#2795A3',
  onAccent: '#052529',

  // Status
  green: '#10A37F',
  greenSoft: '#4ADE80',
  red: '#FF5A5A',
  amber: '#F5A524',

  accentSoft: 'rgba(57,202,219,0.12)',
  redSoft: 'rgba(255,90,90,0.12)',
  amberSoft: 'rgba(245,165,36,0.12)',
  greenTint: 'rgba(74,222,128,0.12)',

  border: '#26383A',
  borderSoft: '#1A2628',

  userBubble: '#1F2C2F',
  userText: '#FFFFFF',
  assistantBubble: 'transparent',

  blush: '#829396',
  thinkBorder: 'transparent',
  btnTint: 'transparent',
}

const MOHEME_SHAPE: Shape = {
  radiusCard: 16,
  radiusBubble: 24,
  radiusBubbleTail: 8,
  radiusComposer: 32,
  radiusChip: 999,
  composerBorder: 1.5,
  sendSize: 38,
  assistantCard: true,
  assistantAvatar: true,
  trayHeader: true,
  dashedThinking: true,
  drawerRoundedCap: true,
  modelChipTint: true,
  mochiIcons: true,
  askPlaceholder: 'Ask Mochi…',
}

const RELAY_SHAPE: Shape = {
  radiusCard: 12,
  radiusBubble: 20,
  radiusBubbleTail: 20,
  radiusComposer: 26,
  radiusChip: 13,
  composerBorder: 1,
  sendSize: 34,
  assistantCard: false,
  assistantAvatar: false,
  trayHeader: false,
  dashedThinking: false,
  drawerRoundedCap: false,
  modelChipTint: false,
  mochiIcons: false,
  askPlaceholder: 'Ask Hermes',
}

const PALETTES: Record<ThemeId, Palette> = { mocheme: MOHEME_PALETTE, relay: RELAY_PALETTE }
const SHAPES: Record<ThemeId, Shape> = { mocheme: MOHEME_SHAPE, relay: RELAY_SHAPE }

/** Live token objects — mutated in place by applyTheme, read by style factories. */
export const C = { ...MOHEME_PALETTE }
export const S = { ...MOHEME_SHAPE }

/** Bumps on every switch; useStyles subscribes to it. */
export const themeVersion = atom(0)
export const themeId = atom<ThemeId>('mocheme')

/** Apply a theme to the live tokens. Screens restyle via useStyles. */
export function applyTheme(id: ThemeId) {
  Object.assign(C, PALETTES[id])
  Object.assign(S, SHAPES[id])
  themeId.set(id)
  themeVersion.set(themeVersion.get() + 1)
}

const THEME_KEY = 'hermes.theme.v1'

/** Restore the saved theme (default: Mocheme). Call once at startup. */
export async function loadTheme() {
  try {
    const saved = await AsyncStorage.getItem(THEME_KEY)
    if (saved === 'mocheme' || saved === 'relay') applyTheme(saved)
  } catch {
    // Storage failure keeps the default.
  }
}

/** Switch and persist the theme. */
export async function setTheme(id: ThemeId) {
  try {
    await AsyncStorage.setItem(THEME_KEY, id)
  } catch {
    // Apply anyway for this run.
  }
  applyTheme(id)
}

/**
 * Build a component's styles from the live tokens and restyle it on theme
 * switches. The factory must read C/S (not closed-over constants):
 *
 *   const makeS = () => StyleSheet.create({ box: { backgroundColor: C.bgCard } })
 *   function MyComponent() {
 *     const s = useStyles(makeS)
 *     ...
 *   }
 */
export function useStyles<T>(make: () => T): T {
  const v = useStore(themeVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => make(), [v])
}

/** Shape/string tokens for render-time branchings (avatar, cards, labels). */
export function useShape(): Shape {
  useStore(themeVersion)
  return S
}

/** The Appearance picker's entries. */
export const THEME_OPTIONS: { id: ThemeId; name: string; desc: string; swatches: string[] }[] = [
  {
    id: 'mocheme',
    name: 'Mocheme',
    desc: "Mochi's palette + cute mochi shapes",
    swatches: [MOHEME_PALETTE.bg, MOHEME_PALETTE.accent, MOHEME_PALETTE.userBubble, MOHEME_PALETTE.blush],
  },
  {
    id: 'relay',
    name: 'Relay',
    desc: 'The classic cyan-on-teal look',
    swatches: [RELAY_PALETTE.bg, RELAY_PALETTE.accent, RELAY_PALETTE.userBubble, RELAY_PALETTE.bgElev],
  },
]

export const FONT = { regular: '400', medium: '500', bold: '700' } as const

/** ChatGPT-style pill. `size` is the pill height; radius is always half of it. */
export function pill(height: number) {
  return { borderRadius: height / 2, minHeight: height }
}
