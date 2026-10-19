import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { api, internal } from '../../convex/_generated/api.js'
import type { Id } from '../../convex/_generated/dataModel.js'
import { sourceHash } from '../../shared/daymark.js'
import { gmailReadScope } from '../../shared/emailWatches.js'

// Actual model and durable local workers, with made-up messages only. The
// connection has no provider token, so this fixture cannot contact Gmail.
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const origin = 'http://127.0.0.1:3210'
assert.equal(config.ports.cloud, 3210)
assert.equal(await (await fetch(`${origin}/instance_name`)).text(), config.deploymentName)
const environment: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}` }
for (const key of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete environment[key]
function cli(args: string[], input?: string) {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { env: environment, encoding: 'utf8', timeout: 45000, ...(input === undefined ? {} : { input }) })
  assert.equal(result.status, 0, 'Local fixture command failed; potentially private output withheld.')
  return result.stdout.trim()
}
const names = new Set(cli(['env', 'list', '--names-only']).split(/\r?\n/).map(s => s.trim()))
assert.ok(names.has('ANTHROPIC_API_KEY') && names.has('DAYMARK_MODEL'), 'Configure the model before this synthetic evaluation.')
assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'), 'Fixture cleanup must not contact Auth0.')
assert.ok(!names.has('DAYMARK_ENVIRONMENT') || cli(['env', 'get', 'DAYMARK_ENVIRONMENT']) !== 'production')
const suffix = randomUUID(), email = `synthetic-routine-${suffix}@example.test`, subject = `synthetic-routine-${suffix}`, owner = `https://daymark-test.invalid|${subject}`
const oldAllowlist = cli(['env', 'get', 'DAYMARK_TEST_GOOGLE_EMAILS'])
const scratch = mkdtempSync(join(tmpdir(), 'sola-mail-routine-'))
// Only this isolated evaluation uses the local backend's undeclared admin API.
type LocalClient = ConvexHttpClient & { setAdminAuth(key: string, identity?: Record<string, string | boolean>): void }
type LocalAdmin = LocalClient & { mutation<Args extends Record<string, any>, Result>(reference: FunctionReference<'mutation', 'internal', Args, Result>, args: Args): Promise<Result> }
const client = new ConvexHttpClient(origin) as LocalClient, admin = new ConvexHttpClient(origin) as LocalAdmin, other = new ConvexHttpClient(origin) as LocalClient
client.setAdminAuth(config.adminKey, { subject, tokenIdentifier: owner, issuer: 'https://daymark-test.invalid', email, emailVerified: true })
admin.setAdminAuth(config.adminKey)
other.setAdminAuth(config.adminKey, { subject: `${subject}-other`, tokenIdentifier: `${owner}-other`, issuer: 'https://daymark-test.invalid' })
const read = (expression: string) => JSON.parse(cli(['run', '--inline-query', expression]))
function append(table: string, record: unknown) {
  const path = join(scratch, `${table}.json`)
  writeFileSync(path, JSON.stringify([record]), { mode: 0o600 })
  cli(['import', '--append', '--table', table, path])
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let householdId: Id<'households'> | undefined, allowlistChanged = false, stage = 'isolation'
const diagnostic: { curationStatus?: string; candidateKinds?: string[]; failureCode?: string } = {}
const priorHouseholds = read('return (await ctx.db.query("households").collect()).map(h => h._id).sort()') as string[]
try {
  cli(['env', 'set', 'DAYMARK_TEST_GOOGLE_EMAILS'], `${oldAllowlist},${email}`); allowlistChanged = true
  householdId = await client.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  append('memberships', { householdId, subject: `${owner}-other`, role: 'adult' })
  stage = 'source-grounded process recognition'
  const text = 'Whenever a new school email asks for a field-trip permission form, prepare a short reply asking whether electronic signatures are accepted. Please suggest this as one reusable private email routine for my review, not a scheduled routine or permission to send.'
  const now = Date.now()
  append('sources', { householdId, text, hash: sourceHash(text), revision: 1, expiresAt: now + 86400_000 })
  const sourceId = read(`return (await ctx.db.query('sources').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).first())._id`) as Id<'sources'>
  append('jobs', { householdId, sourceId, createdBy: owner, preparing: false, cancelled: false, conversation: true, clarification: 'Synthetic routine review.' })
  const jobId = read(`return (await ctx.db.query('jobs').withIndex('by_household',q=>q.eq('householdId',${JSON.stringify(householdId)})).first())._id`) as Id<'jobs'>
  const curationId = await client.mutation(api.learnedWorkflows.request, { jobId, sourceRevision: 1 })
  stage = 'curator completion'
  const curationDeadline = Date.now() + 150000
  let curation: { status: string; failureCode?: string }
  do { await wait(500); curation = read(`return await ctx.db.get(${JSON.stringify(curationId)})`) } while (!['complete', 'failed', 'cancelled'].includes(curation.status) && Date.now() < curationDeadline)
  diagnostic.curationStatus = curation.status
  diagnostic.failureCode = curation.failureCode
  assert.equal(curation.status, 'complete', 'Actual model did not complete the process proposal; content withheld.')
  stage = 'email process candidate'
  const candidates = await client.query(api.learnedWorkflows.list, {})
  diagnostic.candidateKinds = candidates.map(c => c.kind)
  const proposal = candidates.find(p => p.kind === 'mail_routine')
  assert.ok(proposal, 'The model did not propose the explicitly requested email routine.')
  assert.deepEqual(await other.query(api.learnedWorkflows.list, {}), [])
  stage = 'private parent approval'
  const saved = await client.mutation(api.learnedWorkflows.approve, { id: proposal._id as Id<'learnedWorkflows'>, version: proposal.version, value: proposal.value, shareConfirmed: false })
  assert.ok(saved.mailRoutineId)
  const routineId = saved.mailRoutineId
  let routine = (await client.query(api.mailRoutines.list, {})).find(r => r.id === routineId)!
  assert.equal(routine.state, 'paused')
  assert.deepEqual(await other.query(api.mailRoutines.list, {}), [])
  console.log('Actual model proposed the explicit email process; parent review saved it privately and paused, with no mailbox grant.')

  stage = 'activation and private source preparation'
  append('connections', { householdId, subject: owner, provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email })
  const connectionId = (await client.query(api.connections.overview, {})).items[0].id as Id<'connections'>
  const accountKey = sourceHash(JSON.stringify([connectionId, email]))
  append('mailboxes', { householdId, createdBy: owner, connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: Date.now(), createdAt: Date.now(), nextCheckAt: Date.now() + 86400_000 })
  const mailboxId = (await client.query(api.mailbox.settings, {})).mailbox!.id as Id<'mailboxes'>
  await client.mutation(api.mailRoutines.setPaused, { id: routineId, version: routine.version, paused: false })
  routine = (await client.query(api.mailRoutines.list, {})).find(r => r.id === routineId)!
  assert.equal(routine.state, 'active')
  await wait(10)
  const body = 'Maya’s class is visiting the museum on November 3, 2026. Return the signed field-trip permission form by October 23, 2026. Reply to this school address with any questions.'
  const message = { providerId: `form-${suffix}`, threadId: `form-thread-${suffix}`, sender: 'school@example.test', subject: 'Synthetic permission form', receivedAt: Date.now(), text: body, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'] }
  append('mailMessages', { ...message, householdId, createdBy: owner, mailboxId, connectionId, connectionVersion: 1, accountKey, version: 1, contentHash: sourceHash(JSON.stringify(message)), expiresAt: now + 86400_000, dismissed: false })
  const m = (await client.query(api.mailbox.messages, {})).find(m => m.receivedAt === message.receivedAt)!
  await wait(10)
  const newsletter = { ...message, providerId: `newsletter-${suffix}`, threadId: `newsletter-thread-${suffix}`, sender: 'newsletter@example.test', subject: 'Synthetic community news', receivedAt: Date.now(), text: 'The community newsletter has a new design. Enjoy these photos from last month. No forms, replies or other action are needed.' }
  append('mailMessages', { ...newsletter, householdId, createdBy: owner, mailboxId, connectionId, connectionVersion: 1, accountKey, version: 1, contentHash: sourceHash(JSON.stringify(newsletter)), expiresAt: now + 86400_000, dismissed: false })
  const unrelated = (await client.query(api.mailbox.messages, {})).find(m => m.receivedAt === newsletter.receivedAt)!
  const run = { householdId, createdBy: owner, mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey, requestId: `poll:synthetic-${suffix}`, requestHash: 'synthetic', request: 'Check new email and apply my saved preparation routines when relevant.', kind: 'check', query: '', lookbackDays: 30, mode: 'baseline', scope: 'inbox', updateCheckpoint: true, quiet: true, status: 'complete', version: 1, scanned: 2, segmentScanned: 2, from: routine.activatedAt!, through: Date.now(), createdAt: Date.now(), expiresAt: now + 86400_000, messageIds: [m.id, unrelated.id], hasMore: false }
  append('mailRuns', run)
  const runId = read(`return (await ctx.db.query('mailRuns').withIndex('by_request',q=>q.eq('householdId',${JSON.stringify(householdId)}).eq('createdBy',${JSON.stringify(owner)}).eq('requestId',${JSON.stringify(run.requestId)})).unique())._id`) as Id<'mailRuns'>
  const refs = [{ id: m.id as Id<'mailMessages'>, version: m.version, hash: sourceHash(JSON.stringify(message)) }, { id: unrelated.id as Id<'mailMessages'>, version: unrelated.version, hash: sourceHash(JSON.stringify(newsletter)) }]
  const agentId = await admin.mutation(internal.mailFollowthrough.start, { runId, runVersion: 1, sources: refs })
  assert.ok(agentId)
  const deadline = Date.now() + 180000
  let agent: { status: string; step: number; attempts: number }
  do { await wait(500); agent = read(`return await ctx.db.get(${JSON.stringify(agentId)})`) } while (!['complete', 'failed', 'cancelled'].includes(agent.status) && Date.now() < deadline)
  assert.equal(agent.status, 'complete', 'Actual model did not finish routine preparation; content withheld.')
  assert.ok(agent.step <= 4 && agent.attempts <= 6)
  const prepared = (await client.query(api.mailFollowthrough.list, {})).filter(p => p.runId === runId)
  const reply = prepared.find(p => p.kind === 'reply')
  assert.ok(reply && /electronic|digital|e.signature/i.test(reply.replyBody), 'Prepared reply did not use the saved routine instruction.')
  assert.equal(reply.messageId, m.id)
  const history = await client.query(api.mailRoutines.history, { id: routineId })
  assert.equal(history.filter(h => h.status === 'prepared').length, 1)
  assert.deepEqual(await other.query(api.mailFollowthrough.list, {}), [])
  await assert.rejects(() => other.query(api.mailRoutines.history, { id: routineId }))
  assert.equal(await admin.mutation(internal.mailFollowthrough.start, { runId, runVersion: 1, sources: refs }), agentId)
  assert.equal((await client.query(api.mailRoutines.history, { id: routineId })).length, history.length)
  await client.mutation(api.mailRoutines.setPaused, { id: routineId, version: routine.version, paused: true })
  await assert.rejects(() => client.mutation(api.mailFollowthrough.reviewReply, { id: reply.id as Id<'mailProposals'>, version: reply.version }))
  for (const table of ['actions', 'approvals', 'attempts', 'mailDrafts', 'planEvents', 'privateTasks'] as const) {
    assert.equal(read(`return (await ctx.db.query(${JSON.stringify(table)}).filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()).length`), 0)
  }
  console.log(`Actual model/durable worker followed the saved email instruction in ${agent.step} step(s), while unrelated mail did not trigger it; duplicate preparation coalesced, another adult was denied and pause blocked stale review. No Gmail/calendar calls or writes.`)
} catch {
  console.log(JSON.stringify({ syntheticOnlyDiagnostic: true, stage, ...diagnostic }))
  throw new Error(`Synthetic email-routine evaluation failed during ${stage}; private diagnostics withheld.`)
} finally {
  try {
    if (householdId) {
      await client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
      const job = read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).first()`)
      if (job) await admin.mutation(internal.privacy.eraseHousehold, { householdId, jobId: job._id })
      for (const table of ['mailRoutines', 'mailRoutineDecisions'] as const) assert.equal(read(`return (await ctx.db.query(${JSON.stringify(table)}).withIndex('by_household',q=>q.eq('householdId',${JSON.stringify(householdId)})).collect()).length`), 0)
    }
  } finally {
    if (allowlistChanged) cli(['env', 'set', 'DAYMARK_TEST_GOOGLE_EMAILS'], oldAllowlist)
    rmSync(scratch, { recursive: true, force: true })
  }
  const surviving = read('return (await ctx.db.query("households").collect()).map(h => h._id).sort()') as string[]
  assert.deepEqual(surviving, priorHouseholds, 'Original households must be preserved after synthetic cleanup.')
}
