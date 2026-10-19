import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { event } from '../tests/fixtures/calendar'
import { payloadHash } from '../shared/daymark'

vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts')
const now = Date.parse('2026-10-05T08:59:00Z'), due = now + 60_000
const paginationOpts = { numItems: 20, cursor: null }
const definition = { title: 'Library morning', outcome: { kind: 'personal_task', task: { title: 'Pack library books', notes: 'In the blue bag', childId: 'maya' }, dueAfterDays: 0 }, schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC', startDate: '2026-10-05' } }
const preparation = { ...definition, outcome: { kind: 'prepare_request', instruction: 'Prepare a school reply about tomorrow’s synthetic field trip.' }, schedule: { ...definition.schedule, endDate: '2026-10-05' } }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('DAYMARK_MODEL', ''); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const create = (value = definition, enabled = true, requestId = 'synthetic-routine') => parent.mutation(api.routines.create, { requestId, definition: value, enabled })
  return { t, parent, outsider, householdId, create }
}

it('saves one versioned routine per creation request, with household and adult controls', async () => {
  const f = await fixture(), id = await f.create()
  expect(await f.create()).toBe(id)
  expect(await f.parent.query(api.routines.settings, {})).toEqual({ preparationModelConfigured: false, catchUp: 'latest_only', maxSaved: 100 })
  expect((await f.parent.query(api.routines.list, {}))[0]).toMatchObject({ version: 1, state: 'active', nextRunAt: due, canEdit: true, definition })
  expect((await f.parent.query(api.routines.versions, { id, paginationOpts })).page).toHaveLength(1)
  expect(await f.outsider.query(api.routines.list, {})).toEqual([])
  await expect(f.t.query(api.routines.list, {})).rejects.toThrow('Sign in')
  await expect(f.t.query(api.routines.settings, {})).rejects.toThrow('Sign in')
  await expect(f.outsider.query(api.routines.occurrences, { id, paginationOpts })).rejects.toThrow('unavailable')
  await expect(f.outsider.mutation(api.routines.update, { id, version: 1, definition })).rejects.toThrow('unavailable')
  await expect(f.create({ ...definition, title: 'Other' })).rejects.toThrow('another routine')
  const other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  expect((await other.query(api.routines.list, {}))[0].canEdit).toBe(false)
  await expect(other.mutation(api.routines.setPaused, { id, version: 1, paused: true })).rejects.toThrow('adult who saved')
  await expect(other.mutation(api.routines.remove, { id, version: 1 })).rejects.toThrow('adult who saved')
  expect(await other.mutation(api.routines.create, { requestId: 'synthetic-routine', definition, enabled: false })).not.toBe(id)
})

it('runs the real timer once and keeps personal work distinct from assistant completion', async () => {
  const f = await fixture(), id = await f.create()
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  await vi.advanceTimersByTimeAsync(60_000); await f.t.finishInProgressScheduledFunctions()
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  const tasks = await f.parent.query(api.personalTasks.list, {})
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ title: 'Pack library books', dueDate: '2026-10-05', done: false })
  let occurrences = await f.parent.query(api.routines.occurrences, { id, paginationOpts })
  expect(occurrences.page).toHaveLength(1)
  expect(occurrences.page[0]).toMatchObject({ version: 1, localDate: '2026-10-05', status: 'needs_parent' })
  await f.parent.mutation(api.personalTasks.setDone, { id: tasks[0].id as any, version: 1, done: true })
  occurrences = await f.parent.query(api.routines.occurrences, { id, paginationOpts })
  expect(occurrences.page[0].status).toBe('done_by_parent')
  expect(await f.t.run(async ctx => [await ctx.db.query('jobs').collect(), await ctx.db.query('approvals').collect(), await ctx.db.query('attempts').collect()])).toEqual([[], [], []])
})

it('recovers only the latest missed occurrence, advances once and never recreates a removed task', async () => {
  const f = await fixture(), id = await f.create()
  vi.setSystemTime('2026-10-09T12:00:00Z')
  await Promise.all([f.t.mutation(internal.routines.recover, {}), f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })])
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  let occurrences = await f.parent.query(api.routines.occurrences, { id, paginationOpts })
  expect(occurrences.page).toHaveLength(1)
  expect(occurrences.page[0]).toMatchObject({ localDate: '2026-10-09', caughtUpFrom: due })
  expect((await f.parent.query(api.routines.list, {}))[0].nextRunAt).toBe(Date.parse('2026-10-10T09:00:00Z'))
  const task = (await f.parent.query(api.personalTasks.list, {}))[0]
  await f.parent.mutation(api.personalTasks.remove, { id: task.id as any, version: 1 })
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  occurrences = await f.parent.query(api.routines.occurrences, { id, paginationOpts })
  expect(occurrences.page[0].status).toBe('removed')
})

