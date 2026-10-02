// Runtime proof: evaluate the real app module graph in a fake Android/Expo Go
// environment where `expo-notifications` THROWS ON IMPORT (exactly what the
// device does), and confirm every route still yields a default export.
//
// This reproduces the reported failure and then verifies the fix.
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const ROOT = process.argv[2] ?? '.'
const require_ = createRequire(path.resolve(ROOT, 'noop.js'))

// ── Install a throwing stub for expo-notifications ─────────────────────────
// The real module throws during evaluation on Android in Expo Go. If any app
// module imports it at the top level, that module's evaluation fails and its
// default export never registers.
const originalResolve = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'expo-notifications') return 'expo-notifications'
  return originalResolve.call(this, request, ...rest)
}

const load = Module as unknown as { _load(id: string, parent: unknown, isMain: boolean): unknown }
const originalLoad = load._load
load._load = function (id: string, parent: unknown, isMain: boolean) {
  if (id === 'expo-notifications') {
    throw new Error(
      'expo-notifications: Android Push notifications (remote notifications) functionality provided by expo-notifications was removed from Expo Go with the release of SDK 53.',
    )
  }
  return originalLoad.call(this, id, parent, isMain)
}

// ── Stub the rest of the RN/Expo surface the app touches at import time ────
const store = new Map<string, unknown>()
const innerLoad = load._load
load._load = function (id: string, parent: unknown, isMain: boolean): unknown {
  if (store.has(id)) return store.get(id)
  if (id === 'expo-notifications') {
    throw new Error('expo-notifications was imported at module scope (the bug this test guards against)')
  }
  return innerLoad.call(this, id, parent, isMain)
}

function stub(name: string, value: unknown): void {
  store.set(name, value)
}

// Metro/RN globals the bundle relies on.
;(globalThis as Record<string, unknown>).__DEV__ = true

// Metro turns `require('./x.png')` into an asset descriptor at build time;
// Node has no such loader, so stand one in (routes may require images).
const pngLoad = load._load
load._load = function (id: string, parent: unknown, isMain: boolean): unknown {
  if (id.endsWith('.png')) return { __metroAsset: true, uri: id }
  return pngLoad.call(this, id, parent, isMain)
}

