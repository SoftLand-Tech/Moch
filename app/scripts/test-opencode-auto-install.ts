/**
 * Regression tests for OpenCode auto-install (`ensureOpencodeInstalled`,
 * `ocEnsureServer`, `ocModelsOneShot`, and `runOneShotTurn`).
 *
 * Run: cd app && npx tsx scripts/test-opencode-auto-install.ts
 */

import { createRequire } from 'node:module'
import ws from 'ws'

export {}

const require = createRequire(import.meta.url)
const Module = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}

const asyncStorageBacking = new Map<string, string>()
const asyncStorageMock = {
  getItem: async (k: string) => asyncStorageBacking.get(k) ?? null,
  setItem: async (k: string, v: string) => void asyncStorageBacking.set(k, v),
  removeItem: async (k: string) => void asyncStorageBacking.delete(k),
  multiGet: async (keys: string[]) => keys.map((k) => [k, asyncStorageBacking.get(k) ?? null]),
  multiSet: async (pairs: [string, string][]) => {
    for (const [k, v] of pairs) asyncStorageBacking.set(k, v)
  },
}

interface GuestState {
  bootstrapped: boolean
  rootfsExists: boolean
  tmpExists: boolean
  tarballExists: boolean
  opencodeInstalled: boolean
  bootstrapOk: boolean
  bootstrapSteps: string
  bootstrapCalls: number
  downloadCalls: number
  downloadShouldFail: boolean
  downloadGate: Promise<void> | null
  downloadGateResolve: (() => void) | null
  bootstrapGate: Promise<void> | null
  bootstrapGateResolve: (() => void) | null
  execCalls: string[]
  termProbeCalls: number
  termWrites: string[]
}

const state: GuestState = {
  bootstrapped: false,
  rootfsExists: false,
  tmpExists: false,
  tarballExists: false,
  opencodeInstalled: false,
  bootstrapOk: true,
  bootstrapSteps: '',
  bootstrapCalls: 0,
  downloadCalls: 0,
  downloadShouldFail: false,
  downloadGate: null,
  downloadGateResolve: null,
  bootstrapGate: null,
  bootstrapGateResolve: null,
  execCalls: [],
  termProbeCalls: 0,
  termWrites: [],
}

function resetState(overrides?: Partial<GuestState>) {
  state.bootstrapped = false
  state.rootfsExists = false
  state.tmpExists = false
  state.tarballExists = false
  state.opencodeInstalled = false
  state.bootstrapOk = true
  state.bootstrapSteps = ''
  state.bootstrapCalls = 0
  state.downloadCalls = 0
  state.downloadShouldFail = false
  state.downloadGate = null
  state.downloadGateResolve = null
  state.bootstrapGate = null
  state.bootstrapGateResolve = null
  state.execCalls = []
  state.termProbeCalls = 0
  state.termWrites = []
  if (overrides) Object.assign(state, overrides)
}

class MockDirectory {
  path: string
  constructor(parent: string | MockDirectory, name: string) {
    const base = typeof parent === 'string' ? parent : parent.path
    this.path = `${base.replace(/\/$/, '')}/${name}`
  }
  get exists(): boolean {
    if (this.path.endsWith('/.hermes/linux/rootfs')) return state.rootfsExists
    if (this.path.endsWith('/.hermes/linux/rootfs/tmp')) return state.rootfsExists && state.tmpExists
    return true
  }
}

class MockFile {
  path: string
  constructor(parent: string | MockDirectory, name: string) {
    const base = typeof parent === 'string' ? parent : parent.path
    this.path = `${base.replace(/\/$/, '')}/${name}`
  }
  get exists(): boolean {
    return state.tarballExists
  }
  delete(): void {
    state.tarballExists = false
  }
  static createDownloadTask(
    _url: string,
    dest: MockFile,
    opts?: { onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void },
  ) {
    return {
      async downloadAsync() {
        state.downloadCalls++
        if (state.downloadGate) await state.downloadGate
        if (state.downloadShouldFail) throw new Error('network error')
        opts?.onProgress?.({ bytesWritten: 50, totalBytes: 100 })
        opts?.onProgress?.({ bytesWritten: 100, totalBytes: 100 })
        state.tarballExists = true
        return dest
      },
    }
  }
}

let mockGatewayInfo: Record<string, unknown> | null = null