it('rejects stale changes and ignores old timers after editing, pausing or resuming', async () => {
  const f = await fixture(), id = await f.create()
  expect(await f.parent.mutation(api.routines.update, { id, version: 1, definition: { ...definition, schedule: { ...definition.schedule, time: '10:00' } } })).toBe(2)
  await expect(f.parent.mutation(api.routines.remove, { id, version: 1 })).rejects.toThrow('changed')
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  await f.parent.mutation(api.routines.setPaused, { id, version: 2, paused: true })
  vi.setSystemTime('2026-10-09T12:00:00Z')
  await f.t.mutation(internal.routines.run, { id, version: 2, expectedAt: Date.parse('2026-10-05T10:00:00Z') })
  await f.parent.mutation(api.routines.setPaused, { id, version: 3, paused: false })
  expect((await f.parent.query(api.routines.list, {}))[0]).toMatchObject({ version: 4, nextRunAt: Date.parse('2026-10-10T10:00:00Z') })
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  const history = await f.parent.query(api.routines.versions, { id, paginationOpts })
  expect(history.page.map(v => v.version)).toEqual([4, 3, 2, 1])
})

it('does not duplicate an occurrence when a later time is saved for the same local date', async () => {
  const f = await fixture(), id = await f.create()
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  await f.parent.mutation(api.routines.update, { id, version: 1, definition: { ...definition, schedule: { ...definition.schedule, time: '10:00' } } })
  vi.setSystemTime('2026-10-05T10:00:00Z')
  await f.t.mutation(internal.routines.run, { id, version: 2, expectedAt: Date.now() })
  expect(await f.parent.query(api.personalTasks.list, {})).toHaveLength(1)
  expect((await f.parent.query(api.routines.occurrences, { id, paginationOpts })).page).toHaveLength(1)
})

it('prepares through Workflow with the occurrence date, but never treats a routine as approval', async () => {
  const f = await fixture()
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic')
  vi.mocked(extractStructured).mockResolvedValue({ actions: [event], clarification: 'Prepared for review.' })
  const id = await f.create(preparation as any)
  vi.setSystemTime('2026-10-07T12:00:00Z')
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  const jobs = await f.parent.query(api.jobs.list, {})
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ routineId: id, routineVersion: 1, routineDate: '2026-10-05', preparing: false })
  expect(jobs[0].actions[0]).toMatchObject({ status: 'review', receipts: [] })
  expect(vi.mocked(extractStructured).mock.calls[0][2]).toMatchObject({ routine: { localDate: '2026-10-05', timezone: 'UTC', scheduledAt: due } })
  expect((await f.parent.query(api.routines.list, {}))[0].state).toBe('finished')
  expect((await f.parent.query(api.routines.occurrences, { id, paginationOpts })).page[0].status).toBe('Needs you')
  expect(await f.t.run(async ctx => [await ctx.db.query('approvals').collect(), await ctx.db.query('attempts').collect()])).toEqual([[], []])
})

it('preserves an honest missing-model state and a failed preparation without duplicating the occurrence', async () => {
  for (const failingModel of [false, true]) {
    const f = await fixture()
    if (failingModel) { vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockRejectedValue(new Error('Synthetic interruption')) }
    const id = await f.create(preparation as any)
    vi.setSystemTime(due)
    await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    const job = (await f.parent.query(api.jobs.list, {}))[0]
    expect(job.preparing).toBe(false)
    expect(job.actions).toEqual([])
    expect(job.clarification).toContain(failingModel ? 'Preparation stopped' : 'not connected')
    await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
    expect(await f.parent.query(api.jobs.list, {})).toHaveLength(1)
    vi.setSystemTime(now)
  }
})

it('stops pending preparation and un-dispatched approvals after a routine changes, preserving real receipts', async () => {
  const f = await fixture(), id = await f.create(preparation as any)
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  const job = (await f.parent.query(api.jobs.list, {}))[0]
  await f.t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [event], clarification: '' })
  const action = (await f.parent.query(api.jobs.list, {}))[0].actions[0]
  const approvalId = await f.t.run(async ctx => {
    const connectionId = await ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', provider: 'google', status: 'active', scopes: ['https://www.googleapis.com/auth/calendar.app.created'], calendarId: 'synthetic-calendar', version: 1 })
    const approvalId = await ctx.db.insert('approvals', { householdId: f.householdId, actionId: action._id, revision: 1, sourceRevision: 1, payloadHash: payloadHash(event), subject: 'test|parent', destination: 'synthetic-calendar', expiresAt: Date.now() + 60000, connectionId, connectionVersion: 1, provider: 'google' })
    await ctx.db.patch(action._id, { status: 'queued', approvalId })
    return approvalId
  })
  const claimed = await f.t.mutation(internal.execution.claim, { actionId: action._id, approvalId })
  expect(claimed).not.toBeNull()
  await f.parent.mutation(api.routines.setPaused, { id, version: 1, paused: true })
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claimed!.attemptId })).toBe(false)
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: action._id, revision: 1 }] })).rejects.toThrow('routine changed')
  await f.t.run(ctx => ctx.db.patch(job._id, { preparing: true }))
  await f.t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [event], clarification: 'Late preparation' })
  expect((await f.parent.query(api.jobs.list, {}))[0].actions).toHaveLength(1)
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toContain('routine changed')
  // A late provider receipt from an already-dispatched attempt must still be recorded.
  await f.t.run(async ctx => { await ctx.db.patch(claimed!.attemptId, { dispatched: true, finished: false }); await ctx.db.patch(action._id, { status: 'executing', approvalId }) })
  await f.t.mutation(internal.execution.finish, { attemptId: claimed!.attemptId, status: 'succeeded', providerId: 'synthetic-event', etag: 'synthetic-etag' })
  expect((await f.parent.query(api.jobs.list, {}))[0].actions[0].receipts).toHaveLength(1)
})

