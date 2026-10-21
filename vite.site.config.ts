import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/website'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve('dist/site'),
    emptyOutDir: true
  },
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  preview: { host: '127.0.0.1', port: 5175, strictPort: true }
})
