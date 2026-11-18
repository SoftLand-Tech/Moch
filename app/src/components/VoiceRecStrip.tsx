import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Animated, AccessibilityInfo, Platform } from 'react-native'
import { Icon } from './Icon'
import { PrimaryBtn } from './ui'
import type { AudioRecorder } from 'expo-audio'
import { C, useStyles } from '../lib/theme'
import { REC_POLL_MS, pushLevel, barsFromLevels, formatRecSecs } from '../lib/voiceLevels'
import { useDir, useT } from '../lib/strings'

const BAR_COUNT = 18
const WAVE_H = 18
const MIN_BAR_H = 3

/**
 * The composer's face while a voice recording is live — the mockup's rounded
 * recording pill: a pulsing red dot, a scrolling waveform driven by the
 * recorder's real metering (dBFS → bar heights, newest sample at the right
 * edge), the mono elapsed timer, the Transcribe CTA (stop + transcribe, the
 * same path the mic's stop used to take) and a discard affordance. Mounted
 * only while `recording`, so its ~16 Hz metering polls and re-renders never
 * touch the chat screen. Without metering data (first polls, or a platform
 * that reports none) the bars sit at their floor — the timer is the honest
 * signal, the bars never fake audio that isn't there.
 */
export const VoiceRecStrip = React.memo(function VoiceRecStrip({
  recorder,
  secs,
  onFinish,
  onCancel,
}: {
  recorder: AudioRecorder
  secs: number
  /** Stop the take and transcribe it into the composer. */
  onFinish: () => void
  onCancel: () => void
}) {
  const st = useStyles(makeSt)
  const dir = useDir()
  const t = useT()
  const [levels, setLevels] = useState<number[]>([])
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {})
  }, [])
  useEffect(() => {
    const id = setInterval(() => {
      let db: number | undefined
      try {
        db = recorder.getStatus().metering
      } catch {
        db = undefined
      }
      setLevels((cur) => pushLevel(cur, db, BAR_COUNT))
    }, REC_POLL_MS)
    return () => clearInterval(id)
  }, [recorder])

  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduce) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduce, pulse])

  const bars = barsFromLevels(levels, BAR_COUNT)
  // Latched: once any real level has landed, the hint stays off for this
  // recording — a pause mid-speech shouldn't flap the label back on.
  const [heard, setHeard] = useState(false)
  useEffect(() => {
    if (!heard && levels.some((u) => u > 0)) setHeard(true)
  }, [levels, heard])

  const quiet = !heard && secs >= 2
  const time = formatRecSecs(secs)
  return (
    <View
      style={[st.strip, { flexDirection: dir.row }]}
      accessibilityLabel={
        heard ? t('chat.voice.a11y', { time }) : t('chat.voice.a11yQuiet', { time })
      }
    >
      <Animated.View
        style={[st.dot, !reduce && { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }, reduce && { opacity: 0.9 }]}
      />
      <View style={st.wave} pointerEvents="none">
        {bars.map((h, i) => (
          <View
            key={i}
            style={[st.bar, { height: Math.round(MIN_BAR_H + h * (WAVE_H - MIN_BAR_H)), opacity: 0.35 + h * 0.65 }]}
          />
        ))}
      </View>
      <Text style={st.time} numberOfLines={1}>
        {quiet ? t('chat.voice.quiet') : ''}
        {t('chat.voice.listening', { time })}
      </Text>
      <PrimaryBtn
        label={t('chat.voice.transcribe')}
        small
        onPress={onFinish}
        style={st.transcribe}
        textStyle={st.transcribeText}
      />
      <Pressable
        style={({ pressed }) => [st.cancel, pressed && st.cancelPressed]}
        onPress={onCancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('chat.voice.discardA11y')}
      >
        <Icon name="close" size={16} color={C.textDim} />
      </Pressable>
    </View>
  )
})

const makeSt = () => StyleSheet.create({
  // Recording pill: bgCard, accent hairline, stadium shape, 7×10 padding.
  strip: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.accent,
    backgroundColor: C.bgCard,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: C.red,
    flexShrink: 0,
  },
  wave: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: WAVE_H,
    overflow: 'hidden',
  },
  bar: {
    width: 2.5,
    borderRadius: 2,
    backgroundColor: C.red,
  },
  time: {
    fontSize: 12,
    fontWeight: '700',
    color: C.text,
    fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' }),
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  transcribe: { borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12, minHeight: 0 },
  transcribeText: { fontSize: 11.5 },
  cancel: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelPressed: {
    backgroundColor: C.bgHover,
  },
})
