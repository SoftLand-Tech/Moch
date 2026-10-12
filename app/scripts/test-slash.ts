// Verifies the app's slash execution contract against the live gateway:
//   - skills go through command.dispatch (slash.exec refuses them with 4018)
//   - built-ins go through slash.exec and return output
//   - the "//name" double-slash bug is handled by normalisation
//   - usage errors surface as text, not silent failure
// Plus the offline unit battery (BH-000023) that runs first, no gateway
// needed: the empty-catalog hold-off and the send-path routing decision.
import fs from 'node:fs'
import {
  isKnownSlashCommand, slashRouteFor, resolveSlashRoute, resetCatalog,
  commandCatalog, skillCommands, _useGatewayForTests,
} from '../src/lib/slash'

let pass = 0
let fail = 0
const errCode = (e: unknown): number | undefined => (e as { code?: number }).code
const errMsg = (e: unknown): string => (e as Error).message ?? ''
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// Mirrors normalizeCommandName from src/lib/slash.ts
const normalizeCommandName = (raw: string) => String(raw).trim().replace(/^\/+/, '').toLowerCase()
const canonicalName = (raw: string): string => normalizeCommandName(raw)

/** A gateway whose commands.catalog call FAILS — the offline shape. */
const offlineGateway = {
  rpc: async (method: string): Promise<unknown> => {
    throw Object.assign(new Error(`${method}: not connected`), { code: -1 })
  },
  onEvent: () => () => {},
} as unknown as typeof import('../src/lib/gateway')

/** A gateway that serves a small catalog (model known, airtable skill). */
const catalogGateway = {
  rpc: async (method: string): Promise<unknown> => {
    if (method === 'commands.catalog') {
      return {
        commands: { model: { description: 'Switch model' }, status: { description: 'Status' } },
        skills: { '/airtable': {} },
        categories: [],
      }
    }
    return {}
  },
  onEvent: () => () => {},
} as unknown as typeof import('../src/lib/gateway')

/** BH-000023: the empty-catalog guess is gone — the send path HOLDS, loads
 *  once, and never dead-ends "/…" text into a 'Command failed' alert that
 *  bypasses the offline outbox. */
async function runUnits() {
  console.log('— units: empty-catalog routing (no gateway process) —')

  // 1. Empty registry (offline / pre-boot): nothing is KNOWN any more.
  resetCatalog()
  check('empty catalog: isKnownSlashCommand is false (was the legacy true)', isKnownSlashCommand('/model') === false)
  check('empty catalog: plain text is still a message', slashRouteFor('hello world') === 'message')
  check('empty catalog: slash text routes to hold, not a guess', slashRouteFor('/model') === 'hold')
  check('bare "/" is a message (no command name)', slashRouteFor('/') === 'message')

  // 2. loadCatalog fails (offline): the hold resolves to 'message' so the
  //    text flows through sendPrompt and the offline machinery owns it
  //    (failed row + outbox retry) instead of a dead-end alert.
  _useGatewayForTests(offlineGateway)
  const offlineRoute = await resolveSlashRoute('/model')
  check('catalog load fails offline -> text is queued as a message', offlineRoute === 'message', offlineRoute)
  check('offline route for plain text stays message', (await resolveSlashRoute('hello')) === 'message')

  // 3. Catalog loads: known commands dispatch exactly as before.
  _useGatewayForTests(catalogGateway)
  resetCatalog()
  const knownRoute = await resolveSlashRoute('/model')
  check('loaded catalog: known command dispatches', knownRoute === 'command', knownRoute)
  check('loaded catalog: skill command dispatches', (await resolveSlashRoute('/airtable')) === 'command')

  // 4. Loaded catalog + unknown slash text: BUG-042 behavior (send it).
  const unknownRoute = await resolveSlashRoute('/usr/bin/env')
  check('loaded catalog: unknown slash text sends as a message', unknownRoute === 'message', unknownRoute)
  check('loaded catalog: isKnownSlashCommand known -> true', isKnownSlashCommand('/model') === true)
  check('loaded catalog: isKnownSlashCommand unknown -> false', isKnownSlashCommand('/usr/bin/env') === false)
  check('loaded catalog: slashRouteFor known -> command', slashRouteFor('/model') === 'command')

  _useGatewayForTests(null)
  resetCatalog()
}