it('blocks removed adults and invalid child references before creating work', async () => {
  for (const change of ['membership', 'child', 'household']) {
    const f = await fixture(), id = await f.create()
    await f.t.run(async ctx => {
      if (change === 'membership') { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(member!._id) }
      else await ctx.db.patch(f.householdId, change === 'child' ? { children: [] } : { deleted: true })
    })
    vi.setSystemTime(due)
    await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
    expect((await f.t.run(ctx => ctx.db.get(id)))?.state).toBe('blocked')
    expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toEqual([])
    vi.setSystemTime(now)
  }
})

it('removes routine definitions and their history without resurrecting them or deleting existing personal tasks', async () => {
  const f = await fixture(), id = await f.create()
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  await f.parent.mutation(api.routines.remove, { id, version: 1 })
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  expect(await f.create()).toBe(id)
  expect(await f.parent.query(api.routines.list, {})).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(id)))?.definition).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('routineVersions').collect())).toEqual([])
  expect(await f.parent.query(api.personalTasks.list, {})).toHaveLength(1)
  await expect(f.parent.query(api.routines.versions, { id, paginationOpts })).rejects.toThrow('removed')
})

it('validates typed outcomes and removes routine data with the household', async () => {
  const f = await fixture()
  for (const invalid of [{ ...definition, approved: true }, { ...definition, outcome: { kind: 'send_email', to: 'unknown@example.test' } }, { ...definition, outcome: { ...definition.outcome, task: { ...definition.outcome.task, childId: 'elsewhere' } } }, { ...preparation, outcome: { kind: 'prepare_request', instruction: 'What needs my attention?' } }, { ...definition, schedule: { ...definition.schedule, endDate: '2026-10-04' } }]) await expect(f.create(invalid as any)).rejects.toThrow()
  const id = await f.create()
  await f.parent.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  const deletion = (await f.t.run(ctx => ctx.db.query('deletionJobs').collect()))[0]
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion._id })
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  expect(await f.t.run(async ctx => [await ctx.db.query('routines').collect(), await ctx.db.query('routineVersions').collect(), await ctx.db.query('routineOccurrences').collect(), await ctx.db.query('personalTasks').collect()])).toEqual([[], [], [], []])
})

it('preserves native read-back and deletion evidence in occurrence summaries', async () => {
  for (const [outcome, expected] of [['apple_calendar_readback', 'connected iPhone'], ['calendar_deletion_verified', 'Calendar removal verified']]) {
    const f = await fixture(), id = await f.create(preparation as any)
    vi.setSystemTime(due)
    await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
    const job = (await f.parent.query(api.jobs.list, {}))[0]
    await f.t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [event], clarification: '' })
    const action = (await f.parent.query(api.jobs.list, {}))[0].actions[0]
    await f.t.run(async ctx => {
      await ctx.db.patch(action._id, { status: 'succeeded' })
      await ctx.db.insert('receipts', { householdId: f.householdId, actionId: action._id, revision: 1, outcome, verifiedAt: Date.now(), providerId: 'synthetic-provider-id' })
    })
    expect((await f.parent.query(api.routines.occurrences, { id, paginationOpts })).page[0].summary).toContain(expected)
    vi.setSystemTime(now)
  }
})

