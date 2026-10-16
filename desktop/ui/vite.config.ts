import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devBridge } from './dev-bridge'

// Tauri dev server: strictPort so a stale 5173 fails loudly instead of
// silently serving the wrong app; dev-bridge serves the runtime state to a
// plain-browser preview (user-testing track).
export default defineConfig({
  plugins: [react(), devBridge()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
  },
})
