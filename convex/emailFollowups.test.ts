import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { gmailReadScope, watchIntervalMs } from '../shared/emailWatches'
import { event } from '../tests/fixtures/calendar'
import type { EmailTaskProposal } from '../shared/emailTasks'
import { payloadHash } from '../shared/daymark'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-06T12:00:00Z')
const body = 'Please return the signed form by October 12, 2026. Bring a packed lunch.'
const coverage = { format: 'plain' as const, incomplete: false, truncated: false, attachments: false, issues: [] }
const proposal: EmailTaskProposal = { title: 'Return the signed form', notes: 'Sign the field trip form.', dueDate: '2026-10-12', childId: 'maya', evidence: ['Please return the signed form by October 12, 2026.'], dateEvidence: 'by October 12, 2026' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-not-used'); vi.stubEnv('DAYMARK_MODEL', 'synthetic-not-used') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test' }))
  const watchId = await parent.mutation(api.emailWatches.create, { requestId: 'watch', connectionId, title: 'School mail', senders: ['school@example.test'], instruction: 'Find family tasks and dates.', consent: true })
  let serial = 0
  async function intake(overrides: { id?: string; threadId?: string; text?: string; sender?: string; receivedAt?: number } = {}) {
    if (serial) vi.setSystemTime(Date.now() + watchIntervalMs)
    const lease = { id: watchId, version: 1, lease: `lease-${++serial}` }
    await t.mutation(internal.emailWatches.claim, lease)
    const message = { id: `message-${serial}`, threadId: 'thread-1', sender: 'school@example.test', subject: `School message ${serial}`, text: body, receivedAt: Date.now() - 1000, truncated: false, extraction: coverage, ...overrides }
    await t.mutation(internal.emailWatches.finish, { ...lease, messages: [message] })
    return (await t.run(ctx => ctx.db.query('jobs').withIndex('by_email_watch', q => q.eq('emailWatchId', watchId)).order('desc').first()))!
  }
  const job = await intake()
  const prepare = (jobId = job._id, tasks: EmailTaskProposal[] = [proposal], actions: unknown[] = []) => t.mutation(internal.jobs.prepared, { jobId, sourceRevision: 1, tasks, actions, clarification: '' })
  const suggestion = async (jobId = job._id) => (await t.run(ctx => ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', jobId)).first()))!
  const saveArgs = async () => { const s = await suggestion(); return { id: s._id, version: s.version, sourceRevision: s.sourceRevision, input: { title: s.title, notes: s.notes, ...(s.dueDate ? { dueDate: s.dueDate } : {}), ...(s.childId ? { childId: s.childId } : {}) } } }
  return { t, parent, other, outsider, householdId, connectionId, watchId, job, intake, prepare, suggestion, saveArgs }
}

it('only saves an explicitly reviewed suggestion, accepts edits, and never marks the work complete', async () => {
  const f = await fixture(); await f.prepare()
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  expect(await f.parent.query(api.emailFollowups.suggestions, {})).toMatchObject([{ status: 'proposed', canSave: true }])
  const args = await f.saveArgs(), input = { ...args.input, title: 'Sign and return the form', dueDate: '2026-10-11' }
  const taskId = await f.parent.mutation(api.emailFollowups.saveTask, { ...args, input })
  expect(await f.parent.query(api.personalTasks.list, {})).toMatchObject([{ id: taskId, ...input, done: false, version: 1 }])
  expect(await f.parent.query(api.emailFollowups.suggestions, {})).toMatchObject([{ status: 'saved', canSave: false, personalTaskId: taskId }])
  for (const table of ['approvals', 'attempts', 'receipts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})

it('serializes concurrent duplicate saves and does not resurrect a removed personal task on retry', async () => {
  const f = await fixture(); await f.prepare(); const args = await f.saveArgs()
  const ids = await Promise.all(Array.from({ length: 50 }, () => f.parent.mutation(api.emailFollowups.saveTask, args)))
  expect(new Set(ids).size).toBe(1); expect(await f.parent.query(api.personalTasks.list, {})).toHaveLength(1)
  await f.parent.mutation(api.personalTasks.remove, { id: ids[0]!, version: 1 })
  const retries = await Promise.all(Array.from({ length: 50 }, () => f.parent.mutation(api.emailFollowups.saveTask, args)))
  expect(retries.every(id => id === ids[0])).toBe(true)
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toHaveLength(1)
  expect(await f.suggestion()).toMatchObject({ title: 'Removed task', notes: '', evidence: [] })
  await expect(f.parent.mutation(api.emailFollowups.saveTask, { ...args, input: { ...args.input, title: 'Changed retry' } })).rejects.toThrow('changed')
})

it('keeps suggestion reads and mutations private to the owning adult, including within the household', async () => {
  const f = await fixture(); await f.prepare(); const args = await f.saveArgs()
  for (const reader of [f.other, f.outsider]) {
    expect(await reader.query(api.emailFollowups.suggestions, {})).toEqual([])
    expect(await reader.query(api.emailWatches.recentChecks, {})).toEqual([])
    await expect(reader.mutation(api.emailFollowups.saveTask, args)).rejects.toThrow('unavailable')
    await expect(reader.mutation(api.emailFollowups.dismissTask, { id: args.id, version: 1, sourceRevision: 1 })).rejects.toThrow('unavailable')
    await expect(reader.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'dismiss' })).rejects.toThrow('unavailable')
    await expect(reader.mutation(api.emailFollowups.retry, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('unavailable')
  }
  await expect(f.t.mutation(api.emailFollowups.saveTask, args)).rejects.toThrow('Sign in')
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
})

it('dismisses a task suggestion without creating a task and rejects stale saves or dismissals', async () => {
  const f = await fixture(); await f.prepare(); const args = await f.saveArgs()
  await f.parent.mutation(api.emailFollowups.dismissTask, { id: args.id, version: 1, sourceRevision: 1 })
  expect(await f.suggestion()).toMatchObject({ status: 'dismissed', version: 2 })
  await expect(f.parent.mutation(api.emailFollowups.saveTask, args)).rejects.toThrow('changed')
  await expect(f.parent.mutation(api.emailFollowups.dismissTask, { id: args.id, version: 1, sourceRevision: 1 })).rejects.toThrow('changed')
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
})

it.each(['version', 'source', 'expired', 'paused', 'revoked', 'cancelled', 'preparing', 'dismissed'] as const)('blocks a save whose %s state changed after review', async change => {
  const f = await fixture(); await f.prepare(); const args = await f.saveArgs()
  if (change === 'version') args.version = 0
  else if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.job.sourceId, { revision: 2 }))
  else if (change === 'expired') await f.t.run(ctx => ctx.db.patch(f.job.sourceId, { expiresAt: Date.now() }))
  else if (change === 'paused') await f.parent.mutation(api.emailWatches.setPaused, { id: f.watchId, version: 1, paused: true })
  else if (change === 'revoked') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
  else if (change === 'cancelled') await f.t.run(ctx => ctx.db.patch(f.job._id, { cancelled: true }))
  else if (change === 'preparing') await f.t.run(ctx => ctx.db.patch(f.job._id, { preparing: true }))
  else await f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'dismiss' })
  await expect(f.parent.mutation(api.emailFollowups.saveTask, args)).rejects.toThrow()
  expect(await f.parent.query(api.personalTasks.list, {})).toEqual([])
})

it('rejects malformed parent edits and children from outside the household', async () => {
  const f = await fixture(); await f.prepare(); const args = await f.saveArgs()
  for (const input of [{ ...args.input, title: ' ' }, { ...args.input, dueDate: '2026-02-30' }, { ...args.input, childId: 'someone-else' }]) await expect(f.parent.mutation(api.emailFollowups.saveTask, { ...args, input })).rejects.toThrow()
  expect((await f.suggestion()).status).toBe('proposed')
})

it('replaces an unsaved same-thread suggestion with a current saveable review instead of stranding it', async () => {
  const f = await fixture(); await f.prepare(); const oldArgs = await f.saveArgs()
  const latest = await f.intake(); await f.prepare(latest._id)
  await expect(f.parent.mutation(api.emailFollowups.saveTask, oldArgs)).rejects.toThrow('newer message')
  const current = (await f.parent.query(api.emailFollowups.suggestions, {})).filter(s => s.canSave)
  expect(current).toHaveLength(1)
  expect(current[0].jobId).toBe(latest._id)
  expect(current[0].input.title).toBe(proposal.title)
})

it('does not treat an older related email excerpt as evidence in the current message', async () => {
  const f = await fixture(); await f.prepare()
  const latest = await f.intake({ text: 'Thanks for reading this follow-up.' }); await f.prepare(latest._id)
  expect(await f.t.run(ctx => ctx.db.query('emailTaskSuggestions').withIndex('by_job', q => q.eq('jobId', latest._id)).collect())).toEqual([])
  expect((await f.parent.query(api.emailFollowups.suggestions, {})).filter(s => s.canSave)).toEqual([])
})

it('suppresses a repeated saved task but proposes a changed deadline for fresh review', async () => {
  const f = await fixture(); await f.prepare(); await f.parent.mutation(api.emailFollowups.saveTask, await f.saveArgs())
  const repeated = await f.intake(); await f.prepare(repeated._id)
  expect(await f.t.run(ctx => ctx.db.query('emailTaskSuggestions').collect())).toHaveLength(1)
  const changed = await f.intake({ text: 'Please return the signed form by October 15, 2026.' })
  await f.prepare(changed._id, [{ ...proposal, dueDate: '2026-10-15', evidence: ['Please return the signed form by October 15, 2026.'], dateEvidence: 'by October 15, 2026' }])
  expect(await f.parent.query(api.personalTasks.list, {})).toHaveLength(1)
  expect((await f.parent.query(api.emailFollowups.suggestions, {})).filter(s => s.canSave)).toMatchObject([{ input: { dueDate: '2026-10-15' } }])
})

it('keeps saved-task deduplication after a thread grows beyond the bounded model context', async () => {
  const f = await fixture(); await f.prepare(); await f.parent.mutation(api.emailFollowups.saveTask, await f.saveArgs())
  for (let n = 0; n < 6; n++) { const followup = await f.intake({ text: `Checked informational follow-up ${n}.` }); await f.prepare(followup._id, []) }
  const repeated = await f.intake(); await f.prepare(repeated._id)
  expect((await f.parent.query(api.emailFollowups.suggestions, {})).filter(s => s.canSave)).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('emailTaskSuggestions').collect())).toHaveLength(1)
})

