import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { expireLearnedWorkflows } from './learnedWorkflows'
import { extractStructured } from '../server/model'
vi.mock('../server/model', async original => ({ ...await original<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T09:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(text = 'Maya goes to Oak School. Every Sunday at 7 PM, remind me to pack school bags.') {
  const t = convexTest(schema, modules), owner = t.withIdentity({ subject: 'owner', tokenIdentifier: 'test|owner' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text, hash: sourceHash(text), revision: 1, expiresAt: now + 86400000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|owner', preparing: false, cancelled: false, clarification: 'Synthetic completion.', conversation: true }))
  const request = () => owner.mutation(api.learnedWorkflows.request, { jobId, sourceRevision: 1 })
  const candidate = { kind: 'fact', title: 'Maya’s school', reason: 'Useful household context.', quote: 'Maya goes to Oak School.', value: { kind: 'school', childId: 'maya', school: 'Oak School', className: '' } }
  const routine = { kind: 'routine', title: 'School bags', reason: 'An explicit weekly request.', quote: 'Every Sunday at 7 PM, remind me to pack school bags.', value: { title: 'School bags', outcome: { kind: 'personal_task', task: { title: 'Pack school bags', notes: '' }, dueAfterDays: 0 }, schedule: { frequency: 'weekly', weekdays: [7], time: '19:00', timezone: 'UTC', startDate: '2026-10-18' } } }
  const prepare = async (candidates = [candidate]) => { const id = await request(); const lease = { id, version: 1, lease: 'lease' }; expect(await t.mutation(internal.learnedWorkflows.claim, lease)).not.toBeNull(); await t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates }) }); return (await owner.query(api.learnedWorkflows.list, {}))[0] }
  return { t, owner, other, householdId, sourceId, jobId, text, request, candidate, routine, prepare }
}
it('uses the configured model to recognize a source-backed candidate without confirming memory', async () => {
  const f = await fixture(), id = await f.request()
  vi.mocked(extractStructured).mockResolvedValue({ candidates: [f.candidate] })
  await f.t.action(internal.workflowCurator.prepare, { id, version: 1 })
  expect(vi.mocked(extractStructured).mock.calls[0][2]).toMatchObject({ parentText: f.text, timezone: 'UTC' })
  expect((await f.owner.query(api.learnedWorkflows.list, {}))).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).filter(x => x.key.startsWith('family:'))).toEqual([])
  expect(await f.other.query(api.learnedWorkflows.list, {})).toEqual([])
})
it('coalesces fifty requests and claims, validates exact evidence, and rejects late completion', async () => {
  const f = await fixture(), ids = await Promise.all(Array.from({ length: 50 }, () => f.request())); expect(new Set(ids).size).toBe(1)
  const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => f.t.mutation(internal.learnedWorkflows.claim, { id: ids[0], version: 1, lease: `lease${i}` }))); expect(claims.filter(Boolean)).toHaveLength(1)
  const lease = { id: ids[0], version: 1, lease: `lease${claims.findIndex(Boolean)}` }
  await expect(f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [{ ...f.candidate, quote: 'Invented source' }] }) })).rejects.toThrow('exact')
  expect(await f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [f.candidate] }) })).toBe(true)
  expect(await f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [f.candidate] }) })).toBe(false)
})
it('keeps exact edits private until sharing confirmation, handles stale versions, and approves once', async () => {
  const f = await fixture(), p = await f.prepare(), value = { ...f.candidate.value, className: 'Class A' }
  const version = await f.owner.mutation(api.learnedWorkflows.update, { id: p._id as any, version: 1, value }); expect(version).toBe(2)
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version: 1, value, shareConfirmed: true })).rejects.toThrow('changed')
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version, value, shareConfirmed: false })).rejects.toThrow('sharing')
  await expect(f.other.mutation(api.learnedWorkflows.approve, { id: p._id as any, version, value, shareConfirmed: true })).rejects.toThrow('unavailable')
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version, value, shareConfirmed: true })))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).filter(x => x.key.startsWith('family:'))).toHaveLength(1)
  expect(await f.owner.query(api.learnedWorkflows.list, {})).toEqual([])
})
it('saves reviewed recurring work paused without a timer or any external action', async () => {
  const f = await fixture(), id = await f.request(), lease = { id, version: 1, lease: 'r' }
  await f.t.mutation(internal.learnedWorkflows.claim, lease); await f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [f.routine] }) })
  const p = (await f.owner.query(api.learnedWorkflows.list, {}))[0]
  const result = await f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version: 1, value: f.routine.value, shareConfirmed: true })
  expect(await f.t.run(ctx => ctx.db.get(result.routineId!))).toMatchObject({ state: 'paused', version: 1 })
  expect((await f.t.run(ctx => ctx.db.get(result.routineId!)))!.timerId).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})
