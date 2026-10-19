import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { event } from '../tests/fixtures/calendar'
import { extractStructured } from '../server/model'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts')
const email = { kind: 'email' as const, childId: 'maya', to: 'teacher@example.test', subject: 'Trip RSVP', body: 'Thank you for organizing the field trip. Maya will attend on Friday.', requirement: '', evidence: {} }
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic field trip RSVP requested for Friday.', hash: 'fixture', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|alice', preparing: false, cancelled: false, clarification: '' })
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, payload: email, status: 'review' })
    await ctx.db.insert('connections', { householdId, subject: 'test|alice', version: 1, status: 'active', scopes: ['https://www.googleapis.com/auth/gmail.send'], email: 'parent@example.test' })
    return { sourceId, jobId, actionId }
  })
  const request = () => alice.mutation(api.revisions.request, { actionId: ids.actionId, revision: 1, instruction: 'Make it shorter.' })
  return { t, alice, householdId, ...ids, request }
}
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'teacher@example.test'); vi.mocked(extractStructured).mockReset() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

it('cancels queued approval, refuses approval while revising, and requires a new revision afterward', async () => {
  const f = await fixture()
  await f.alice.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1 }] })
  const old = (await f.t.run(ctx => ctx.db.query('approvals').collect()))[0]
  expect(await f.request()).toBe(2)
  expect(await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: old._id })).toBeNull()
  await expect(f.alice.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 2 }] })).rejects.toThrow('revised draft')
  expect(await f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'Maya will attend Friday.' }, clarification: '' })).toBe(true)
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action).toMatchObject({ revision: 3, status: 'review', payload: { body: 'Maya will attend Friday.' } })
  expect(action?.approvalId).toBeUndefined(); expect(action?.revisionRequest).toBeUndefined()
  await expect(f.alice.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1 }] })).rejects.toThrow('changed')
  await f.alice.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 3 }] })
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toHaveLength(2)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
})
it('never overwrites manual edits, a kept draft, a changed source, cancellation, or a deleted household', async () => {
  for (const change of ['manual', 'keep', 'source', 'cancel', 'delete']) {
    const f = await fixture(); await f.request()
    if (change === 'manual') await f.alice.mutation(api.jobs.edit, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'My newer manual correction.' } })
    if (change === 'keep') await f.alice.mutation(api.revisions.cancel, { actionId: f.actionId, revision: 2 })
    if (change === 'source') await f.alice.mutation(api.jobs.reviseSource, { jobId: f.jobId, revision: 1, text: 'Synthetic revised notice' })
    if (change === 'cancel') await f.alice.mutation(api.jobs.cancel, { jobId: f.jobId })
    if (change === 'delete') await f.t.run(ctx => ctx.db.patch(f.householdId, { deleted: true }))
    expect(await f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'An obsolete model response.' }, clarification: '' })).toBe(false)
    expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload.body).toBe(change === 'manual' ? 'My newer manual correction.' : email.body)
  }
})
it('fails safely on timeout without deleting the previous draft or allowing a late result', async () => {
  const f = await fixture(); await f.request(); vi.advanceTimersByTime(120001)
  expect(await f.t.query(internal.revisions.context, { actionId: f.actionId, revision: 2 })).toBeNull()
  expect(await f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: email, clarification: '' })).toBe(false)
  await f.t.mutation(internal.revisions.fail, { actionId: f.actionId, revision: 2 })
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action).toMatchObject({ revision: 3, status: 'review', payload: email })
  expect(action?.error).toContain('previous draft is preserved')
  expect(action?.revisionRequest).toBeUndefined()
})

