/**
 * Test — the command-output pipeline: classification, usage extraction, name
 * normalization, and the runCommand producer overrides.
 *
 * Runs OFFLINE against a fake gateway (same harness shape as
 * test-interactive.ts) — NOT test-slash.ts, which needs a live gateway and
 * real sessions. Plain tsx, node only: everything imported here loads in
 * plain node (slash.ts and the protocol client do; chat.ts does not — only
 * its TYPE is imported below, which is erased at runtime).
 *
 * Covered:
 *  - classifyOutput rule order, pinned by the trap fixture: a ~200-line
 *    /help-style dump that ENDS WITH a "Type /help …" footer must classify
 *    'catalog' (volume rule first), never 'usage'
 *  - the ≤4-line usage gate: a 30-line kv table with the same trailing
 *    footer classifies 'status'
 *  - extractUsage / slashLabel / sub-parsers as units
 *  - runCommand: both catch paths keep variant 'error' AND run the same
 *    suggestion/hint extraction; the 4018 fall-through is intact; directive
 *    output is classified; send outcomes carry no subtype
 *  - interactiveTarget: catalog-before-argumentModeFor, args guard, model
 *  - persistence shape (pure JSON, deliberately weaker than driving the real
 *    persistSession — chat.ts is unimportable in plain node): `cmd`
 *    round-trips when present, stays absent otherwise
 *
 *   npx tsx scripts/test-command-output.ts
 */
import ws from 'ws'
import {
  runCommand, classifyOutput, extractUsage, slashLabel,
  catalogTokenHits, listRowStats, parseStatusPairs, interactiveTarget,
  commandCatalog, skillCommands, commandCategories,
  resetCatalog, _useGatewayForTests,
  type SlashOutcome,
} from '../src/lib/slash'
// Type-only — erased before execution; chat.ts itself needs react-native.
import type { ChatMessage } from '../src/lib/chat'
import { JsonRpcGatewayClient } from '../src/protocol/json-rpc-gateway'

const WebSocketServerImpl = ((ws as unknown as Record<string, unknown>).WebSocketServer ??
  (ws as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** An error frame the way the gateway sends one — code rides the throw. */
class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

const READY = {
  type: 'gateway.ready',
  payload: { heartbeat: true, change_events: true, replay_epoch: 'cmdtest000001', skin: {} },
}

interface WireFrame {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

type Handler = (params: Record<string, unknown>) => unknown

/** Fake gateway on an ephemeral port; handlers may throw RpcError to send an error frame. */
async function withFakeGateway(handlers: Record<string, Handler>, fn: (sent: Array<{ method: string; params: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    sock.on('message', (data: import('ws').RawData) => {
      let frame: WireFrame
      try { frame = JSON.parse(String(data)) as WireFrame } catch { return }
      if (frame.method === 'client.capabilities') {
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { server_requests: [] } }))
        return
      }
      if (typeof frame.method === 'string' && frame.params) {
        sent.push({ method: frame.method, params: frame.params })
        const h = handlers[frame.method]
        if (!h) {
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
          return
        }
        try {
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: h(frame.params) ?? {} }))
        } catch (e) {
          const err = e as { code?: number; message?: string }
          sock.send(JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: typeof err.code === 'number' ? err.code : -32000, message: err.message ?? String(e) },
          }))
        }
      }
    })
  })
  const client = new JsonRpcGatewayClient({
    connectTimeoutMs: 8000,
    requestTimeoutMs: 8000,
    socketFactory: (url) => new WebSocket(url) as unknown as WebSocket,
  })
  const realGateway = {
    rpc: <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => client.request<T>(method, params),
    onEvent: () => () => {},
  }
  try {
    await client.connect(`ws://127.0.0.1:${port}/api/ws?token=t`)
    _useGatewayForTests(realGateway as unknown as typeof import('../src/lib/gateway'))
    return await fn(sent)
  } finally {
    _useGatewayForTests(null)
    try { client.close() } catch {}
    wss.close()
  }
}

// ── Registry seed (shared by the classification fixtures) ──────────────────

const SEED_CMDS = Array.from({ length: 64 }, (_, i) => `cmd${String(i).padStart(2, '0')}`)
const SEED_SKILLS = ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e', 'skill-f', 'skill-g', 'skill-h']

