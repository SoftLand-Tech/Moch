// Unit tests for the Moch Browser relay state (src/lib/browserRelay.ts):
// status normalization, the tab store lifecycle, active-url sync against a
// fake native module, and the Ask-Moch payload shape — no RN, no device
// (same constraint/contract as test-sharein.ts / test-queue.ts).
//
// REVIEW FIX: `export {}` makes this a module. tsconfig.scripts.json
// typechecks every script together and script-style files share one global
// scope — the top-level pass/fail/check/tick collided with test-chat-list.ts
// (TS2451) and broke `npm run typecheck`.
export {}
import type { MochTabOpEvent } from '../src/lib/browserRelay'
type RelayMod = typeof import('../src/lib/browserRelay')
type TabOpEvent = MochTabOpEvent

let m: RelayMod

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

type FakeTarget = { id: string; url: string; title: string }

function makeFakeNative() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const acks: Array<{ requestId: string; ok: boolean; error: string | null }> = []
  let url: string | null = null
  let targets: FakeTarget[] = []
  return {
    calls,
    acks,
    setTabTargets(next: FakeTarget[]) {
      targets = next
    },
    module: {
      async ensureRunning(port: number) {
        calls.push({ fn: 'ensureRunning', args: [port] })
        return { running: true, port, token: 'tok123', activeUrlPrefix: url, lastError: null, webDebugEnabled: true }
      },
      async stop() {
        calls.push({ fn: 'stop', args: [] })
        return { running: false, port: 0, token: null, activeUrlPrefix: null, lastError: null, webDebugEnabled: true }
      },
      async status() {
        return { running: true, port: 9334, token: 'tok123', activeUrlPrefix: url, lastError: null, webDebugEnabled: true }
      },
      async setActiveUrl(next: string | null) {
        calls.push({ fn: 'setActiveUrl', args: [next] })
        url = next
        return true
      },
      async setWebDebugEnabled(enabled: boolean) {
        calls.push({ fn: 'setWebDebugEnabled', args: [enabled] })
        return enabled
      },
      tabOpAck(requestId: string, ok: boolean, error?: string | null) {
        calls.push({ fn: 'tabOpAck', args: [requestId, ok, error] })
        acks.push({ requestId, ok, error: error ?? null })
      },
      async tabTargets() {
        calls.push({ fn: 'tabTargets', args: [] })
        return targets
      },
    },
  }
}

/** Fake mochTabOp emitter (pattern from test-sharein.ts's fakeEmitter). */
function makeFakeEmitter() {
  const listeners: Array<(e: TabOpEvent) => void> = []
  return {
    emit(ev: Partial<TabOpEvent>) {
      listeners.slice().forEach((cb) => cb(ev as TabOpEvent))
    },
    listenerCount: () => listeners.length,
    emitter: {
      addListener(name: string, cb: (e: TabOpEvent) => void) {
        if (name !== 'mochTabOp') throw new Error(`unexpected event name: ${name}`)
        listeners.push(cb)
        return { remove: () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } }
      },
    },
  }
}

