/**
 * Local embedded Hermes runtime — TypeScript surface.
 *
 * Milestone 1 exposes read-only status (is the bundled CPython alive and what
 * version). The full bridge (sendMessage / streaming events / lifecycle) grows
 * here in Milestones 3-4; UI code should depend on this module, never on
 * NativeModules.HermesBridge directly.
 */

import { NativeModules } from 'react-native'

export interface HermesRuntimeStatus {
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
  status(): Promise<HermesRuntimeStatus>
  getGateway(): Promise<EmbeddedGatewayInfo | null>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
  requestBatteryExemption(): Promise<'already' | 'requested'>
  linuxBootstrap(distro: string): Promise<{ ok: boolean; steps: string }>
  linuxExec(command: string): Promise<{ ok: boolean; stdout: string; stderr: string; error: string }>
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
}


const bridge = NativeModules.HermesBridge as HermesBridgeModule | undefined

/** Stop the background agent runtime (foreground service teardown). */
export function stopEmbeddedRuntime(): Promise<void> {
  if (!bridge) return Promise.resolve()
  return bridge.stop().then(() => undefined)
}

export function hermesRuntimeStatus(): Promise<HermesRuntimeStatus> {
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

export function linuxReset(): Promise<boolean> {
  if (!bridge) return Promise.resolve(false)
  return bridge.linuxReset()
}

export function linuxBootstrap(distro: string): Promise<{ ok: boolean; steps: string } | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.linuxBootstrap(distro)
}

export function linuxExec(command: string): Promise<{ ok: boolean; stdout: string; stderr: string; error: string } | null> {
  if (!bridge) return Promise.resolve(null)
  return bridge.linuxExec(command)
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