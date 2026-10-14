import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../web-ui',
    emptyOutDir: true,
  },
  server: {
    fs: { allow: ['..', '../../app/src/protocol'] },
  },
})
