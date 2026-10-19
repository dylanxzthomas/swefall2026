import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { createServer, normalizePath } from 'vite'

const project = fileURLToPath(new URL('../', import.meta.url))
const canary = 'synthetic-private-canary-for-http-regression'
const fsPath = path => '/@fs' + normalizePath(path)
function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    // http.request preserves traversal/encoding variants rather than normalizing
    // them as a URL or fetch client would. Actual credentials use HEAD only.
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { Accept: path === '/' ? 'text/html' : 'application/octet-stream' } }, res => {
      const chunks = []; let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 2_000_000) { req.destroy(new Error('HTTP fixture response exceeded its bound.')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, bytes, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('HTTP fixture request timed out.')))
    req.on('error', reject); req.end()
  })
}
async function fixture(run) {
  // macOS tmpdir aliases /private/var through /var. Match the real path used by
  // the config module URL rather than broadening the serving allow list.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sola dev server test-')))
  let server
  const put = async (path, value) => { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value) }
  const copy = async path => { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(project, path), target) }
  try {
    // Run the unchanged real configuration in an isolated tree. Its allow paths
    // are derived from import.meta.url, so no private repository root is allowed.
    await copy('vite.config.ts')
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
    await put('package.json', '{"type":"module"}')
    await copy('web/index.html'); await copy('shared/persona.ts'); await copy('convex/_generated/api.js')
    await put('web/src/main.tsx', "import { assistantName } from '../../shared/persona'; import { api } from '../../convex/_generated/api'; import '@fontsource-variable/geist'; document.querySelector('#root').textContent = assistantName({}) + Boolean(api);\n")
    for (const path of ['docs/MVP_BUILD_SPEC.md', 'docs/IPHONE.md', 'README.md', 'CHANGELOG.md']) await put(path, 'Public fixture documentation.')
    await put('docs/diagrams/public.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Public diagram</title></svg>')
    const privateFiles = [
      '.convex/local/default/config.json', '.env.local', 'docs/internal.json', 'server/private.json',
      'web/.convex/local/default/config.json', 'web/.CoNvEx/local/default/config.json',
      'web/.env', 'web/.ENV.local', 'web/.npmrc', 'web/.yarnrc.yml', 'web/test.key', 'web/test.P12',
      'shared/.git/config', 'shared/.vercel/project.json', 'shared/data/private.json',
      'web/native-artifacts/private.json', 'web/test-results/private.json', 'web/playwright-report/private.json',
      'convex/_generated/.env.local',
    ]
    for (const path of privateFiles) await put(path, canary)
    // Vite treats port=0 as its configured default. Reserve an ephemeral port
    // first and pass its nonzero number so this fixture never claims 5173/5174.
    const reservation = http.createServer()
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
    const port = reservation.address().port
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    server = await createServer({
      configFile: join(root, 'vite.config.ts'), root: join(root, 'web'), envDir: root, logLevel: 'silent', cacheDir: join(root, '.vite-cache'),
      // No browser, dependency prebundle, file watcher or upstream API request.
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null, preTransformRequests: false },
    })
    assert.equal(server.config.root, normalizePath(join(root, 'web')))
    assert.ok(server.config.server.fs.allow.includes(normalizePath(join(root, 'web'))), 'Copied config must allow its own disposable web root.')
    assert.equal(server.config.cacheDir, normalizePath(join(root, '.vite-cache')), 'Fixture must not share a live preview dependency cache.')
    await server.listen(port)
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    await run({ root, port: address.port, privateFiles, put })
  } finally {
    if (server) await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('real dev HTTP server confines file access while serving public browser imports and documentation', async t => fixture(async ({ root, port, privateFiles }) => {
  await t.test('serves app entry, shared module, generated API, dependency font and explicitly public docs', async () => {
    const publicPaths = [
      '/', '/src/main.tsx', fsPath(join(root, 'shared/persona.ts')),
      fsPath(join(root, 'shared/persona.ts')) + '?fixture=a%2Fb%5Cc',
      fsPath(join(root, 'convex/_generated/api.js')),
      fsPath(join(root, 'node_modules/@fontsource-variable/geist/index.css')),
      fsPath(join(root, 'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')),
      fsPath(join(root, 'docs/diagrams/public.svg')),
      ...['docs/MVP_BUILD_SPEC.md', 'docs/IPHONE.md', 'README.md', 'CHANGELOG.md'].map(path => fsPath(join(root, path))),
    ]
    for (const [index, path] of publicPaths.entries()) {
      const [pathname, query] = path.split('?')
      const response = await request(port, encodeURI(pathname) + (query ? '?' + query : ''))
      assert.equal(response.status, 200, `Intended public resource ${index} must remain available.`)
      assert.ok(response.bytes > 0)
      assert.ok(!response.text.includes(canary), 'Public response must not contain private canary data.')
    }
  })
  await t.test('blocks synthetic private files inside and outside otherwise allowed folders', async () => {
    for (const path of privateFiles) {
      const response = await request(port, encodeURI(fsPath(join(root, path))))
      assert.ok([400, 403, 404].includes(response.status), 'Private canary request must be denied.')
      assert.ok(!response.text.includes(canary), 'Private canary contents must never be served.')
    }
  })
  await t.test('blocks encoded, case, raw/import and traversal variants using synthetic data only', async () => {
    const target = fsPath(join(root, 'web/.convex/local/default/config.json'))
    const variants = [
      encodeURI(target), encodeURI(target).replace('.convex', '%2econvex'),
      encodeURI(target).replace('.convex/local', '.convex%2flocal'),
      encodeURI(target).replace('.convex/local', '.convex%2Flocal'),
      encodeURI(target).replace('.convex/local', '.convex%5clocal'),
      encodeURI(target).replace('.convex/local', '.convex%5Clocal'),
      encodeURI(target).replace('.convex', '.CoNvEx'),
      encodeURI(target).replace('/@fs/', '/@fs//'),
      encodeURI(fsPath(join(root, 'shared'))) + '/../web/.convex/local/default/config.json',
      encodeURI(fsPath(join(root, 'shared'))) + '/%2e%2e/web/.convex/local/default/config.json',
      '/.convex/local/default/config.json', '/%2econvex/local/default/config.json',
    ]
    const unexpected = []
    for (const [index, path] of variants.entries()) for (const suffix of ['', '?raw', '?url', '?import', '?raw&import', '?url&import']) {
      const response = await request(port, path + suffix)
      if (![400, 403, 404].includes(response.status)) unexpected.push({ variant: index, query: suffix, status: response.status })
      assert.ok(!response.text.includes(canary), 'Private path variant must not return canary contents.')
    }
    assert.deepEqual(unexpected, [], 'Every private path variant must receive a denied status.')
  })
  await t.test('uses body-free HEAD checks for actual project private paths, never credential GET requests', async () => {
    const actualPaths = [
      resolve(project, '.convex/local/default/config.json'), resolve(project, '.env'),
      resolve(project, '.env.local'), resolve(project, '.git/config'),
    ]
    for (const [index, path] of actualPaths.entries()) for (const suffix of ['', '?raw', '?url&import']) {
      const response = await request(port, encodeURI(fsPath(path)) + suffix, 'HEAD')
      assert.ok([400, 403, 404].includes(response.status), `Actual private HEAD ${index}${suffix}: HTTP ${response.status}; body bytes: ${response.bytes}.`)
      assert.equal(response.bytes, 0, 'Actual private path check must have no response body.')
    }
  })
}))
