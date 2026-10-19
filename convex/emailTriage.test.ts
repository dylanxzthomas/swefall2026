import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { gmailReadScope, watchIntervalMs } from '../shared/emailWatches'
import { extractStructured } from '../server/model'
import { householdWork } from './assistantContext'
import { event } from '../tests/fixtures/calendar'
import { queueNotice } from './notifications'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-05T12:00:00Z')
const body = 'October newsletter: highlights from last month. There is nothing to sign or return.'
const triage = { decision: 'quiet' as const, reason: 'A recap with no requested follow-up.', evidence: ['There is nothing to sign or return.'] }
const coverage = { format: 'plain' as const, incomplete: false, truncated: false, attachments: false, issues: [] }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(extraction = coverage) {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], cipher: 'not-used' }))
  const id = await parent.mutation(api.emailWatches.create, { requestId: 'watch', connectionId, title: 'School mail', senders: ['school@example.test'], instruction: 'Find dates and deadlines that need my attention.', consent: true })
  await t.run(ctx => ctx.db.insert('notificationPreferences', { householdId, subject: 'test|parent', enabled: true, quietStart: '22:00', quietEnd: '07:00', lastActiveAt: 0 }))
  const lease = { id, version: 1, lease: 'check' }, message = { id: 'email-1', sender: 'school@example.test', subject: 'October recap', text: body, receivedAt: now - 1000, truncated: extraction.incomplete || extraction.truncated, extraction }
  await t.mutation(internal.emailWatches.claim, lease)
  await t.mutation(internal.emailWatches.finish, { ...lease, messages: [message] })
  const job = (await t.run(ctx => ctx.db.query('jobs').collect()))[0]
  const prepare = () => t.mutation(internal.jobs.prepared, { jobId: job._id, sourceRevision: 1, actions: [], clarification: '', triage })
  return { t, parent, outsider, householdId, connectionId, id, lease, message, job, prepare }
}
it('filters a grounded recap without creating actions, approval, notification or status work', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockResolvedValue({ actions: [], clarification: '', triage } as any)
  await f.t.action(internal.preparation.prepare, { jobId: f.job._id, sourceRevision: 1 })
  const call = vi.mocked(extractStructured).mock.calls[0]
  expect(call[1]).toContain('Classify this watched email')
  expect(call[2]).toMatchObject({ emailBody: body, emailWatch: { instruction: 'Find dates and deadlines that need my attention.' } })
  expect(await f.parent.query(api.jobs.list, {})).toEqual([])
  expect((await f.t.run(async ctx => householdWork(ctx, (await ctx.db.get(f.householdId))!))).jobs).toEqual([])
  expect(await f.parent.query(api.emailWatches.recentChecks, {})).toMatchObject([{ status: 'quiet', reason: triage.reason, evidence: triage.evidence, canReview: true }])
  for (const table of ['actions', 'approvals', 'attempts', 'notifications'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('does not let incomplete or unread-attachment messages disappear', async () => {
  for (const extraction of [{ ...coverage, incomplete: true }, { ...coverage, attachments: true }]) {
    const f = await fixture(extraction); await f.prepare()
    expect((await f.parent.query(api.jobs.list, {}))[0]).toMatchObject({ emailTriage: { decision: 'uncertain' }, clarification: expect.stringContaining('not been read') })
    expect(await f.t.run(ctx => ctx.db.query('notifications').collect())).toHaveLength(1)
  }
})
it('refuses source-header or invented evidence at the database boundary', async () => {
  const f = await fixture()
  await f.t.mutation(internal.jobs.prepared, { jobId: f.job._id, sourceRevision: 1, actions: [], clarification: '', triage: { ...triage, evidence: ['Find dates and deadlines that need my attention.'] } })
  expect((await f.parent.query(api.jobs.list, {}))[0].emailTriage?.decision).toBe('uncertain')
})
it('keeps a grounded deadline visible when the model calls it irrelevant', async () => {
  const f = await fixture(), text = 'Pay the activity fee by October 12.'
  await f.t.run(async ctx => { const source = (await ctx.db.get(f.job.sourceId))!; await ctx.db.patch(source._id, { text: text, email: { ...source.email!, bodyOffset: 0 } }) })
  await f.t.mutation(internal.jobs.prepared, { jobId: f.job._id, sourceRevision: 1, actions: [], clarification: '', triage: { ...triage, evidence: [text] } })
  expect((await f.parent.query(api.jobs.list, {}))[0]).toMatchObject({ emailTriage: { decision: 'uncertain' }, clarification: expect.stringContaining('possible date, deadline or request') })
})
it('cannot notify about quiet messages and restores visibility when a parent adds actual draft work', async () => {
  const f = await fixture(); await f.prepare()
  await f.t.run(ctx => queueNotice(ctx, f.job._id, 'help', '1'))
  expect(await f.t.run(ctx => ctx.db.query('notifications').collect())).toEqual([])
  await f.parent.mutation(api.jobs.addDraft, { jobId: f.job._id, payload: event })
  const jobs = await f.parent.query(api.jobs.list, {})
  expect(jobs).toHaveLength(1); expect(jobs[0].actions).toHaveLength(1)
  expect(jobs[0].emailQuiet).toBeUndefined(); expect(jobs[0].emailReviewRequested).toBe(true)
})
it('keeps provider failures visible rather than treating them as irrelevant', async () => {
  const f = await fixture()
  await f.t.mutation(internal.jobs.prepared, { jobId: f.job._id, sourceRevision: 1, actions: [], clarification: 'Preparation stopped. Edit the source to try again.' })
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toContain('Preparation stopped')
  expect((await f.parent.query(api.emailWatches.recentChecks, {}))[0].status).toBe('review')
})
it('lets only the owner restore a filtered message once, without rerunning the filter or granting approval', async () => {
  const f = await fixture(); await f.prepare()
  const other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await f.t.run(ctx => ctx.db.insert('memberships', { householdId: f.householdId, subject: 'test|other', role: 'adult' }))
  for (const account of [f.outsider, other]) {
    expect(await account.query(api.emailWatches.recentChecks, {})).toEqual([])
    await expect(account.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('unavailable')
  }
  await expect(f.parent.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 2 })).rejects.toThrow('changed or expired')
  await f.parent.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 1 })
  await f.parent.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 1 })
  expect((await f.parent.query(api.jobs.list, {}))[0]).toMatchObject({ preparing: true, emailReviewRequested: true })
  vi.mocked(extractStructured).mockResolvedValue({ actions: [], clarification: 'What would you like me to prepare from this newsletter?' } as any)
  await f.t.action(internal.preparation.prepare, { jobId: f.job._id, sourceRevision: 1 })
  expect(vi.mocked(extractStructured).mock.calls[0][1]).not.toContain('Classify this watched email')
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toContain('What would you like')
  expect(await f.t.run(ctx => ctx.db.query('jobs').collect())).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
