/**
 * OTA updates (expo-updates) — client helpers.
 *
 * How updates reach a phone:
 *  1. NATIVE (always on): the manifest sets EXPO_UPDATES_CHECK_ON_LAUNCH=ALWAYS,
 *     so on every cold start expo-updates checks the production channel and
 *     downloads a newer JS bundle in the background; it is applied on the
 *     NEXT launch (standard expo-updates behavior, no code needed here).
 *  2. MANUAL: Settings' "Check for updates" row calls checkForMochUpdate() —
 *     same channel, immediate; when a bundle is downloaded the user can
 *     restart into it right away via reloadIntoUpdate().
 *
 * CI publishes those bundles (`.github/workflows/android-apk.yml` → `ota`
 * job) on every main push once the EXPO_TOKEN secret is set. Updates ship
 * JS + assets only — native changes always need a new APK.
 *
 * All helpers resolve honestly (no throws to callers) and are no-ops in dev
 * mode, where OTA is disabled by expo-updates itself.
 */
import * as Updates from 'expo-updates'
import { log } from './log'

export interface MochUpdateCheck {
  /** A newer bundle exists on the channel. */
  available: boolean
  /** …and it is downloaded and ready to load on restart. */
  ready: boolean
  /** Present when the check itself failed (rendered by the caller). */
  error?: string
}

/** True when this build can actually receive OTA updates. */
export function otaSupported(): boolean {
  return !__DEV__ && Updates.isEnabled
}

/**
 * Check the production channel and download an update if one exists.
 * Never throws — failures come back as `{ available: false, error }`.
 */
export async function checkForMochUpdate(): Promise<MochUpdateCheck> {
  if (__DEV__) return { available: false, ready: false }
  try {
    const check = await Updates.checkForUpdateAsync()
    if (!check.isAvailable) return { available: false, ready: false }
    const fetched = await Updates.fetchUpdateAsync()
    return { available: true, ready: fetched.isNew }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    log('warn', 'updates', `check failed: ${why}`)
    return { available: false, ready: false, error: why }
  }
}

/**
 * Cold-restart the app into a downloaded update. Resolves when the reload
 * begins (the JS context is torn down mid-call, so the promise may never
 * settle — callers must not rely on it).
 */
export async function reloadIntoUpdate(): Promise<void> {
  try {
    await Updates.reloadAsync()
  } catch (e) {
    log('warn', 'updates', `reload failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
