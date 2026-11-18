/**
 * MochiMark — the static Mochi mascot from the redesign showcase
 * (`getMochiSVG()` in docs/redesign/design.html), built from plain RN views so
 * it needs no SVG runtime and scales crisply at any size.
 *
 * Cream mochi body, navy visor with sprout-orange eyes, blush cheeks and the
 * green/orange sprout on top. `mood="sleepy"` closes the eyes (error/resting
 * states). Used in the drawer header, chat assistant rows, empty states and
 * the launch screen.
 */
import React from 'react'
import { View, ViewStyle, StyleProp } from 'react-native'
import { C } from '../lib/theme'
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
  const k = size / 80 // mockup viewBox is 80×80
  const dot = (left: number, top: number, w: number, h: number, bg: string) => (
    <View
      style={{
        position: 'absolute',
        left: left * k,
        top: top * k,
        width: w * k,
        height: h * k,
        borderRadius: (Math.min(w, h) * k) / 2,
        backgroundColor: bg,
      }}
    />
  )
  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={tr('mochi.mascot')}
    >
      {/* soft glow */}
      <View
        style={{
          position: 'absolute',
          left: 4 * k,
          top: 6 * k,
          width: 72 * k,
          height: 72 * k,
          borderRadius: 36 * k,
          backgroundColor: C.accentSoft,
        }}
      />
      {/* sprout stem + leaves */}
      <View
        style={{
          position: 'absolute',
          left: 38.6 * k,
          top: 8 * k,
          width: 2.8 * k,
          height: 11.5 * k,
          borderRadius: 2 * k,
          backgroundColor: C.greenSoft,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 40.5 * k,
          top: 8.5 * k,
          width: 13.5 * k,
          height: 5.5 * k,
          borderRadius: 4 * k,
          backgroundColor: C.accent,
          transform: [{ rotate: '-16deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 27 * k,
          top: 10.5 * k,
          width: 12.5 * k,
          height: 5 * k,
          borderRadius: 4 * k,
          backgroundColor: C.greenSoft,
          transform: [{ rotate: '16deg' }],
        }}
      />
      {/* round body */}
      <View
        style={{
          position: 'absolute',
          left: 15 * k,
          top: 20 * k,
          width: 50 * k,
          height: 44 * k,
          borderRadius: 22 * k,
          backgroundColor: '#FBF3E9',
          borderWidth: 1.5 * k,
          borderColor: 'rgba(255,255,255,0.5)',
        }}
      />
      {/* visor */}
      <View
        style={{
          position: 'absolute',
          left: 21 * k,
          top: 29 * k,
          width: 38 * k,
          height: 22 * k,
          borderRadius: 11 * k,
          backgroundColor: '#171424',
        }}
      />
      {mood === 'sleepy' ? (
        <>
          <View
            style={{
              position: 'absolute',
              left: 28.5 * k,
              top: 39 * k,
              width: 7 * k,
              height: 2.6 * k,
              borderRadius: 2 * k,
              backgroundColor: C.accent,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 44.5 * k,
              top: 39 * k,
              width: 7 * k,
              height: 2.6 * k,
              borderRadius: 2 * k,
              backgroundColor: C.accent,
            }}
          />
        </>
      ) : (
        <>
          {dot(28.8, 35.8, 6.4, 6.4, C.accent)}
          {dot(44.8, 35.8, 6.4, 6.4, C.accent)}
          {dot(29.9, 36.6, 2, 2, '#FFFFFF')}
          {dot(45.9, 36.6, 2, 2, '#FFFFFF')}
          {/* small smile */}
          <View
            style={{
              position: 'absolute',
              left: 37.3 * k,
              top: 43.2 * k,
              width: 5.4 * k,
              height: 3.2 * k,
              borderBottomWidth: 2 * k,
              borderColor: C.blush,
              borderBottomLeftRadius: 4 * k,
              borderBottomRightRadius: 4 * k,
            }}
          />
        </>
      )}
      {/* rosy cheeks */}
      <View
        style={{
          position: 'absolute',
          left: 20.5 * k,
          top: 50.5 * k,
          width: 7 * k,
          height: 4 * k,
          borderRadius: 2 * k,
          backgroundColor: C.blush,
          opacity: 0.55,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 52.5 * k,
          top: 50.5 * k,
          width: 7 * k,
          height: 4 * k,
          borderRadius: 2 * k,
          backgroundColor: C.blush,
          opacity: 0.55,
        }}
      />
    </View>
  )
}