stub('expo', { isRunningInExpoGo: () => true, useEvent: () => ({ status: 'idle' }), useEventListener: () => {} })
stub('expo-constants', { default: { expoConfig: null, easConfig: null } })
stub('expo-device', { isDevice: false })
stub('react-native', {
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  NativeModules: {},
  StyleSheet: {
    create: <T,>(s: T): T => s,
    flatten: (s: unknown) => s,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  View: () => null,
  Text: () => null,
  Pressable: () => null,
  TextInput: () => null,
  ScrollView: () => null,
  FlatList: () => null,
  KeyboardAvoidingView: () => null,
  Switch: () => null,
  ActivityIndicator: () => null,
  RefreshControl: () => null,
  Alert: { alert: () => {} },
  Linking: { openURL: () => {} },
})
stub('@nanostores/react', { useStore: () => ({}) })
stub('@react-native-async-storage/async-storage', {
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
  },
})
stub('expo-secure-store', {
  isAvailableAsync: async () => false,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
})
stub('expo-router', {
  Stack: () => null,
  Tabs: () => null,
  router: { push: () => {}, replace: () => {} },
  useFocusEffect: () => {},
})
stub('expo-linking', { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) })
stub('expo-status-bar', { StatusBar: () => null })
// Bundled in Expo Go (SDK 57 ships keyboard-controller 1.21.9 + reanimated
// 4.5.1 natively), but its module graph is the first in the app to evaluate
// react-native-reanimated, whose entry needs TurboModuleRegistry — absent
// from the react-native stub above. On a real Expo Go install both evaluate
// fine, so stand in the component surface the app imports.
stub('react-native-keyboard-controller', {
  KeyboardProvider: ({ children }: { children: unknown }) => children,
  KeyboardAvoidingView: ({ children }: { children: unknown }) => children,
})
// chat.tsx now imports reanimated directly (keyboard-inset padding). Its
// module entry needs TurboModuleRegistry, absent from the RN stub above;
// reanimated ships natively in Expo Go, so stand in the surface chat uses.
stub('react-native-reanimated', {
  default: { View: () => null },
  useAnimatedStyle: () => ({}),
  createAnimatedComponent: () => (props: unknown) => props,
})
stub('@expo/vector-icons', { Ionicons: () => null })
stub('@ronradtke/react-native-markdown-display', { default: () => null })
stub('expo-clipboard', { setStringAsync: async () => {} })
stub('expo-speech', { speak: () => {}, stop: async () => {} })
stub('expo-audio', { AudioModule: {}, useAudioRecorder: () => ({}), RecordingPresets: {}, createAudioPlayer: () => ({}) })
stub('expo-camera', { CameraView: () => null, useCameraPermissions: () => ({}) })
stub('expo-file-system/legacy', { readAsStringAsync: async () => '', writeAsStringAsync: async () => {}, cacheDirectory: '/cache/', EncodingType: { Base64: 'base64' } })
stub('expo-file-system', new Proxy({}, { get: () => async () => '' }))
stub('expo-haptics', { impactAsync: async () => {}, notificationAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} })
// Media spine (SDK 57 packages the chat screen pulls in at module scope).
stub('expo-image', { Image: () => null, getCachePathAsync: async () => null })
stub('expo-image-picker', {
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
  launchCameraAsync: async () => ({ canceled: true, assets: [] }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: false }),
  requestCameraPermissionsAsync: async () => ({ granted: false }),
})
stub('expo-document-picker', { getDocumentAsync: async () => ({ canceled: true, assets: [] }) })
stub('expo-image-manipulator', { ImageManipulator: { manipulate: () => ({ resize: () => ({}), renderAsync: async () => ({}), saveAsync: async () => ({}) }) }, SaveFormat: { JPEG: 'jpeg', PNG: 'png' } })
stub('expo-video', { VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) })
stub('expo-sharing', { shareAsync: async () => {} })
stub('react-native-safe-area-context', { SafeAreaView: () => null, useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) })
stub('react-native-markdown-display', { default: () => null })
const reactStub: Record<string, unknown> = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (f: unknown) => f,
  useMemo: (f: () => unknown) => f(),
  memo: (f: unknown) => f,
  Fragment: null,
}
reactStub.default = reactStub
stub('react', reactStub)

const routes = [
  'app/index.tsx',
  'app/_layout.tsx',
  'app/add-computer.tsx',
  'app/(tabs)/_layout.tsx',
  'app/(tabs)/chat.tsx',
  'app/(tabs)/sessions.tsx',
  'app/(tabs)/agent.tsx',
  'app/(tabs)/settings.tsx',
]

console.log('Evaluating every route with expo-notifications THROWING on import\n')
let bad = 0
for (const r of routes) {
  const abs = path.resolve(ROOT, r)
  if (!existsSync(abs)) {
    console.log(`  MISSING  ${r}`)
    bad++
    continue
  }
  try {
    // Fresh module registry per route, like a fresh bundle evaluation.
    ;(Module as any)._cache = {}
    const mod = require_(abs)
    const hasDefault = mod && typeof mod.default !== 'undefined' && mod.default !== null
    console.log(`  ${hasDefault ? 'OK      ' : 'NO EXPORT'} ${r}${hasDefault ? '' : '  <-- would warn + break routing'}`)
    if (!hasDefault) bad++
  } catch (err) {
    console.log(`  THREW    ${r}`)
    console.log(`             ${(err as Error).message.split('\n')[0].slice(0, 100)}`)
    bad++
  }
}

console.log(`\nroutes that failed to expose a default export: ${bad}`)
console.log(bad === 0 ? 'PASS - routes survive a throwing expo-notifications' : 'FAIL')
process.exit(bad === 0 ? 0 : 1)