it.each(['source', 'hash', 'expiry', 'cancelled', 'membership', 'deleted', 'family'] as const)('rejects pending learning after %s changes', async change => {
  const f = await fixture(), p = await f.prepare()
  await f.t.run(async ctx => { if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 }); if (change === 'hash') await ctx.db.patch(f.sourceId, { text: 'Altered without a revision.' }); if (change === 'expiry') vi.setSystemTime(Date.now() + 86400001); if (change === 'cancelled') await ctx.db.patch(f.jobId, { cancelled: true }); if (change === 'membership') await ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|owner')).unique())!._id); if (change === 'deleted') await ctx.db.delete(f.sourceId); if (change === 'family') await ctx.db.patch(f.householdId, { timezone: 'America/Los_Angeles' }) })
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version: 1, value: f.candidate.value, shareConfirmed: true })).rejects.toThrow()
  if (change !== 'membership') expect(await f.owner.query(api.learnedWorkflows.list, {})).toEqual([])
})
it('rejects revoked private mail context and expired-source output without writing partial candidates', async () => {
  const f = await fixture(), p = await f.prepare()
  const mailboxId = await f.t.run(async ctx => {
    const connectionId = await ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|owner', status: 'revoked', version: 1, scopes: [] })
    return ctx.db.insert('mailboxes', { householdId: f.householdId, createdBy: 'test|owner', connectionId, connectionVersion: 1, accountKey: 'synthetic', version: 1, state: 'paused', lookbackDays: 30, consentedAt: now, createdAt: now })
  })
  await f.t.run(async ctx => {
    const runId = await ctx.db.insert('mailRuns', { householdId: f.householdId, createdBy: 'test|owner', mailboxId, mailboxVersion: 1, connectionId: (await ctx.db.get(mailboxId))!.connectionId, connectionVersion: 1, accountKey: 'synthetic', requestId: 'synthetic', requestHash: 'synthetic', request: 'Synthetic', kind: 'check', query: '', lookbackDays: 30, mode: 'baseline', scope: 'inbox', status: 'complete', version: 1, scanned: 0, segmentScanned: 0, from: now, through: now, createdAt: now, expiresAt: now + 86400000, messageIds: [], hasMore: false })
    await ctx.db.patch(f.jobId, { mailContext: { mailboxId, mailboxVersion: 1, runId, runVersion: 1, summaryHash: 'synthetic', expiresAt: now + 86400000, messages: [] } })
  })
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: p._id as any, version: 1, value: f.candidate.value, shareConfirmed: true })).rejects.toThrow('changed')
  expect(await f.owner.query(api.learnedWorkflows.list, {})).toEqual([])
})
it('caps owner model checks and erases both expired curation and candidate source content', async () => {
  const f = await fixture(); await f.prepare()
  for (let revision = 2; revision <= 10; revision++) { await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision })); await f.owner.mutation(api.learnedWorkflows.request, { jobId: f.jobId, sourceRevision: revision }) }
  await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 11 }))
  await expect(f.owner.mutation(api.learnedWorkflows.request, { jobId: f.jobId, sourceRevision: 11 })).rejects.toThrow('ten learning')
  vi.setSystemTime(Date.now() + 86400001); await f.t.run(expireLearnedWorkflows)
  expect(await f.t.run(ctx => ctx.db.query('learnedWorkflows').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('workflowCurations').collect())).toEqual([])
})
it('dismisses without sharing and does not resurrect the same candidate from a later request', async () => {
  const f = await fixture(), p = await f.prepare(); await f.owner.mutation(api.learnedWorkflows.dismiss, { id: p._id as any, version: 1 })
  await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2 }))
  const id = await f.owner.mutation(api.learnedWorkflows.request, { jobId: f.jobId, sourceRevision: 2 }), lease = { id, version: 1, lease: 'next' }
  await f.t.mutation(internal.learnedWorkflows.claim, lease); await f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [f.candidate] }) })
  expect(await f.owner.query(api.learnedWorkflows.list, {})).toEqual([])
  expect((await f.t.run(ctx => ctx.db.query('learnedWorkflows').collect()))[0].value).toBeUndefined()
})
it('bounds interrupted calls, reclaims leases, ignores late failure, and cleans expired private records', async () => {
  const f = await fixture(), id = await f.request(), old = { id, version: 1, lease: 'old' }
  await f.t.mutation(internal.learnedWorkflows.claim, old); vi.setSystemTime(Date.now() + 91001)
  const next = { id, version: 1, lease: 'next' }; expect(await f.t.mutation(internal.learnedWorkflows.claim, next)).not.toBeNull()
  await f.t.mutation(internal.learnedWorkflows.failed, old); expect((await f.t.run(ctx => ctx.db.get(id)))!.status).toBe('running')
  vi.setSystemTime(Date.now() + 91001); expect(await f.t.mutation(internal.learnedWorkflows.claim, { ...next, lease: 'third' })).toBeNull(); expect((await f.t.run(ctx => ctx.db.get(id)))!.status).toBe('failed')
  vi.setSystemTime(Date.now() + 86400000); await f.t.run(expireLearnedWorkflows); expect(await f.t.run(ctx => ctx.db.query('workflowCurations').collect())).toEqual([])
})