it('blocks model context and late revised output after the requesting adult loses household access', async () => {
  const f = await fixture(); await f.request()
  await f.t.run(async ctx => { const member = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|alice')).unique(); await ctx.db.delete(member!._id) })
  expect(await f.t.query(internal.revisions.context, { actionId: f.actionId, revision: 2 })).toBeNull()
  expect(await f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'Obsolete model output' }, clarification: '' })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload.body).toBe(email.body)
})
it('denies wrong-household, stale, missing-model, and already-dispatched requests', async () => {
  const f = await fixture(), bob = f.t.withIdentity({ subject: 'bob' })
  await bob.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await expect(bob.mutation(api.revisions.request, { actionId: f.actionId, revision: 1, instruction: 'Shorter' })).rejects.toThrow('unavailable')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  await expect(f.request()).rejects.toThrow('not connected')
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.revision).toBe(1)
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic')
  await expect(f.alice.mutation(api.revisions.request, { actionId: f.actionId, revision: 99, instruction: 'Shorter' })).rejects.toThrow('changed')
  for (const status of ['executing', 'succeeded', 'waiting', 'uncertain', 'cancelled']) {
    await f.t.run(ctx => ctx.db.patch(f.actionId, { status }))
    await expect(f.request()).rejects.toThrow('already started')
  }
})
it('rejects another action type or an unrelated attachment in the model result', async () => {
  const f = await fixture(); await f.request()
  await expect(f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: event, clarification: '' })).rejects.toThrow('action type')
  await expect(f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, attachments: [{ id: 'not-a-shared-file', name: 'other.pdf', hash: 'unknown' }] }, clarification: '' })).rejects.toThrow('attachment changed or expired')
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload).toEqual(email)
})
it('uses the saved draft as context, strips invented source quotes, and records a model revision without sending', async () => {
  const f = await fixture(); await f.request()
  vi.mocked(extractStructured).mockResolvedValue({ payload: { ...email, body: 'Maya will attend Friday.', evidence: { date: 'Friday', body: 'Invented quote' } }, clarification: '' })
  await f.t.action(internal.preparation.revise, { actionId: f.actionId, revision: 2 })
  const input = vi.mocked(extractStructured).mock.calls[0][2] as any
  expect(input.parentInstruction).toBe('Make it shorter.'); expect(input.currentDraft).toEqual(email)
  expect(input).not.toHaveProperty('connection')
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action?.payload.evidence).toEqual({ date: 'Friday' }); expect(action?.status).toBe('review')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toHaveLength(0)
})
it('source retention removes a pending revision instruction and prevents it restarting after expiry', async () => {
  const f = await fixture(); await f.request()
  await f.t.run(ctx => ctx.db.patch(f.sourceId, { expiresAt: Date.now() - 1 }))
  await f.t.mutation(internal.privacy.expireSources, {})
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action?.revisionRequest).toBeUndefined()
  await expect(f.alice.mutation(api.revisions.request, { actionId: f.actionId, revision: action!.revision, instruction: 'Try again' })).rejects.toThrow('expired')
})
it('keeps a portal or signature requirement when the model shortens an email', async () => {
  const f = await fixture(), requirement = 'Use the school portal to sign the form. Email is not a submission.'
  await f.t.run(ctx => ctx.db.patch(f.actionId, { payload: { ...email, requirement } }))
  await f.request()
  await f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'Please confirm receipt.', requirement: '' }, clarification: '' })
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload.requirement).toBe(requirement)
  await expect(f.alice.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 3 }] })).rejects.toThrow('school portal')
})
it('the durable revision workflow finishes after the requesting client leaves', async () => {
  const f = await fixture()
  vi.mocked(extractStructured).mockResolvedValue({ payload: { ...email, body: 'Maya will attend Friday.' }, clarification: '' })
  await f.request()
  // Advance execution in small steps; jumping to every timer also jumps straight
  // to the intentional two-minute watchdog before queued work can start.
  for (let n = 0; n < 40; n++) {
    await vi.advanceTimersByTimeAsync(25)
    await f.t.finishInProgressScheduledFunctions()
    if (!(await f.t.run(ctx => ctx.db.get(f.actionId)))?.revisionRequest) break
  }
  expect(vi.mocked(extractStructured)).toHaveBeenCalledOnce()
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action).toMatchObject({ status: 'review', revision: 3, payload: { body: 'Maya will attend Friday.' } })
  expect(action?.revisionRequest).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
})
it('preserves the draft if an original attachment disappears before a requested revision', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(['synthetic image']))
    const fileId = await ctx.db.insert('attachments', { householdId: f.householdId, sourceId: f.sourceId, subject: 'test|alice', storageId, name: 'notice.png', size: 15, hash: 'synthetic-file', mediaType: 'image/png', status: 'ready', expiresAt: Date.now() - 1 })
    await ctx.db.patch(f.sourceId, { attachmentIds: [fileId] })
  })
  await f.request()
  await f.t.action(internal.preparation.revise, { actionId: f.actionId, revision: 2 })
  const action = await f.t.run(ctx => ctx.db.get(f.actionId))
  expect(action?.payload).toEqual(email)
  expect(action?.revisionRequest).toBeUndefined()
  expect(action?.error).toContain('previous draft is preserved')
  expect(extractStructured).not.toHaveBeenCalled()
})
it('rejects a revision that finishes after an original file expires', async () => {
  const f = await fixture()
  const fileId = await f.t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(['synthetic image']))
    const id = await ctx.db.insert('attachments', { householdId: f.householdId, sourceId: f.sourceId, subject: 'test|alice', storageId, name: 'notice.png', size: 15, hash: 'synthetic-file', mediaType: 'image/png', status: 'ready', expiresAt: Date.now() + 10000 })
    await ctx.db.patch(f.sourceId, { attachmentIds: [id] })
    return id
  })
  await f.request()
  expect(await f.t.query(internal.revisions.context, { actionId: f.actionId, revision: 2 })).not.toBeNull()
  await f.t.run(ctx => ctx.db.patch(fileId, { expiresAt: Date.now() - 1 }))
  await expect(f.t.mutation(internal.revisions.finish, { actionId: f.actionId, revision: 2, payload: { ...email, body: 'Maya will attend.' }, clarification: '' })).rejects.toThrow('original file changed or expired')
  await f.t.mutation(internal.revisions.fail, { actionId: f.actionId, revision: 2 })
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.payload).toEqual(email)
})