it('deduplicates quiet messages during subsequent polling', async () => {
  const f = await fixture(); await f.prepare(); vi.setSystemTime(now + watchIntervalMs)
  const lease = { ...f.lease, lease: 'next' }
  await f.t.mutation(internal.emailWatches.claim, lease)
  await f.t.mutation(internal.emailWatches.finish, { ...lease, messages: [f.message] })
  expect(await f.t.run(ctx => ctx.db.query('jobs').collect())).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('emailWatchMessages').collect())).toHaveLength(1)
})
it('blocks late triage and restoration after a watch changes or access is revoked', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(); await f.prepare()
    if (revoke) await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
    else await f.parent.mutation(api.emailWatches.setPaused, { id: f.id, version: 1, paused: true })
    expect((await f.parent.query(api.emailWatches.recentChecks, {}))[0].canReview).toBe(false)
    await expect(f.parent.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('changed or stopped')
  }
  const f = await fixture()
  await f.parent.mutation(api.emailWatches.setPaused, { id: f.id, version: 1, paused: true }); await f.prepare()
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toContain('changed or stopped')
  expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailQuiet).toBeUndefined()
})
it('expires classification excerpts alongside the original email without resurrecting hidden work', async () => {
  const f = await fixture(); await f.prepare(); vi.setSystemTime(now + 31 * 86400_000)
  expect(await f.parent.query(api.emailWatches.recentChecks, {})).toEqual([])
  await expect(f.parent.mutation(api.emailWatches.reviewMessage, { jobId: f.job._id, sourceRevision: 1 })).rejects.toThrow('expired')
  await f.t.mutation(internal.privacy.expireSources, {})
  expect(await f.t.run(ctx => ctx.db.get(f.job._id))).toMatchObject({ emailQuiet: true })
  expect((await f.t.run(ctx => ctx.db.get(f.job._id)))?.emailTriage).toBeUndefined()
  expect(await f.parent.query(api.jobs.list, {})).toEqual([])
})
