import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4747', changeOrigin: true },
      '/audio': { target: 'http://localhost:4747', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
