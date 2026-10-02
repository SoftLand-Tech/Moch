// Pure math behind the live recording waveform. No react-native or expo
// imports here — scripts/test-voice.ts loads this module in plain node
// (voice.ts itself cannot: it pulls expo/RN at import time).

/** How often the recording strip samples the recorder's metering, in ms. */
export const REC_POLL_MS = 60

/** Everything below this dBFS counts as silence. Speech sits ≈ −30…−12 dB. */
export const VOICE_DB_FLOOR = -45

/**
 * dBFS reading (expo-audio metering, −160…0 on both platforms) → 0..1 level.
 * Undefined/NaN (metering off, first polls) and deep silence map to 0; a
 * gamma curve keeps mid-level speech from looking pinned at the top.
 */
export function levelToUnit(db: number | undefined): number {
  if (db === undefined || Number.isNaN(db)) return 0
  const lin = (db - VOICE_DB_FLOOR) / (0 - VOICE_DB_FLOOR)
  if (lin <= 0) return 0
  if (lin >= 1) return 1
  return Math.pow(lin, 1.25)
}

/** Append one reading to a rolling window, keeping the newest `max` values. */
export function pushLevel(window: number[], db: number | undefined, max: number): number[] {
  const next = window.length >= max ? window.slice(window.length - max + 1) : window.slice()
  next.push(levelToUnit(db))
  return next
}

/**
 * Rolling window → bar heights in 0..1, oldest left / newest right, left-padded
 * with zeros until the window has filled. Each height keeps a visible floor so
 * the strip reads as "armed" even before the first audio lands.
 */
export function barsFromLevels(levels: number[], barCount: number, floor = 0.12): number[] {
  const recent = levels.slice(-barCount)
  const pad = barCount - recent.length
  const bars: number[] = []
  for (let i = 0; i < pad; i++) bars.push(0)
  for (const u of recent) bars.push(floor + u * (1 - floor))
  return bars
}

/** Seconds → m:ss for the recording timer. */
export function formatRecSecs(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
