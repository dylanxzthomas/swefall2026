import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceVersion } from './release-metadata.mjs'

const rootFiles = ['package.json', 'package-lock.json', 'convex.json', 'vite.config.ts', 'vercel.json', 'tsconfig.json', 'tsconfig.server.json', 'web/index.html']
const codeRoots = ['convex', 'shared', 'server', 'web/src', 'scripts']
const codeExtensions = /\.(?:ts|tsx|js|mjs|css)$/
const publicExtensions = /\.(?:svg|png|webp|jpe?g|gif|woff2?|ico)$/
const forbiddenContent = [/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/, /sk-ant-[\w-]{20,}/, /GOCSPX-[\w-]{15,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /(?:prod|dev|preview):[\w:-]+\|[\w-]{32,}/]
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex')

/** Read-only source snapshot; never follows symlinks or includes local data/settings. */
export async function hostedSource(root) {
  root = resolve(root)
  const files = []
  let totalBytes = 0
  async function include(path) {
    const full = join(root, path), stat = await lstat(full)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Hosted source must be a regular file: ${path}`)
    if (stat.size > 5 * 1024 * 1024) throw new Error(`Hosted source file exceeds its review limit: ${path}`)
    const bytes = await readFile(full)
    if (/\.(?:ts|tsx|js|mjs|json|html|css|svg)$/.test(path) && forbiddenContent.some(pattern => pattern.test(bytes.toString('utf8')))) throw new Error(`Possible credential in hosted source; review this file without printing it: ${path}`)
    totalBytes += bytes.length
    if (totalBytes > 15 * 1024 * 1024) throw new Error('Hosted source exceeds the reviewed snapshot size limit.')
    files.push({ file: path, sha: digest(bytes, 'sha1'), size: bytes.length })
  }
  async function walk(path, publicFiles = false) {
    const stat = await lstat(join(root, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error(`Hosted source does not follow symlinks: ${path}`)
    if (!stat.isDirectory()) throw new Error(`Expected a source directory: ${path}`)
    for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'data', 'fixtures', 'test-results', 'native-artifacts'].includes(entry.name)) continue
      const child = `${path}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Hosted source does not follow symlinks: ${child}`)
      if (entry.isDirectory()) await walk(child, publicFiles)
      else if (entry.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && (publicFiles ? publicExtensions : codeExtensions).test(entry.name)) await include(child)
    }
  }
  for (const path of rootFiles) await include(path)
  for (const path of codeRoots) await walk(path)
  await walk('web/public', true)
  files.sort((a, b) => a.file.localeCompare(b.file))
  return { files, totalBytes, sourceSha256: digest(JSON.stringify(files), 'sha256') }
}

/** Freeze the reviewed source and attach its public identity, never .git or .env. */
export async function stageHostedSource(root, destination, identity) {
  root = resolve(root); destination = resolve(destination)
  if (!relative(root, destination).startsWith('..')) throw new Error('Stage hosted source outside the project to preserve the working tree.')
  const snapshot = await hostedSource(root)
  const metadata = sourceVersion({ version: 1, commit: identity.commit, dirty: identity.dirty, evaluatedModel: identity.evaluatedModel ?? null, sourceSha256: snapshot.sourceSha256 })
  await mkdir(destination, { mode: 0o700 }) // Refuse an existing destination.
  try {
    for (const file of snapshot.files) {
      const source = join(root, file.file), stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('A source file changed during snapshot creation.')
      const bytes = await readFile(source)
      if (digest(bytes, 'sha1') !== file.sha || bytes.length !== file.size) throw new Error('A source file changed during snapshot creation.')
      await mkdir(dirname(join(destination, file.file)), { recursive: true, mode: 0o700 })
      await writeFile(join(destination, file.file), bytes, { mode: 0o600, flag: 'wx' })
    }
    const bytes = Buffer.from(JSON.stringify(metadata) + '\n'), file = { file: 'source-version.json', sha: digest(bytes, 'sha1'), size: bytes.length }
    await writeFile(join(destination, file.file), bytes, { mode: 0o600, flag: 'wx' })
    return { ...snapshot, files: [...snapshot.files, file].sort((a, b) => a.file.localeCompare(b.file)), totalBytes: snapshot.totalBytes + bytes.length }
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--manifest' || !args[1]) throw new Error('Use hosted-source --manifest <private manifest path>. This command never deploys.')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const snapshot = await hostedSource(root)
  await writeFile(resolve(args[1]), JSON.stringify(snapshot), { mode: 0o600 })
  console.log(JSON.stringify({ files: snapshot.files.length, bytes: snapshot.totalBytes, sourceSha256: snapshot.sourceSha256 }))
}
