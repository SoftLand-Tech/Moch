/**
 * Local embedded Mochi runtime — TypeScript surface.
 *
 * Milestone 1 exposes read-only status (is the bundled CPython alive and what
 * version). The full bridge (sendMessage / streaming events / lifecycle) grows
 * here in Milestones 3-4; UI code should depend on this module, never on
 * NativeModules.HermesBridge directly.
 *
 * `HermesBridge` below is the NATIVE module name registered on the Kotlin side
 * (HermesBridgePackage.kt) — it is engine plumbing, pinned; do not rename it
 * here without renaming it there.
 */

import { NativeModules } from 'react-native'

export interface MochiRuntimeStatus {
  running: boolean
  pythonVersion: string | null
  hermesVersion: string | null
}

export interface EmbeddedGatewayInfo {
  running: boolean
  ready: boolean
  port: number | null
  token: string | null
  workspace: string | null
  error: string | null
}

interface HermesBridgeModule {
  status(): Promise<MochiRuntimeStatus>
  getGateway(): Promise<EmbeddedGatewayInfo | null>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
  requestBatteryExemption(): Promise<'already' | 'requested'>
  linuxBootstrap(distro: string): Promise<{ ok: boolean; steps: string }>
  /**
   * Exactly two JS arguments, always: the interop layer is name-keyed AND
   * exact-arity, so the optional timeout must be sent explicitly as null
   * (native default 30s) rather than omitted.
   */
  linuxExec(command: string, timeoutSec: number | null): Promise<LinuxExecResult>
  linuxStatus(): Promise<{ bootstrapped: boolean; sizeMb: number; distro: string }>
  linuxStatusLive(): Promise<{ bootstrapped: boolean; sizeMb: number; distro: string }>
  linuxReset(): Promise<boolean>
  linuxTermProbe(): Promise<{ pty: boolean; guest: boolean; shell: boolean; error?: string }>
  linuxTermStart(cols: number, rows: number): Promise<{ ok: boolean; alreadyRunning: boolean; error?: string }>
  linuxTermWrite(dataB64: string): Promise<boolean>
  linuxTermDrain(): Promise<{ chunks: string[]; alive: boolean }>
  linuxTermReplay(): Promise<{ chunk: string; alive: boolean }>
  linuxTermResize(cols: number, rows: number): Promise<boolean>
  linuxTermKill(): Promise<boolean>
  /**
   * Multi-session terminal (slice B). Optional on the interface: an OTA JS
   * bundle can run against an older APK whose bridge predates these methods,
   * and every wrapper below guards before calling — never a hard crash.
   */
  linuxTermStartSession?(
    sessionId: string,
    cwd: string | null,
    cols: number,
    rows: number,
  ): Promise<{ ok: boolean; alreadyRunning: boolean; error?: string }>
  linuxTermWriteSession?(sessionId: string, dataB64: string): Promise<boolean>
  linuxTermDrainSession?(sessionId: string): Promise<{ chunks: string[]; alive: boolean }>
  linuxTermReplaySession?(sessionId: string): Promise<{ chunk: string; alive: boolean }>
  linuxTermClearSession?(sessionId: string): Promise<boolean>
  linuxTermResizeSession?(sessionId: string, cols: number, rows: number): Promise<boolean>
  linuxTermKillSession?(sessionId: string): Promise<boolean>
}


const bridge = NativeModules.HermesBridge as HermesBridgeModule | undefined

/**
 * Stop the background agent runtime — FULL teardown (BUG-129): the native
 * side removes the foreground service + its notification and exits the
 * process (the runtime IS the process; Chaquopy can't unload Python
 * in-process). The app closes shortly after resolve(); the next launch
 * auto-starts the runtime fresh. No TS behavior change — native semantics
 * only; this comment documents them.
 */
export function stopEmbeddedRuntime(): Promise<void> {
  if (!bridge) return Promise.resolve()
  return bridge.stop().then(() => undefined)
}

export function mochiRuntimeStatus(): Promise<MochiRuntimeStatus> {
  if (!bridge) return Promise.resolve({ running: false, pythonVersion: null, hermesVersion: null })
  return bridge.status()
}

/** Embedded gateway connection info; null when running under Expo Go / no native build. */
export function getEmbeddedGateway(): Promise<EmbeddedGatewayInfo | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.getGateway()
}

/** True runtime restart: the process relaunches itself with a fresh Python. */
export function restartEmbeddedRuntime(): Promise<void> {
  if (!bridge) return Promise.resolve()
  return bridge.restart().then(() => undefined)
}

/** Show the system's battery-optimization exemption dialog (user consent). */
export function requestBatteryExemption(): Promise<'already' | 'requested' | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.requestBatteryExemption()
}


// ---- Moch Linux (M7.5) ----

export interface LinuxGuestStatus {
  bootstrapped: boolean
  sizeMb: number
  distro: string
}

// Serialize guest-mutating filesystem operations (bootstrap / reset) so two
// triggers (e.g. Settings Linux row + OpenCode thinker switch) never race on
// the same rootfs directory.
let linuxFsTail: Promise<unknown> = Promise.resolve()

function enqueueLinuxFsOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = linuxFsTail.then(fn, fn)
  linuxFsTail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export function linuxReset(): Promise<boolean> {
  if (!bridge) return Promise.resolve(false)
  return enqueueLinuxFsOp(() => bridge.linuxReset())
}

