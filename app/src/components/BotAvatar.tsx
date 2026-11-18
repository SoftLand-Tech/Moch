import React from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { C, useStyles } from '../lib/theme'
import { DEFAULT_PROFILE } from '../lib/botRosterMeta'

/**
 * Shared bot avatar (issue #170).
 *
 * One design language for every surface that renders bot identity:
 * drawer roster (`BotsRoster`), Fleet cards (`app/(tabs)/fleet.tsx`),
 * and bot detail (`app/bot.tsx`).
 *
 * - Default agent → Mochi mascot on an accentSoft disc (it is Moch, not a hire).
 * - Named bots → deterministic mochi-profiles PNG (stable hash % 15), so a
 *   bot keeps its picture across launches with zero data-model change.
 * - `frozen` adds a small snow badge (Fleet used to swap the whole icon for
 *   snow-outline; the freeze button already carries play/pause, this keeps
 *   the at-a-glance signal without losing identity).
 */
const AVATARS = [
  require('../../assets/mochi-profiles/01-moko.png'),
  require('../../assets/mochi-profiles/02-mocha.png'),
  require('../../assets/mochi-profiles/03-moshi.png'),
  require('../../assets/mochi-profiles/04-mochu.png'),
  require('../../assets/mochi-profiles/05-moro.png'),
  require('../../assets/mochi-profiles/06-mori.png'),
  require('../../assets/mochi-profiles/07-momo.png'),
  require('../../assets/mochi-profiles/08-chibi.png'),
  require('../../assets/mochi-profiles/09-mopo.png'),
  require('../../assets/mochi-profiles/10-morin.png'),
  require('../../assets/mochi-profiles/11-molu.png'),
  require('../../assets/mochi-profiles/12-chiko.png'),
  require('../../assets/mochi-profiles/13-molo.png'),
  require('../../assets/mochi-profiles/14-mogo.png'),
  require('../../assets/mochi-profiles/15-mobi.png'),
]

/** Stable 0..14 avatar slot for a profile name (same hash as botTintIndex). */
export function botAvatarIndex(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % AVATARS.length
}

export function botAvatarSource(profile: string): number {
  return AVATARS[botAvatarIndex(profile)]
}

export function BotAvatar({
  profile,
  isDefault,
  size = 32,
  frozen = false,
}: {
  profile: string
  isDefault?: boolean
  size?: number
  frozen?: boolean
}) {
  const s = useStyles(makeS)
  const def = isDefault ?? profile === DEFAULT_PROFILE
  const imgSize = Math.round(size * 0.78)
  return (
    <View
      style={[s.disc, { width: size, height: size, borderRadius: size / 2 }]}
      accessibilityRole="image"
      accessibilityLabel={def ? 'Moch' : profile}
    >
      <Image
        source={def ? require('../../assets/mochi-run-1.png') : botAvatarSource(profile)}
        style={{ width: imgSize, height: imgSize, resizeMode: 'contain' }}
      />
      {frozen ? (
        <View style={[s.frozenBadge, { width: size * 0.45, height: size * 0.45, borderRadius: size * 0.225 }]}>
          <Ionicons name="snow-outline" size={Math.max(8, Math.round(size * 0.28))} color={C.accent} />
        </View>
      ) : null}
    </View>
  )
}

const makeS = () =>
  StyleSheet.create({
    disc: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.accentSoft,
      overflow: 'visible',
    },
    frozenBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.accent,
    },
  })
