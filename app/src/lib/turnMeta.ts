/**
 * Per-turn usage provenance (2026-10-14 UI revamp): what model answered a
 * message and what it cost in tokens/speed. The gateway has ALWAYS sent this
 * on message.complete — the app used to drop it; these helpers parse and
 * format it for the reply footer. Pure module on purpose (regression-tested
 * in scripts/test-turn-meta.ts): nothing here imports RN or stores.
 */

/** A display-safe subset of the gateway's usage payload. */
export interface TurnMeta {
  /** Model id that actually answered (may differ from the header after /model once). */
  model?: string
  /** Total tokens the turn consumed (input + output + reasoning, as reported). */
  totalTokens?: number
  /** Rolling average tokens/second for the completion — NOT shown in the
   *  thinking header (a deliberate user call: speed readouts there read as
   *  noise); this lives on the finished message where it belongs. */
  tps?: number
}

/**
 * Extract display-safe TurnMeta from a message.complete usage payload.
 * Every field optional, nothing thrown — a malformed payload renders no
 * footer rather than breaking the turn. `total` is preferred; a bare
 * `output` count still earns a footer (some providers stop there).
 */
export function parseTurnUsage(u: unknown): TurnMeta | undefined {
  if (!u || typeof u !== 'object') return undefined
  const r = u as Record<string, unknown>
  const meta: TurnMeta = {}
  if (typeof r.model === 'string' && r.model) meta.model = r.model
  const total =
    typeof r.total === 'number' ? r.total
      : typeof r.output === 'number' ? r.output
        : undefined
  if (typeof total === 'number' && total > 0) meta.totalTokens = total
  if (typeof r.avg_tps === 'number' && r.avg_tps > 0) meta.tps = r.avg_tps
  return meta.model || meta.totalTokens || meta.tps ? meta : undefined
}

/** "glm-5.3 · 1.2k tok · 31 t/s" — empty string when there is nothing to show. */
export function formatTurnMeta(m: TurnMeta | undefined): string {
  if (!m) return ''
  const tok = m.totalTokens
    ? m.totalTokens >= 1000
      ? `${(m.totalTokens / 1000).toFixed(m.totalTokens >= 10000 ? 0 : 1)}k tok`
      : `${m.totalTokens} tok`
    : ''
  const tps = m.tps ? `${Math.round(m.tps)} t/s` : ''
  return [m.model, tok, tps].filter(Boolean).join(' · ')
}