it('blocks older-thread action approval as soon as newer checked mail is received', async () => {
  const f = await fixture(); await f.prepare(f.job._id, [], [event])
  const action = (await f.t.run(ctx => ctx.db.query('actions').first()))!
  await f.intake({ text: 'The school trip has been rescheduled. Please wait for details.' })
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: action._id, revision: 1 }] })).rejects.toThrow('newer message')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('blocks an old undispatched approval after a reply while retaining a result already dispatched', async () => {
  for (const dispatched of [false, true]) {
    vi.setSystemTime(now)
    const f = await fixture(); await f.prepare(f.job._id, [], [event])
    const action = (await f.t.run(ctx => ctx.db.query('actions').first()))!
    const attemptId = await f.t.run(async ctx => {
      const approvalId = await ctx.db.insert('approvals', { householdId: f.householdId, actionId: action._id, revision: 1, sourceRevision: 1, payloadHash: payloadHash(event), subject: 'test|parent', destination: 'synthetic-calendar', expiresAt: now + 86400_000 })
      const attemptId = await ctx.db.insert('attempts', { householdId: f.householdId, actionId: action._id, approvalId, dispatched, finished: false, startedAt: now })
      await ctx.db.patch(action._id, { status: 'executing', approvalId, attemptId })
      return attemptId
    })
    await f.intake({ text: 'The field trip has been rescheduled.' })
    if (dispatched) {
      await f.t.mutation(internal.execution.finish, { attemptId, status: 'succeeded', providerId: 'synthetic-existing-result', etag: 'synthetic-etag' })
      expect((await f.t.run(ctx => ctx.db.get(action._id)))?.status).toBe('succeeded')
      expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
    } else {
      expect(await f.t.mutation(internal.execution.dispatch, { attemptId })).toBe(false)
      expect((await f.t.run(ctx => ctx.db.get(action._id)))?.status).toBe('review')
      expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
    }
  }
})

