// Unit tests for OpenCode history grouping (no gateway, no RN): a single
// OpenCode turn is persisted as several assistant messages (one per step), so
// rehydration must merge them into ONE row with ordered segments — otherwise
// returning to a chat renders N bubbles where the live stream showed one.
//
// The mapper lives in src/lib/ocHistory.ts precisely so this suite can import
// it under plain tsx (opencodeChat.ts pulls AsyncStorage at module scope).
//
// Run: cd app && npx tsx scripts/test-oc-history.ts

import { mapOcHistory, type OcHistoryMessageLike, type OcHistoryRow } from '../src/lib/ocHistory'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const user = (text: string, ts: number): OcHistoryMessageLike => ({
  type: 'user',
  time: { created: ts },
  payload: { text },
})

const assistant = (ts: number, content: OcHistoryMessageLike['content']): OcHistoryMessageLike => ({
  type: 'assistant',
  time: { created: ts },
  content,
})

const seg = (r: OcHistoryRow, i: number) => r.segments?.[i]
const kinds = (r: OcHistoryRow) => (r.segments ?? []).map((s) => s.kind).join(',')

function main() {
  // ── One turn persisted as two assistant step messages → ONE row ──────────
  // Server payloads are NEWEST FIRST; this is [step2, step1, user1].
  const twoSteps: OcHistoryMessageLike[] = [
    assistant(300, [
      { type: 'reasoning', text: 'think-2' },
      { type: 'text', text: 'b1' },
      { type: 'tool', id: 'tool-2', name: 'read', state: { status: 'error' } },
    ]),
    assistant(200, [
      { type: 'reasoning', text: 'think-1' },
      { type: 'tool', id: 'tool-1', name: 'bash', state: { status: 'done' } },
      { type: 'text', text: 'a1' },
    ]),
    user('q1', 100),
  ]
  const r1 = mapOcHistory(twoSteps)
  check('two assistant steps between users → user + ONE assistant row', r1.length === 2 && r1[1].role === 'assistant')
  check('grouped row keeps the FIRST step timestamp', r1[1]?.ts === 200)
  check(
    'segments preserve stream order across steps',
    kinds(r1[1]) === 'thinking,text,thinking,text',
    kinds(r1[1]),
  )
  check(
    'thinking blocks stay in order',
    seg(r1[1], 0)?.text === 'think-1' && seg(r1[1], 2)?.text === 'think-2',
  )
  check('text blocks stay in order', seg(r1[1], 1)?.text === 'a1' && seg(r1[1], 3)?.text === 'b1')
  check('joined `text` covers both steps', r1[1]?.text === 'a1\nb1', JSON.stringify(r1[1]?.text))
  check('joined `thinking` covers both steps', r1[1]?.thinking === 'think-1think-2', JSON.stringify(r1[1]?.thinking))
  check(
    'tools collect across steps (id + name + ok)',
    r1[1]?.tools?.length === 2 &&
      r1[1].tools[0].id === 'tool-1' && r1[1].tools[0].name === 'bash' && r1[1].tools[0].ok === true &&
      r1[1].tools[1].id === 'tool-2' && r1[1].tools[1].name === 'read' && r1[1].tools[1].ok === false,
  )

  // ── A second user message starts a second assistant row ─────────────────
  const twoTurns: OcHistoryMessageLike[] = [
    assistant(500, [{ type: 'text', text: 'a2' }]),
    user('q2', 400),
    assistant(300, [{ type: 'text', text: 'b1' }]),
    assistant(200, [{ type: 'text', text: 'a1' }]),
    user('q1', 100),
  ]
  const r2 = mapOcHistory(twoTurns)
  check(
    'second user message starts a new assistant row (no merge across user)',
    r2.length === 4 &&
      r2[0].role === 'user' && r2[0].text === 'q1' &&
      r2[1].role === 'assistant' && r2[1].text === 'a1\nb1' &&
      r2[2].role === 'user' && r2[2].text === 'q2' &&
      r2[3].role === 'assistant' && r2[3].text === 'a2',
  )
  check('second turn keeps its own first timestamp', r2[3]?.ts === 500)

  // ── Adjacent same-kind segments merge across steps ─────────────────────
  const sameKind: OcHistoryMessageLike[] = [
    assistant(300, [{ type: 'text', text: 'second' }]),
    assistant(200, [{ type: 'text', text: 'first' }]),
    user('q', 100),
  ]
  const r3 = mapOcHistory(sameKind)
  check(
    'adjacent text blocks merge into one segment',
    kinds(r3[1]) === 'text' && seg(r3[1], 0)?.text === 'first\nsecond' && r3[1].text === 'first\nsecond',
  )
  const sameThinking: OcHistoryMessageLike[] = [
    assistant(300, [{ type: 'reasoning', text: 'two' }]),
    assistant(200, [{ type: 'reasoning', text: 'one' }]),
    user('q', 100),
  ]
  check(
    'adjacent thinking blocks merge into one segment',
    kinds(mapOcHistory(sameThinking)[1]) === 'thinking' &&
      seg(mapOcHistory(sameThinking)[1], 0)?.text === 'onetwo',
  )

  // ── Tool-only step still produces a row (and no fake text) ─────────────
  const toolOnly: OcHistoryMessageLike[] = [
    assistant(200, [{ type: 'tool', id: 't', name: 'glob', state: { status: 'running' } }]),
    user('q', 100),
  ]
  const r4 = mapOcHistory(toolOnly)
  check(
    'tool-only assistant row survives with no segments',
    r4.length === 2 && r4[1].role === 'assistant' && r4[1].text === '' &&
      r4[1].segments === undefined && r4[1].tools?.length === 1 && r4[1].tools[0].ok === true,
  )

  // ── Empty assistant step boundaries do not split or create rows ────────
  const emptyStep: OcHistoryMessageLike[] = [
    assistant(400, []),
    assistant(300, [{ type: 'text', text: 'tail' }]),
    assistant(200, []),
    assistant(150, [{ type: 'text', text: 'head' }]),
    assistant(120, []),
    user('q', 100),
  ]
  const r5 = mapOcHistory(emptyStep)
  check('empty step messages are skipped, the turn stays one row', r5.length === 2 && kinds(r5[1]) === 'text' && r5[1].text === 'head\ntail')
  check('the FIRST assistant step still owns the turn timestamp', r5[1]?.ts === 120)

  // ── Empty user text still separates turns ──────────────────────────────
  const emptyUser: OcHistoryMessageLike[] = [
    assistant(300, [{ type: 'text', text: 'after' }]),
    user('   ', 250),
    assistant(200, [{ type: 'text', text: 'before' }]),
    user('q', 100),
  ]
  const r6 = mapOcHistory(emptyUser)
  check(
    'blank user message does not merge assistant steps across it',
    r6.length === 3 && r6[0].text === 'q' && r6[1].text === 'before' && r6[2].text === 'after',
  )

  // ── Empty history / junk types are harmless ────────────────────────────
  check('empty history maps to no rows', mapOcHistory([]).length === 0)
  check(
    'idle/unknown message types are ignored',
    mapOcHistory([{ type: 'idle', time: { created: 1 } }]).length === 0,
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
