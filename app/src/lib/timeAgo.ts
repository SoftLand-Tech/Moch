/**
 * Relative-time labels ("just now" / "3m ago" / "2h ago" / "5d ago" / date),
 * extracted from the Chats screen's fmtWhen (2026-10-14 UI revamp) so the
 * drawer's chat rows show the same honest timestamps. Same contract:
 * BUG-058's clock-skew clamp travels with it (a future timestamp must never
 * pin the label at "just now" forever), and an unknown ts renders ''.
 */
import { toMs } from './sessionList'

export function timeAgo(ts?: number | null): string {
  const ms = toMs(ts)
  if (!ms) return ''
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  try {
    return new Date(ms).toLocaleDateString()
  } catch {
    return ''
  }
}
