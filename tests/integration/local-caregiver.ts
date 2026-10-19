import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'
import { api, internal } from '../../convex/_generated/api.js'
import type { Id } from '../../convex/_generated/dataModel.js'
import type { PickupDraft } from '../../shared/daymark.js'

// These admin-only methods exist at runtime but are intentionally absent from
// the browser client's public declaration. Keep their use local to this fixture.
type LocalClient = ConvexHttpClient & {
  setAdminAuth(key: string, identity?: Record<string, string | boolean | undefined>): void
  query<Query extends FunctionReference<'query', 'internal'>>(query: Query, args: FunctionArgs<Query>): Promise<FunctionReturnType<Query>>
  mutation<Mutation extends FunctionReference<'mutation', 'internal'>>(mutation: Mutation, args: FunctionArgs<Mutation>): Promise<FunctionReturnType<Mutation>>
}
const localClient = (origin: string) => new ConvexHttpClient(origin) as LocalClient

// Opt-in, actual local Convex/workflow. No email, model or calendar provider calls.
assert.ok(process.argv.includes('--run'), 'Opt in with: node --import tsx tests/integration/local-caregiver.ts --run')
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const origin = 'http://127.0.0.1:3210'
assert.equal(config.ports.cloud, 3210)
assert.equal(await (await fetch(`${origin}/instance_name`)).text(), config.deploymentName)
const environment: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}` }
for (const key of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete environment[key]
const cli = (args: string[], input?: string) => {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { env: environment, encoding: 'utf8', timeout: 45000, ...(input === undefined ? {} : { input }) })
  assert.equal(result.status, 0, 'Local fixture command failed; output withheld.')
  return result.stdout.trim()
}
const read = (expression: string): any => JSON.parse(cli(['run', '--inline-query', expression]) || 'null')
const names = new Set(cli(['env', 'list', '--names-only']).split(/\r?\n/).map(s => s.trim()))
assert.ok(!names.has('DAYMARK_ENVIRONMENT') || cli(['env', 'get', 'DAYMARK_ENVIRONMENT']) !== 'production')
assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'), 'Synthetic cleanup must not contact Auth0.')
const priorAllowlist = names.has('DAYMARK_TEST_EMAIL_RECIPIENTS') ? cli(['env', 'get', 'DAYMARK_TEST_EMAIL_RECIPIENTS']) : undefined
const scratch = mkdtempSync(join(tmpdir(), 'sola-caregiver-')), suffix = randomUUID()
const admin = localClient(origin); admin.setAdminAuth(config.adminKey)
function actor(label: string, email?: string, emailVerified = true) {
  const subject = `synthetic-caregiver-${label}-${suffix}`, owner = `https://daymark-test.invalid|${subject}`
  const client = localClient(origin)
  client.setAdminAuth(config.adminKey, { subject, tokenIdentifier: owner, issuer: 'https://daymark-test.invalid', email, emailVerified })
  return { client, subject, owner, email }
}
const parent = actor('parent', `synthetic-parent-${suffix}@example.test`)
const alex = actor('alex', `synthetic-alex-${suffix}@example.test`), jordan = actor('jordan', `synthetic-jordan-${suffix}@example.test`)
const households: { id: Id<'households'>; client: ConvexHttpClient }[] = []
const existingHouseholds: string[] = read("return (await ctx.db.query('households').collect()).map(h=>h._id)")
const append = (table: string, record: unknown) => { const path = join(scratch, `${table}.json`); writeFileSync(path, JSON.stringify([record]), { mode: 0o600 }); cli(['import', '--append', '--table', table, path]) }
let allowlistChanged = false, parentHousehold: Id<'households'>, primary: Id<'caregivers'>, backup: Id<'caregivers'>
let deviceId = randomUUID(), calendarId = `synthetic-calendar-${suffix}`, calendarVersion = 1
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10)
async function draft(label: string, offset: number, changes: Partial<PickupDraft> = {}) {
  const sourceHash = `synthetic-caregiver-source-${suffix}-${label}`
  append('sources', { householdId: parentHousehold, text: 'Synthetic private parent source; never expose this to the caregiver.', hash: sourceHash, revision: 1, expiresAt: Date.now() + 30 * 86400_000 })
  const sourceId = read(`return (await ctx.db.query('sources').withIndex('by_hash',q=>q.eq('householdId',${JSON.stringify(parentHousehold)}).eq('hash',${JSON.stringify(sourceHash)})).unique())._id`)
  append('jobs', { householdId: parentHousehold, sourceId, createdBy: parent.owner, preparing: false, cancelled: false, clarification: 'Synthetic parent-reviewed pickup.' })
  const jobId: Id<'jobs'> = read(`return (await ctx.db.query('jobs').withIndex('by_source',q=>q.eq('sourceId',${JSON.stringify(sourceId)})).unique())._id`)
  const date = day(offset)
  const payload: PickupDraft = { kind: 'pickup', childId: 'maya', caregiverId: primary, date, time: '15:00', timezone: 'UTC', location: 'Synthetic north gate', deadline: `${date}T12:00:00Z`, message: 'Synthetic reviewed pickup request.', evidence: {}, ...changes }
  const actionId = await parent.client.mutation(api.jobs.addDraft, { jobId, payload })
  return { jobId, actionId, payload }
}
const action = async (jobId: Id<'jobs'>, actionId: Id<'actions'>) => (await parent.client.query(api.jobs.list, {})).find(j => j._id === jobId)!.actions.find(a => a._id === actionId)!
async function approve(id: Id<'actions'>, revision: number, conditional = false) {
  await parent.client.mutation(api.jobs.approve, { actions: [{ id, revision, deliveryChannel: 'app', ...(conditional ? { selectionVersion: 1, nativeCalendar: { calendarId, version: calendarVersion } } : {}) }] })
  const approval = (await admin.query(internal.execution.snapshot, { actionId: id }))!.approval!
  assert.equal(approval.toolName, 'caregiver.app.request'); assert.equal(approval.deliveryChannel, 'app')
  assert.ok(approval.recipientSubject === alex.owner || approval.recipientSubject === jordan.owner)
}
async function inbox(client: ConvexHttpClient, actionId: Id<'actions'>) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const arrangements = await parent.client.query(api.pickups.arrangements, {})
    const ids = new Set(arrangements.filter(r => r.actionId === actionId).map(r => r.id))
    const found = (await client.query(api.pickups.inbox, {})).find(r => ids.has(r.id))
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Bounded local in-app delivery did not finish; private output withheld.')
}
const respond = (client: ConvexHttpClient, request: { id: Id<'pickupRequests'>; revision: number }, response: 'accept' | 'decline' | 'suggest', suggestion = '') => client.mutation(api.pickups.respondInApp, { requestId: request.id, revision: request.revision, response, suggestion })
try {
  cli(['env', 'set', 'DAYMARK_TEST_EMAIL_RECIPIENTS'], [priorAllowlist, alex.email, jordan.email].filter(Boolean).join(',')); allowlistChanged = true
  for (const actor of [parent, alex, jordan]) {
    const id = await actor.client.mutation(api.households.save, { timezone: 'UTC', children: actor === parent ? [{ id: 'maya', name: 'Maya' }, { id: 'luca', name: 'Luca' }] : [] })
    households.push({ id, client: actor.client })
  }
  parentHousehold = households[0].id
  await alex.client.mutation(api.pickups.saveDeliverySettings, { channel: 'app' }); await jordan.client.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })
  primary = await parent.client.mutation(api.pickups.addCaregiver, { name: 'Synthetic Alex', email: alex.email!, childIds: ['maya', 'luca'] })
  backup = await parent.client.mutation(api.pickups.addCaregiver, { name: 'Synthetic Jordan', email: jordan.email!, childIds: ['maya', 'luca'] })
  const native = await parent.client.mutation(api.apple.register, { deviceId, calendarId, title: 'Synthetic pending calendar', account: 'Synthetic local calendar' }); calendarVersion = native.version
  await parent.client.mutation(api.connections.choose, { id: native.id, purpose: 'calendar', version: 0 })

  // Exact review plus a conditional native calendar step: acceptance queues it,
  // but the fixture never calls Apple claim/dispatch/finish or any provider.
  const firstDate = day(7)
  const first = await draft('accept', 7, { calendarUpdate: { kind: 'calendar', title: 'Synthetic pickup', childId: 'maya', date: firstDate, startTime: '14:45', endDate: firstDate, endTime: '15:15', allDay: false, timezone: 'UTC', location: 'Synthetic south gate', notes: '', targetId: null, evidence: {} } })
  await parent.client.mutation(api.jobs.edit, { actionId: first.actionId, revision: 1, payload: { ...first.payload, location: 'Synthetic south gate' } })
  await assert.rejects(() => approve(first.actionId, 1, true))
  await approve(first.actionId, 2, true); await approve(first.actionId, 2, true)
  const request = await inbox(alex.client, first.actionId)
  assert.equal(request.revision, 2); assert.equal(request.location, 'Synthetic south gate')
  assert.deepEqual(Object.keys(request).sort(), ['id', 'revision', 'child', 'date', 'time', 'timezone', 'location', 'message', 'deadline', 'reminder'].sort())
  assert.deepEqual(await alex.client.query(api.jobs.list, {}), []); assert.deepEqual(await jordan.client.query(api.pickups.inbox, {}), [])
  await assert.rejects(() => respond(parent.client, request, 'accept'))
  const activeConflict = await draft('active-conflict', 7, { caregiverId: backup, time: '15:10' })
  await assert.rejects(() => approve(activeConflict.actionId, 1))
  let firstJob = (await parent.client.query(api.jobs.list, {})).find(j => j._id === first.jobId)!
  assert.equal(firstJob.actions.find(a => a.dependsOn === first.actionId)!.status, 'waiting')
  await respond(alex.client, request, 'accept'); await assert.rejects(() => respond(alex.client, request, 'accept'))
  firstJob = (await parent.client.query(api.jobs.list, {})).find(j => j._id === first.jobId)!
  const accepted = firstJob.actions.find(a => a._id === first.actionId)!, conditional = firstJob.actions.find(a => a.dependsOn === first.actionId)!
  assert.equal(accepted.status, 'succeeded')
  assert.deepEqual(accepted.receipts.map(r => r.outcome).sort(), ['caregiver_accepted_not_pickup_completed', 'request_available_in_app'].sort())
  assert.equal(conditional.status, 'queued'); assert.deepEqual(conditional.receipts, [])
  assert.ok((await parent.client.query(api.apple.pending, { deviceId })).some(a => a.id === conditional._id))
  assert.deepEqual(await parent.client.query(api.jobs.plan, {}), [])
  assert.equal((await parent.client.query(api.pickups.arrangements, {})).find(r => r.id === request.id)!.status, 'accepted')
  await assert.rejects(() => parent.client.mutation(api.jobs.edit, { actionId: first.actionId, revision: 2, payload: first.payload }))
  const personConflict = await draft('person-conflict', 7, { childId: 'luca', time: '15:10' })
  await assert.rejects(() => approve(personConflict.actionId, 1))
  await assert.rejects(() => approve(activeConflict.actionId, 1))

  const suggested = await draft('suggest', 8); await approve(suggested.actionId, 1)
  const oldSuggestion = await inbox(alex.client, suggested.actionId)
  await respond(alex.client, oldSuggestion, 'suggest', 'Use the south gate at 16:00.')
  let current = await action(suggested.jobId, suggested.actionId)
  assert.equal(current.status, 'review'); assert.equal(current.revision, 2); assert.equal(current.payload.time, '15:00')
  assert.ok(!current.receipts.some(r => r.outcome === 'caregiver_accepted_not_pickup_completed'))
  await assert.rejects(() => respond(alex.client, oldSuggestion, 'accept'))
  await parent.client.mutation(api.jobs.edit, { actionId: suggested.actionId, revision: 2, payload: { ...suggested.payload, time: '16:00', location: 'Synthetic south gate' } })
  await assert.rejects(() => approve(suggested.actionId, 2)); await approve(suggested.actionId, 3)
  const revised = await inbox(alex.client, suggested.actionId)
  assert.equal(revised.revision, 3); assert.equal(revised.time, '16:00'); assert.equal(revised.location, 'Synthetic south gate')
  await respond(alex.client, revised, 'accept')

  const declined = await draft('decline', 9); await approve(declined.actionId, 1)
  const oldDecline = await inbox(alex.client, declined.actionId)
  await respond(alex.client, oldDecline, 'decline')
  current = await action(declined.jobId, declined.actionId)
  assert.equal(current.status, 'review'); assert.equal(current.revision, 2); assert.equal(current.payload.caregiverId, backup)
  assert.match(current.revisionNote!, /Nothing has been sent/)
  assert.deepEqual(await jordan.client.query(api.pickups.inbox, {}), [])
  await approve(declined.actionId, 2)
  const alternative = await inbox(jordan.client, declined.actionId)
  await assert.rejects(() => respond(alex.client, alternative, 'accept')); await respond(jordan.client, alternative, 'accept')

  const paused = await draft('paused-delivery', 10)
  await alex.client.mutation(api.pickups.saveDeliverySettings, { channel: 'email' })
  await assert.rejects(() => approve(paused.actionId, 1))
  assert.equal((await action(paused.jobId, paused.actionId)).status, 'review')
  await alex.client.mutation(api.pickups.saveDeliverySettings, { channel: 'app' }); await approve(paused.actionId, 1)
  const cancelled = await inbox(alex.client, paused.actionId)
  await parent.client.mutation(api.jobs.cancel, { jobId: paused.jobId })
  await assert.rejects(() => respond(alex.client, cancelled, 'accept'))
  assert.ok(!(await alex.client.query(api.pickups.inbox, {})).some(r => r.id === cancelled.id))

  const stale = await draft('eligibility', 11); await approve(stale.actionId, 1)
  const staleRequest = await inbox(alex.client, stale.actionId)
  await parent.client.mutation(api.pickups.updateCaregiver, { id: primary, name: 'Synthetic Alex', email: alex.email!, childIds: [] })
  await assert.rejects(() => respond(alex.client, staleRequest, 'accept'))
  await parent.client.mutation(api.pickups.updateCaregiver, { id: primary, name: 'Synthetic Alex', email: alex.email!, childIds: ['maya', 'luca'] })
  await assert.rejects(() => respond(alex.client, staleRequest, 'accept'))
  await assert.rejects(() => approve(stale.actionId, 1))

  const access = await draft('account-access', 12); await approve(access.actionId, 1)
  const accessRequest = await inbox(alex.client, access.actionId)
  for (const [email, verified] of [[alex.email, false], [`wrong-${suffix}@example.test`, true]] as const) {
    const changed = localClient(origin)
    changed.setAdminAuth(config.adminKey, { subject: alex.subject, tokenIdentifier: alex.owner, issuer: 'https://daymark-test.invalid', email, emailVerified: verified })
    assert.deepEqual(await changed.query(api.pickups.inbox, {}), []); await assert.rejects(() => respond(changed, accessRequest, 'accept'))
  }
  await alex.client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  assert.deepEqual(await alex.client.query(api.pickups.inbox, {}), []); await assert.rejects(() => respond(alex.client, accessRequest, 'accept'))
  assert.ok(!(await action(access.jobId, access.actionId)).receipts.some(r => r.outcome === 'caregiver_accepted_not_pickup_completed'))
  assert.deepEqual(await parent.client.query(api.jobs.plan, {}), [])
  const providerActions = (await parent.client.query(api.jobs.list, {})).flatMap(j => j.actions).filter(a => a.payload.kind !== 'pickup')
  assert.deepEqual(providerActions.map(a => [a.payload.kind, a.status, a.receipts.length]), [['calendar', 'queued', 0]])
  console.log('Synthetic caregiver runtime passed: exact reviewed in-app requests, authenticated accept/decline/suggest, conflict/access/replay guards, parent arrangement evidence, conditional calendar queued only. No email/model/calendar provider calls; Auth0 and email delivery not exercised.')
} finally {
  try {
    for (const account of households.reverse()) {
      const household = read(`return await ctx.db.get(${JSON.stringify(account.id)})`)
      if (!household) continue
      if (!household.deleted) await account.client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
      const deletion = read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(account.id)})).first()`)
      assert.ok(deletion, 'Synthetic cleanup journal is required.')
      for (let pass = 0; pass < 10 && read(`return await ctx.db.get(${JSON.stringify(account.id)})`); pass++) await admin.mutation(internal.privacy.eraseHousehold, { householdId: account.id, jobId: deletion._id })
      assert.equal(read(`return await ctx.db.get(${JSON.stringify(account.id)})`), null, 'Synthetic household cleanup did not complete.')
      await admin.mutation(internal.privacy.identityResult, { jobId: deletion._id, status: 'deleted' })
      assert.equal(read(`return await ctx.db.get(${JSON.stringify(deletion._id)})`), null, 'Synthetic deletion metadata cleanup did not complete.')
    }
    const remaining: string[] = read("return (await ctx.db.query('households').collect()).map(h=>h._id)")
    assert.ok(existingHouseholds.every(id => remaining.includes(id)), 'Pre-existing households must be preserved.')
  } finally {
    if (allowlistChanged) cli(priorAllowlist === undefined ? ['env', 'remove', 'DAYMARK_TEST_EMAIL_RECIPIENTS'] : ['env', 'set', 'DAYMARK_TEST_EMAIL_RECIPIENTS'], priorAllowlist)
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log('Synthetic caregiver cleanup complete; original data and recipient allowlist preserved. Google allowlist and model keys untouched.')
}
