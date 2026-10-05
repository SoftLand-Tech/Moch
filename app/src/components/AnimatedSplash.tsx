/**
 * Animated cold-start brand splash.
 *
 * The native splash (config plugin) shows the logo statically on #000000;
 * this overlay takes over at mount with the same background and the same
 * logo width, so the handoff is invisible. The logo settles into place over
 * two expanding cyan ripples while the Mochi WebView loads underneath; at
 * 650ms the logo crossfades into waking-up Mochi, who plays the first half
 * of his 5.8s wake loop (asleep → stretch → eyes open) and the overlay
 * fades out over the app right on the eyes-open beat. Tap anywhere to skip;
 * reduced-motion users skip straight through.
 * Runs once per cold start (mounted from the root layout).
 */
import React, { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet } from 'react-native'
import { C, useStyles } from '../lib/theme'
import { MochiStage } from './Mascot'

/** Same width as the native splash `imageWidth`, so frame one matches it. */
const LOGO_W = 200
const LOGO_H = Math.round((LOGO_W * 608) / 800) // logo.png is 800×608
// Mochi's body is ~55% of his viewBox, so 240 renders at roughly the logo's
// visual weight.
const MOCH_W = 240
// Logo → Mochi crossfade start; late enough that the cold WebView (which
// fades itself in on load) is usually already showing frame one.
const CROSSFADE_AT = 650
// Mochi has then played ~2.6-2.9s of his 5.8s loop ≈ the eyes-open beat.
const EXIT_AT = 3250

export function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const s = useStyles(makeS)
  const [reduced, setReduced] = useState(false)
  // Overlay starts as a pixel-for-pixel match of the native splash.
  const settle = useRef(new Animated.Value(1.045)).current
  const fade = useRef(new Animated.Value(1)).current
  const exitScale = useRef(new Animated.Value(1)).current
  const ripple1 = useRef(new Animated.Value(0)).current
  const ripple2 = useRef(new Animated.Value(0)).current
  const logoFade = useRef(new Animated.Value(1)).current
  const mochiIn = useRef(new Animated.Value(0)).current
  const intro = useRef<Animated.CompositeAnimation | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  /** The rAF-stall safety timer — never cleared by skip(), only by unmount. */
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipped = useRef(false)
  const done = useRef(false)

  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => { if (live) setReduced(r) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  /** Exit: the brand moment passes through into the app. Fires once. */
  const exit = (duration: number) => {
    if (done.current) return
    done.current = true
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(exitScale, { toValue: 1.06, duration, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) onDone() })
  }

  /** Tap-to-skip: cut everything short and start the exit fade now. */
  const skip = () => {
    if (skipped.current) return
    skipped.current = true
    timers.current.forEach(clearTimeout)
    intro.current?.stop()
    exit(250)
  }

  useEffect(() => {
    if (reduced) { onDone(); return }
    intro.current = Animated.parallel([
      // settle: the logo eases from the static splash pose into place
      Animated.timing(settle, { toValue: 1, duration: 550, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(ripple1, { toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.sequence([Animated.delay(220), Animated.timing(ripple2, { toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: true })]),
    ])
    intro.current.start()
    timers.current = [
      // Crossfade the settled logo into waking-up Mochi.
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(mochiIn, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(logoFade, { toValue: 0, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start()
      }, CROSSFADE_AT),
      // Leave on the wake arc's payoff instead of a fixed beat.
      setTimeout(() => exit(400), EXIT_AT),
    ]
    // Safety net: the exit above completes via an animation callback, which
    // never fires if the page's animation frames are stalled (an occluded
    // web view keeps timers but freezes rAF — the overlay then sat on the
    // app forever and ate every tap). Plain timers still run in that state,
    // so the handoff is guaranteed even when the fade can't play. The
    // healthy path unmounts first and clears this in cleanup; onDone is an
    // idempotent setState, so a stray late call is harmless.
    safety.current = setTimeout(() => onDone(), EXIT_AT + 1600)
    return () => {
      intro.current?.stop()
      timers.current.forEach(clearTimeout)
      if (safety.current) { clearTimeout(safety.current); safety.current = null }
    }
    // onDone is a setState wrapper from the root layout — stable in practice.
  }, [reduced])

  const rippleStyle = (v: Animated.Value) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.0] }) }],
  })
  const logoStyle = {
    opacity: logoFade,
    transform: [
      { scale: Animated.multiply(settle, exitScale) },
    ],
  }

  return (
    <Animated.View style={[s.overlay, { opacity: fade }]} accessibilityLabel="Loading Moch">
      {/* Tap anywhere to skip — plain Views/Images above don't intercept. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={skip}
        accessibilityLabel="Skip intro"
        accessibilityRole="button"
      />
      <Animated.View style={[s.ripple, rippleStyle(ripple1)]} />
      <Animated.View style={[s.ripple, rippleStyle(ripple2)]} />
      <Animated.Image
        source={require('../../assets/logo.png')}
        style={[s.logo, logoStyle]}
        resizeMode="contain"
      />
      {/* Mochi mounts with the overlay (the WebView needs the whole cold
          start to load) and is revealed by the crossfade above. */}
      <Animated.View style={[s.mochiLayer, { opacity: mochiIn }]} pointerEvents="none">
        <MochiStage state="mochi-waking-up" size={MOCH_W} marginBottom={0} />
      </Animated.View>
    </Animated.View>
  )
}

const makeS = () => StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000', // same as the native splash backgroundColor
    alignItems: 'center',
    justifyContent: 'center',
  },
  ripple: {
    position: 'absolute',
    width: LOGO_W,
    height: LOGO_W,
    borderRadius: LOGO_W / 2,
    borderWidth: 2,
    borderColor: C.accent,
  },
  logo: {
    width: LOGO_W,
    height: LOGO_H,
  },
  mochiLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