it('snoozes and restores a review using versioned timers without preparing or approving work', async () => {
  const f = await fixture(); await f.prepare(); const until = now + 3600_000
  const args = { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'snooze' as const, until }
  await f.parent.mutation(api.emailFollowups.handleMessage, args)
  expect(await f.parent.query(api.jobs.list, {})).toEqual([])
  expect(await f.parent.query(api.emailWatches.recentChecks, {})).toMatchObject([{ status: 'snoozed', handlingVersion: 1, snoozedUntil: until }])
  await expect(f.parent.mutation(api.emailFollowups.saveTask, await f.saveArgs())).rejects.toThrow('Restore')
  await expect(f.parent.mutation(api.emailFollowups.handleMessage, { ...args, operation: 'restore' })).rejects.toThrow('changed')
  await f.t.mutation(internal.emailFollowups.wake, { jobId: f.job._id, version: 1, sourceRevision: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailHandling).toBe('snoozed')
  vi.setSystemTime(until)
  await f.t.mutation(internal.emailFollowups.wake, { jobId: f.job._id, version: 1, sourceRevision: 1 })
  expect(await f.parent.query(api.jobs.list, {})).toMatchObject([{ preparing: false, emailHandlingVersion: 2 }])
  await f.parent.mutation(api.emailFollowups.handleMessage, { ...args, handlingVersion: 2, operation: 'dismiss', until: undefined })
  await f.t.mutation(internal.emailFollowups.wake, { jobId: f.job._id, version: 1, sourceRevision: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailHandling).toBe('dismissed')
  await f.parent.mutation(api.emailFollowups.handleMessage, { ...args, handlingVersion: 3, operation: 'restore', until: undefined })
  expect(await f.parent.query(api.jobs.list, {})).toHaveLength(1)
  for (const table of ['actions', 'approvals', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})

it.each(['queued', 'executing', 'uncertain', 'waiting', 'succeeded'] as const)('cannot hide %s work by snoozing or dismissing its source', async status => {
  const f = await fixture(); await f.prepare(f.job._id, [], [event])
  await f.t.run(async ctx => { const action = (await ctx.db.query('actions').first())!; await ctx.db.patch(action._id, { status }) })
  for (const operation of ['dismiss', 'snooze'] as const) await expect(f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation, until: now + 1000 })).rejects.toThrow('active work')
  expect((await f.parent.query(api.emailWatches.recentChecks, {}))[0].canHandle).toBe(false)
})

it('cannot hide a partially completed request with a pending review alongside its recorded result', async () => {
  const f = await fixture(); await f.prepare(f.job._id, [], [event, { ...event, title: 'Trip pickup' }])
  await f.t.run(async ctx => { const action = (await ctx.db.query('actions').first())!; await ctx.db.patch(action._id, { status: 'succeeded' }); await ctx.db.insert('receipts', { householdId: f.householdId, actionId: action._id, revision: 1, providerId: 'synthetic-confirmed-event', outcome: 'succeeded', verifiedAt: now }) })
  await expect(f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'dismiss' })).rejects.toThrow('active work')
  expect(await f.parent.query(api.jobs.list, {})).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
})

