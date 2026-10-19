import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { ConvexHttpClient } from 'convex/browser'
import { ConvexError } from 'convex/values'
import { sourceHash } from '../../shared/daymark'

// Privileged imports are confined to the existing anonymous localhost deployment.
// Never use real inbox content, credentials, a live model, or provider actions here.
const environment = readFileSync('.env.local', 'utf8')
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
assert.match(environment, /^CONVEX_DEPLOYMENT=anonymous:/m)
assert.ok(environment.includes(`CONVEX_DEPLOYMENT=anonymous:${config.deploymentName}`), 'The local deployment does not match its configuration.')
assert.equal(config.ports.cloud, 3210, 'This fixture only runs on the preserved localhost backend.')
const childEnvironment: NodeJS.ProcessEnv = { ...process.env, CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}`, CONVEX_AGENT_MODE: 'anonymous' }
for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete childEnvironment[name]
const rawCli = (args: string[], input?: string) => {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { encoding: 'utf8', env: childEnvironment, ...(input === undefined ? {} : { input }), timeout: 45_000 })
  if (result.status !== 0) {
    // Environment commands can contain private values. Never echo their output.
    const detail = 'Local fixture operation failed; potentially private diagnostic output withheld.'
    throw new Error(detail || 'Local backend command failed.')
  }
  return result.stdout
}
const cli = (...args: string[]) => rawCli(args).trim()
const names = new Set(cli('env', 'list', '--names-only').split(/\r?\n/).map(s => s.trim()))
assert.ok(!names.has('ANTHROPIC_API_KEY') && !names.has('DAYMARK_MODEL'), 'This synthetic suite refuses a model-configured deployment.')
assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'), 'This synthetic suite refuses configured identity deletion credentials.')
const getEnv = (name: string) => rawCli(['env', 'get', name]).replace(/\r?\n$/, '')
assert.ok(!names.has('DAYMARK_ENVIRONMENT') || getEnv('DAYMARK_ENVIRONMENT') !== 'production', 'This suite must never run against a production environment.')
const allowlistName = 'DAYMARK_TEST_GOOGLE_EMAILS', hadAllowlist = names.has(allowlistName), originalAllowlist = hadAllowlist ? getEnv(allowlistName) : undefined
const suffix = randomUUID(), fixtureEmail = `private-mailbox-${suffix}@example.test`
const updatedAllowlist = `${originalAllowlist ? `${originalAllowlist},` : ''}${fixtureEmail}`
const setEnv = (name: string, value: string) => rawCli(['env', 'set', name], value)
const subject = `synthetic-mailbox-${suffix}`, secondAdult = `synthetic-mailbox-adult-${suffix}`, outsider = `synthetic-mailbox-outsider-${suffix}`
const identifier = (user: string) => `https://daymark-test.invalid|${user}`
const identity = (user: string) => JSON.stringify({ subject: user, issuer: 'https://daymark-test.invalid', tokenIdentifier: identifier(user), email: fixtureEmail, emailVerified: true })
const run = (fn: string, input: unknown, user?: string): any => {
  const output = cli('run', fn, JSON.stringify(input), ...(user ? ['--identity', identity(user)] : []))
  return output ? JSON.parse(output) : undefined
}
const rejects = async (fn: string, input: unknown, user: string, expected: RegExp) => {
  const client = new ConvexHttpClient('http://127.0.0.1:3210')
  client.setAdminAuth(config.adminKey, JSON.parse(identity(user)))
  await assert.rejects(() => client.mutation(fn as any, input as any), error =>
    error instanceof ConvexError && typeof error.data === 'string' && expected.test(error.data))
}
const read = (expression: string): any => { const output = cli('run', '--inline-query', expression); return output ? JSON.parse(output) : null }
const scratch = mkdtempSync(join(tmpdir(), 'daymark-private-mailbox-'))
const append = (table: string, record: unknown) => {
  const path = join(scratch, `${table}.json`)
  writeFileSync(path, JSON.stringify([record]), { mode: 0o600 })
  cli('import', '--append', '--table', table, path)
}
const households: Array<{ user: string; id: string }> = []
let allowlistChanged = false
try {
  allowlistChanged = true; setEnv(allowlistName, updatedAllowlist)
  const householdId: string = run('households:save', { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] }, subject)
  households.push({ user: subject, id: householdId })
  const outsideId: string = run('households:save', { timezone: 'UTC', children: [] }, outsider)
  households.push({ user: outsider, id: outsideId })
  append('memberships', { householdId, subject: identifier(secondAdult), role: 'adult' })
  // No cipher or token exists, even if an unexpected timer were to fire.
  append('connections', { householdId, subject: identifier(subject), provider: 'google', version: 1, status: 'active', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], email: fixtureEmail })
  const connectionId: string = run('connections:overview', {}, subject).items[0].id
  const accountKey = sourceHash(JSON.stringify([connectionId, fixtureEmail])), now = Date.now()
  append('mailboxes', { householdId, createdBy: identifier(subject), connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now, nextCheckAt: now + 86400_000 })
  const mailboxId: string = run('mailbox:settings', {}, subject).mailbox.id
  let nextRun = 0
  const seedRun = () => {
    const requestId = `synthetic-private-run-${suffix}-${++nextRun}`, lease = `synthetic-lease-${nextRun}`
    append('mailRuns', { householdId, createdBy: identifier(subject), mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey, requestId, requestHash: 'synthetic-fixture', request: 'Review synthetic private school correspondence.', kind: 'check', query: '', lookbackDays: 30, mode: 'baseline', scope: 'inbox', status: 'running', version: 1, scanned: 0, segmentScanned: 0, reservedReads: 10, reservationDay: Math.floor(now / 86400_000), from: now - 86400_000, through: now, createdAt: now, expiresAt: now + 86400_000, messageIds: [], hasMore: true, lease, leaseUntil: Date.now() + 120_000 })
    const row = read(`return await ctx.db.query('mailRuns').withIndex('by_request',q=>q.eq('householdId',${JSON.stringify(householdId)}).eq('createdBy',${JSON.stringify(identifier(subject))}).eq('requestId',${JSON.stringify(requestId)})).unique()`)
    assert.ok(row, 'The synthetic run was not persisted.')
    return { id: row._id as string, version: 1, lease }
  }
  const message = { providerId: `synthetic-message-${suffix}`, threadId: 'synthetic-private-thread', sender: 'school@example.test', subject: 'Synthetic private trip form', receivedAt: now - 1000, text: 'Please return Maya’s signed form by October 20. Private note: call Elaine about the synthetic pickup change.', extraction: { format: 'plain', truncated: false, incomplete: false, attachments: false, issues: [] }, labels: ['INBOX'] }
  const first = seedRun()
  assert.equal(run('mailbox:finishBatch', { ...first, messages: [message], removedIds: [], processed: 1, baselineHistoryId: '100' }), true)
  assert.equal(run('mailbox:finishBatch', { ...first, messages: [message], removedIds: [], processed: 1 }), false, 'A completed page must not be applied twice.')
  let privateMessage = run('mailbox:messages', {}, subject)[0]
  assert.equal(privateMessage.subject, message.subject); assert.equal(privateMessage.text, message.text); assert.equal(privateMessage.version, 1)
  assert.equal(run('mailbox:runs', {}, subject).length, 1)
  const privateSource = read(`return await ctx.db.get(${JSON.stringify(privateMessage.id)})`)
  // Explicit fixture draft, not model output or a provider-created draft.
  append('mailDrafts', { householdId, createdBy: identifier(subject), mailboxId, messageId: privateMessage.id, sourceVersion: 1, sourceHash: privateSource.contentHash, connectionId, connectionVersion: 1, accountKey, accountEmail: fixtureEmail, version: 1, input: { to: message.sender, subject: `Re: ${message.subject}`, body: 'Synthetic private draft: I will return the form.' }, instruction: 'Synthetic fixture only.', preparationKey: `synthetic-${suffix}`, status: 'review', createdAt: now, expiresAt: now + 86400_000 })
  const draft = run('mailDrafts:list', {}, subject)[0]
  assert.equal(draft.status, 'review'); assert.equal(draft.gmailDraftId, undefined)
  for (const user of [secondAdult, outsider]) {
    assert.deepEqual(run('mailbox:messages', {}, user), [])
    assert.deepEqual(run('mailbox:runs', {}, user), [])
    assert.deepEqual(run('mailDrafts:list', {}, user), [])
    await rejects('mailbox:shareMessage', { id: privateMessage.id, version: 1, text: 'Unauthorized sharing', consent: true }, user, /unavailable/)
    await rejects('mailDrafts:edit', { id: draft.id, version: 1, input: { to: message.sender, subject: 'Changed', body: 'Unauthorized' } }, user, /unavailable/)
  }
  assert.deepEqual(run('jobs:list', {}, subject), []); assert.deepEqual(run('jobs:list', {}, secondAdult), [])
  const second = seedRun()
  assert.equal(run('mailbox:finishBatch', { ...second, messages: [message], removedIds: [], processed: 1 }), true)
  assert.equal(run('mailbox:messages', {}, subject).length, 1, 'Re-reading a provider message must not create a duplicate.')
  assert.equal(run('mailbox:messages', {}, subject)[0].version, 1)
  const third = seedRun(), revised = { ...message, text: message.text.replace('October 20', 'October 21') }
  assert.equal(run('mailbox:finishBatch', { ...third, messages: [revised], removedIds: [], processed: 1 }), true)
  privateMessage = run('mailbox:messages', {}, subject)[0]
  assert.equal(privateMessage.version, 2); assert.equal(privateMessage.text, revised.text)
  await rejects('mailbox:shareMessage', { id: privateMessage.id, version: 1, text: 'Stale sharing', consent: true }, subject, /changed/)
  await rejects('mailbox:dismissMessage', { id: privateMessage.id, version: 1, dismissed: true }, subject, /changed/)
  assert.deepEqual(run('jobs:list', {}, secondAdult), [])

  const reviewedText = 'Help me prepare an unfinished family task: return Maya’s synthetic form by October 21.'
  const sharedJobId: string = run('mailbox:shareMessage', { id: privateMessage.id, version: 2, text: reviewedText, consent: true }, subject)
  assert.equal(run('mailbox:shareMessage', { id: privateMessage.id, version: 2, text: reviewedText, consent: true }, subject), sharedJobId)
  await rejects('mailbox:shareMessage', { id: privateMessage.id, version: 2, text: 'A different unreviewed request', consent: true }, subject, /already shared/)
  let shared: any[] = []
  for (let n = 0; n < 20; n++) {
    shared = run('jobs:list', {}, secondAdult)
    if (shared[0] && !shared[0].preparing) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(shared.length, 1); assert.equal(shared[0]._id, sharedJobId)
  assert.equal(shared[0].source.text, reviewedText); assert.equal(shared[0].preparing, false); assert.deepEqual(shared[0].actions, [])
  assert.match(shared[0].clarification, /not connected/)
  assert.ok(!JSON.stringify(shared).includes('Private note:'), 'Sharing must include only the reviewed edit, never the raw private message.')
  assert.ok(!JSON.stringify(shared).includes('Synthetic private draft:'), 'Private draft content must stay out of household jobs.')
  assert.deepEqual(run('jobs:list', {}, outsider), [])
  assert.deepEqual(run('mailbox:messages', {}, secondAdult), []); assert.deepEqual(run('mailbox:runs', {}, secondAdult), []); assert.deepEqual(run('mailDrafts:list', {}, secondAdult), [])
  assert.deepEqual(read(`return await ctx.db.query('approvals').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()`), [])

  const interrupted = seedRun()
  run('mailbox:setPaused', { id: mailboxId, version: 1, paused: true }, subject)
  assert.equal(run('mailbox:permitted', interrupted), false)
  assert.equal(run('mailbox:finishBatch', { ...interrupted, messages: [{ ...message, providerId: 'late-private-fixture' }], removedIds: [], processed: 1 }), false)
  await rejects('mailbox:shareMessage', { id: privateMessage.id, version: 2, text: reviewedText, consent: true }, subject, /paused|disconnected/)
  run('mailbox:remove', { id: mailboxId, version: 2 }, subject)
  assert.deepEqual(run('mailbox:messages', {}, subject), []); assert.deepEqual(run('mailbox:runs', {}, subject), []); assert.deepEqual(run('mailDrafts:list', {}, subject), [])
  run('mailbox:eraseMailbox', { id: mailboxId })
  run('mailbox:eraseMailbox', { id: mailboxId })
  for (const table of ['mailMessages', 'mailRuns', 'mailDrafts']) assert.deepEqual(read(`return await ctx.db.query('${table}').withIndex('by_household',q=>q.eq('householdId',${JSON.stringify(householdId)})).collect()`), [])
  assert.equal(run('jobs:list', {}, secondAdult)[0].source.text, reviewedText, 'Explicitly shared work survives removing its private mailbox history.')
} finally {
  const cleanupErrors: unknown[] = []
  for (const { user, id } of households) {
    try {
      run('privacy:deleteAccount', { confirmation: 'DELETE' }, user)
      const deletion = read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(id)})).first()`)
      if (deletion) {
        // These synthetic subjects never existed in Auth0; do not leave retry jobs.
        run('privacy:identityResult', { jobId: deletion._id, status: 'deleted' })
        run('privacy:eraseHousehold', { householdId: id, jobId: deletion._id })
      }
      assert.equal(read(`return await ctx.db.get(${JSON.stringify(id)})`), null)
    } catch (error) { cleanupErrors.push(error) }
  }
  try {
    if (allowlistChanged) {
      const current = getEnv(allowlistName)
      if (current === updatedAllowlist) {
        if (hadAllowlist) setEnv(allowlistName, originalAllowlist!)
        else cli('env', 'remove', allowlistName)
      } else {
        // Preserve independent changes made while this check was running.
        const remaining = current.split(',').filter(value => value.trim().toLowerCase() !== fixtureEmail).join(',')
        if (remaining || hadAllowlist) setEnv(allowlistName, remaining)
        else cli('env', 'remove', allowlistName)
      }
    }
  } catch (error) { cleanupErrors.push(error) }
  rmSync(scratch, { recursive: true, force: true })
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic fixture cleanup did not finish; inspect only this suite’s fixture households and allowlist addition.')
}
console.log('Local Convex private mailbox passed: persisted private messages and draft fixtures, same-household adult/outsider isolation, duplicate reads, source revisions, exact edited sharing, paused late-result rejection, and private history cleanup. Temporary fixtures and allowlist changes were removed. No Gmail, live model, draft-save or other provider call was performed.')