const origLoad = Module._load
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native') {
    return {
      Platform: { OS: 'android', select: (m: Record<string, unknown>) => m.android ?? m.default },
      AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
      NativeModules: {
        HermesBridge: {
          getGateway: async () => mockGatewayInfo,
          status: async () => ({ ready: true }),
          linuxStatus: async () => ({
            bootstrapped: state.bootstrapped,
            sizeMb: state.bootstrapped ? 120 : 0,
            distro: 'ubuntu-24.04',
          }),
          linuxBootstrap: async (_distro: string) => {
            state.bootstrapCalls++
            if (state.bootstrapGate) await state.bootstrapGate
            if (state.bootstrapOk) {
              state.bootstrapped = true
              state.rootfsExists = true
              state.tmpExists = true
            }
            return { ok: state.bootstrapOk, steps: state.bootstrapSteps }
          },
          linuxExec: async (cmd: string, _timeoutSec: number | null) => {
            state.execCalls.push(cmd)
            if (cmd.includes('command -v opencode')) {
              return state.opencodeInstalled
                ? { ok: true, stdout: '2.3.0\n', stderr: '', error: '' }
                : { ok: false, stdout: '', stderr: '', error: '' }
            }
            if (cmd.includes('tar xzf /tmp/opencode-arm64.tgz')) {
              if (!state.tarballExists) {
                return { ok: false, stdout: '', stderr: 'tarball missing', error: 'tarball missing' }
              }
              state.tarballExists = false
              state.opencodeInstalled = true
              return { ok: true, stdout: '2.3.0\n', stderr: '', error: '' }
            }
            if (cmd.includes('opencode models')) {
              if (!state.opencodeInstalled) {
                return { ok: false, stdout: '', stderr: 'opencode: command not found', error: '' }
              }
              return { ok: true, stdout: 'opencode/big-pickle\n', stderr: '', error: '' }
            }
            if (cmd.includes('opencode run')) {
              if (!state.opencodeInstalled) {
                return { ok: false, stdout: '', stderr: 'opencode: command not found', error: '' }
              }
              return {
                ok: true,
                stdout: JSON.stringify({
                  sessionID: 'ses_oneshot_1',
                  part: { type: 'text', text: 'Hello from auto-installed opencode!' },
                }),
                stderr: '',
                error: '',
              }
            }
            return { ok: true, stdout: '', stderr: '', error: '' }
          },
          linuxTermProbe: async () => {
            state.termProbeCalls++
            return { pty: true, guest: true, shell: true }
          },
          linuxTermStart: async () => ({ ok: true, alreadyRunning: true }),
          linuxTermWrite: async (dataB64: string) => {
            state.termWrites.push(Buffer.from(dataB64, 'base64').toString('utf8'))
            return true
          },
        },
      },
      NativeEventEmitter: class {
        addListener() {
          return { remove: () => {} }
        }
      },
    }
  }
  if (request === '@react-native-async-storage/async-storage') {
    return { default: asyncStorageMock, ...asyncStorageMock }
  }
  if (request === 'expo-file-system') {
    return {
      Directory: MockDirectory,
      File: MockFile,
      Paths: { document: '/data/user/0/ai.moch/files' },
    }
  }
  if (request === 'expo/fetch') {
    return { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }
  }
  if (request === '@react-native-community/netinfo') {
    return {
      default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) },
      addEventListener: () => () => {},
      fetch: async () => ({ isConnected: true }),
    }
  }
  if (
    request === 'expo' ||
    request.startsWith('expo-') ||
    request.startsWith('expo/')
  ) {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === '__esModule') return true
          if (prop === 'default') return {}
          if (prop === 'EventEmitter' || prop === 'NativeModule') return class {}
          return () => Promise.resolve(undefined)
        },
      },
    )
  }
  return origLoad.call(this, request, parent, isMain)
}

if (!(globalThis as Record<string, unknown>).WebSocket) {
  const WsCtor = (ws as unknown as { WebSocket?: unknown }).WebSocket ?? ws
  ;(globalThis as Record<string, unknown>).WebSocket = WsCtor
}
if (!globalThis.window) {
  ;(globalThis as unknown as Record<string, unknown>).window = globalThis
}
;(globalThis as Record<string, unknown>).__DEV__ = false

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const READY = {
  type: 'gateway.ready',
  payload: { heartbeat: true, change_events: true, replay_epoch: 'oc-autoinstall-1', skin: {} },
}

