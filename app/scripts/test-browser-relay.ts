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
type RelayMod = typeof import('../src/lib/browserRelay')

let m: RelayMod

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function makeFakeNative() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  let url: string | null = null
  return {
    calls,
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
  })
  const bad = await m.ensureBrowserRelay()
  check('native failure surfaces as non-running status with lastError', bad.running === false && !!bad.lastError)
  check('failed status still lands in the store for the UI', m.relayStatus.get()?.running === false)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
