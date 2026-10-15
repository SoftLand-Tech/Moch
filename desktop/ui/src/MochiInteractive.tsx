/**
 * Interactive Mochi Mascot — Web/Desktop twin of mobile's MochiSurface.
 * Bundles the 32 animated SVG states (breathing, eye tracking, blinking,
 * thinking, listening, celebration, head-pat, wink, etc.).
 * Interactive: responds to clicks, turns, and state updates.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { mochiDocument, type MochiStateName } from '../../../app/src/components/mochi/mochiStates.gen'

type MochiWindow = Window & {
  __mochSet?: (name: string) => void
  __mochCurrent?: () => string | null
}

const INTERACTIVE_TAPS: MochiStateName[] = [
  'mochi-wink',
  'mochi-excited',
  'mochi-celebration',
  'mochi-head-pat',
  'mochi-idea',
]

export default function MochiInteractive({
  state = 'mochi-greeting',
  size = 140,
  className = '',
  onClick,
}: {
  state?: MochiStateName
  size?: number
  className?: string
  onClick?: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const loadedRef = useRef(false)
  const pendingRef = useRef<MochiStateName | null>(null)
  const lastInjectedRef = useRef<MochiStateName | null>(null)
  const [tapIndex, setTapIndex] = useState(0)
  const [interactiveState, setInteractiveState] = useState<MochiStateName | null>(null)
  const resetTimer = useRef<number | undefined>(undefined)

  const activeState = interactiveState || state

  const html = useMemo(() => {
    const doc = mochiDocument(false)
    const initial = activeState || 'mochi-greeting'
    return doc.replace(
      'var current = null;',
      `var current = null; setTimeout(function() { if (window.__mochSet) window.__mochSet('${initial}'); }, 10);`
    )
  }, [])

  const inject = (name: MochiStateName) => {
    const win = iframeRef.current?.contentWindow as MochiWindow | null
    if (win && typeof win.__mochSet === 'function') {
      try {
        win.__mochSet(name)
        lastInjectedRef.current = name
      } catch {
        /* iframe teardown */
      }
    } else {
      setTimeout(() => inject(name), 30)
    }
  }


  useEffect(() => {
    if (!loadedRef.current) {
      pendingRef.current = activeState
      return
    }
    if (activeState !== lastInjectedRef.current) {
      inject(activeState)
    }
  }, [activeState])

  const handleIframeLoad = () => {
    loadedRef.current = true
    const wanted = pendingRef.current || activeState
    pendingRef.current = null
    if (wanted) inject(wanted)
  }

  const handleMochiClick = () => {
    onClick?.()
    clearTimeout(resetTimer.current)
    const nextReaction = INTERACTIVE_TAPS[tapIndex % INTERACTIVE_TAPS.length]
    setTapIndex((i) => i + 1)
    setInteractiveState(nextReaction)

    resetTimer.current = window.setTimeout(() => {
      setInteractiveState(null)
    }, 1800)
  }

  return (
    <div
      className={`mochi-interactive-container ${className}`}
      style={{ width: size, height: size }}
      onClick={handleMochiClick}
      title="Click to interact with Mochi!"
    >
      <iframe
        ref={iframeRef}
        title="Mochi"
        srcDoc={html}
        onLoad={handleIframeLoad}
        className="mochi-interactive-iframe"
      />
    </div>
  )
}
