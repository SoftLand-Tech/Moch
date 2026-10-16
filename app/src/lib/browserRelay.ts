import { atom } from 'nanostores'
import { log } from './log'

/**
 * Moch Browser relay state (BUILD-PLAN.md).
 *
 * The Kotlin side (BrowserRelayModule + CdpRelay) owns the loopback CDP
 * relay to the WebView DevTools socket. This module is the JS face of it:
 *
 * - `ensureBrowserRelay()` starts (or reports) the relay and flips the
 *   `webDebugEnabled` switch — the DevTools socket only exists while debug
 *   is on, so the Browser screen calls this BEFORE mounting any WebView.
 * - `syncActiveUrl(url)` feeds the relay's /json/list filter so the agent's
 *   "first page target" is the tab the user is looking at. Pure local IPC —
 *   never throws, never blocks the UI.
 * - BUG-136: this module is the RN half of the tab-lifecycle round-trip —
 *   the relay's /json/new|close|activate emit one "mochTabOp" event, the
 *   handler below applies it to the store and acks via `tabOpAck`; the
 *   tabs⇔targets registry maps store tabs to DevTools target ids so
 *   close/activate can find their tab.
 * - `browserTabs` is the screen's tab list (id/url/title/live/targetId),
 *   and `activeTabId` picks which one the agent binds to. Persistence is
 *   deliberately session-local: tabs are ephemeral by design; cookies and
 *   logins live in the WebView profile (CookieManager), not this list.
 *
 * No react-native imports at module scope (same contract as shareIn.ts /
 * drafts.ts): the native module resolves lazily behind an accessor, so
 * node-side tests can inject a fake.
 */

export interface RelayStatus {
  running: boolean
  port: number
  token: string | null
  activeUrlPrefix: string | null
  lastError: string | null
  webDebugEnabled: boolean
}

export interface BrowserTab {
  id: string
  url: string
  title: string
  /** False while the first load is still in flight. */
  ready: boolean
  /**
   * DevTools target id of this tab's WebView (BUG-136), resolved by matching
   * tab.url against the relay's upstream page list — see refreshTabTargetIds.
   * Undefined until mapped, and dropped again when the target disappears
   * (e.g. after a renderer remount creates a NEW id).
   */
  targetId?: string
}

/** One /json/moch-tabs entry (the relay's full upstream page list). */
export interface TabTarget {
  id: string
  url: string
  title: string
}

export const browserTabs = atom<BrowserTab[]>([])
export const activeTabId = atom<string | null>(null)
export const relayStatus = atom<RelayStatus | null>(null)

type RelayModule = {
  ensureRunning(port: number): Promise<RelayStatus>
  stop(): Promise<RelayStatus>
  status(): Promise<RelayStatus>
  setActiveUrl(url: string | null): Promise<boolean>
  setWebDebugEnabled(enabled: boolean): Promise<boolean>
  /** RN ack for a mochTabOp round-trip (bridge method, fire-and-forget). */
  tabOpAck(requestId: string, ok: boolean, error?: string | null): void
  /** The relay's full upstream page list — the tab⇔target registry source. */
  tabTargets(): Promise<TabTarget[]>
}

/** One "mochTabOp" event from the relay (CdpRelay → RN, BUG-136). */
export interface MochTabOpEvent {
  requestId: string
  op: 'open' | 'close' | 'activate'
  url?: string
  targetId?: string
}

type EmitterLike = {
  addListener(name: string, cb: (e: MochTabOpEvent) => void): { remove(): void }
}

let moduleOverride: RelayModule | null = null
let cached: RelayModule | null = null
let tabOpEmitterOverride: EmitterLike | null = null
let tabOpSub: { remove(): void } | null = null

/** Test seam — inject a fake native module (+ a fake mochTabOp emitter). */
export function _useBrowserRelayForTests(m: RelayModule | null, e?: EmitterLike | null) {
  moduleOverride = m
  cached = null
  tabOpEmitterOverride = e ?? null
  tabOpSub?.remove()
  tabOpSub = null
}

function native(): RelayModule {
  armTabOpListener()
  if (moduleOverride) return moduleOverride
  if (!cached) {
    // TurboModule interop: NativeModules still resolves legacy bridge modules.
    const { NativeModules } = require('react-native')
    cached = NativeModules.BrowserRelay as RelayModule
  }
  return cached
}

/**
 * Subscribe ONCE (process lifetime) to the relay's "mochTabOp" events — the
 * RN side of the BUG-136 /json/new|close|activate round-trip. Armed lazily on
 * the first native-module touch (same no-react-native-at-module-scope
 * contract as shareIn.ts); scripts inject a fake emitter instead.
 */
function armTabOpListener() {
  if (tabOpSub) return
  try {
    const e = tabOpEmitterOverride ?? resolveDeviceEventEmitter()
    if (e) tabOpSub = e.addListener(MOCH_TAB_OP_EVENT, onMochTabOp)
  } catch {
    // node-side tests without an injected emitter: stay unarmed, retry later
  }
}

