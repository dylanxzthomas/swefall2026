import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from '../../convex/_generated/api.js'

// Real durable turns and model calls; never a real user's identity or mailbox.
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
assert.equal(config.ports.cloud, 3210)
assert.match(readFileSync('.env.local', 'utf8'), /^VITE_CONVEX_URL=http:\/\/127\.0\.0\.1:3210$/m)
assert.equal(await (await fetch('http://127.0.0.1:3210/instance_name')).text(), config.deploymentName)
const environment: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}` }
for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete environment[name]
const env = (...args: string[]) => {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', 'env', ...args], { env: environment, encoding: 'utf8', timeout: 45000 })
  assert.equal(result.status, 0, 'Local configuration check failed; private output withheld.')
  return result.stdout.trim()
}
const names = new Set(env('list', '--names-only').split(/\r?\n/).map(s => s.trim()))
assert.ok(names.has('ANTHROPIC_API_KEY') && names.has('DAYMARK_MODEL'), 'Configure the backend model before this live synthetic test.')
assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'), 'Fixture cleanup must not contact Auth0.')
assert.ok(!names.has('DAYMARK_ENVIRONMENT') || env('get', 'DAYMARK_ENVIRONMENT') !== 'production')
const subject = `synthetic-conversation-${randomUUID()}`
const identity = { subject, issuer: 'https://daymark-test.invalid', tokenIdentifier: `https://daymark-test.invalid|${subject}`, email: `${subject}@example.test`, emailVerified: true }
const connect = () => {
  const client = new ConvexHttpClient('http://127.0.0.1:3210')
  client.setAdminAuth(config.adminKey, identity)
  return client
}
const scratch = mkdtempSync(join(tmpdir(), 'sola-working-memory-'))
const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', ...args], { env: environment, encoding: 'utf8', timeout: 45000 })
  assert.equal(r.status, 0, 'Synthetic fixture command failed; private output withheld.')
  return r.stdout.trim()
}
const append = (table: string, records: unknown[]) => { const path = join(scratch, table + '.json'); writeFileSync(path, JSON.stringify(records), { mode: 0o600 }); cli(['import', '--append', '--table', table, path]) }
const read = (expression: string) => JSON.parse(cli(['run', '--inline-query', expression]))
let client = connect(), householdId: string | undefined
const admin = new ConvexHttpClient('http://127.0.0.1:3210'); admin.setAdminAuth(config.adminKey)
try {
  householdId = await client.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const turn = async (text: string) => {
    const id = await client.mutation(api.jobs.submit, { text })
    const context = await admin.query(internal.jobs.context, { jobId: id })
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const job = (await client.query(api.jobs.list, {})).find(j => j._id === id)
      if (job && !job.preparing) {
        assert.equal(job.conversation, true, 'Discussion must stay in chat.')
        assert.equal(job.actions.length, 0, 'Discussion must not create work.')
        console.log(JSON.stringify({ request: text, historyTurns: context?.assistant?.history.length, reply: job.clarification }))
        return { job, context }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Synthetic conversation did not finish within its bounded wait.')
  }
  const first = await turn('what should I order for dinner')
  const second = await turn('just in general')
  assert.equal(second.context?.assistant?.history.at(-1)?.request, 'what should I order for dinner')
  assert.equal(second.context?.assistant?.history.at(-1)?.response, first.job.clarification)
  assert.match(second.job.clarification, /dinner|pizza|pasta|tacos|curry|takeout|stir.fry|bowl|sushi/i, 'Follow-up must continue dinner, not ask for a new task.')
  // New client, same signed-in identity: continuity comes from the database.
  client = connect()
  const third = await turn('make those vegetarian')
  assert.equal(third.context?.assistant?.history.length, 2)
  assert.match(third.job.clarification, /vegetarian|veggie|vegetable|bean|tofu|lentil|chickpea|mushroom/i)
  assert.deepEqual(await client.query(api.personalTasks.list, {}), [])
  console.log('Live local conversation passed: dinner follow-up, correction and fresh-client continuity; no work or provider actions created.')
  const rows = Array.from({ length: 15 }, (_, i) => ({ householdId, text: i === 0 ? 'My go-to quick dinner is vegetarian fried rice.' : `A synthetic completed conversation about household organization ${i}.`, revision: 1, hash: `working-memory-${subject}-${i}`, expiresAt: Date.now() + 86400_000 }))
  append('sources', rows)
  const sourceIds = read(`return (await ctx.db.query('sources').filter(q => q.eq(q.field('householdId'), ${JSON.stringify(householdId)})).collect()).filter(s => s.hash.startsWith(${JSON.stringify('working-memory-' + subject + '-')})).map(s => s._id)`)
  assert.equal(sourceIds.length, 15)
  append('jobs', sourceIds.map((sourceId: string) => ({ householdId, sourceId, createdBy: identity.tokenIdentifier, interactive: true, conversation: true, preparing: false, cancelled: false, clarification: 'A synthetic completed reply.' })))
  const latestId = read(`return (await ctx.db.query('jobs').withIndex('by_creator', q => q.eq('householdId', ${JSON.stringify(householdId)}).eq('createdBy', ${JSON.stringify(identity.tokenIdentifier)})).order('desc').first())._id`)
  // Contend over the actual database lease; only its winner may call the model.
  await Promise.all(Array.from({ length: 50 }, () => admin.action(internal.workingMemoryWorker.refresh, { jobId: latestId })))
  const caches = read(`return await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', ${JSON.stringify(householdId)}).eq('createdBy', ${JSON.stringify(identity.tokenIdentifier)})).collect()`)
  assert.equal(caches.length, 1)
  assert.ok(caches[0].notes.some((n: { quote: string }) => /fried rice/i.test(n.quote)))
  assert.ok(caches[0].metrics.inputTokens > 0)
  assert.equal(caches[0].lease, undefined)
  const remembered = await turn('What was my go-to quick dinner?')
  assert.ok(remembered.context?.assistant?.workingMemory?.notes.some(n => /fried rice/i.test(n.quote)))
  assert.ok(!remembered.context?.assistant?.history.some(h => /go-to quick dinner is vegetarian fried rice/i.test(h.request)))
  assert.match(remembered.job.clarification, /rice/i)
  await turn('Actually, my quick dinner preference is vegetarian noodles instead of rice.')
  client = connect()
  const corrected = await turn('What is my quick dinner preference now?')
  assert.match(corrected.job.clarification, /noodle/i)
  assert.doesNotMatch(corrected.job.clarification, /not a saved household|saved household detail|only a note|review it first/i)
  assert.ok(corrected.job.workingContext)
  const otherSubject = `${identity.tokenIdentifier}-other`
  append('memberships', [{ householdId, subject: otherSubject, role: 'adult' }])
  const other = new ConvexHttpClient('http://127.0.0.1:3210')
  other.setAdminAuth(config.adminKey, { ...identity, subject: `${subject}-other`, tokenIdentifier: otherSubject })
  assert.deepEqual(await other.query(api.jobs.list, {}), [])
  assert.deepEqual(await client.query(api.personalTasks.list, {}), [])
  assert.ok(read(`return await ctx.db.query('memoryFacts').filter(q => q.eq(q.field('householdId'), ${JSON.stringify(householdId)})).collect()`).every((f: { key: string }) => ['timezone', 'children'].includes(f.key)))
  console.log(JSON.stringify({ workingMemory: 'passed', concurrentRefreshRequests: 50, notes: caches[0].notes.length, inputTokens: caches[0].metrics.inputTokens, outputTokens: caches[0].metrics.outputTokens, elapsedMs: caches[0].metrics.elapsedMs, corrections: 'latest wins', visibility: 'owner only', providerWrites: 0 }))
  // Submit the correction while the first reply is still being prepared.
  const rapidFirst = await client.mutation(api.jobs.submit, { text: 'Suggest two easy breakfast ideas' })
  const rapidSecond = await client.mutation(api.jobs.submit, { text: 'Make those dairy-free' })
  const rapidDeadline = Date.now() + 120000
  let rapidFinished = false
  while (Date.now() < rapidDeadline) {
    const jobs = await client.query(api.jobs.list, {})
    const first = jobs.find(j => j._id === rapidFirst), second = jobs.find(j => j._id === rapidSecond)
    if (first && second && !first.preparing && !second.preparing) {
      assert.equal(first.conversation, true); assert.equal(second.conversation, true)
      assert.equal(first.actions.length + second.actions.length, 0)
      assert.match(second.clarification, /breakfast|oat|toast|egg|smoothie|pancake/i)
      const context = await admin.query(internal.jobs.context, { jobId: rapidSecond })
      assert.equal(context!.assistant!.history.at(-1)!.request, 'Suggest two easy breakfast ideas')
      assert.equal(context!.assistant!.history.at(-1)!.response, first.clarification)
      assert.deepEqual(await other.query(api.jobs.list, {}), [])
      rapidFinished = true; break
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(rapidFinished, 'Rapid conversational follow-up did not finish within its bounded wait.')
  console.log('Rapid follow-up passed: two immediate submissions, ordered preparation, breakfast context retained, no shared work or provider writes.')
  const queued = read(`return await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', ${JSON.stringify(householdId)}).eq('createdBy', ${JSON.stringify(identity.tokenIdentifier)})).unique()`)
  assert.equal(queued.pendingJobId, rapidSecond)
  assert.ok(queued.refreshTimerId && queued.refreshAt > Date.now())
  const pendingTimers = read(`return (await ctx.db.system.query('_scheduled_functions').collect()).filter(s => s.args[0]?.id === ${JSON.stringify(queued._id)} && s.state.kind === 'pending').length`)
  assert.equal(pendingTimers, 1)
  const refreshDeadline = queued.refreshAt + 120000
  let refreshed = false
  while (Date.now() < refreshDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    const current = read(`return await ctx.db.query('workingMemories').withIndex('by_owner', q => q.eq('householdId', ${JSON.stringify(householdId)}).eq('createdBy', ${JSON.stringify(identity.tokenIdentifier)})).unique()`)
    if (current.updatedAt > queued.updatedAt && !current.lease && !current.pendingJobId && !current.refreshTimerId) { refreshed = true; break }
  }
  assert.ok(refreshed, 'The durable working-context timer must refresh without another conversation request.')
  assert.equal(await admin.mutation(internal.workingMemory.resume, { id: queued._id, resetVersion: queued.resetVersion ?? 0, expectedAt: queued.refreshAt }), false)
  console.log('Durable coalesced refresh passed: one pending timer for the latest conversation, real scheduler/model refresh after cooldown, no new prompt required, replay refused.')
  const memorySettings = await client.query(api.workingMemory.settings, {})
  assert.ok(memorySettings.excerptCount > 0)
  assert.deepEqual(await other.query(api.workingMemory.settings, {}), { version: 0, excerptCount: 0 })
  const resets = await Promise.allSettled(Array.from({ length: 50 }, () => client.mutation(api.workingMemory.reset, { version: memorySettings.version })))
  assert.equal(resets.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await client.query(api.workingMemory.settings, {})).excerptCount, 0)
  assert.equal((await other.query(api.workingMemory.settings, {})).version, 0)
  const oldContext = await admin.query(internal.jobs.context, { jobId: rapidSecond })
  assert.equal(oldContext!.assistant!.workingMemory, undefined)
  const oldReply = (await client.query(api.jobs.list, {})).find(j => j._id === corrected.job._id)!
  assert.match(oldReply.clarification, /earlier conversation context changed/i)
  assert.deepEqual(await client.query(api.personalTasks.list, {}), [])
  console.log('Working-context reset passed: one of fifty accepted, owner isolation, no older backfill, derived reply withdrawn, original requests and saved work retained.')



} finally {
  if (householdId) {
    assert.equal((await client.query(api.households.current, {}))?._id, householdId)
    await client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
    const deletion = await admin.query(internal.privacy.deletionContext, {
      // Read only this synthetic identity's deletion marker through the local CLI.
      jobId: JSON.parse(spawnSync(process.execPath, ['node_modules/convex/bin/main.js', 'run', '--inline-query', `return (await ctx.db.query('deletionJobs').withIndex('by_subject', q => q.eq('subject', ${JSON.stringify(identity.tokenIdentifier)})).unique())._id`], { env: environment, encoding: 'utf8', timeout: 45000 }).stdout.trim()),
    })
    assert.ok(deletion && deletion.householdId === householdId)
    await admin.mutation(internal.privacy.eraseHousehold, { householdId: deletion.householdId, jobId: deletion._id })
    assert.equal(await client.query(api.households.current, {}), null)
    assert.deepEqual(read(`return await ctx.db.query('workingMemories').withIndex('by_household', q => q.eq('householdId', ${JSON.stringify(householdId)})).collect()`), [])
    console.log('Synthetic household data removed; existing users and credentials preserved.')
  }
  rmSync(scratch, { recursive: true, force: true })
}
