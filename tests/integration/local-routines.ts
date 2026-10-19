import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'

// Only the existing anonymous localhost deployment is allowed. Never print the admin key.
const environment = readFileSync('.env.local', 'utf8')
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
assert.match(environment, /^CONVEX_DEPLOYMENT=anonymous:/m)
assert.ok(environment.includes(`CONVEX_DEPLOYMENT=anonymous:${config.deploymentName}`))
assert.equal(config.ports.cloud, 3210)
const client = (subject: string) => {
  const connection = new ConvexHttpClient('http://127.0.0.1:3210', { logger: false })
  connection.setAdminAuth(config.adminKey, { subject, issuer: 'https://daymark-test.invalid', tokenIdentifier: `https://daymark-test.invalid|${subject}`, email: 'parent@example.test', emailVerified: true })
  return connection
}
const suffix = crypto.randomUUID(), parent = client(`routine-parent-${suffix}`), outsider = client(`routine-outsider-${suffix}`)
await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
assert.equal((await parent.query(api.routines.settings, {})).preparationModelConfigured, false, 'This suite requires model preparation to be disconnected; it must not call a live model.')
const scheduledAt = Math.ceil((Date.now() + 10_000) / 60_000) * 60_000
const date = new Date(scheduledAt).toISOString().slice(0, 10), time = new Date(scheduledAt).toISOString().slice(11, 16)
const definition = { title: 'Synthetic library routine', outcome: { kind: 'personal_task', task: { title: 'Pack synthetic library books', notes: '', childId: 'maya' }, dueAfterDays: 1 }, schedule: { frequency: 'daily', time, timezone: 'UTC', startDate: date, endDate: date } }
const paginationOpts = { numItems: 20, cursor: null }
const routineIds: string[] = []
try {
  const args = { requestId: `routine-${suffix}`, definition, enabled: true }
  const id = await parent.mutation(api.routines.create, args); routineIds.push(id)
  assert.equal(await parent.mutation(api.routines.create, args), id)
  assert.deepEqual(await outsider.query(api.routines.list, {}), [])
  await assert.rejects(outsider.mutation(api.routines.setPaused, { id, version: 1, paused: true }), /unavailable/)
  const preparationId = await parent.mutation(api.routines.create, { ...args, requestId: `prepare-${suffix}`, definition: { ...definition, outcome: { kind: 'prepare_request', instruction: 'Prepare a school reply about tomorrow’s synthetic field trip.' } } }); routineIds.push(preparationId)
  const pausedId = await parent.mutation(api.routines.create, { ...args, requestId: `pause-${suffix}` }); routineIds.push(pausedId)
  await parent.mutation(api.routines.setPaused, { id: pausedId, version: 1, paused: true })
  await assert.rejects(parent.mutation(api.routines.update, { id: pausedId, version: 1, definition }), /changed/)
  assert.equal((await parent.query(api.routines.versions, { id: pausedId, paginationOpts })).page.length, 2)
  console.log('Waiting for the real local routine timer; no model or provider action is requested.')
  const timeout = scheduledAt + 45_000
  while (Date.now() < timeout) {
    const tasks = await parent.query(api.personalTasks.list, {})
    const jobs = await parent.query(api.jobs.list, {})
    if (tasks.length === 1 && jobs.length === 1 && !jobs[0].preparing) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const tasks = await parent.query(api.personalTasks.list, {}), jobs = await parent.query(api.jobs.list, {})
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, 'Pack synthetic library books')
  assert.equal(tasks[0].done, false)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].preparing, false)
  assert.match(jobs[0].clarification, /not connected/)
  assert.deepEqual(jobs[0].actions, [])
  assert.equal((await parent.query(api.routines.occurrences, { id, paginationOpts })).page[0].status, 'needs_parent')
  assert.equal((await parent.query(api.routines.occurrences, { id: pausedId, paginationOpts })).page.length, 0)
  await parent.mutation(api.personalTasks.setDone, { id: tasks[0].id as any, version: 1, done: true })
  assert.equal((await parent.query(api.routines.occurrences, { id, paginationOpts })).page[0].status, 'done_by_parent')
  assert.equal((await parent.query(api.routines.list, {})).find(r => r._id === id)?.state, 'finished')
  assert.equal(await parent.mutation(api.routines.create, args), id)
  assert.equal((await parent.query(api.personalTasks.list, {})).length, 1)
  console.log('Local routine backend passed: real timer, per-occurrence records, task persistence/completion, missing-model preparation, paused timer cancellation, stale edits, household isolation and duplicate creation protection. No external writes or live model calls were performed.')
} finally {
  // Remove only synthetic definitions created by this suite; leave no future test routines enabled.
  for (const routine of await parent.query(api.routines.list, {})) if (routineIds.includes(routine._id)) await parent.mutation(api.routines.remove, { id: routine._id, version: routine.version })
}