async function main() {
  m = await import('../src/lib/browserRelay')

  // ── ensureBrowserRelay against the fake ─────────────────────────────────
  const fake = makeFakeNative()
  m._useBrowserRelayForTests(fake.module as never)

  const st = await m.ensureBrowserRelay()
  check('ensureRunning starts relay + enables debug', st.running === true && st.port === 9334 && st.webDebugEnabled === true)
  check('debug called before ensureRunning', (() => {
    const fns = fake.calls.map((c) => c.fn)
    return fns.indexOf('setWebDebugEnabled') < fns.indexOf('ensureRunning') && fns.indexOf('setWebDebugEnabled') !== -1
  })())

  // ── tab store ────────────────────────────────────────────────────────────
  const t1 = m.addTab('https://example.com/a')
  check('addTab sets it active', m.activeTabId.get() === t1.id)
  check('addTab syncs url to native', fake.calls.some((c) => c.fn === 'setActiveUrl' && c.args[0] === 'https://example.com/a'))

  const t2 = m.addTab('https://example.com/b')
  check('second tab becomes active', m.activeTabId.get() === t2.id)

  // In-page navigation: updateTab with a live url re-syncs.
  m.updateTab(t2.id, { url: 'https://example.com/b?page=2', title: 'B2' })
  await tick()
  check(
    'updateTab re-syncs active url',
    fake.calls.some((c) => c.fn === 'setActiveUrl' && c.args[0] === 'https://example.com/b?page=2'),
  )

  // Background tab navigation does NOT move the relay filter.
  fake.calls.length = 0
  m.updateTab(t1.id, { url: 'https://example.com/a2' })
  await tick()
  check('background tab update does not sync filter', !fake.calls.some((c) => c.fn === 'setActiveUrl'))

  m.switchTab(t1.id)
  await tick()
  check('switchTab syncs the tab url', fake.calls.some((c) => c.fn === 'setActiveUrl' && c.args[0] === 'https://example.com/a2'))

  // ── closeTab ─────────────────────────────────────────────────────────────
  m.closeTab(t1.id)
  check('closing the active tab falls back to a neighbor', m.activeTabId.get() === t2.id)
  check('closed tab removed from store', m.browserTabs.get().length === 1)

  m.closeTab(t2.id)
  check('closing the last tab clears active', m.activeTabId.get() === null)

  // switchTab to a dead id is a no-op
  m.switchTab('nope')
  check('switchTab to unknown id is a no-op', m.activeTabId.get() === null)

  // ── getActiveTab ─────────────────────────────────────────────────────────
  const t3 = m.addTab('https://example.com/c')
  check('getActiveTab returns the active tab', m.getActiveTab()?.id === t3.id)
  m.closeTab(t3.id)
  check('getActiveTab null with no tabs', m.getActiveTab() === null)

  // ── ensure failure path ──────────────────────────────────────────────────
  m._useBrowserRelayForTests({
    ensureRunning: () => Promise.reject(new Error('relay dead')),
    stop: () => Promise.resolve({} as never),
    status: () => Promise.resolve({} as never),
    setActiveUrl: () => Promise.resolve(true),
    setWebDebugEnabled: () => Promise.resolve(true),
    tabOpAck: () => {},
    tabTargets: () => Promise.resolve([]),
  })
  const bad = await m.ensureBrowserRelay()
  check('native failure surfaces as non-running status with lastError', bad.running === false && !!bad.lastError)
  check('failed status still lands in the store for the UI', m.relayStatus.get()?.running === false)

  // ── BUG-136: mochTabOp round-trip + tabs⇔targets registry ────────────────
  // Reset the store (earlier sections closed everything they opened).
  m.browserTabs.set([])
  m.activeTabId.set(null)

  const fx = makeFakeNative()
  const fe = makeFakeEmitter()
  m._useBrowserRelayForTests(fx.module as never, fe.emitter)
  await m.ensureBrowserRelay() // any native touchpoint arms the mochTabOp listener
  await tick()
  check('mochTabOp listener armed once', fe.listenerCount() === 1)

  // open → addTab + ok ack carrying the SAME requestId
  fe.emit({ requestId: 'req-open', op: 'open', url: 'https://round.trip/new' })
  await tick()
  await tick()
  check(
    'open adds the tab to the store',
    m.browserTabs.get().length === 1 && m.browserTabs.get()[0].url === 'https://round.trip/new',
  )
  check('open makes the new tab active', m.activeTabId.get() === m.browserTabs.get()[0].id)
  check(
    'open acked ok with the right requestId',
    fx.acks.length === 1 && fx.acks[0].requestId === 'req-open' && fx.acks[0].ok === true && fx.acks[0].error === null,
  )

  // registry: map tab.url against the relay's upstream page list
  fx.setTabTargets([{ id: 'TG-NEW', url: 'https://round.trip/new', title: 'New' }])
  await m.refreshTabTargetIds(true)
  check('registry maps the tab to its DevTools target', m.browserTabs.get()[0].targetId === 'TG-NEW')

  // activate → switchTab by targetId
  const tB = m.addTab('https://round.trip/b')
  check('pre-activate: the other tab is active', m.activeTabId.get() === tB.id)
  fe.emit({ requestId: 'req-act', op: 'activate', targetId: 'TG-NEW' })
  await tick()
  check('activate switches to the mapped tab', m.activeTabId.get() === m.browserTabs.get()[0].id)
  check('activate acked ok', fx.acks.some((a) => a.requestId === 'req-act' && a.ok))

  // activate with an unknown target → honest failure ack
  fe.emit({ requestId: 'req-act-bad', op: 'activate', targetId: 'NOPE' })
  await tick()
  const badAct = fx.acks.find((a) => a.requestId === 'req-act-bad')
  check(
    'activate with an unknown target fails honestly',
    !!badAct && badAct.ok === false && /no open tab matches/.test(badAct.error ?? ''),
  )

  // close → closeTab by targetId
  fx.setTabTargets([
    { id: 'TG-NEW', url: 'https://round.trip/new', title: 'New' },
    { id: 'TG-B', url: 'https://round.trip/b', title: 'B' },
  ])
  await m.refreshTabTargetIds(true)
  check('second tab mapped', m.browserTabs.get().find((t) => t.id === tB.id)?.targetId === 'TG-B')
  fe.emit({ requestId: 'req-close', op: 'close', targetId: 'TG-B' })
  await tick()
  check('close removes the mapped tab', !m.browserTabs.get().some((t) => t.id === tB.id))
  check('close acked ok', fx.acks.some((a) => a.requestId === 'req-close' && a.ok))
  check(
    'close kept the other tab with its mapping',
    m.browserTabs.get().length === 1 && m.browserTabs.get()[0].targetId === 'TG-NEW',
  )

  // close the LAST remaining tab → refused (RN mirror of the Python guard)
  fe.emit({ requestId: 'req-close-last', op: 'close', targetId: 'TG-NEW' })
  await tick()
  const lastAck = fx.acks.find((a) => a.requestId === 'req-close-last')
  check(
    'closing the last tab is refused',
    !!lastAck && lastAck.ok === false && /last remaining tab/.test(lastAck.error ?? ''),
  )
  check('the last tab stays in the store', m.browserTabs.get().length === 1)

  // duplicate-URL ties map in order, each target claimed once
  m.browserTabs.set([])
  m.activeTabId.set(null)
  m.addTab('https://dup.example/')
  m.addTab('https://dup.example/')
  fx.setTabTargets([
    { id: 'DUP-1', url: 'https://dup.example/', title: 'd1' },
    { id: 'DUP-2', url: 'https://dup.example/', title: 'd2' },
  ])
  await m.refreshTabTargetIds(true)
  const dups = m.browserTabs.get().map((t) => t.targetId)
  check(
    'duplicate URLs tie to the first unused target (documented limitation)',
    dups[0] === 'DUP-1' && dups[1] === 'DUP-2',
  )

  // a target that disappeared upstream → its tab's targetId is dropped
  fx.setTabTargets([{ id: 'DUP-1', url: 'https://dup.example/', title: 'd1' }])
  await m.refreshTabTargetIds(true)
  check(
    'disappeared target unmaps (stale ids never linger)',
    m.browserTabs.get()[0].targetId === 'DUP-1' && m.browserTabs.get()[1].targetId === undefined,
  )

  // re-injecting without an emitter unsubscribes the old one
  m._useBrowserRelayForTests(null)
  check('re-inject without an emitter unsubscribes', fe.listenerCount() === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