function resolveDeviceEventEmitter(): EmitterLike | null {
  const rn = require('react-native') as { DeviceEventEmitter?: EmitterLike }
  return rn.DeviceEventEmitter ?? null
}

/**
 * Normalize whatever the bridge hands back ( bridge map values arrive as
 * plain primitives; a turbo interop layer may wrap errors as strings).
 */
function normalize(raw: Record<string, unknown> | RelayStatus | null | undefined): RelayStatus {
  const r: Record<string, unknown> = raw ? (raw as Record<string, unknown>) : {}
  return {
    running: Boolean(r.running),
    port: Number(r.port ?? 0),
    token: (r.token as string) ?? null,
    activeUrlPrefix: (r.activeUrlPrefix as string) ?? null,
    lastError: (r.lastError as string) ?? null,
    webDebugEnabled: Boolean(r.webDebugEnabled),
  }
}

/** Start the relay (idempotent) + enable WebView debugging. */
export async function ensureBrowserRelay(): Promise<RelayStatus> {
  let debugError: string | null = null
  try {
    await native().setWebDebugEnabled(true)
  } catch (e) {
    // Don't mask the relay state behind a debug-toggle failure — the relay
    // can still start; page connects would just fail until debug is on.
    debugError = String(e)
  }
  try {
    const status = normalize(await native().ensureRunning(9334))
    if (debugError && !status.lastError) status.lastError = debugError
    relayStatus.set(status)
    return status
  } catch (e) {
    const failed: RelayStatus = {
      running: false,
      port: 0,
      token: null,
      activeUrlPrefix: null,
      lastError: debugError ?? String(e),
      webDebugEnabled: false,
    }
    relayStatus.set(failed)
    return failed
  }
}

export async function stopBrowserRelay(): Promise<RelayStatus> {
  try {
    const status = normalize(await native().stop())
    relayStatus.set(status)
    return status
  } catch (e) {
    log('warn', 'browserRelay', `stop failed: ${e}`)
    return relayStatus.get() ?? normalize(null)
  }
}

/**
 * Tell the relay which URL the visible tab shows. Called from the Browser
 * screen's onNavigationStateChange/onLoadEnd. Fire-and-forget: a dropped
 * sync only degrades tab targeting (relay falls back to the first tab).
 */
export function syncActiveUrl(url: string | null) {
  try {
    void native().setActiveUrl(url)
    // BUG-136: every URL sync is a cheap, throttled chance to re-map the
    // tab⇔target registry (in-page navigations drift tab.url vs the live URL).
    void refreshTabTargetIds()
  } catch (e) {
    log('warn', 'browserRelay', `setActiveUrl failed: ${e}`)
  }
}

// ── Tab store (screen-local model, kept here for test parity) ──────────────

let seq = 0

export function addTab(url = 'https://www.google.com'): BrowserTab {
  const tab: BrowserTab = { id: `t${++seq}-${Date.now().toString(36)}`, url, title: url, ready: false }
  const tabs = [...browserTabs.get(), tab]
  browserTabs.set(tabs)
  activeTabId.set(tab.id)
  syncActiveUrl(tab.url)
  return tab
}

export function closeTab(id: string) {
  const tabs = browserTabs.get()
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const next = tabs.filter((t) => t.id !== id)
  browserTabs.set(next)
  if (activeTabId.get() === id) {
    const fallback = next[Math.max(0, idx - 1)] ?? null
    activeTabId.set(fallback?.id ?? null)
    syncActiveUrl(fallback?.url ?? null)
  }
}

export function switchTab(id: string) {
  if (!browserTabs.get().some((t) => t.id === id)) return
  activeTabId.set(id)
  const tab = browserTabs.get().find((t) => t.id === id)
  syncActiveUrl(tab?.url ?? null)
}

