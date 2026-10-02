import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { isRunningInExpoGo } from 'expo'
import { Platform } from 'react-native'
import { log } from './log'

type NotificationsModule = typeof import('expo-notifications')

/**
 * `expo-notifications` is loaded LAZILY, never with a top-level import.
 *
 * Why this matters: a top-level `import` of the module makes it part of the
 * static import graph of every route that (transitively) imports this file. In
 * Expo Go on Android, evaluating that module throws. A throw during route
 * evaluation means the route module never finishes, so expo-router sees
 * `module.default === undefined` and reports every screen as "missing the
 * required default export" — then crashes with
 * `Cannot read property 'ErrorBoundary' of undefined`.
 */
let notificationsModule: NotificationsModule | null = null
let notificationsLoadFailed = false

/**
 * True when this environment cannot support notifications at all. Checked
 * BEFORE any require, so we never evaluate a module we know will fail.
 *
 * In Expo Go on Android, SDK 53+ removed the notification native modules, so
 * requiring expo-notifications throws. Chat is the product — a notification
 * library must never be able to stand in front of it.
 */
const expoGoAndroid = Platform.OS === 'android' && isRunningInExpoGo()

function N(): NotificationsModule | null {
  if (notificationsModule || notificationsLoadFailed) return notificationsModule
  if (expoGoAndroid) {
    notificationsLoadFailed = true
    // `info`, never `warn`: in dev, console.warn opens a blocking LogBox
    // overlay. An expected, already-explained environment limitation should
    // not cover the app the user is trying to use.
    log('info', 'push', 'expo-notifications skipped: unavailable in Expo Go on Android since SDK 53')
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notificationsModule = require('expo-notifications') as NotificationsModule
  } catch (err) {
    notificationsLoadFailed = true
    log('info', 'push', `expo-notifications unavailable: ${String(err).slice(0, 160)}`)
  }
  return notificationsModule
}

/**
 * Remote (server-driven) push was removed from Expo Go on Android in SDK 53.
 * Local notifications still work there on a real build, so this gate only
 * describes the remote half.
 */
export const remotePushSupported = !expoGoAndroid

export const remotePushBlockedReason = remotePushSupported
  ? null
  : 'Remote push needs a development build on Android. Run `npx expo run:android` (or an EAS build) — Expo Go cannot receive server pushes since SDK 53.'

/** True once we know notifications cannot work at all in this environment. */
export function notificationsAvailable(): boolean {
  return N() !== null
}

let handlerRegistered = false
function ensureHandler(): boolean {
  if (handlerRegistered) return notificationsModule !== null
  handlerRegistered = true
  const n = N()
  if (!n) return false
  try {
    n.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    })
    return true
  } catch (err) {
    log('warn', 'push', `notification handler unavailable: ${String(err)}`)
    return false
  }
}

const ENABLED_KEY = 'hermes.notifications.enabled.v1'
const TOKEN_KEY = 'hermes.expo_push_token.v1'
const CHANNEL_ID = 'hermes-alerts'

export const notificationsEnabled = atom(true)
export const expoPushToken = atom<string | null>(null)
export const notificationPermission = atom<string>('unknown')

export async function initPush(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ENABLED_KEY)
    if (raw !== null) notificationsEnabled.set(raw === '1')
  } catch {}
  try {
    const tok = await AsyncStorage.getItem(TOKEN_KEY)
    if (tok) expoPushToken.set(tok)
  } catch {}

  const n = N()
  if (!n) {
    log('info', 'push', 'notifications unavailable in this environment — continuing without them')
    return
  }
  ensureHandler()

  if (Platform.OS === 'android') {
    try {
      await n.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Hermes alerts',
        importance: n.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      })
    } catch (err) {
      log('warn', 'push', `channel failed: ${String(err)}`)
    }
  }
  try {
    const p = await n.getPermissionsAsync()
    notificationPermission.set(p.granted ? 'granted' : 'denied')
  } catch {}
}

