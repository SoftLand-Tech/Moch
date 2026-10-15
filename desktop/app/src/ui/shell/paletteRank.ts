/**
 * Palette ranking — pure, node-testable. Spec 4.3: exact prefix >
 * word-prefix > substring; recency breaks ties.
 */
export interface RankableItem {
  id: string
  title: string
  hint?: string
  recency?: number
}

export function scoreItem(query: string, item: RankableItem): number {
  const q = query.trim().toLowerCase()
  if (q === '') return 50 + (item.recency ?? 0)
  const t = item.title.toLowerCase()
  const h = (item.hint ?? '').toLowerCase()
  if (t === q) return 1000 + (item.recency ?? 0)
  if (t.startsWith(q)) return 800 + (item.recency ?? 0)
  const wordStart = wordPrefixIndex(t, q)
  if (wordStart >= 0) return 600 + wordStart + (item.recency ?? 0)
  if (h.startsWith(q)) return 400 + (item.recency ?? 0)
  const hi = h.indexOf(q)
  if (hi >= 0) return 300 - hi + (item.recency ?? 0)
  const ti = t.indexOf(q)
  if (ti > 0) return 200 - ti + (item.recency ?? 0)
  return -1
}

function wordPrefixIndex(title: string, q: string): number {
  for (let i = 0; i < title.length; i++) {
    const ch = title[i]
    const isSep =
      ch === ' ' || ch === '-' || ch === '/' || ch === '_' || ch === '.' || /[0-9]/.test(ch)
    if (isSep && title.startsWith(q, i + 1)) return i
  }
  return -1
}

export function rankItems<T extends RankableItem>(query: string, items: T[]): T[] {
  return items
    .map((item) => ({ item, score: scoreItem(query, item) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .map((r) => r.item)
}
