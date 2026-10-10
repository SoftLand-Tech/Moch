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
 * - `browserTabs` is the screen's tab list (id/url/title/live), and
 *   `activeTabId` picks which one the agent binds to. Persistence is
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
}

let moduleOverride: RelayModule | null = null
let cached: RelayModule | null = null

/** Test seam — inject a fake native module (parity with shareIn.ts). */
export function _useBrowserRelayForTests(m: RelayModule | null) {
  moduleOverride = m
  cached = null
}

function native(): RelayModule {
  if (moduleOverride) return moduleOverride
  if (!cached) {
    // TurboModule interop: NativeModules still resolves legacy bridge modules.
    const { NativeModules } = require('react-native')
    cached = NativeModules.BrowserRelay as RelayModule
  }
  return cached
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
  browserTabs.set(browserTabs.get().map((t) => (t.id === id ? { ...t, ...patch } : t)))
  if (patch.url && activeTabId.get() === id) syncActiveUrl(patch.url)
}

export function getActiveTab(): BrowserTab | null {
  const id = activeTabId.get()
  return browserTabs.get().find((t) => t.id === id) ?? null
}
