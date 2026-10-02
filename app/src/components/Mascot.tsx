import React, { useEffect, useRef } from 'react'
import { AppState, Pressable, StyleSheet, View } from 'react-native'
import { useStore } from '@nanostores/react'
import { MochiSurface } from './mochi/MochiSurface'
import { mochiCommitted, type UseMochiState } from './mochi/useMochiState'
import type { MochiStateName } from './mochi/mochiStates.gen'

const BOX = 144

/**
 * The chat mascot: a tap is a complete no-op (Mochi keeps whatever
 * animation he is running); press-and-hold past a 500ms threshold (owned by
 * useMochiState) for a pat that stays squished until release, then springs
 * back through the one-shot head-pat-release state — no long-press gesture
 * competes with it. The wrapper is pointerEvents 'box-none' so ONLY the
 * 144px square is touchable — the composer, queue strip and list scroll
 * are never intercepted.
 *
 * NO haptics anywhere in the mascot: user rejected every variant (hold pulse
 * loop, then the single touch-down tick — each read as an uninvited buzz).
 * The animation alone is the feedback.
 *
 * This leaf owns the mascot-state subscription (`mochiCommitted`): the
 * waterfall's 400ms heartbeat re-renders at most this 144px square, never
 * the host Chat screen. (Dev state-forcing lives in the mascot document's
 * `window.__mochForce`, used by the browser sweep.)
 */
export function Mascot({ mochi }: { mochi: UseMochiState }) {
  const state = useStore(mochiCommitted)
  const pressedRef = useRef(false)

  // App blur mid-press = touch cancel: the pat ends with the finger's life.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && pressedRef.current) {
        pressedRef.current = false
        mochi.onPressOut()
      }
    })
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mochi])

  return (
    <View style={s.wrap} pointerEvents="box-none">
      <Pressable
        style={s.box}
        accessibilityRole="button"
        accessibilityLabel="Mochi the mascot"
        onPressIn={() => {
          // One press = one pat session: if the OS ever re-delivers pressIn
          // without a pressOut (Android touch churn), don't restart the
          // hold — it just continues.
          if (pressedRef.current) return
          pressedRef.current = true
          mochi.onPressIn()
        }}
        onPressOut={() => {
          pressedRef.current = false
          mochi.onPressOut()
        }}
      >
        <MochiSurface state={state} />
      </Pressable>
    </View>
  )
}

/**
 * The bare mascot for surfaces with no waterfall and no touch target (the
 * connection overlay, splash, onboarding). Mounts fresh with its surface —
 * inside the 94%-black veil the status text appears first and Mochi fades
 * in a beat later (cold WebView start ~200-500ms on low-end devices;
 * accepted).
 */
export function MochiStage({ state, marginBottom = 12, size = BOX }: { state: MochiStateName; marginBottom?: number; size?: number }) {
  return (
    <View style={[s.stage, { marginBottom, width: size, height: size }]} pointerEvents="none" aria-hidden={true}>
      <MochiSurface state={state} />
    </View>
  )
}

const s = StyleSheet.create({
  // The wrapper lets touches pass everywhere except the square itself.
  // Horizontal placement belongs to the host's float container (the chat's
  // mochFloat); no alignSelf here — it would override the host's alignment.
  // marginBottom 4 keeps the chat-screen mount geometry of the old box.
  wrap: { marginBottom: 4 },
  box: {
    width: BOX,
    height: BOX,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  stage: {
    width: BOX,
    height: BOX,
    alignSelf: 'center',
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
})
