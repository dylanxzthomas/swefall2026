import { spawnSync } from 'node:child_process'
const preview = process.env.VERCEL_ENV === 'preview'
const key = process.env.CONVEX_DEPLOY_KEY ?? ''
if (preview && !/^preview:[^:|]+:[^|]+\|/.test(key)) throw new Error('Preview requires a Convex project preview deploy key. Refusing a shared or production backend.')
if (!key) throw new Error('Connect the matching Convex deployment before publishing Daymark.')
const args = ['node_modules/convex/bin/main.js', 'deploy', '--cmd', 'node scripts/vercel-client.mjs', '--cmd-url-env-var-name', 'VITE_CONVEX_URL']
if (preview) {
  if (!process.env.VERCEL_URL) throw new Error('Preview URL is required for an isolated backend.')
  args.push('--preview-name', process.env.VERCEL_URL.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 100))
}
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
