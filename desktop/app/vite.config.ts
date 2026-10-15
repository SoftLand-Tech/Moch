import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The shared engine (app/src/lib) imports its storage at module scope from
// React Native packages. The desktop build aliases those to localStorage
// shims so the REAL chat/gateway/protocol modules compile unmodified —
// one protocol core, a dedicated desktop UI on top.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Single-copy rule: the shared engine's atoms and this UI's
      // subscriptions MUST be the same nanostores module instance or the
      // UI renders empty stores. Both resolve to the app's installed copy.
      // react/react-dom join the rule — @nanostores/react imports react
      // from its own directory, and two React copies break hooks.
      { find: /^react$/, replacement: r('../../app/node_modules/react') },
      { find: /^react-dom(.*)$/, replacement: r('../../app/node_modules/react-dom') + '$1' },
      { find: /^react\/jsx-runtime$/, replacement: r('../../app/node_modules/react/jsx-runtime') },
      { find: /^nanostores$/, replacement: r('../../app/node_modules/nanostores') },
      { find: /^@nanostores\/react$/, replacement: r('../../app/node_modules/@nanostores/react') },
      { find: /^@react-native-async-storage\/async-storage$/, replacement: r('src/shim/asyncStorage.ts') },
      { find: /^expo-secure-store$/, replacement: r('src/shim/secureStore.ts') },
      { find: /^expo-file-system\/legacy$/, replacement: r('src/shim/expoFileSystem.ts') },
      { find: /^expo-file-system$/, replacement: r('src/shim/expoFileSystem.ts') },
      { find: /^expo-image-manipulator$/, replacement: r('src/shim/expoFileSystem.ts') },
      { find: /^expo-audio$/, replacement: r('src/shim/expoAudio.ts') },
      { find: /^expo-image$/, replacement: r('src/shim/expoImage.ts') },
      { find: /^react-native$/, replacement: r('src/shim/reactNative.ts') },
      { find: /^react-native\//, replacement: r('src/shim/reactNative.ts') },
    ],
  },
  build: {
    outDir: '../app-desktop-web',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: { port: 5180 },
})
