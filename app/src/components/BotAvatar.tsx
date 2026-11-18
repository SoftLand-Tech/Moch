import React, { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, Image, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { C, useStyles } from '../lib/theme'
import { useDir } from '../lib/strings'
import { DEFAULT_PROFILE } from '../lib/botRosterMeta'
import { useReduceMotion } from './useReduceMotion'

/**
 * Shared bot avatar (issue #170, round-2 feedback #8).
 *
 * One design language for every surface that renders bot identity:
 * drawer roster (`BotsRoster`), Fleet cards (`app/(tabs)/fleet.tsx`),
 * and bot detail (`app/bot.tsx`).
 *
 * - Default agent → the real Mochi logo (`app/assets/logo.png`); it is Moch,
 *   not a hire, so it gets the brand mark, not a generated profile picture.
 * - Named bots → deterministic transparent mochi-profiles PNG (stable hash
 *   % 15), so a bot keeps its picture across launches with zero data-model
 *   change. Rendered at its own size, no disc/container behind it.
 * - `frozen` adds a small snow badge over the image (Fleet used to swap the
 *   whole icon for snow-outline; the freeze button already carries
 *   play/pause, this keeps the at-a-glance signal without losing identity).
 * - Gentle idle "breathing" (bob + tiny scale), phased per avatar so lists
 *   don't pulse in sync; disabled under OS reduce-motion (BUG-056 hook).
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
  style,
}: {
  profile: string
  isDefault?: boolean
  size?: number
  frozen?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const s = useStyles(makeS)
  const dir = useDir()
  const reduceMotion = useReduceMotion()
  const def = isDefault ?? profile === DEFAULT_PROFILE

  // Phase offset per avatar slot so rows in a list breathe out of sync.
  const phase = ((botAvatarIndex(def ? DEFAULT_PROFILE : profile) / AVATARS.length) * Math.PI * 2)
  const t = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (reduceMotion) return
    const loop = Animated.sequence([
      Animated.delay(Math.round(phase * 800)),
      Animated.loop(Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      ),
    ])
    loop.start()
    return () => loop.stop()
  }, [t, reduceMotion, phase])

  const animStyle = useMemo(() => {
    if (reduceMotion) return undefined
    const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.05] })
    const scale = t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] })
    const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1.5deg'] })
    return { transform: [{ translateY }, { scale }, { rotate }] }
  }, [t, reduceMotion, size])

  // Manual RTL mirroring (root layout never forces I18nManager): the snow
  // badge sits on the logical end of the image, like every other badge in
  // the redesign. Public props/behavior are unchanged for Sidebar/BotsRoster.
  const badgeSide = dir.rtl ? { left: -2 } : { right: -2 }
  return (
    <Animated.View
      style={[{ width: size, height: size }, animStyle, style]}
      accessibilityRole="image"
      accessibilityLabel={def ? 'Moch' : profile}
    >
      <Image
        source={def ? require('../../assets/logo.png') : botAvatarSource(profile)}
        style={{ width: size, height: size, resizeMode: 'contain' }}
      />
      {frozen ? (
        <View
          style={[
            s.frozenBadge,
            badgeSide,
            { width: size * 0.45, height: size * 0.45, borderRadius: size * 0.225 },
          ]}
        >
          <Ionicons name="snow-outline" size={Math.max(8, Math.round(size * 0.28))} color={C.accent} />
        </View>
      ) : null}
    </Animated.View>
  )
}

const makeS = () =>
  StyleSheet.create({
    frozenBadge: {
      position: 'absolute',
      bottom: -2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgElev,
      borderWidth: 1,
      borderColor: C.accent,
    },
  })
