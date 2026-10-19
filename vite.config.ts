import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => ({
  root: 'web',
  envDir: '..',
  // Browser checks must not replace the live preview's optimized dependencies.
  cacheDir: fileURLToPath(new URL(mode === 'test' ? './node_modules/.vite-test' : './node_modules/.vite', import.meta.url)),
  plugins: [react(), tailwindcss(), {
    name: 'local-file-paths',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        // Encoded separators are not valid asset names and reach Vite's raw/URL
        // transforms before its ordinary file guard. Reject ambiguous paths.
        if (/%(?:2f|5c)/i.test((request.url ?? '').split('?')[0])) {
          response.statusCode = 400
          response.end('Invalid file path.')
          return
        }
        next()
      })
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      strict: true,
      // Shared modules are needed by the app; the repository also contains
      // private backend configuration and family data that must never be served.
      allow: ['web', 'shared', 'convex/_generated', 'node_modules', 'docs/diagrams', 'docs/MVP_BUILD_SPEC.md', 'docs/IPHONE.md', 'README.md', 'CHANGELOG.md'].map(path => fileURLToPath(new URL(`./${path}`, import.meta.url))),
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.convex/**', '**/.vercel/**', '**/data/**', '**/native-artifacts/**', '**/test-results/**', '**/playwright-report/**'],
    },
    proxy: {
      '/api': { target: 'http://localhost:4747', changeOrigin: true },
      '/audio': { target: 'http://localhost:4747', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
}))