it('rejects both new and late model revisions from a stopped routine', async () => {
  const f = await fixture(), id = await f.create(preparation as any)
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic')
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  const job = (await f.parent.query(api.jobs.list, {}))[0]
  await f.t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [event], clarification: '' })
  const action = (await f.parent.query(api.jobs.list, {}))[0].actions[0]
  await f.parent.mutation(api.revisions.request, { actionId: action._id, revision: 1, instruction: 'Change the title.' })
  await f.parent.mutation(api.routines.setPaused, { id, version: 1, paused: true })
  expect(await f.t.query(internal.revisions.context, { actionId: action._id, revision: 2 })).toBeNull()
  expect(await f.t.mutation(internal.revisions.finish, { actionId: action._id, revision: 2, payload: { ...event, title: 'Obsolete title' }, clarification: '' })).toBe(false)
  const unchanged = await f.t.run(ctx => ctx.db.get(action._id))
  expect(unchanged?.payload.title).toBe(event.title)
  expect(unchanged?.revisionRequest).toBeUndefined()
  expect(unchanged?.error).toContain('routine changed')
  await expect(f.parent.mutation(api.revisions.request, { actionId: action._id, revision: unchanged!.revision, instruction: 'Try again' })).rejects.toThrow('routine changed')
  expect(await f.t.run(ctx => ctx.db.query('notifications').collect())).toEqual([])
})

it('stops email and in-app caregiver reminders from a paused routine without suppressing late results', async () => {
  for (const channel of ['email', 'app'] as const) {
    const f = await fixture(), id = await f.create(preparation as any)
    vi.setSystemTime(due)
    await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
    const job = (await f.parent.query(api.jobs.list, {}))[0]
    const requestId = await f.t.run(async ctx => {
      const caregiverId = await ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Synthetic caregiver', email: 'caregiver@example.test', childIds: ['maya'] })
      const payload = { kind: 'pickup', childId: 'maya', caregiverId, date: '2026-10-06', time: '15:00', timezone: 'UTC', location: 'Synthetic gate', deadline: new Date(Date.now() + 86400000).toISOString(), message: 'Synthetic pickup request', followUpAt: new Date(Date.now()).toISOString(), evidence: {} }
      const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId: job._id, sourceRevision: 1, revision: 1, payload, status: 'waiting' })
      const approvalId = await ctx.db.insert('approvals', { householdId: f.householdId, actionId, revision: 1, sourceRevision: 1, payloadHash: payloadHash(payload as any), subject: 'test|parent', destination: 'caregiver@example.test', expiresAt: Date.now() + 86400000 })
      await ctx.db.patch(actionId, { approvalId })
      return ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId, caregiverId, revision: 1, deliveryChannel: channel, tokenHash: 'synthetic', status: 'waiting', expiresAt: Date.now() + 86400000, followUpStatus: 'scheduled', followUpCipher: 'synthetic-cipher' })
    })
    await f.parent.mutation(api.routines.setPaused, { id, version: 1, paused: true })
    if (channel === 'email') expect(await f.t.mutation(internal.pickups.claimFollowup, { requestId })).toBeNull()
    else await f.t.mutation(internal.pickups.remindInApp, { requestId })
    expect((await f.t.run(ctx => ctx.db.get(requestId)))?.followUpStatus).toBe('cancelled')
    // A reminder already handed to a provider can still report its actual acceptance.
    await f.t.run(ctx => ctx.db.patch(requestId, { followUpStatus: 'dispatched' }))
    await f.t.mutation(internal.pickups.followupFinished, { requestId, status: 'accepted', providerId: 'synthetic-reminder' })
    expect((await f.t.run(ctx => ctx.db.get(requestId)))?.followUpProviderId).toBe('synthetic-reminder')
    vi.setSystemTime(now)
  }
})

it('suppresses delayed ready alerts after a routine stops, while preserving alerts about actual results', async () => {
  const f = await fixture(), id = await f.create(preparation as any)
  vi.setSystemTime(due)
  await f.t.mutation(internal.routines.run, { id, version: 1, expectedAt: due })
  const job = (await f.parent.query(api.jobs.list, {}))[0]
  await f.t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [event], clarification: '' })
  const notices = await f.t.run(async ctx => {
    await ctx.db.insert('notificationPreferences', { householdId: f.householdId, subject: 'test|parent', enabled: true, quietStart: '20:00', quietEnd: '07:00', lastActiveAt: now - 60_000 })
    await ctx.db.insert('devices', { householdId: f.householdId, subject: 'test|parent', token: 'synthetic-token' })
    return Promise.all((['ready', 'help'] as const).map(kind => ctx.db.insert('notifications', { householdId: f.householdId, subject: 'test|parent', jobId: job._id, kind, key: `synthetic-${kind}`, status: 'queued', createdAt: now })))
  })
  await f.parent.mutation(api.routines.setPaused, { id, version: 1, paused: true })
  expect(await f.t.mutation(internal.notifications.claim, { id: notices[0] })).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(notices[0])))?.status).toBe('suppressed')
  await f.t.run(async ctx => {
    const action = await ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', job._id)).first()
    await ctx.db.patch(action!._id, { status: 'uncertain', error: 'An already dispatched operation is unconfirmed.' })
  })
  expect(await f.t.mutation(internal.notifications.claim, { id: notices[1] })).not.toBeNull()
})
