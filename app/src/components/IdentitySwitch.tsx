/**
 * Sessions | Bots segmented switch — the drawer's top-level identity.
 *
 * Two surfaces over one gateway: Sessions is every conversation, Bots is the
 * profile roster. The selected half takes the accent wash (`C.accentSoft`)
 * rather than a hard accent fill: the drawer's accent is reserved for the
 * primary New-chat action, and a full orange pill at the top of the panel
 * competed with it. Text/icon go `C.accent` on the wash, `C.textDim` off it.
 *
 * 44dp minimum targets (touch floor) and explicit accessibility labels: the
 * visible copy is localized, so the label is the localized word plus the mode.
 */
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useStore } from '@nanostores/react'
import { C, useStyles } from '../lib/theme'
import { tr, localeAtom } from '../lib/strings'
import type { Identity } from '../lib/workspace'

export interface IdentitySwitchProps {
  identity: Identity
  onChange: (i: Identity) => void
}

const MODES: Identity[] = ['sessions', 'bots']

export function IdentitySwitch({ identity, onChange }: IdentitySwitchProps) {
  const s = useStyles(makeS)
  // Re-render on a locale switch so the two labels follow the app language.
  useStore(localeAtom)

  return (
    <View style={s.track} accessibilityRole="tablist">
      {MODES.map((mode) => {
        const on = identity === mode
        const label = mode === 'sessions' ? tr('sidebar.sessions') : tr('sidebar.bots')
        return (
          <Pressable
            key={mode}
            style={({ pressed }) => [s.seg, on && s.segOn, pressed && s.segPressed]}
            onPress={() => {
              if (!on) onChange(mode)
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={label}
          >
            <Text style={[s.label, on && s.labelOn]} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const makeS = () => StyleSheet.create({
  track: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 3,
    borderRadius: 14,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.borderSoft,
    gap: 3,
  },
  seg: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
  segOn: { backgroundColor: C.accentSoft },
  segPressed: { backgroundColor: C.bgHover },
  label: { color: C.textDim, fontSize: 14, fontWeight: '600' },
  labelOn: { color: C.accent, fontWeight: '700' },
})
