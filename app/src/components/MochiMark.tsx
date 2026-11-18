/**
 * MochiMark — the app's real Mochi mascot logo (`app/assets/logo.png`,
 * 800×608, transparent background). Rendered with `resizeMode="contain"` in a
 * square box sized by the `size` prop, so the logo stays centered at any
 * size. `mood="sleepy"` dims the logo slightly (resting/error states); the
 * drawing itself is identical. Used in the drawer header, chat assistant
 * rows, empty states and the launch screen.
 */
import React from 'react'
import { Image, StyleProp, View, ViewStyle } from 'react-native'
import { tr } from '../lib/strings'

export type MochiMood = 'happy' | 'sleepy'

export function MochiMark({
  size = 56,
  mood = 'happy',
  style,
}: {
  size?: number
  mood?: MochiMood
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={tr('mochi.mascot')}
    >
      <Image
        source={require('../../assets/logo.png')}
        style={{
          width: size,
          height: size,
          resizeMode: 'contain',
          opacity: mood === 'sleepy' ? 0.55 : 1,
        }}
      />
    </View>
  )
}