export function linuxBootstrap(distro: string): Promise<{ ok: boolean; steps: string } | null> {
  if (!bridge) return Promise.resolve(null)
  return enqueueLinuxFsOp(() => bridge.linuxBootstrap(distro))
}

export interface LinuxExecResult {
  ok: boolean
  stdout: string
  stderr: string
  error: string
  /** Guest exit code — present when the command actually ran to completion. */
  exit?: number
}

/**
 * Run one shell command inside the guest. `timeoutSec` (1..3600, null =
 * python's 30s default) rides through the native bridge, whose old hard-wired
 * 30s cap killed every real apt stage; pass a generous timeout for long
 * installs. Backward compatible: existing 1-arg callers keep the 30s default.
 */
export function linuxExec(command: string, timeoutSec?: number): Promise<LinuxExecResult | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.linuxExec(command, timeoutSec ?? null)
}

export function linuxStatus(): Promise<LinuxGuestStatus | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.linuxStatus()
}

/**
 * Uncached guest status (walks the rootfs for a live size). The periodic
 * Settings poll must use linuxStatus(): computing size_mb means stat()ing
 * every file of a full Ubuntu rootfs — seconds of GIL-hot Python inside the
 * app process, every poll, which starved the gateway loop and the JS thread
 * during sessions. Live walks are for the install wizard's progress display
 * only, where the rootfs is actually growing.
 */
export function linuxStatusLive(): Promise<LinuxGuestStatus | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.linuxStatusLive()
}

// ---- Interactive guest terminal (M9) ----

export interface LinuxTermProbe {
  pty: boolean
  guest: boolean
  shell: boolean
  error?: string
}

export interface LinuxTermDrain {
  chunks: string[]
  alive: boolean
}

export function linuxTermProbe(): Promise<LinuxTermProbe | null> {
  if (!bridge?.linuxTermProbe) return Promise.resolve(null)
  return bridge.linuxTermProbe()
}

export function linuxTermStart(
  cols: number,
  rows: number,
): Promise<{ ok: boolean; alreadyRunning: boolean; error?: string } | null> {
  if (!bridge?.linuxTermStart) return Promise.resolve(null)
  return bridge.linuxTermStart(cols, rows)
}

export function linuxTermWrite(dataB64: string): Promise<boolean> {
  if (!bridge?.linuxTermWrite) return Promise.resolve(false)
  return bridge.linuxTermWrite(dataB64).catch(() => false)
}

export function linuxTermDrain(): Promise<LinuxTermDrain | null> {
  if (!bridge?.linuxTermDrain) return Promise.resolve(null)
  return bridge.linuxTermDrain().catch(() => null)
}

export function linuxTermReplay(): Promise<{ chunk: string; alive: boolean } | null> {
  if (!bridge?.linuxTermReplay) return Promise.resolve(null)
  return bridge.linuxTermReplay().catch(() => null)
}

export function linuxTermResize(cols: number, rows: number): Promise<boolean> {
  if (!bridge?.linuxTermResize) return Promise.resolve(false)
  return bridge.linuxTermResize(cols, rows).catch(() => false)
}

export function linuxTermKill(): Promise<boolean> {
  if (!bridge?.linuxTermKill) return Promise.resolve(false)
  return bridge.linuxTermKill().catch(() => false)
}

// ---- Multi-session interactive terminals (slice B) ----
//
// One PTY per session id. The legacy functions above remain bound to
// python's `__default__` session (the hidden OpenCode server launch), so the
// Terminal screen can open its own isolated tabs without touching it.

export function linuxTermStartSession(
  sessionId: string,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<{ ok: boolean; alreadyRunning: boolean; error?: string } | null> {
  if (!bridge?.linuxTermStartSession) return Promise.resolve(null)
  return bridge
    .linuxTermStartSession(sessionId, cwd, cols, rows)
    .catch(() => null)
}

export function linuxTermWriteSession(sessionId: string, dataB64: string): Promise<boolean> {
  if (!bridge?.linuxTermWriteSession) return Promise.resolve(false)
  return bridge.linuxTermWriteSession(sessionId, dataB64).catch(() => false)
}

export function linuxTermDrainSession(sessionId: string): Promise<LinuxTermDrain | null> {
  if (!bridge?.linuxTermDrainSession) return Promise.resolve(null)
  return bridge.linuxTermDrainSession(sessionId).catch(() => null)
}

export function linuxTermReplaySession(
  sessionId: string,
): Promise<{ chunk: string; alive: boolean } | null> {
  if (!bridge?.linuxTermReplaySession) return Promise.resolve(null)
  return bridge.linuxTermReplaySession(sessionId).catch(() => null)
}

export function linuxTermClearSession(sessionId: string): Promise<boolean> {
  if (!bridge?.linuxTermClearSession) return Promise.resolve(false)
  return bridge.linuxTermClearSession(sessionId).catch(() => false)
}

export function linuxTermResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  if (!bridge?.linuxTermResizeSession) return Promise.resolve(false)
  return bridge.linuxTermResizeSession(sessionId, cols, rows).catch(() => false)
}

export function linuxTermKillSession(sessionId: string): Promise<boolean> {
  if (!bridge?.linuxTermKillSession) return Promise.resolve(false)
  return bridge.linuxTermKillSession(sessionId).catch(() => false)
}