async function startMockGateway(
  handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>,
) {
  const WebSocketServerImpl = ((ws as unknown as Record<string, unknown>).WebSocketServer ??
    (ws as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    socket.on('message', async (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: string | number; method?: string; params?: Record<string, unknown> }
      if (!msg.method) return
      if (msg.method === 'client.capabilities') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { server_requests: [] } }))
        return
      }
      const params = msg.params ?? {}
      rpcCalls.push({ method: msg.method, params })
      const handler = handlers[msg.method]
      if (!handler) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
        return
      }
      try {
        const result = await handler(params)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      } catch (err) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        )
      }
    })
  })

  return {
    port,
    host: `127.0.0.1:${port}`,
    rpcCalls,
    async close() {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}

async function main() {
  const thinker = await import('../src/lib/thinker')
  const ocClient = await import('../src/lib/opencodeClient')
  const ocChat = await import('../src/lib/opencodeChat')
  const gateway = await import('../src/lib/gateway')

  // ── 1. Already installed -> succeeds immediately without download ────────
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: true })
  {
    const stages: string[] = []
    const r = await thinker.ensureOpencodeInstalled({
      onStage: (s) => stages.push(s),
    })
    check(
      'ensureOpencodeInstalled succeeds immediately when already installed',
      r.ok && r.stdout === 'installed' && state.downloadCalls === 0 && state.bootstrapCalls === 0 && stages.length === 0,
      `r=${JSON.stringify(r)} downloads=${state.downloadCalls} stages=${JSON.stringify(stages)}`,
    )
  }

  // ── 2. Guest bootstrapped, opencode missing -> downloads & installs ──────
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: false })
  {
    const events: Array<[string, number | undefined]> = []
    const r = await thinker.ensureOpencodeInstalled({
      onStage: (s, pct) => events.push([s, pct]),
    })
    check(
      'ensureOpencodeInstalled downloads & installs when guest is bootstrapped and opencode is missing',
      r.ok &&
        state.bootstrapCalls === 0 &&
        state.downloadCalls === 1 &&
        state.opencodeInstalled &&
        events[0]?.[0] === 'downloading' &&
        events.some(([s, pct]) => s === 'downloading' && pct === 99),
      `r=${JSON.stringify(r)} downloads=${state.downloadCalls} events=${JSON.stringify(events)}`,
    )
  }

  // ── 3. Guest missing, autoInstallGuest=false -> Settings error ───────────
  resetState({ bootstrapped: false, rootfsExists: false, tmpExists: false, opencodeInstalled: false })
  {
    const r = await thinker.ensureOpencodeInstalled()
    const lower = r.stderr.toLowerCase()
    check(
      'ensureOpencodeInstalled returns clear Settings-based error when guest missing and autoInstallGuest=false',
      !r.ok &&
        r.stderr.includes('Settings → Runtime & agent') &&
        !lower.includes('onboarding') &&
        !lower.includes('previous step') &&
        state.bootstrapCalls === 0 &&
        state.downloadCalls === 0,
      `stderr=${JSON.stringify(r.stderr)}`,
    )
  }

  // ── 4. Guest missing, autoInstallGuest=true -> bootstraps + installs ─────
  resetState({ bootstrapped: false, rootfsExists: false, tmpExists: false, opencodeInstalled: false })
  {
    const stages: string[] = []
    const r = await thinker.ensureOpencodeInstalled({
      autoInstallGuest: true,
      onStage: (s, pct) => stages.push(pct === undefined ? s : `${s}:${pct}`),
    })
    check(
      'ensureOpencodeInstalled({ autoInstallGuest: true }) bootstraps guest and installs OpenCode',
      r.ok &&
        state.bootstrapCalls === 1 &&
        state.downloadCalls === 1 &&
        state.bootstrapped &&
        state.opencodeInstalled &&
        stages[0] === 'guest' &&
        stages.includes('downloading'),
      `r=${JSON.stringify(r)} stages=${JSON.stringify(stages)}`,
    )
  }

  // ── 5. Concurrent calls single-flight so only one download occurs ────────
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: false })
  {
    state.downloadGate = new Promise<void>((resolve) => {
      state.downloadGateResolve = resolve
    })
    const p1 = thinker.ensureOpencodeInstalled()
    const p2 = thinker.ensureOpencodeInstalled()
    const p3 = thinker.ensureOpencodeInstalled()
    await new Promise((r) => setTimeout(r, 15))
    state.downloadGateResolve?.()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    check(
      'concurrent ensureOpencodeInstalled() calls single-flight to one download',
      r1.ok && r2.ok && r3.ok && state.downloadCalls === 1,
      `downloads=${state.downloadCalls} results=${JSON.stringify([r1.ok, r2.ok, r3.ok])}`,
    )
  }

  // ── 5b. Concurrent autoInstallGuest=false + autoInstallGuest=true ────────
  resetState({ bootstrapped: false, rootfsExists: false, tmpExists: false, opencodeInstalled: false })
  {
    const pNoGuest = thinker.ensureOpencodeInstalled({ autoInstallGuest: false })
    const pWithGuest = thinker.ensureOpencodeInstalled({ autoInstallGuest: true })
    const [rNoGuest, rWithGuest] = await Promise.all([pNoGuest, pWithGuest])
    check(
      'concurrent autoInstallGuest=true still bootstraps after in-flight non-autoInstallGuest fails for missing guest',
      !rNoGuest.ok && rWithGuest.ok && state.bootstrapCalls === 1 && state.downloadCalls === 1,
      `rNoGuest=${rNoGuest.ok} rWithGuest=${rWithGuest.ok} boots=${state.bootstrapCalls} downloads=${state.downloadCalls}`,
    )
  }

  // ── 6. ocEnsureServer() auto-installs OpenCode before launching ──────────
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: false })
  {
    let serverAlive = false
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/info') && serverAlive) {
        return new Response(JSON.stringify({ version: '2.3.0' }), { status: 200 })
      }
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    const gw = await startMockGateway({
      'moch.opencode.ensure': async () => {
        serverAlive = true
        return { ok: true, started: true }
      },
    })
    mockGatewayInfo = {
      running: true,
      ready: true,
      port: gw.port,
      token: 'test-token',
      workspace: '/workspace',
      error: '',
    }
    await gateway.connect({ host: gw.host, token: 'test-token', tls: false })
    const deadline = Date.now() + 4000
    while (!gateway.isConnected.get() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }

    let opencodeInstalledAtEnsure = false
    // Verify order: opencode is installed BEFORE termProbe / RPC ensure runs.
    const res = await ocClient.ocEnsureServer()
    opencodeInstalledAtEnsure = state.opencodeInstalled
    gateway.disconnect()
    mockGatewayInfo = null
    await gw.close()

    check(
      'ocEnsureServer() auto-installs OpenCode before launching when server is not alive',
      res.ok &&
        opencodeInstalledAtEnsure &&
        state.downloadCalls === 1 &&
        state.termProbeCalls === 1 &&
        gw.rpcCalls.some((c) => c.method === 'moch.opencode.ensure'),
      `res=${JSON.stringify(res)} downloads=${state.downloadCalls} termProbe=${state.termProbeCalls}`,
    )
  }

  // ── 7. runOneShotTurn() auto-installs OpenCode before `opencode run` ─────
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: false })
  {
    const res = await ocChat.runOneShotTurn({ mapKey: 'chat_1', text: 'hello' })
    check(
      'runOneShotTurn() auto-installs OpenCode before running opencode run',
      !res.failed &&
        res.text === 'Hello from auto-installed opencode!' &&
        state.downloadCalls === 1 &&
        state.opencodeInstalled &&
        state.execCalls.some((c) => c.includes('opencode run')),
      `res=${JSON.stringify(res)} downloads=${state.downloadCalls}`,
    )
  }

  // ── 8. ocModelsOneShot() auto-installs OpenCode before `opencode models` ─
  resetState({ bootstrapped: true, rootfsExists: true, tmpExists: true, opencodeInstalled: false })
  {
    const models = await ocClient.ocModelsOneShot()
    check(
      'ocModelsOneShot() auto-installs OpenCode before listing models',
      models.length === 1 && models[0].id === 'big-pickle' && state.downloadCalls === 1 && state.opencodeInstalled,
      `models=${JSON.stringify(models)} downloads=${state.downloadCalls}`,
    )
  }

  console.log(`\nSummary: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
