/**
 * Web mascot surface: the same single-document 32-state bundle in an iframe
 * (srcDoc is same-origin, so the parent drives it via
 * contentWindow.__mochSet). react-native-webview is never imported on web —
 * Metro/expo platform extensions resolve this file instead of
 * MochiSurface.native.tsx. Same buffering, same last-injected guard, same
 * 150ms first-load fade (a CSS opacity transition).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { mochiDocument, type MochiStateName } from './mochiStates.gen'
import type { MochiSurfaceHandle, MochiSurfaceProps } from './MochiSurfaceCommon'

type MochiWindow = Window & {
  __mochSet?: (name: string) => void
  __mochForce?: (name: string) => void
}

export const MochiSurface = forwardRef<MochiSurfaceHandle, MochiSurfaceProps>(
  function MochiSurface({ state }, ref) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null)
    const loadedRef = useRef(false)
    const pendingRef = useRef<MochiStateName | null>(null)
    const lastInjectedRef = useRef<MochiStateName | null>(null)
    const [shown, setShown] = useState(false)
    const html = useMemo(() => mochiDocument(__DEV__), [])

    const inject = (name: MochiStateName) => {
      lastInjectedRef.current = name
      const win = iframeRef.current?.contentWindow as MochiWindow | null
      const fn = __DEV__ ? (win?.__mochForce ?? win?.__mochSet) : win?.__mochSet
      try {
        fn?.(name)
      } catch {
        /* the iframe can tear down mid-call — nothing to recover */
      }
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
      if (state !== lastInjectedRef.current) inject(state)
    }, [state])

    const applyPending = () => {
      loadedRef.current = true
      const wanted = pendingRef.current
      pendingRef.current = null
      if (wanted && wanted !== lastInjectedRef.current) inject(wanted)
      setShown(true)
    }

    return (
      // title="Mochi" is the dev-sweep contract: devtools target
      // document.querySelector('iframe[title=Mochi]').contentWindow.__mochForce
      <iframe
        ref={iframeRef as React.RefObject<HTMLIFrameElement>}
        title="Mochi"
        srcDoc={html}
        onLoad={applyPending}
        style={{
          ...s.iframe,
          opacity: shown ? 1 : 0,
          // Reduced motion: hard cut instead of the 150ms fade.
          transition: reducedMotion() ? 'none' : 'opacity 150ms ease-out',
        }}
      />
    )
  },
)

function reducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

const s = {
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    backgroundColor: 'transparent',
    pointerEvents: 'none',
  },
} satisfies Record<string, React.CSSProperties>
