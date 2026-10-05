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

interface HermesBridgeModule {
  status(): Promise<HermesRuntimeStatus>
}

const bridge = NativeModules.HermesBridge as HermesBridgeModule | undefined

export function hermesRuntimeStatus(): Promise<HermesRuntimeStatus> {
  if (!bridge) return Promise.resolve({ running: false, pythonVersion: null, hermesVersion: null })
  return bridge.status()
}