export async function setNotificationsEnabled(on: boolean) {
  notificationsEnabled.set(on)
  try {
    await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0')
  } catch {}
  if (!on) {
    const n = N()
    if (!n) return
    try {
      await n.dismissAllNotificationsAsync()
    } catch {}
    try {
      await n.setBadgeCountAsync(0)
    } catch {}
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const n = N()
  if (!n) return false
  try {
    const cur = await n.getPermissionsAsync()
    if (cur.granted) {
      notificationPermission.set('granted')
      return true
    }
    const req = await n.requestPermissionsAsync()
    const ok = req.granted
    notificationPermission.set(ok ? 'granted' : 'denied')
    return ok
  } catch (err) {
    log('warn', 'push', `permission failed: ${String(err)}`)
    return false
  }
}

/** Immediate local notification (trigger: null). No-op when disabled. */
export async function notifyLocal(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  if (!notificationsEnabled.get()) return
  const n = N()
  if (!n || !ensureHandler()) return
  try {
    await n.scheduleNotificationAsync({
      content: { title, body: body.slice(0, 300), data: data ?? {}, sound: true },
      trigger: null,
    })
  } catch (err) {
    log('warn', 'push', `notify failed: ${String(err)}`)
  }
}

export async function setBadge(count: number) {
  const n = N()
  if (!n) return
  try {
    await n.setBadgeCountAsync(Math.max(0, count))
  } catch {}
}

export async function clearBadge() {
  await setBadge(0)
}

/** What a notification tap wants opened. `storedId` targets a specific chat. */
export interface NotificationTarget {
  storedId?: string
}

/** Pull the deep-link target out of a NotificationResponse. */
function targetOf(response: unknown): NotificationTarget {
  try {
    const data = (response as { notification?: { request?: { content?: { data?: unknown } } } })
      ?.notification?.request?.content?.data
    const storedId = (data as Record<string, unknown> | null | undefined)?.storedId
    return { storedId: typeof storedId === 'string' ? storedId : undefined }
  } catch {
    return {}
  }
}

/** Replay the notification the user tapped (covers killed-state launch), so
 *  the root layout can route. Null when no tap is pending. */
export async function lastNotificationResponse(): Promise<NotificationTarget | null> {
  const n = N()
  if (!n) return null
  try {
    const r = await n.getLastNotificationResponseAsync()
    return r ? targetOf(r) : null
  } catch {
    return null
  }
}

/** Forget the replayed tap so the next normal launch doesn't re-route to it. */
export async function clearLastNotificationResponse(): Promise<void> {
  const n = N()
  if (!n) return
  try {
    await n.clearLastNotificationResponseAsync()
  } catch {}
}

/** Subscribe to notification taps. Returns a remover, or null if unavailable. */
export function onNotificationResponse(handler: (target: NotificationTarget) => void): (() => void) | null {
  const n = N()
  if (!n) return null
  try {
    const sub = n.addNotificationResponseReceivedListener((response) => handler(targetOf(response)))
    return () => {
      try {
        sub.remove()
      } catch {}
    }
  } catch {
    return null
  }
}

function projectId(): string | null {
  const cfg = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return cfg?.eas?.projectId ?? (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId ?? null
}

export function easProjectId(): string | null {
  return projectId()
}

/**
 * Fetch an Expo push token for remote (server-driven) pushes.
 * Requires a linked EAS project (`npx eas init`) + a dev/prod build —
 * Expo Go cannot receive remote pushes on Android. Throws with a
 * human-readable reason when unavailable.
 */
export async function fetchPushToken(): Promise<string> {
  // Checked first: `getExpoPushTokenAsync` throws hard on Android in Expo Go,
  // and the raw message is easy to miss in a log.
  if (!remotePushSupported) {
    throw new Error(remotePushBlockedReason ?? 'Remote push is unavailable in this environment.')
  }
  const n = N()
  if (!n) throw new Error('expo-notifications is unavailable in this build.')
  if (!Device.isDevice) throw new Error('Push tokens need a physical device (not a simulator).')
  const ok = await ensureNotificationPermission()
  if (!ok) throw new Error('Notification permission denied.')
  const pid = projectId()
  if (!pid) {
    throw new Error('No EAS project linked. Run `npx eas init` in hermes-mobile, rebuild, then retry.')
  }
  const t = await n.getExpoPushTokenAsync({ projectId: pid })
  const token = t.data
  expoPushToken.set(token)
  try {
    await AsyncStorage.setItem(TOKEN_KEY, token)
  } catch {}
  log('info', 'push', 'Expo push token acquired')
  return token
}

export async function sendTestNotification(): Promise<void> {
  const n = N()
  if (!n) throw new Error('Notifications are unavailable in this build.')
  ensureHandler()
  const ok = await ensureNotificationPermission()
  if (!ok) throw new Error('Notification permission denied.')
  await n.scheduleNotificationAsync({
    content: { title: 'Moch', body: 'Notifications are working — approvals will buzz here.', data: { screen: 'chat' } },
    trigger: null,
  })
}
