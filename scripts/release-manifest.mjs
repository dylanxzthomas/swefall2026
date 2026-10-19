import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { loadEnv } from 'vite'
import { sourceVersion } from './release-metadata.mjs'
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const command = (...args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
const digest = createHash('sha256')
for (const file of (await readdir('web/dist/assets')).sort()) { digest.update(file); digest.update(await readFile(`web/dist/assets/${file}`)) }
const versions = {}
for (const name of ['convex', '@convex-dev/workflow', '@capacitor/core', '@auth0/auth0-react', '@anthropic-ai/sdk', '@googleapis/calendar', '@googleapis/gmail']) versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version
const sourceStatus = command('status', '--porcelain')
let reviewed
try { reviewed = sourceVersion(JSON.parse(await readFile('source-version.json', 'utf8'))) }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Public source version could not be verified. Build stopped without displaying its contents.') }
const release = { name: pkg.name, version: pkg.version, builtAt: new Date().toISOString(), commit: reviewed?.commit ?? command('rev-parse', 'HEAD'), uncommittedChanges: reviewed?.dirty ?? (sourceStatus === null ? null : Boolean(sourceStatus)), ...(reviewed ? { reviewedSourceSha256: reviewed.sourceSha256 } : {}), bundleSha256: digest.digest('hex'), backendUrl: env.VITE_CONVEX_URL || null, backendApiVersion: 1, evaluatedModel: process.env.DAYMARK_EVALUATED_MODEL || reviewed?.evaluatedModel || null, nativeVerified: false, toolVersions: versions }
await writeFile('web/dist/release.json', JSON.stringify(release, null, 2) + '\n')
console.log('Release manifest saved; native and live-provider verification remain separate gates.')
