/**
 * Sessions | Bots segmented switch — the drawer's top-level identity.
 *
 * Two surfaces over one gateway: Sessions is every conversation, Bots is the
 * profile roster. Presentation follows the redesign mockup's identity switch
 * (`design.html` renderSidebarDrawer): the app's `Segmented` primitive —
 * `--bg` track, hairline border, accent-filled active half with `onAccent`
 * ink. Identity state + persistence stay in `lib/workspace` (the parent owns
 * `identity` / `onChange`); in OpenCode mode the caller locks the switch on
 * Sessions by passing a no-op `onChange`, exactly as before.
 *
 * The mockup labels the Bots half with the roster count ("Bots (3)"); pass
 * `botsCount` to get that. Omitted → the plain localized "Bots".
 */
import React from 'react'
import { View, StyleSheet } from 'react-native'
import { useStore } from '@nanostores/react'
import { Segmented, Txt } from './ui'
import { localeAtom, tr } from '../lib/strings'
import { C, useStyles } from '../lib/theme'
import type { Identity } from '../lib/workspace'

export interface IdentitySwitchProps {
  identity: Identity
  onChange: (i: Identity) => void
  /** Number of named bot profiles — renders "Bots (n)" like the mockup. */
  botsCount?: number
  /**
   * [14] OpenCode mode has no Bots surface: when true the Segmented is not
   * rendered — only a static, already-active "Sessions" label takes its place
   * (an inert half-segment reads as broken). Existing callers omit it and get
   * the two-way switch, unchanged.
   */
  hideBots?: boolean
}

const MODES: Identity[] = ['sessions', 'bots']

export function IdentitySwitch({ identity, onChange, botsCount, hideBots }: IdentitySwitchProps) {
  const s = useStyles(makeS)
  // Re-render on a locale switch so the two labels follow the app language.
  useStore(localeAtom)

  if (hideBots) {
    return (
      <View style={[s.wrap, s.soloWrap]} accessibilityRole="header">
        <Txt size={12.5} weight="700" color={C.text}>
          {tr('sidebar.sessions')}
        </Txt>
      </View>
    )
  }

  const label = (mode: Identity): string =>
    mode === 'sessions'
      ? tr('sidebar.sessions')
      : botsCount && botsCount > 0
        ? tr('chrome.drawer.botsCount', { n: botsCount })
        : tr('sidebar.bots')

  return (
    <View style={s.wrap} accessibilityRole="tablist">
      <Segmented
        tone="bg"
        options={MODES.map((mode) => ({ key: mode, label: label(mode) }))}
        value={identity}
        onChange={onChange}
      />
    </View>
  )
}

const makeS = () => StyleSheet.create({
  wrap: { marginBottom: 10 },
  // [14] sessions-only label keeps the switch's slot height in OC mode.
  soloWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgCard,
  },
})
