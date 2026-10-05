import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { isRunningInExpoGo } from 'expo'
import { AppState, Platform } from 'react-native'
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
      // Remote pushes are muted while the app is ACTIVE: in-app toasts
      // (SessionToasts) already surface attention events, so a tray banner
      // on top of them is a double knock. Delivery while backgrounded or
      // killed never runs this handler — that's the OS's job. Local
      // notifications keep the always-show behavior (their senders already
      // gate on backgrounding; the reclaimed-session note posts
      // deliberately while foregrounded).
      handleNotification: async (notification) => {
        // The trigger union is not fully discriminated (a channel trigger is
        // just `{ channelId }`), so read `type` defensively: only a remote
        // push carries `{ type: 'push' }`.
        const trigger = notification?.request?.trigger as { type?: string } | null | undefined
        const push = trigger?.type === 'push'
        if (push && AppState.currentState === 'active') {
          return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }
        }
        return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }
      },
    })
    return true
  } catch (err) {
    log('warn', 'push', `notification handler unavailable: ${String(err)}`)
    return false
  }
}

const ENABLED_KEY = 'hermes.notifications.enabled.v1'
const TOKEN_KEY = 'hermes.expo_push_token.v1'
/** Asked-once latch for the first-message permission prompt: a denial (or a
 *  grant) must never re-prompt on later sends — one ask per install. */
const PUSH_ARMED_KEY = 'hermes.push.armed.v1'
const CHANNEL_ID = 'hermes-alerts'

/**
 * Android channels for REMOTE pushes. The ids are the contract the push
 * sender cites (`channelId` in the Expo push payload) — they must exist
 * BEFORE the first push arrives: Android silently drops notifications that
 * name an unknown channel, so a missing channel here means no knock at all.
 */
const CHANNEL_APPROVALS = 'approvals' // HIGH + sound + vibrate — Mochi needs you
const CHANNEL_REPLIES = 'replies' // DEFAULT — a finished turn can wait a beat
const CHANNEL_MISC = 'misc' // quiet fallback for anything untagged

export const notificationsEnabled = atom(true)
export const expoPushToken = atom<string | null>(null)
export const notificationPermission = atom<string>('unknown')

/** Current Expo push token, or null until one is acquired. Sync and cheap —
 *  gateway.ts reads this on every dial to advertise the token on the URL. */
export function currentPushToken(): string | null {
  return expoPushToken.get()
}

export async function initPush(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ENABLED_KEY)
    if (raw !== null) notificationsEnabled.set(raw === '1')
  } catch {}
  let restoredToken = false
  try {
    const tok = await AsyncStorage.getItem(TOKEN_KEY)
    if (tok) {
      expoPushToken.set(tok)
      restoredToken = true
    }
  } catch {}

  const n = N()
  if (!n) {
    log('info', 'push', 'notifications unavailable in this environment — continuing without them')
    return
  }
  ensureHandler()
  trackOurNotifications()

  if (Platform.OS === 'android') {
    // One channel per knock loudness. Importance/sound are only settable at
    // CREATE — later calls update mutable fields only, which is fine: these
    // values are the ones we want on first create and never change after.
    const channels: Array<[string, Parameters<typeof n.setNotificationChannelAsync>[1]]> = [
      [CHANNEL_ID, { name: 'Hermes alerts', importance: n.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250] }],
      [CHANNEL_APPROVALS, { name: 'Approvals', importance: n.AndroidImportance.HIGH, sound: 'default', enableVibrate: true, vibrationPattern: [0, 250, 250, 250] }],
      [CHANNEL_REPLIES, { name: 'Replies', importance: n.AndroidImportance.DEFAULT }],
      [CHANNEL_MISC, { name: 'Misc', importance: n.AndroidImportance.LOW }],
      // The keep-alive channel: MIUI (Xiaomi) and some other OEM launchers
      // BLOCK FCM delivery to apps they consider "stopped" — the notification
      // arrives minutes late or not at all. A persistent low-importance
      // notification makes the OS treat the app as foreground/active, which
      // keeps the FCM broadcast path open. This is the same survival trick
      // every major messaging app uses on aggressive-OEM Androids.
      [CHANNEL_KEEPALIVE, { name: 'Connection', importance: n.AndroidImportance.MIN, showBadge: false, enableVibrate: false, sound: undefined }],
    ]
    for (const [id, cfg] of channels) {
      try {
        await n.setNotificationChannelAsync(id, cfg)
      } catch (err) {
        log('warn', 'push', `channel ${id} failed: ${String(err)}`)
      }
    }
    // A restored token means push was armed on a previous launch: re-post the
    // keep-alive EVERY launch. The tray notification dies with the process —
    // a reboot or an OEM kill is exactly the moment it exists to cover, so
    // posting it only in the session that first fetched the token left the
    // exact vulnerable windows uncovered.
    if (restoredToken) void ensureKeepAlive()
  }
  try {
    const p = await n.getPermissionsAsync()
    notificationPermission.set(p.granted ? 'granted' : 'denied')
  } catch {}
}

const CHANNEL_KEEPALIVE = 'connection'

/** The MIUI/OEM keep-alive: a silent persistent notification that makes the
 *  OS treat the app as active, so FCM broadcasts are delivered immediately
 *  instead of deferred by battery-saving heuristics. Posted whenever push is
 *  armed and the app connects; dismissed never (it IS the lifeline). */
