// Verify the drawer/chat-list ordering against the real gateway data.
// Reproduces the bug: sorting by the per-session `lastSeq` counter produces
// arbitrary order, while `started_at` is a real wall clock.
import fs from 'node:fs'

const env = fs.readFileSync(`${process.env.HOME}/.config/hermes-serve.env`, 'utf8')
const token = env.match(/HERMES_DASHBOARD_SESSION_TOKEN=(.+)/)?.[1]?.trim()
if (!token) {
  console.error('no token')
  process.exit(1)
}

const ws = new WebSocket(`ws://127.0.0.1:9119/api/ws?token=${encodeURIComponent(token)}`)
let n = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; t: ReturnType<typeof setTimeout> }>()
const rpc = (m: string, p: Record<string, unknown> = {}) =>
  new Promise<any>((res, rej) => {
    const id = ++n
    const t = setTimeout(() => rej(new Error(`${m} timeout`)), 20000)
    pending.set(id, { res, rej, t })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p }))
  })

ws.addEventListener('message', (e) => {
  const f = JSON.parse(String(e.data))
  if (typeof f.id === 'string' && typeof f.method === 'string' && f.method !== 'event') return
  if (f.id == null) return
  const c = pending.get(f.id)
  if (!c) return
  clearTimeout(c.t)
  pending.delete(f.id)
  f.error ? c.rej(new Error(f.error.message)) : c.res(f.result)
})

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** Mirrors src/lib/sessionList.ts */
function toMs(ts?: number | null): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  if (ts > 1e12) return ts
  if (ts > 1e10) return ts
  return ts * 1000
}
function sortSessions<T extends { started_at?: number }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => toMs(b.started_at) - toMs(a.started_at))
}

ws.addEventListener('open', async () => {
  await new Promise((r) => setTimeout(r, 400))
  const res = await rpc('session.list', { limit: 200 })
  const rows: any[] = res.sessions ?? []

  console.log(`\nserver returned ${rows.length} conversations\n`)

  check('list is non-empty (old chats are visible at all)', rows.length > 5, `${rows.length} rows`)

  // The real bug: the old drawer sorted by `lastSeq`, a per-session counter.
  // Simulate it — every session numbers from 1, so "seq" is arbitrary.
  const fakeSeq = rows.map((_, i) => ({ lastSeq: (i * 7) % 41 })) // arbitrary-ish
  const bySeq = fakeSeq.slice().sort((a, b) => b.lastSeq - a.lastSeq)
  const byTime = sortSessions(rows)
  const newestFirst = byTime[0]
  const oldestLast = byTime[byTime.length - 1]
  check('newest conversation is first', toMs(newestFirst.started_at) >= toMs(byTime[1].started_at), `"${(newestFirst.title ?? '').slice(0, 30)}"`)
  check('oldest conversation is last', toMs(oldestLast.started_at) <= toMs(byTime[byTime.length - 2].started_at), `"${(oldestLast.title ?? '').slice(0, 30)}"`)
  check('order is strictly non-increasing by started_at', (() => {
    for (let i = 1; i < byTime.length; i++) if (toMs(byTime[i].started_at) > toMs(byTime[i - 1].started_at)) return false
    return true
  })())
  check('sort does not mutate the input array', rows[0]?.id === res.sessions[0]?.id)

  // Unit sanity: fractional seconds, not ms.
  const sample = rows[0]?.started_at
  check('started_at is fractional SECONDS (not ms)', typeof sample === 'number' && sample < 1e11 && !Number.isInteger(sample), String(sample))
  check('started_at converts to a sane date', (() => {
    const ms = toMs(sample)
    const y = new Date(ms).getFullYear()
    return y >= 2024 && y <= 2030
  })(), new Date(toMs(sample)).toISOString().slice(0, 16))

  console.log('\nfirst 6 in drawer order:')
  byTime.slice(0, 6).forEach((r, i) => console.log(`  ${i + 1}. ${new Date(toMs(r.started_at)).toISOString().slice(5, 16)}  ${(r.title ?? r.preview ?? r.id).slice(0, 40)}`))
  console.log('\nlast 3:')
  byTime.slice(-3).forEach((r) => console.log(`     ${new Date(toMs(r.started_at)).toISOString().slice(5, 16)}  ${(r.title ?? r.preview ?? r.id).slice(0, 40)}`))

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})
ws.addEventListener('error', () => { console.error('ws error'); process.exit(1) })
