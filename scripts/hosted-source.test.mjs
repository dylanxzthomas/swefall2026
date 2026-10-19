import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostedSource, stageHostedSource } from './hosted-source.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'sola-source-test-'))
  try {
    for (const path of ['web', 'convex', 'server/data', 'web/src', 'web/public']) await mkdir(join(root, path), { recursive: true })
    for (const path of ['package.json', 'package-lock.json', 'convex.json', 'vite.config.ts', 'vercel.json', 'tsconfig.json', 'tsconfig.server.json', 'web/index.html']) await writeFile(join(root, path), path.endsWith('.json') ? '{}' : '// synthetic')
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
test('includes only source/public assets and excludes credentials, local data and tests', async () => fixture(async root => {
  await writeFile(join(root, '.env.local'), 'synthetic private credential')
  await writeFile(join(root, 'convex/.env'), 'synthetic backend secret')
  await writeFile(join(root, 'server/data/private.ts'), 'synthetic private data')
  await writeFile(join(root, 'web/src/example.test.tsx'), 'synthetic fixture')
  await writeFile(join(root, 'web/src/app.tsx'), 'export default 1')
  await writeFile(join(root, 'web/public/avatar.svg'), '<svg/>')
  await writeFile(join(root, 'web/public/private.json'), '{"synthetic":"private"}')
  const snapshot = await hostedSource(root), paths = snapshot.files.map(f => f.file)
  assert.ok(paths.includes('web/src/app.tsx')); assert.ok(paths.includes('web/public/avatar.svg'))
  assert.ok(!paths.some(p => /\.env|private|\.test\./.test(p)))
  assert.equal((await hostedSource(root)).sourceSha256, snapshot.sourceSha256)
  await writeFile(join(root, 'web/src/app.tsx'), 'export default 2')
  assert.notEqual((await hostedSource(root)).sourceSha256, snapshot.sourceSha256)
}))
test('refuses credentials in otherwise eligible source without reflecting the value', async () => fixture(async root => {
  const value = 'sk-ant-' + 'synthetic'.repeat(4)
  await writeFile(join(root, 'web/src/app.tsx'), `const key = '${value}'`)
  await assert.rejects(hostedSource(root), error => error.message.includes('web/src/app.tsx') && !error.message.includes(value))
}))
test('refuses source symlinks rather than reading files outside the reviewed tree', async () => fixture(async root => {
  await symlink(join(root, '.env.local'), join(root, 'web/src/leak.ts'))
  await assert.rejects(hostedSource(root), /does not follow symlinks/)
}))
test('freezes only reviewed files and stamps public source identity without copying Git or settings', async () => fixture(async root => {
  const stageParent = await mkdtemp(join(tmpdir(), 'sola-stage-test-')), destination = join(stageParent, 'source')
  try {
    await writeFile(join(root, '.env.local'), 'synthetic credential')
    const base = await hostedSource(root), staged = await stageHostedSource(root, destination, { commit: 'a'.repeat(40), dirty: true, evaluatedModel: 'claude-sonnet-5-5' })
    assert.equal(staged.sourceSha256, base.sourceSha256)
    assert.equal(staged.files.length, base.files.length + 1)
    assert.ok(staged.files.some(file => file.file === 'source-version.json'))
    assert.ok(!staged.files.some(file => file.file.includes('.env') || file.file.startsWith('.git/')))
    await assert.rejects(stageHostedSource(root, destination, { commit: null, dirty: true }), /EEXIST/)
    await assert.rejects(stageHostedSource(root, join(root, 'stage'), { commit: null, dirty: true }), /outside the project/)
  } finally { await rm(stageParent, { recursive: true, force: true }) }
}))

test('refuses OpenAI project and service-account credentials without reflecting the value',async()=>fixture(async root=>{
 for(const prefix of ['sk-proj-','sk-svcacct-']){const value=prefix+'synthetic'.repeat(8);await writeFile(join(root,'web/src/key.ts'),`const key='${value}'`);await assert.rejects(hostedSource(root),error=>error.message.includes('web/src/key.ts')&&!error.message.includes(value))}
}))
