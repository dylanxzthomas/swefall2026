import { spawn } from 'node:child_process'
import { readFile, access, chmod, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

// Keep the existing anonymous SQLite deployment, including its keys and data.
// The standard local launcher binds every network interface; this pilot must not.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(root, 'node_modules/convex/bin/main.js')
let backend, watcher, scratch, closing = false, preservedDeployment
async function restoreDeploymentSelection() {
  if (!preservedDeployment) return
  const path = join(root, '.env.local'), current = await readFile(path, 'utf8')
  // The CLI's URL-based watcher removes this selection during initial setup.
  // Restore only that line; never overwrite concurrent edits to other settings.
  if (!/^CONVEX_DEPLOYMENT=/m.test(current)) await writeFile(path, `CONVEX_DEPLOYMENT=${preservedDeployment}\n${current}`, { mode: 0o600 })
}
async function stop(code = 0) {
  if (closing) return
  closing = true
  for (const child of [watcher, backend]) {
    if (!child || child.exitCode !== null || child.signalCode) continue
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))])
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
  }
  if (scratch) await rm(scratch, { recursive: true, force: true })
  await restoreDeploymentSelection()
  process.exitCode = code
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())

try {
  const environment = await readFile(join(root, '.env.local'), 'utf8').catch(() => '')
  const deployment = (process.env.CONVEX_DEPLOYMENT ?? environment.match(/^CONVEX_DEPLOYMENT=(.*)$/m)?.[1] ?? '').trim()
  if (!deployment.startsWith('anonymous:')) {
    watcher = spawn(process.execPath, [cli, 'dev'], { cwd: root, stdio: 'inherit' })
    watcher.once('error', () => void stop(1)); watcher.once('exit', code => void stop(code ?? 1))
  } else {
    preservedDeployment = deployment
    const directory = join(root, '.convex/local/default')
    const configPath = join(directory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    if (deployment !== `anonymous:${config.deploymentName}` || !/^precompiled-[a-zA-Z0-9-]+$/.test(config.backendVersion) || !config.instanceSecret || !config.adminKey || ![config.ports?.cloud, config.ports?.site].every(p => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('Invalid preserved deployment configuration.')
    const binary = join(homedir(), '.cache/convex/binaries', config.backendVersion, 'convex-local-backend')
    const database = join(directory, 'convex_local_backend.sqlite3')
    await access(binary, constants.X_OK); await access(database)
    for (const port of [config.ports.cloud, config.ports.site]) {
      await new Promise((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
      })
    }
    await chmod(directory, 0o700); await chmod(configPath, 0o600)
    scratch = await mkdtemp(join(tmpdir(), 'sola-local-backend-'))
    const selection = join(scratch, 'deployment.env')
    const origin = `http://127.0.0.1:${config.ports.cloud}`
    await writeFile(selection, `CONVEX_SELF_HOSTED_URL=${origin}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${config.adminKey}\n`, { mode: 0o600 })
    backend = spawn(binary, ['--interface', '127.0.0.1', '--port', String(config.ports.cloud), '--site-proxy-port', String(config.ports.site), '--instance-name', config.deploymentName, '--instance-secret', config.instanceSecret, '--local-storage', join(directory, 'convex_local_storage'), '--disable-beacon', '--redact-logs-to-client', database], { cwd: root, stdio: 'ignore' })
    backend.once('error', () => void stop(1)); backend.once('exit', code => { if (!closing) { console.error('Local backend stopped; private credentials were not displayed.'); void stop(code ?? 1) } })
    let ready = false
    for (let attempt = 0; attempt < 60 && !closing; attempt++) {
      try {
        const response = await fetch(`${origin}/instance_name`, { signal: AbortSignal.timeout(500) })
        if (response.ok && await response.text() === config.deploymentName) { ready = true; break }
      } catch { /* Startup is asynchronous. Never log transport details or secrets. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error('The preserved local backend did not start.')
    const childEnvironment = { ...process.env }
    for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_DEPLOYMENT', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete childEnvironment[name]
    console.log(`Private local backend ready at ${origin}; HTTP callbacks stay on 127.0.0.1:${config.ports.site}. Existing data retained.`)
    watcher = spawn(process.execPath, [cli, 'dev', '--env-file', selection, '--tail-logs', 'disable'], { cwd: root, env: childEnvironment, stdio: ['inherit', 'pipe', 'pipe'] })
    let startupLog = ''
    for (const [stream, output] of [[watcher.stdout, process.stdout], [watcher.stderr, process.stderr]]) stream.on('data', chunk => {
      output.write(chunk)
      startupLog = (startupLog + chunk.toString()).slice(-4000)
      if (startupLog.includes('Convex functions ready')) void restoreDeploymentSelection().catch(() => { console.error('Local deployment selection could not be restored; backend stopped safely.'); void stop(1) })
    })
    watcher.once('error', () => void stop(1)); watcher.once('exit', code => void stop(code ?? 1))
  }
} catch {
  console.error('Local backend setup stopped safely. Check the existing deployment, pinned binary and occupied ports. No data or keys were reset.')
  await stop(1)
}