function seedRegistry() {
  commandCatalog.set(Object.fromEntries(SEED_CMDS.map((n) => [n, { description: n }])))
  skillCommands.set(Object.fromEntries(SEED_SKILLS.map((n) => [`/${n}`, { origin: 'core' as const }])))
  commandCategories.set([{ name: 'Core', pairs: SEED_CMDS.slice(0, 8).map((n) => [`/${n}`, n] as [string, string]) }])
}

/** ~200-line /help-style box art listing 60 seeded commands, 3 ghosts, and the trap footer. */
function helpDump(): string {
  const lines: string[] = []
  lines.push('╭──────────────────────────────────────╮')
  lines.push('│  Hermes — available commands         │')
  lines.push('╰──────────────────────────────────────╯')
  lines.push('')
  for (const n of SEED_CMDS.slice(0, 60)) lines.push(`  /${n} — do the ${n} thing`)
  for (const g of ['ghost-one', 'ghost-two', 'ghost-three']) lines.push(`  /${g} — not in this registry`)
  while (lines.length < 199) lines.push('   (more notes on usage and flags)')
  lines.push('Type /help <command> for details.')
  return lines.join('\n')
}

/** 30 `label: value` lines plus the same trap footer. */
function kvTable(): string {
  const lines = Array.from({ length: 30 }, (_, i) => `Metric ${i}: value-${i}`)
  lines.push('Type /help for details.')
  return lines.join('\n')
}

async function testSubParsers() {
  console.log('\n— sub-parsers —')
  resetCatalog()

  const pairs = parseStatusPairs('Model: glm-5.3-flash\nno colon here\n- Not: a kv line\nCost (USD): $1.23')
  check('status pairs: two real, kv-in-markdown skipped',
    pairs.length === 2 && pairs[0][0] === 'Model' && pairs[0][1] === 'glm-5.3-flash' && pairs[1][0] === 'Cost (USD)',
    JSON.stringify(pairs))

  const rows = listRowStats('/a one\n1. two\nplain line\n2) three')
  check('list rows: slash-led + numbered, prose not', rows.lines === 4 && rows.rows === 3, JSON.stringify(rows))

  check('extractUsage: did-you-mean', extractUsage('Unknown command — did you mean /codex?').suggestion === '/codex')
  check('extractUsage: bare did-you-mean (no slash in prose)', extractUsage('did you mean codex maybe').suggestion === '/codex')
  check('extractUsage: type /help', extractUsage('Type /help for the full list.').hint === 'Type /help for the full list.')
  check('extractUsage: unknown command', extractUsage('unknown command /x').hint !== undefined)
  check('extractUsage: usage: prefix', extractUsage('usage: /model <name>').hint !== undefined)
  check('extractUsage: clean prose extracts nothing', Object.keys(extractUsage('All done, nothing to see.')).length === 0)

  check('slashLabel: bare canonical', slashLabel('model') === '/model')
  check('slashLabel: label with slash', slashLabel('/model') === '/model')
  check('slashLabel: skill key with slash', slashLabel('//airtable') === '/airtable')
  check('slashLabel: whitespace tolerance', slashLabel('  model  ') === '/model')
}

