// Unit tests for src/lib/push.ts — offline, fakes only, no device, no FCM.
//
// The module was made node-loadable (tracker BH-000028) by lazy-requiring
// AsyncStorage / expo-device / expo-constants / react-native behind the same
// pattern it already used for expo-notifications; this suite pins its honest
// testable surface: the Expo-Go gate, storage restore, channel setup, the
// knock payload shape, the foreground mute rule, permission/token flow and
// the ask-once latch. Delivery itself (FCM, tray behavior) stays
// device-verified.
type Push = typeof import('../src/lib/push')

let m: Push

// In-memory AsyncStorage stand-in.
const backing = new Map<string, string>()
const fakeStorage = {
  getItem: async (k: string) => backing.get(k) ?? null,
  setItem: async (k: string, v: string) => void backing.set(k, v),
}

/** Minimal expo-notifications fake: records every call, answers what we pin. */
class FakeNotifications {
  scheduled: Array<Record<string, unknown>> = []
  channels: Array<[string, Record<string, unknown>]> = []
  handler: ((n: unknown) => Promise<Record<string, boolean>>) | null = null
  permission = { granted: true }
  permissionCalls = 0
  tokenCalls = 0
  failNextToken = false
  AndroidImportance = { HIGH: 5, DEFAULT: 3, LOW: 1, MIN: 0 }
  setNotificationHandler(h: never) { this.handler = h as never }
  async getPermissionsAsync() { this.permissionCalls++; return this.permission }
  async requestPermissionsAsync() { this.permissionCalls++; return this.permission }
  async getExpoPushTokenAsync() {
    this.tokenCalls++
    if (this.failNextToken) { this.failNextToken = false; throw new Error('fcm hiccup') }
    return { data: 'ExpoPushToken[fake-1]' }
  }
  async scheduleNotificationAsync(req: Record<string, unknown>) { this.scheduled.push(req); return `nid-${this.scheduled.length}` }
  async setNotificationChannelAsync(id: string, cfg: Record<string, unknown>) { this.channels.push([id, cfg]) }
  async dismissAllNotificationsAsync() { this.dismissedAll = true }
  dismissedAll = false
  async setBadgeCountAsync(count: number) { this.badge = count }
  badge = -1
}
const fake = new FakeNotifications()

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  m = await import('../src/lib/push')
  m._usePushStorageForTests(fakeStorage)

  // ── Bare-node facts: the module imports cleanly outside the app runtime ─
  check('module loads in plain node; notifications unavailable without a fake', m.notificationsAvailable() === false)
  check('remote push is supported off-device when not in Expo Go', m.remotePushSupported() === true && m.remotePushBlockedReason() === null)

  // ── Expo Go (Android) gating: everything remote must no-op BEFORE any
  //    expo-notifications evaluation — chat is the product.
  m._usePushPlatformForTests({ os: 'android', expoGo: true })
  m._useNotificationsForTests(fake as unknown as Parameters<typeof m._useNotificationsForTests>[0])
  check('expo-go android: remote push reported unsupported with an actionable reason', m.remotePushSupported() === false && (m.remotePushBlockedReason() ?? '').includes('Expo Go'))
  await m.fetchPushToken().then(
    () => check('expo-go android: fetchPushToken refuses', false),
    (e: Error) => check('expo-go android: fetchPushToken refuses', /Expo Go/.test(e.message), e.message),
  )
  check('expo-go android: the token RPC was never even attempted', fake.tokenCalls === 0)
  await m.armPushOnFirstSend()
  await m.registerPushIfGranted()
  check(
    'expo-go android: first-send arm + silent register no-op (no latch, no permission ask)',
    backing.get('hermes.push.armed.v1') === undefined && fake.permissionCalls === 0 && m.currentPushToken() === null,
  )

  // ── A real-build android environment for the rest ──────────────────────
  m._usePushPlatformForTests({ os: 'android', expoGo: false, isDevice: true, projectId: 'proj-1' })
  check('easProjectId surfaces the linked project', m.easProjectId() === 'proj-1')

  // initPush: restore enabled flag + token from storage; re-post keep-alive.
  backing.set('hermes.notifications.enabled.v1', '0')
  backing.set('hermes.expo_push_token.v1', 'ExpoPushToken[fake-1]')
  await m.initPush()
  check('initPush restores the notifications toggle from storage', m.notificationsEnabled.get() === false)
  check('initPush restores the push token (sync read for the dial URL)', m.currentPushToken() === 'ExpoPushToken[fake-1]')
  const keepAlive = fake.scheduled[0]
  check(
    'restored token re-posts the silent keep-alive on the connection channel',
    !!keepAlive && (keepAlive.trigger as { channelId?: string })?.channelId === 'connection' &&
      (keepAlive.content as { sticky?: boolean })?.sticky === true,
  )
  const ch = new Map(fake.channels)
  check(
    'initPush creates the knock channels with the right loudness',
    ch.size === 5 &&
      (ch.get('approvals') as { importance?: number })?.importance === fake.AndroidImportance.HIGH &&
      (ch.get('replies') as { importance?: number })?.importance === fake.AndroidImportance.DEFAULT &&
      (ch.get('misc') as { importance?: number })?.importance === fake.AndroidImportance.LOW &&
      (ch.get('connection') as { importance?: number })?.importance === fake.AndroidImportance.MIN,
    [...ch.keys()].join(','),
  )

  // ── Knock payload shape (the push sender's contract) ────────────────────
  await m.setNotificationsEnabled(true)
  await m.notifyLocal('Mochi needs you', 'x'.repeat(400), { screen: 'chat', storedId: 's1' }, 'approvals')
  check(
    'notifyLocal knocks on the named channel: title + data + sound, body capped at 300',
    (() => {
      const k = fake.scheduled[fake.scheduled.length - 1]
      const c = k.content as { title: string; body: string; data: Record<string, unknown>; sound: boolean }
      return (k.trigger as { channelId: string }).channelId === 'approvals' && c.title === 'Mochi needs you' &&
        c.body.length === 300 && c.data.storedId === 's1' && c.sound === true
    })(),
  )
  await m.setNotificationsEnabled(false)
  await m.notifyLocal('muted', 'should not land')
  check('notifyLocal is a full no-op while notifications are disabled', fake.scheduled.length === 2 && fake.dismissedAll === true && fake.badge === 0)
  check('disabling persists to storage', backing.get('hermes.notifications.enabled.v1') === '0')
  await m.setNotificationsEnabled(true)

  // ── Foreground mute: remote pushes are suppressed while the app is ACTIVE;
  //    local notifications always show. AppState is faked via require.cache.
  const rnPath = require.resolve('react-native')
  require.cache[rnPath] = {
    id: rnPath, filename: rnPath, loaded: true,
    exports: { Platform: { OS: 'android' }, AppState: { currentState: 'active' } },
  } as unknown as typeof require.cache[string]
  const handler = fake.handler as unknown as { handleNotification: (n: unknown) => Promise<Record<string, boolean>> }
  const verdict = async (trigger: unknown) =>
    handler.handleNotification({ request: { trigger } })
  const local = await verdict({ channelId: 'approvals' })
  const push = await verdict({ type: 'push' })
  check(
    'foreground: local notifications banner, remote pushes stay silent',
    local.shouldShowBanner === true && push.shouldShowBanner === false && push.shouldPlaySound === false,
  )

  // ── Permission + token flow ─────────────────────────────────────────────
  fake.permission = { granted: true }
  check('granted permission reports true and latches the atom', (await m.ensureNotificationPermission()) === true && m.notificationPermission.get() === 'granted')
  m._usePushPlatformForTests({ os: 'android', expoGo: false, isDevice: false, projectId: 'proj-1' })
  await m.fetchPushToken().then(
    () => check('simulator is refused a token', false),
    (e: Error) => check('simulator is refused a token', /physical device/.test(e.message)),
  )
  m._usePushPlatformForTests({ os: 'android', expoGo: false, isDevice: true, projectId: null })
  await m.fetchPushToken().then(
    () => check('no EAS project is refused a token', false),
    (e: Error) => check('no EAS project is refused a token', /No EAS project linked/.test(e.message)),
  )
  m._usePushPlatformForTests({ os: 'android', expoGo: false, isDevice: true, projectId: 'proj-1' })
  fake.permission = { granted: false }
  await m.fetchPushToken().then(
    () => check('denied permission is refused a token', false),
    (e: Error) => check('denied permission is refused a token', /permission denied/i.test(e.message)),
  )

  // Happy path (ask-once latch never burned yet).
  backing.delete('hermes.push.armed.v1')
  m.expoPushToken.set(null)
  fake.permission = { granted: true }
  const tok = await m.fetchPushToken()
  check(
    'happy path: token returned, atom set, persisted, keep-alive posted',
    tok === 'ExpoPushToken[fake-1]' && m.currentPushToken() === tok && backing.get('hermes.expo_push_token.v1') === tok && fake.scheduled.length > 2,
  )

  // ── Ask-once latch (one prompt per install) ─────────────────────────────
  backing.delete('hermes.push.armed.v1')
  m.expoPushToken.set(null)
  fake.permission = { granted: false }
  await m.armPushOnFirstSend()
  const asksAfterDenial = fake.permissionCalls
  await m.armPushOnFirstSend()
  check('a denial latches the ask — later sends never re-prompt', backing.get('hermes.push.armed.v1') === '1' && fake.permissionCalls === asksAfterDenial)

  backing.delete('hermes.push.armed.v1')
  m.expoPushToken.set(null)
  fake.permission = { granted: true }
  fake.failNextToken = true
  await m.armPushOnFirstSend() // transient provider failure
  check('a transient token failure does NOT burn the one ask', backing.get('hermes.push.armed.v1') === undefined)
  await m.armPushOnFirstSend() // next send retries and succeeds
  check('retry after transient failure acquires the token and latches', backing.get('hermes.push.armed.v1') === '1' && m.currentPushToken() === 'ExpoPushToken[fake-1]')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-push crashed:', err)
  process.exit(1)
})