export async function ensureKeepAlive(): Promise<void> {
  if (Platform.OS !== 'android') return
  const n = N()
  if (!n) return
  if (!expoPushToken.get()) return // nothing to keep alive until push is armed
  try {
    const id = await n.scheduleNotificationAsync({
      content: {
        title: 'Moch',
        body: 'Connected — taps to open Moch.',
        data: { screen: 'chat', persistent: true },
        sticky: true,
        autoDismiss: false,
      },
      // The channel rides the TRIGGER, not a request-level `android` key:
      // scheduleNotificationAsync forwards only `content` and
      // parseTrigger(trigger) to native, so `android:` is silently dropped and
      // trigger:null lands on the auto-created HIGH vibrating channel. A bare
      // {channelId} parses to the immediate channel trigger on Android (and
      // to plain immediate elsewhere), keeping this on the silent channel.
      trigger: { channelId: CHANNEL_KEEPALIVE },
    })
    keepAliveId.set(id)
    log('info', 'push', 'keep-alive notification posted')
  } catch (err) {
    log('warn', 'push', `keep-alive failed: ${String(err)}`)
  }
}

const keepAliveId = atom<string | null>(null)

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

/** Boot-time, SILENT registration: never prompts. Returning users whose
 *  permission is already granted get their token re-registered on the next
 *  dial; fresh installs (or denied) are left for the first-message prompt
 *  below — the user asked for the ask to ride the first send, not boot. */
export async function registerPushIfGranted(): Promise<void> {
  if (!remotePushSupported) return
  const n = N()
  if (!n) return
  try {
    const p = await n.getPermissionsAsync()
    if (!p.granted) return
    if (expoPushToken.get()) return // initPush already restored it
    await fetchPushToken()
  } catch (e) {
    log('info', 'push', `silent push register skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** ONE ask per install, fired on the first message send: this is the moment
 *  notifications become obviously useful ("buzz me when the reply is done"),
 *  so the system prompt lands as a service offer, not a cold-app demand. A
 *  denial is remembered — later sends never re-prompt. The latch is written
 *  only on a DEFINITIVE outcome (user answered the dialog, or the token was
 *  fetched): a transient failure must not burn the one-per-install ask. */
export async function armPushOnFirstSend(): Promise<void> {
  if (!remotePushSupported) return
  const n = N()
  if (!n) return
  try {
    if (expoPushToken.get()) return
    const armed = await AsyncStorage.getItem(PUSH_ARMED_KEY)
    if (armed !== null) return // already asked once — never nag
    const ok = await ensureNotificationPermission()
    if (!ok) {
      // The dialog was answered with a denial — definitive: latch, never nag.
      await AsyncStorage.setItem(PUSH_ARMED_KEY, '1')
      return
    }
    await fetchPushToken()
    // Token in hand: the ask served its purpose. (A throw from fetchPushToken
    // — transient network, provider hiccup — falls to the catch below WITHOUT
    // latching, so the next send retries; permission is already granted, so
    // no second dialog ever shows.)
    await AsyncStorage.setItem(PUSH_ARMED_KEY, '1')
  } catch (e) {
    log('info', 'push', `first-send push arm skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Immediate local notification. No-op when disabled. `channel` picks the
 *  Android notification channel (defaults to the alerts channel) — passed as
 *  a {channelId} trigger for the same reason as the keep-alive above: the
 *  request-level android key never reaches native on this SDK. */
export async function notifyLocal(title: string, body: string, data?: Record<string, unknown>, channel: string = CHANNEL_ID): Promise<void> {
  if (!notificationsEnabled.get()) return
  const n = N()
  if (!n || !ensureHandler()) return
  try {
    await n.scheduleNotificationAsync({
      content: { title, body: body.slice(0, 300), data: data ?? {}, sound: true },
      trigger: { channelId: channel },
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

// ── Tray hygiene ────────────────────────────────────────────────────────────

/** Identifiers of our notifications seen arriving (foreground deliveries). */
const ourNotificationIds = new Set<string>()

/**
 * True when a delivered notification is one of OUR knocks. Both halves of
 * the product mark them the same way — local (chat.ts) and the remote push
 * sender put `{ screen: 'chat', ... }` in the data payload — so that is the
 * stable ownership marker. Anything else in our tray (nothing today) stays.
 */
function isMochNotification(request: { content?: { data?: unknown } } | undefined | null): boolean {
  const data = request?.content?.data as Record<string, unknown> | null | undefined
  return !!data && typeof data === 'object' && data.screen === 'chat'
}

let receivedTracked = false
/** Record our notifications as they arrive, so their ids can be dismissed. */
function trackOurNotifications(): void {
  if (receivedTracked) return
  receivedTracked = true
  const n = N()
  if (!n) return
  try {
    n.addNotificationReceivedListener((notification) => {
      const id = notification?.request?.identifier
      if (id && isMochNotification(notification.request)) ourNotificationIds.add(id)
    })
  } catch (err) {
    log('warn', 'push', `received-listener failed: ${String(err)}`)
  }
}

/**
 * Dismiss every delivered Mochi notification still in the tray. Called when
 * the app is open — our knocks are stale the moment the chat surface itself
 * is reachable. Two sources are swept, because tracking alone is not enough:
 *  - ids recorded as the notifications arrived (foreground deliveries), and
 *  - the tray filtered to ours — notifications delivered while we were
 *    backgrounded or killed never ran JS, so they left no tracked id, and
 *    they are exactly the stale ones this exists for.
 */
export async function dismissMochNotifications(): Promise<void> {
  const n = N()
  if (!n) return
  const ids = new Set(ourNotificationIds)
  ourNotificationIds.clear()
  try {
    for (const presented of await n.getPresentedNotificationsAsync()) {
      const id = presented?.request?.identifier
      if (id && isMochNotification(presented.request)) ids.add(id)
    }
  } catch {}
  for (const id of ids) {
    try { await n.dismissNotificationAsync(id) } catch {}
  }
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
  // Push is armed — post the OEM keep-alive so MIUI & friends can't
  // classify the app as "stopped" and defer FCM delivery by minutes.
  void ensureKeepAlive()
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