async function emailProcessFixture() {
  const text = 'Whenever school sends a field-trip permission form, prepare a reply asking whether electronic signatures are accepted.'
  const f = await fixture(text), id = await f.request(), lease = { id, version: 1, lease: 'email-process' }
  const value = { title: 'Field-trip forms', condition: 'A new school email requests a field-trip permission form.', instruction: 'Prepare a reply asking whether electronic signatures are accepted, for my review.' }
  const candidate = { kind: 'mail_routine', title: value.title, reason: 'An explicit reusable new-email request.', quote: text, value }
  await f.t.mutation(internal.learnedWorkflows.claim, lease)
  await f.t.mutation(internal.learnedWorkflows.finish, { ...lease, result: JSON.stringify({ candidates: [candidate] }) })
  const p = (await f.owner.query(api.learnedWorkflows.list, {}))[0]
  return { ...f, p, value }
}
it('saves a reviewed email process privately and paused without sharing or granting mailbox access', async () => {
  const f = await emailProcessFixture()
  const previousFacts = await f.t.run(ctx => ctx.db.query('memoryFacts').collect())
  expect(await f.other.query(api.learnedWorkflows.list, {})).toEqual([])
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => f.owner.mutation(api.learnedWorkflows.approve, { id: f.p._id as any, version: f.p.version, value: f.value, shareConfirmed: false })))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const saved = await f.owner.query(api.mailRoutines.list, {})
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ state: 'paused', definition: f.value })
  expect(await f.other.query(api.mailRoutines.list, {})).toEqual([])
  for (const table of ['actions', 'approvals', 'attempts', 'mailboxes', 'connections', 'routines'] as const) {
    const rows = await f.t.run(ctx => ctx.db.query(table).collect())
    expect(rows).toEqual([])
  }
  expect(await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).toEqual(previousFacts)
  const reviewed = await f.t.run(ctx => ctx.db.get(f.p._id as any))
  expect(reviewed).toMatchObject({ status: 'approved', quote: '', title: '', reason: '' })
  expect((reviewed as any).value).toBeUndefined()
})
it('keeps edited email-process review source-bound and refuses cross-adult or stale acceptance', async () => {
  const f = await emailProcessFixture(), edited = { ...f.value, instruction: 'Prepare a short reply asking how to return the form, for review.' }
  await expect(f.other.mutation(api.learnedWorkflows.update, { id: f.p._id as any, version: 1, value: edited })).rejects.toThrow('unavailable')
  const version = await f.owner.mutation(api.learnedWorkflows.update, { id: f.p._id as any, version: 1, value: edited })
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: f.p._id as any, version: 1, value: edited, shareConfirmed: false })).rejects.toThrow('changed')
  await f.t.run(ctx => ctx.db.patch(f.sourceId, { revision: 2 }))
  await expect(f.owner.mutation(api.learnedWorkflows.approve, { id: f.p._id as any, version, value: edited, shareConfirmed: false })).rejects.toThrow('changed')
  expect(await f.owner.query(api.mailRoutines.list, {})).toEqual([])
})
it('coalesces explicit learning retries without resetting source bindings or the two-call budget', async () => {
  const f = await fixture(), id = await f.request(), first = { id, version: 1, lease: 'first' }
  await f.t.mutation(internal.learnedWorkflows.claim, first)
  await f.t.mutation(internal.learnedWorkflows.failed, { ...first, failureCode: 'grammar_limit' })
  const retried = await Promise.all(Array.from({ length: 50 }, () => f.request()))
  expect(new Set(retried)).toEqual(new Set([id]))
  const second = { id, version: 1, lease: 'second' }
  expect(await f.t.mutation(internal.learnedWorkflows.claim, second)).not.toBeNull()
  await f.t.mutation(internal.learnedWorkflows.failed, first)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.status).toBe('running')
  await f.t.mutation(internal.learnedWorkflows.failed, { ...second, failureCode: 'unavailable' })
  await expect(f.request()).rejects.toThrow('two-attempt limit')
  expect((await f.t.run(ctx => ctx.db.get(id)))?.attempts).toBe(2)
  expect(await f.t.run(ctx => ctx.db.query('learnedWorkflows').collect())).toEqual([])
})