export function updateTab(id: string, patch: Partial<BrowserTab>) {
  const tabs = browserTabs.get()
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  // Speed pass (SPEED_REPORT A2-4 pattern): onNavigationStateChange fires
  // several times per load and onLoadEnd adds one more — most patches repeat
  // the same title/ready values. A fresh array identity per no-op write made
  // every subscriber (the whole Browser screen, all N WebView wrappers)
  // re-render mid-load. Skip the set entirely when nothing differs.
  const cur = tabs[idx]
  const curRec = cur as unknown as Record<string, unknown>
  const patchRec = patch as unknown as Record<string, unknown>
  const changed = Object.keys(patch).some((k) => patchRec[k] !== curRec[k])
  if (!changed) return
  browserTabs.set(tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  if (patch.url && activeTabId.get() === id) syncActiveUrl(patch.url)
}

export function getActiveTab(): BrowserTab | null {
  const id = activeTabId.get()
  return browserTabs.get().find((t) => t.id === id) ?? null
}

// ── Tab lifecycle round-trip (BUG-136) ──────────────────────────────────────
//
// CdpRelay serves /json/new|close|activate by asking RN — this module IS the
// tab owner. Contract (mirror of CdpRelay.handleTabLifecycle):
//   event  "mochTabOp"  {requestId, op: open|close|activate, url?, targetId?}
//   ack    BrowserRelay.tabOpAck(requestId, ok, error) — statuses live in
//          Kotlin (200 / 409 refused / 502 unreachable / 504 timeout).

const MOCH_TAB_OP_EVENT = 'mochTabOp'

function tabByTargetId(targetId: unknown): BrowserTab | null {
  const tid = typeof targetId === 'string' ? targetId : ''
  if (!tid) return null
  return browserTabs.get().find((t) => t.targetId === tid) ?? null
}

/** Apply one relay tab op to the store, then ack it. Never throws. */
function onMochTabOp(ev: MochTabOpEvent | null | undefined) {
  const requestId = ev && typeof ev.requestId === 'string' ? ev.requestId : ''
  if (!requestId) return
  const op = ev?.op
  let ok = false
  let error: string | null = null
  if (op === 'open') {
    const url = typeof ev?.url === 'string' && ev.url ? ev.url : 'https://www.google.com'
    addTab(url)
    ok = true
  } else if (op === 'close' || op === 'activate') {
    const tab = tabByTargetId(ev?.targetId)
    if (!tab) {
      error = `no open tab matches DevTools target '${ev?.targetId ?? ''}' — the tab strip changed; retry browser_tab_list`
    } else if (op === 'close') {
      if (browserTabs.get().length <= 1) {
        // RN mirror of the Python-side guard: the strip always keeps one tab.
        error = 'refusing to close the last remaining tab — navigate it elsewhere instead'
      } else {
        closeTab(tab.id)
        ok = true
      }
    } else {
      switchTab(tab.id)
      ok = true
    }
  } else {
    error = `unknown tab op '${String(op ?? '')}'`
  }
  if (ok) void refreshTabTargetIds() // opportunistic re-map (open mounts a WebView)
  try {
    native().tabOpAck(requestId, ok, error)
  } catch (e) {
    log('warn', 'browserRelay', `tabOpAck(${requestId}) failed: ${e}`)
  }
}

// ── tabs ⇔ DevTools targets registry (BUG-136) ──────────────────────────────
//
// close/activate arrive as DevTools target ids, but the store owns tab ids —
// this registry bridges them by matching tab.url (the REQUESTED url) against
// the relay's upstream page list (tabTargets = /json/moch-tabs data; the
// hidden agent host page is filtered Kotlin-side). LIMITATIONS, deliberate:
//   - redirects/in-page navigation drift tab.url vs the target's live URL —
//     matches are exact or trailing-slash/prefix-tolerant; a drifted tab may
//     stay unmapped until its URL is re-synced;
//   - duplicate URLs tie to the FIRST unused target (both sides iterate in
//     order) and each target is claimed at most once;
//   - refreshes are opportunistic (tab-op events, URL syncs, remounts), so a
//     stale mapping self-heals on the next refresh rather than being feared.

let refreshInFlight: Promise<void> | null = null
let lastRefreshAt = 0
const REFRESH_MIN_INTERVAL_MS = 800

function urlsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = a.replace(/\/+$/, '')
  const y = b.replace(/\/+$/, '')
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/**
 * Re-map every store tab to its DevTools targetId from the relay's upstream
 * page list. Coalesces concurrent calls and throttles repeat calls (pass
 * force=true after a renderer remount — the fresh WebView gets a NEW id).
 * Existing live mappings are kept as-is so URL drift never unmaps a tab.
 */
export async function refreshTabTargetIds(force = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  if (!force && Date.now() - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return
  lastRefreshAt = Date.now()
  refreshInFlight = (async () => {
    let targets: TabTarget[] = []
    try {
      const raw = await native().tabTargets()
      targets = (Array.isArray(raw) ? raw : []).filter(
        (t): t is TabTarget =>
          !!t && typeof (t as TabTarget).id === 'string' && (t as TabTarget).id !== '',
      )
    } catch (e) {
      log('warn', 'browserRelay', `tabTargets failed: ${e}`)
      return
    }
    const used = new Set<string>()
    let changed = false
    const next = browserTabs.get().map((tab) => {
      if (tab.targetId && targets.some((t) => t.id === tab.targetId)) {
        used.add(tab.targetId) // current id still live — keep it
        return tab
      }
      const hit = targets.find((t) => !used.has(t.id) && urlsMatch(t.url, tab.url))
      if (hit) {
        used.add(hit.id)
        if (hit.id !== tab.targetId) {
          changed = true
          return { ...tab, targetId: hit.id }
        }
        return tab
      }
      if (tab.targetId) {
        changed = true // target gone (renderer remounted, tab closed upstream)
        return { ...tab, targetId: undefined }
      }
      return tab
    })
    if (changed) browserTabs.set(next)
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}
