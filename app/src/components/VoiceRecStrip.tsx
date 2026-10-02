import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Animated, AccessibilityInfo } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import type { AudioRecorder } from 'expo-audio'
import { C, useStyles } from '../lib/theme'
import { REC_POLL_MS, pushLevel, barsFromLevels, formatRecSecs } from '../lib/voiceLevels'

const BAR_COUNT = 26
const WAVE_H = 22
const MIN_BAR_H = 3

/**
 * The composer's face while a voice recording is live: a pulsing red dot, a
 * scrolling waveform driven by the recorder's real metering (dBFS → bar
 * heights, newest sample at the right edge), the elapsed timer, and a cancel
 * affordance. Mounted only while `recording`, so its ~16 Hz metering polls
 * and re-renders never touch the chat screen. Without metering data (first
 * polls, or a platform that reports none) the bars sit at their floor — the
 * timer is the honest signal, the bars never fake audio that isn't there.
 */
export const VoiceRecStrip = React.memo(function VoiceRecStrip({
  recorder,
  secs,
  onCancel,
}: {
  recorder: AudioRecorder
  secs: number
  onCancel: () => void
}) {
  const st = useStyles(makeSt)
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

  return (
    <View style={st.strip} accessibilityLabel={`Recording voice, ${formatRecSecs(secs)}${heard ? '' : ' — no sound yet'}`}>
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
      <Text style={[st.time, !heard && secs >= 2 && st.timeQuiet]}>{!heard && secs >= 2 ? 'no sound yet · ' : ''}{formatRecSecs(secs)}</Text>
      <Pressable
        style={({ pressed }) => [st.cancel, pressed && st.cancelPressed]}
        onPress={onCancel}
        hitSlop={8}
        accessibilityLabel="Discard recording"
      >
        <Icon name="close" size={17} color={C.textDim} />
      </Pressable>
    </View>
  )
})

const makeSt = () => StyleSheet.create({
  strip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
    paddingHorizontal: 12,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: C.red,
  },
  wave: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: WAVE_H,
  },
  bar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: C.red,
  },
  time: {
    fontSize: 12,
    color: C.textDim,
    fontVariant: ['tabular-nums'],
  },
  timeQuiet: {
    color: C.textFaint,
  },
  cancel: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelPressed: {
    backgroundColor: C.border,
  },
})