async function testClassifyFixtures() {
  console.log('\n— classifyOutput rule order (registry seeded) —')
  resetCatalog()
  seedRegistry()

  const dump = helpDump()
  check('catalog: 60 distinct registry hits', catalogTokenHits(dump) === 60, String(catalogTokenHits(dump)))
  check('catalog: volume dump with trap footer -> catalog', classifyOutput(dump) === 'catalog', classifyOutput(dump))
  check('trap isolated: the footer alone IS usage prose', classifyOutput('Type /help <command> for details.') === 'usage')

  check('notice: the no-agent one-liner', classifyOutput('(._.) No active agent -- send a message first.') === 'notice')

  const probe = 'Unknown command /cwd — nothing was sent. Did you mean /codex?\nType /help for the full list.'
  const u = classifyOutput(probe)
  const ex = extractUsage(probe)
  check('usage: live probe string classifies usage', u === 'usage', u)
  check('usage: probe carries suggestion /codex', ex.suggestion === '/codex')
  check('usage: probe carries a hint', !!ex.hint, ex.hint ?? '(none)')

  const kv = kvTable()
  check('status: 30-line kv + trap footer -> status, not usage', classifyOutput(kv) === 'status', classifyOutput(kv))
  check('status: footer line survives as leftover, pairs stay 30', parseStatusPairs(kv).length === 30)

  const sample = 'Model: glm-5.3-flash\nProvider: zai\nTokens: 12,345\nCost: $0.42'
  check('status: 4-line sample -> status', classifyOutput(sample) === 'status', classifyOutput(sample))
  check('status: sample parses 4 pairs', parseStatusPairs(sample).length === 4)

  check('list: numbered slash rows', classifyOutput('1. /model — switch\n2. /help — help\n3. /new — new') === 'list')

  check('result: markdown bullets stay result', classifyOutput('- alpha\n- beta\n- gamma\n- delta') === 'result')
  const prose = Array.from({ length: 10 }, (_, i) => `Paragraph line ${i} with words and no markers.`).join('\n')
  check('result: long plain prose', classifyOutput(prose) === 'result')

  check('notice: single short line under 160', classifyOutput('/new — done') === 'notice')

  // Edge states (pin the empty/very-long/multiline cases the card guards for).
  check('edge: empty text -> notice (card renders nothing)', classifyOutput('') === 'notice')
  check('edge: whitespace-only -> notice', classifyOutput('  \n  \t ') === 'notice')
  check('edge: single line over 160 chars -> result', classifyOutput('x'.repeat(200)) === 'result')
  check('edge: two plain prose lines -> result (notice needs one line)', classifyOutput('first plain line\nsecond plain line') === 'result')
  check('edge: crlf line endings still count lines', classifyOutput('Model: a\r\nProvider: b\r\nTokens: 2') === 'status')
  check('edge: extraction of empty text is empty', Object.keys(extractUsage('')).length === 0)
}

async function testInteractivePrecedence() {
  console.log('\n— interactiveTarget precedence —')
  resetCatalog()
  commandCatalog.set({ help: { description: 'Help', argument_mode: 'options' } })
  commandCategories.set([{ name: 'Core', pairs: [['/help', 'help']] }])

  check('help/commands open the browser even over argument_mode options', interactiveTarget('help', '') === 'catalog', String(interactiveTarget('help', '')))
  check('typed args still guard first', interactiveTarget('help', 'model') === null)
  check('/model unchanged', interactiveTarget('model', '') === 'model-picker')
  check('bare /commands -> catalog', interactiveTarget('commands', '') === 'catalog')

  commandCategories.set([])
  commandCatalog.set({})
  check('empty registry: /help still opens the self-loading browser', interactiveTarget('help', '') === 'catalog', String(interactiveTarget('help', '')))
  check('empty registry: /commands still -> catalog', interactiveTarget('commands', '') === 'catalog')
  check('empty catalog: unknown name falls through', interactiveTarget('nonexistent', '') === null)
}

async function testProducers() {
  console.log('\n— runCommand producer overrides (fake gateway) —')
  resetCatalog()

  await withFakeGateway({
    'command.dispatch': (params) => {
      const name = String(params.name)
      if (name === 'cwd') throw new RpcError(4018, 'not a dispatch command')
      if (name === 'x') throw new RpcError(4004, 'command.dispatch: Unknown command /x — did you mean /y?')
      if (name === 'skillish') return { type: 'exec', output: 'Model: a\nProvider: b\nTokens: 1\nCost: 2' }
      if (name === 'queuer') return { type: 'send', message: 'the queue prompt' }
      throw new RpcError(4018, 'not a dispatch command')
    },
    'slash.exec': (params) => {
      const command = String(params.command)
      if (command.startsWith('/cwd')) {
        throw new RpcError(4018, 'slash.exec: Unknown command /cwd — nothing was sent. Did you mean /codex?\nType /help for the full list.')
      }
      if (command.startsWith('/status')) {
        return { output: 'Model: glm\nProvider: zai\nTokens: 1\nCost: $0.01' }
      }
      return { output: 'ok' }
    },
  }, async (sent) => {
    // The probe: dispatch 4018s -> slash.exec raises usage prose as an error.
    // A failed call is red (variant 'error') AND still extracts suggestion/hint.
    const cwd: SlashOutcome = await runCommand('/cwd', 's1')
    check('probe: action show', cwd.action === 'show')
    if (cwd.action === 'show') {
      check('probe: subtype stays error', cwd.subtype === 'error', cwd.subtype)
      check('probe: suggestion extracted through the catch path', cwd.suggestion === '/codex', cwd.suggestion ?? '(none)')
      check('probe: hint extracted', !!cwd.hint, cwd.hint ?? '(none)')
      check('probe: text keeps the gateway prose', /Did you mean \/codex\?/.test(cwd.text), cwd.text.slice(0, 80))
    }

    // Dispatch failure with a non-4018 code: same extraction, still red.
    const x: SlashOutcome = await runCommand('/x', 's2')
    check('dispatch failure: action show', x.action === 'show')
    if (x.action === 'show') {
      check('dispatch failure: subtype error + suggestion', x.subtype === 'error' && x.suggestion === '/y', `${x.subtype} / ${x.suggestion ?? '(none)'}`)
    }

    // Regression: the 4018 fall-through is intact, success output is classified.
    const status: SlashOutcome = await runCommand('/status', 's3')
    check('fall-through: dispatch first, then slash.exec',
      sent[0]?.method === 'command.dispatch' && sent[1]?.method === 'slash.exec',
      sent.map((f) => f.method).join(' -> '))
    check('fall-through: kv output classified status', status.action === 'show' && status.subtype === 'status', status.action === 'show' ? status.subtype : status.action)

    // Directive exec output is classified too; the name keeps the label convention.
    const dir: SlashOutcome = await runCommand('/skillish', 's4')
    check('directive exec: classified', dir.action === 'show' && dir.subtype === 'status')
    check('directive exec: label convention normalized', dir.action === 'show' && slashLabel(dir.name) === '/skillish', dir.action === 'show' ? dir.name : '')

    // send outcomes are not show outcomes: no subtype, no card.
    const send: SlashOutcome = await runCommand('/queuer now', 's5')
    check('send outcome: no subtype field', send.action === 'send' && !('subtype' in send))
  })
}

