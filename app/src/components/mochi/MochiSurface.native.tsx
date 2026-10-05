/**
 * Native mascot surface: one WebView holding ALL 32 pre-mounted, paused state
 * chunks in a single document. State switches are one class toggle in that
 * document (`window.__mochSet`) — never a re-mount, never a re-source, never
 * a fetch. Transparent, non-interactive, fades in 150ms on first load.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { AccessibilityInfo, Animated, AppState, StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { mochiDocument, type MochiStateName } from './mochiStates.gen'
import type { MochiSurfaceHandle, MochiSurfaceProps } from './MochiSurfaceCommon'

export const MochiSurface = forwardRef<MochiSurfaceHandle, MochiSurfaceProps>(
  function MochiSurface({ state }, ref) {
    const webRef = useRef<WebView>(null)
    // Android injection timing: anything desired before the document finishes
    // loading is buffered here and applied on onLoadEnd — no idle-flash.
    const loadedRef = useRef(false)
    const pendingRef = useRef<MochiStateName | null>(null)
    const lastInjectedRef = useRef<MochiStateName | null>(null)
    const fade = useRef(new Animated.Value(0)).current
    // Memoized once — the document is static for the surface's lifetime.
    const html = useMemo(() => mochiDocument(__DEV__), [])
    // Answer to the foreground probe: null while waiting, then whether the
    // document's hooks are still alive in the renderer.
    const probeReplyRef = useRef<((alive: boolean) => void) | null>(null)

    const inject = (name: MochiStateName) => {
      lastInjectedRef.current = name
      // Guarded dispatch, same contract as the web surface: if the dev-only
      // __mochForce hook isn't in the document (flag mismatch, stale doc),
      // fall through to __mochSet instead of silently eval-throwing inside
      // the WebView — that silent throw was the device "pat never shows" bug.
      webRef.current?.injectJavaScript(
        `window.__mochForce ? window.__mochForce('${name}') : window.__mochSet('${name}');true;`,
      )
    }

    useImperativeHandle(
      ref,
      () => ({
        force: (name: MochiStateName) => {
          if (!loadedRef.current) {
            pendingRef.current = name
            return
          }
          inject(name)
        },
      }),
      [],
    )

    useEffect(() => {
      if (!loadedRef.current) {
        pendingRef.current = state
        return
      }
      // Guard: fire only when the desired state differs from the last-injected
      // one — per-flush re-evaluations recompute equal states.
      if (state !== lastInjectedRef.current) inject(state)
    }, [state])

    const applyPending = () => {
      loadedRef.current = true
      const wanted = pendingRef.current
      pendingRef.current = null
      if (wanted && wanted !== lastInjectedRef.current) inject(wanted)
      // 150ms first-load fade-in; reduced-motion users get a hard cut.
      const start = () => Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start()
      AccessibilityInfo.isReduceMotionEnabled?.()
        .then((rm) => (rm ? fade.setValue(1) : start()))
        .catch(start)
    }

    // Android kills WebView RENDERER processes under background memory
    // pressure while this component stays mounted — the mascot goes
    // permanently blank and every injectJavaScript silently no-ops (onLoadEnd
    // never re-fires for an OS-level renderer death). On foreground, probe
    // the document: silence or a dead flag means reload; onLoadEnd then
    // re-applies the last committed state and replays the fade-in.
    useEffect(() => {
      const sub = AppState.addEventListener('change', (s) => {
        if (s !== 'active' || !loadedRef.current) return
        const myReply = (alive: boolean) => {
          if (alive) return
          const want = lastInjectedRef.current
          lastInjectedRef.current = null // reload starts from the base state
          pendingRef.current = want
          webRef.current?.reload()
        }
        probeReplyRef.current = myReply
        webRef.current?.injectJavaScript(
          `window.ReactNativeWebView.postMessage(JSON.stringify({t:'mochProbe',alive:!!window.__mochSet}));true;`,
        )
        setTimeout(() => {
          // a newer probe replaced ours — its own timeout owns the verdict
          if (probeReplyRef.current !== myReply) return
          probeReplyRef.current = null
          myReply(false) // silence = the renderer is gone
        }, 700)
      })
      return () => sub.remove()
    }, [])

    const onWebViewMessage = (e: { nativeEvent: { data: string } }) => {
      try {
        const m = JSON.parse(e.nativeEvent.data) as { t?: string; alive?: boolean }
        if (m?.t === 'mochProbe' && probeReplyRef.current) {
          const reply = probeReplyRef.current
          probeReplyRef.current = null
          reply(!!m.alive)
        }
      } catch {
        /* not our message — the document never posts anything else */
      }
    }

    return (
      <Animated.View style={[s.fill, { opacity: fade }]} pointerEvents="none">
        <View style={s.fill} pointerEvents="none" aria-hidden={true}>
          <WebView
            ref={webRef}
            source={{ html }}
            onLoadEnd={applyPending}
            onMessage={onWebViewMessage}
            style={s.fill}
            containerStyle={s.fill}
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
            originWhitelist={['*']}
          />
        </View>
      </Animated.View>
    )
  },
)

const s = StyleSheet.create({
  fill: { width: '100%', height: '100%', backgroundColor: 'transparent' },
})