it('bounds snooze dates and ignores timers for changed or expired sources', async () => {
  for (const change of ['source', 'expiry'] as const) {
    const f = await fixture(); await f.prepare()
    for (const until of [now, now - 1, now + 8 * 86400_000, now + 0.5]) await expect(f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'snooze', until })).rejects.toThrow('snooze time')
    await f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'snooze', until: now + 1000 })
    await f.t.run(ctx => ctx.db.patch(f.job.sourceId, change === 'source' ? { revision: 2 } : { expiresAt: now + 1000 }))
    vi.setSystemTime(now + 1000)
    await f.t.mutation(internal.emailFollowups.wake, { jobId: f.job._id, version: 1, sourceRevision: 1 })
    expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailHandling).toBe('snoozed')
    vi.setSystemTime(now)
  }
})

it('does not revive a snoozed review after its watch is paused', async () => {
  const f = await fixture(); await f.prepare()
  await f.parent.mutation(api.emailFollowups.handleMessage, { jobId: f.job._id, sourceRevision: 1, handlingVersion: 0, operation: 'snooze', until: now + 1000 })
  await f.parent.mutation(api.emailWatches.setPaused, { id: f.watchId, version: 1, paused: true })
  vi.setSystemTime(now + 1000)
  await f.t.mutation(internal.emailFollowups.wake, { jobId: f.job._id, version: 1, sourceRevision: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailHandling).toBe('snoozed')
})

it('retries failed preparation idempotently and refuses to replay existing actions or missing-model work', async () => {
  const f = await fixture()
  await f.t.mutation(internal.jobs.prepared, { jobId: f.job._id, sourceRevision: 1, actions: [], clarification: 'Preparation could not finish.', preparationFailed: true })
  expect((await f.parent.query(api.emailWatches.recentChecks, {}))[0].canRetry).toBe(true)
  vi.stubEnv('DAYMARK_MODEL', '')
  await expect(f.parent.mutation(api.emailFollowups.retry, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('cannot be retried')
  vi.stubEnv('DAYMARK_MODEL', 'synthetic-not-used')
  const args = { jobId: f.job._id, sourceRevision: 1 }
  expect(await f.parent.mutation(api.emailFollowups.retry, args)).toBe(f.job._id)
  expect(await f.parent.mutation(api.emailFollowups.retry, args)).toBe(f.job._id)
  expect(await f.t.run(ctx => ctx.db.get(f.job._id))).toMatchObject({ preparing: true, clarification: '' })
  await f.t.mutation(internal.jobs.prepared, { ...args, actions: [event], clarification: 'Incomplete preparation.', preparationFailed: true })
  await expect(f.parent.mutation(api.emailFollowups.retry, args)).rejects.toThrow('does not replay')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('never offers retry for a cancelled failed email check', async () => {
  const f = await fixture()
  await f.t.mutation(internal.jobs.prepared, { jobId: f.job._id, sourceRevision: 1, actions: [], clarification: 'Preparation stopped.', preparationFailed: true })
  await f.parent.mutation(api.jobs.cancel, { jobId: f.job._id })
  expect(await f.parent.query(api.emailWatches.recentChecks, {})).toMatchObject([{ status: 'cancelled', canRetry: false }])
  await expect(f.parent.mutation(api.emailFollowups.retry, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('unavailable')
})

it('bounds related context to checked messages from the same owner, account, watch and thread', async () => {
  const f = await fixture(); await f.prepare()
  const unrelated = await f.intake({ threadId: 'unrelated-thread', text: 'This unrelated thread must not enter the context.' }); await f.prepare(unrelated._id, [])
  const otherConnection = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|other', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'other@example.test' }))
  const otherWatch = await f.other.mutation(api.emailWatches.create, { requestId: 'other-watch', connectionId: otherConnection, title: 'Other mail', senders: ['school@example.test'], instruction: 'Find dates.', consent: true })
  const otherLease = { id: otherWatch, version: 1, lease: 'other-lease' }
  await f.t.mutation(internal.emailWatches.claim, otherLease)
  await f.t.mutation(internal.emailWatches.finish, { ...otherLease, messages: [{ id: 'other-mail', threadId: 'thread-1', sender: 'school@example.test', subject: 'Private other account', text: 'Other adult private details.', receivedAt: Date.now() - 1000, truncated: false, extraction: coverage }] })
  await expect(f.intake({ sender: 'unchecked@example.test', text: 'Unchecked sender content.' })).rejects.toThrow('outside its allowed filter')
  // Release the failed synthetic worker's lease; no unchecked job was committed.
  await f.t.run(ctx => ctx.db.patch(f.watchId, { lease: undefined, leaseUntil: undefined }))
  const latest = await f.intake({ text: 'A checked follow-up in the original thread.', receivedAt: Date.now() - 1000 })
  const context = await f.t.query(internal.jobs.context, { jobId: latest._id })
  expect(context?.relatedMessages).toHaveLength(1)
  expect(context?.relatedMessages[0]).toMatchObject({ body, tasks: [{ title: proposal.title, status: 'proposed' }] })
  expect(JSON.stringify(context?.relatedMessages)).not.toMatch(/unrelated thread|Other adult private|Unchecked sender/)
  const checks = await f.parent.query(api.emailWatches.recentChecks, {})
  expect(checks.find(c => c.jobId === latest._id)?.related).toMatchObject([{ jobId: f.job._id }])
})

it('removes expired task excerpts and unsaved suggestions while preserving explicitly saved tasks', async () => {
  const f = await fixture(); await f.prepare(f.job._id, [proposal, { ...proposal, title: 'Pack lunch', dueDate: null, dateEvidence: null, evidence: ['Bring a packed lunch.'] }])
  const args = await f.saveArgs(); await f.parent.mutation(api.emailFollowups.saveTask, args)
  vi.setSystemTime(now + 31 * 86400_000)
  await f.t.mutation(internal.privacy.expireSources, {})
  const rows = await f.t.run(ctx => ctx.db.query('emailTaskSuggestions').collect())
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'saved', evidence: [] })
  expect(rows[0].issue).toBeUndefined()
  expect(await f.parent.query(api.emailFollowups.suggestions, {})).toEqual([])
  expect(await f.parent.query(api.personalTasks.list, {})).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.get(f.job.sourceId)))?.text).toBeUndefined()
})

it('erases task proposals with household deletion', async () => {
  const f = await fixture(); await f.prepare()
  const deletion = await f.t.run(async ctx => { await ctx.db.patch(f.householdId, { deleted: true }); return ctx.db.insert('deletionJobs', { householdId: f.householdId, requestedAt: now, status: 'pending', identityStatus: 'deleted' }) })
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion })
  expect(await f.t.run(ctx => ctx.db.query('emailTaskSuggestions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toEqual([])
})
