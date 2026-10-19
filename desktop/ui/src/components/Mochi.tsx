/**
 * Mochi — the mascot, on the desktop. Same character the phone ships
 * (mochi-svgs), placed at the moments she belongs: greeting you in empty
 * states, thinking alongside the agent, celebrating finished work, asking
 * for approval, listening during voice.
 */
import { useMemo } from 'react'

export type MochiMood =
  | 'greeting'
  | 'deep-thinking'
  | 'celebration'
  | 'connecting'
  | 'approval'
  | 'listening'
  | 'confused'

const MOODS: Record<MochiMood, string> = {
  greeting: '/mochi/mochi-greeting.svg',
  'deep-thinking': '/mochi/mochi-deep-thinking.svg',
  celebration: '/mochi/mochi-celebration.svg',
  connecting: '/mochi/mochi-connecting.svg',
  approval: '/mochi/mochi-approval.svg',
  listening: '/mochi/mochi-listening.svg',
  confused: '/mochi/mochi-confused.svg',
}

export default function Mochi({ mood = 'greeting', size = 72 }: { mood?: MochiMood; size?: number }) {
  const src = useMemo(() => MOODS[mood] ?? MOODS.greeting, [mood])
  return (
    <img
      src={src}
      alt={`Mochi ${mood}`}
      width={size}
      height={size}
      draggable={false}
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    />
  )
}