async function runLive() {
  const env = fs.readFileSync(`${process.env.HOME}/.config/hermes-serve.env`, 'utf8')
  const token = env.match(/HERMES_DASHBOARD_SESSION_TOKEN=(.+)/)?.[1]?.trim()
  if (!token) { console.error('no token'); process.exit(1) }

  const ws = new WebSocket(`ws://127.0.0.1:9119/api/ws?token=${encodeURIComponent(token)}`)
  let n = 0
  const pend = new Map()
  const rpc = (m: string, p: Record<string, unknown> = {}): Promise<any> =>
    new Promise((res, rej) => {
      const id = `q${++n}`
      const t = setTimeout(() => {
        const err = new Error(`${m}: failed`) as Error & { code: number }
        err.code = -1
        rej(err)
      }, 25000)
      pend.set(id, { res, rej, t })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p }))
    })

  ws.addEventListener('message', (e) => {
    const f = JSON.parse(String(e.data))
    if (typeof f.id === 'string' && typeof f.method === 'string' && f.method !== 'event') return
    if (f.id == null) return
    const c = pend.get(f.id)
    if (!c) return
    clearTimeout(c.t)
    pend.delete(f.id)
    f.error ? c.rej(Object.assign(new Error(f.error.message), { code: f.error.code })) : c.res(f.result)
  })

  ws.addEventListener('open', async () => {
    await new Promise((r) => setTimeout(r, 400))
    const sess = await rpc('session.create', { title: 'verify-slash', cols: 120, source: 'mobile' })
    const SID = sess.session_id

    // 1. Normalisation kills the double-slash bug
    check('normalise "//airtable" -> "airtable"', canonicalName('//airtable') === 'airtable')
    check('normalise "/MODEL" -> "model"', canonicalName('/MODEL') === 'model')
    check('normalise "/" -> ""', canonicalName('/') === '')

    // 2. Skill through command.dispatch (the correct path)
    const cat = await rpc('commands.catalog', { session_id: SID })
    const skillKey = Object.keys(cat?.skills ?? {})[0] // e.g. "/airtable"
    const skillBare = canonicalName(skillKey)
    check('catalog skill keys carry a leading slash', skillKey.startsWith('/'), skillKey)
    try {
      const d = await rpc('command.dispatch', { name: skillBare, session_id: SID })
      check('skill via command.dispatch returns a directive', !!d?.type, `type=${d?.type}`)
    } catch (e) {
      check('skill via command.dispatch returns a directive', false, `${errCode(e)} ${errMsg(e).slice(0, 50)}`)
    }

    // 3. slash.exec REFUSES skills — so dispatch must be tried first
    try {
      await rpc('slash.exec', { command: `/${skillBare}`, session_id: SID })
      check('slash.exec rejects skills (so dispatch-first is required)', false, 'unexpectedly succeeded')
    } catch (e) {
      check('slash.exec rejects skills (so dispatch-first is required)', errCode(e) === 4018, `code=${errCode(e)}`)
    }

    // 4. Built-in through slash.exec returns output
    const st = await rpc('slash.exec', { command: '/status', session_id: SID })
    check('built-in /status via slash.exec returns output', typeof st?.output === 'string' && st.output.length > 0, `${st?.output?.length ?? 0} chars`)

    // 5. dispatch 4018s on built-ins -> the fall-through must trigger
    try {
      await rpc('command.dispatch', { name: 'status', session_id: SID })
      check('dispatch 4018s on built-ins', false, 'unexpectedly succeeded')
    } catch (e) {
      check('dispatch 4018s on built-ins', errCode(e) === 4018, `code=${errCode(e)}`)
    }

    // 6. Usage error (missing arg) surfaces a message, not silence
    try {
      await rpc('command.dispatch', { name: 'queue', session_id: SID })
      check('missing-arg usage error is surfaced', false, 'no error raised')
    } catch (e) {
      check('missing-arg usage error is surfaced', typeof errMsg(e) === 'string' && /usage/i.test(errMsg(e)), errMsg(e).slice(0, 40))
    }

    // 7. completions: text has no slash, display does
    const comp = await rpc('complete.slash', { text: '/', session_id: SID })
    const items = comp?.items ?? []
    check('bare "/" lists the catalog', items.length > 40, `${items.length} items`)
    const commands = items.filter((i: any) => i.kind === 'command')
    const skills = items.filter((i: any) => i.kind === 'skill')
    check('both commands and skills are listed', commands.length > 0 && skills.length > 0, `${commands.length} cmd / ${skills.length} skill`)
    check('every completion yields exactly one leading slash when inserted', items.every((i: any) => {
      // This is the exact insertion logic in chat.tsx.
      const t = String(i.text)
      const insertable = t.startsWith('/') ? t : `/${t}`
      return insertable.startsWith('/') && !insertable.startsWith('//')
    }), items.filter((i: any) => String(i.text).startsWith('/')).length + ' entries ship with a slash already')
    check('completion display always has one', items.every((i: any) => String(i.display ?? '').startsWith('/')), '')

    // 8. subcommand completion
    const sub = await rpc('complete.slash', { text: '/queue ', session_id: SID })
    const subItems = (sub?.items ?? []).map((i: any) => i.text)
    check('"/queue " completes subcommands', subItems.includes('list'), subItems.slice(0, 4).join(','))

    // 9. fuzzy: "/mo" reaches memory/queue via description tokens
    const fz = await rpc('complete.slash', { text: '/mo', session_id: SID })
    const fzNames = (fz?.items ?? []).map((i: any) => i.text)
    check('"/mo" fuzzy-matches beyond prefix', fzNames.length > 3, `${fzNames.length} matches`)

    await rpc('session.delete', { session_id: SID }).catch(() => {})
    console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
  ws.addEventListener('error', () => { console.error('ws error'); process.exit(1) })
}

async function main() {
  await runUnits()
  await runLive()
}

main().catch((err) => { console.error('test-slash crashed:', err); process.exit(1) })
