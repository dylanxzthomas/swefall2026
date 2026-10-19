import { spawnSync } from 'node:child_process'
const url = new URL(process.env.VITE_CONVEX_URL ?? '')
if (!url.hostname.endsWith('.convex.cloud')) throw new Error('Expected the isolated Convex cloud URL supplied by the deployment command.')
const site = `https://${url.hostname.replace('.convex.cloud', '.convex.site')}`
if (process.env.VERCEL_ENV === 'preview') {
  const deployment = url.hostname.slice(0, -'.convex.cloud'.length)
  for (const [name, value] of [['DAYMARK_WEB_URL', `https://${process.env.VERCEL_URL}`], ['DAYMARK_ENVIRONMENT', 'development']]) {
    const configured = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', 'env', 'set', name, value, '--deployment', deployment], { stdio: 'inherit' })
    if (configured.status !== 0) process.exit(configured.status ?? 1)
  }
}
const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit', env: { ...process.env, VITE_CONVEX_SITE_URL: site } })
if (build.status !== 0) process.exit(build.status ?? 1)
const manifest = spawnSync(process.execPath, ['scripts/release-manifest.mjs'], { stdio: 'inherit', env: { ...process.env, VITE_CONVEX_SITE_URL: site } })
process.exit(manifest.status ?? 1)
