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
