import React from 'react'
import { Image, StyleProp, ImageStyle, TextStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useShape } from '../lib/theme'

/**
 * Theme-aware icon. Under Mocheme the core UI glyphs are Mochi's own — a
 * hand-drawn set in his shape language (chunky round strokes, blobby forms,
 * sources in mochi-icons/*.svg, rasterized to tintable alpha PNGs) — while
 * Relay keeps Ionicons. Any name without a Mochi glyph falls back to Ionicons
 * automatically, so the long tail (media kinds, settings rows) can adopt the
 * set incrementally: drop an SVG in mochi-icons/, rasterize, add a line below.
 */
const GLYPHS: Record<string, number> = {
  menu: require('../../assets/mochi-icons/menu.png'),
  search: require('../../assets/mochi-icons/search.png'),
  close: require('../../assets/mochi-icons/close.png'),
  add: require('../../assets/mochi-icons/add.png'),
  checkmark: require('../../assets/mochi-icons/checkmark.png'),
  'alert-circle': require('../../assets/mochi-icons/alert-circle.png'),
  refresh: require('../../assets/mochi-icons/refresh.png'),
  'arrow-up': require('../../assets/mochi-icons/arrow-up.png'),
  'arrow-down': require('../../assets/mochi-icons/arrow-down.png'),
  'arrow-forward': require('../../assets/mochi-icons/arrow-forward.png'),
  'return-down-back': require('../../assets/mochi-icons/return-down-back.png'),
  stop: require('../../assets/mochi-icons/stop.png'),
  'mic-outline': require('../../assets/mochi-icons/mic-outline.png'),
  'copy-outline': require('../../assets/mochi-icons/copy-outline.png'),
  'volume-medium-outline': require('../../assets/mochi-icons/volume-medium-outline.png'),
  'terminal-outline': require('../../assets/mochi-icons/terminal-outline.png'),
  'git-branch-outline': require('../../assets/mochi-icons/git-branch-outline.png'),
  'flash-outline': require('../../assets/mochi-icons/flash-outline.png'),
  'time-outline': require('../../assets/mochi-icons/time-outline.png'),
  'timer-outline': require('../../assets/mochi-icons/timer-outline.png'),
  'chatbubble-outline': require('../../assets/mochi-icons/chatbubble-outline.png'),
  'sparkles-outline': require('../../assets/mochi-icons/sparkles-outline.png'),
  'cube-outline': require('../../assets/mochi-icons/cube-outline.png'),
  'settings-outline': require('../../assets/mochi-icons/settings-outline.png'),
  'cloud-offline-outline': require('../../assets/mochi-icons/cloud-offline-outline.png'),
  'radio-button-on': require('../../assets/mochi-icons/radio-button-on.png'),
  'help-circle-outline': require('../../assets/mochi-icons/help-circle-outline.png'),
  'document-text-outline': require('../../assets/mochi-icons/document-text-outline.png'),
  'chevron-up': require('../../assets/mochi-icons/chevron-up.png'),
  'chevron-down': require('../../assets/mochi-icons/chevron-down.png'),
  'chevron-forward': require('../../assets/mochi-icons/chevron-forward.png'),
  'chevron-back': require('../../assets/mochi-icons/chevron-back.png'),
}

export function Icon({
  name,
  size = 20,
  color,
  style,
}: {
  name: string
  size?: number
  color?: string
  style?: StyleProp<ImageStyle>
}) {
  const S = useShape()
  const glyph = S.mochiIcons ? GLYPHS[name] : undefined
  if (glyph) {
    return <Image source={glyph} style={[{ width: size, height: size, tintColor: color }, style]} />
  }
  return <Ionicons name={name as keyof typeof Ionicons.glyphMap} size={size} color={color} style={style as StyleProp<TextStyle>} />
}
