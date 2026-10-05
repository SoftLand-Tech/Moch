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
  linuxStatus(): Promise<{ bootstrapped: boolean; sizeMb: number }>
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