async function testNameConventions() {
  console.log('\n— name normalization across registry conventions —')
  resetCatalog()
  commandCatalog.set({ model: { description: 'm' }, weird_one: { description: 'w' } })
  skillCommands.set({ '/airtable': { origin: 'local' }, '/cmd-9': {} })
  commandCategories.set([
    { name: 'Core', pairs: [['/model', 'model'], ['/airtable', 'skill']] },
    { name: 'More', pairs: [['/weird_one', 'weird_one']] },
  ])

  const keys = [
    ...Object.keys(commandCatalog.get()),
    ...Object.keys(skillCommands.get()),
    ...commandCategories.get().flatMap((c) => c.pairs.map(([k]) => k)),
  ]
  let bad: string | null = null
  for (const k of keys) {
    const labeled = slashLabel(k)
    if (!/^\/[^/]+$/.test(labeled)) { bad = `${k} -> ${labeled}`; break }
  }
  check(`every registry key renders with exactly one leading slash (${keys.length} keys)`, bad === null, bad ?? '')

  check('both SlashOutcome.name conventions converge', slashLabel('/model') === slashLabel('model') && slashLabel('/model') === '/model')
  check('skill key both ways converge', slashLabel('/airtable') === slashLabel('airtable') && slashLabel('/airtable') === '/airtable')
}

async function testPersistenceShape() {
  console.log('\n— persistence shape (pure JSON — deliberately weaker than driving persistSession) —')
  // chat.ts is unimportable in plain node (react-native/AsyncStorage at module
  // scope), so this pins the JSON round-trip of the field itself. The real
  // persistSession JSON.stringifies whole message objects inside its
  // { v: 1, messages, tools } envelope, so a surviving round-trip here is the
  // same contract the envelope sees.
  const row: ChatMessage = {
    id: 'm1', role: 'assistant', text: 'Model switched to glm.', ts: 1,
    cmd: { name: '/model', variant: 'success' },
  }
  const rt = JSON.parse(JSON.stringify(row)) as ChatMessage
  check('cmd survives JSON round-trip intact', rt.cmd?.name === '/model' && rt.cmd?.variant === 'success', JSON.stringify(rt.cmd))

  const plain: ChatMessage = { id: 'm2', role: 'user', text: 'hi', ts: 2 }
  const rtPlain = JSON.parse(JSON.stringify(plain)) as ChatMessage
  check('messages without cmd parse with cmd undefined', rtPlain.cmd === undefined)

  const hist = { id: 'm3', role: 'assistant', text: 'resumed', ts: 3 }
  check('applyHistory-shaped rows carry no cmd key', !('cmd' in hist))
}

async function main() {
  await testSubParsers()
  await testClassifyFixtures()
  await testInteractivePrecedence()
  await testProducers()
  await testNameConventions()
  await testPersistenceShape()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
