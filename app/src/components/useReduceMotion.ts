import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/**
 * BUG-056: the OS reduce-motion setting, LIVE. The old one-shot reads
 * (`AccessibilityInfo.isReduceMotionEnabled()` once on mount, no listener)
 * went stale until a remount, and several animated components never checked
 * at all. Every animated control uses this shared hook so the accessibility
 * setting applies consistently across the app.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduce(v) })
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(v))
    return () => {
      mounted = false
      sub.remove()
    }
  }, [])
  return reduce
}
