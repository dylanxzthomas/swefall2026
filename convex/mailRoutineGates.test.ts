import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash, sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope } from '../shared/mailbox'
import { event } from '../tests/fixtures/calendar'
import { availableRoutineMessages, routineBinding, routineMessageKey } from './mailRoutines'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T08:00:00Z')
const definition = { title: 'Private school routine', condition: 'New school emails about trips.', instruction: 'Prepare a private permission form reminder.' }
const reply = { to: 'school@example.test', subject: 'Re: Trip', body: 'We will return the reviewed form.' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'school@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, email: 'parent@example.test', calendarId: 'synthetic-calendar', cipher: 'synthetic-unused', scopes: [gmailReadScope, gmailComposeScope, 'https://www.googleapis.com/auth/calendar.app.created'] }))
  await parent.mutation(api.connections.choose, { id: connectionId, purpose: 'calendar', version: 0 })
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const routineId = await parent.mutation(api.mailRoutines.create, { definition, requestId: 'synthetic-routine' })
  await parent.mutation(api.mailRoutines.setPaused, { id: routineId, version: 1, paused: false })
  vi.setSystemTime(now + 1000)
  const messageId = await t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: 'synthetic-private-source', threadId: 'synthetic-thread', sender: 'school@example.test', subject: 'Private trip notice', receivedAt: now + 500, text: 'Private source body. Return the permission form.', extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash('Private source body. Return the permission form.'), dismissed: false, expiresAt: now + 86400_000 }))
  const { binding, snapshot } = await t.run(async ctx => {
    const r = (await ctx.db.get(routineId))!, m = (await ctx.db.get(messageId))!, box = (await ctx.db.get(mailboxId))!
    const snapshot = { id: routineId, version: r.version, definitionHash: r.definitionHash, activatedAt: r.activatedAt! }
    return { binding: routineBinding(snapshot, box, m), snapshot }
  })
  const insertDraft = (saved = false) => t.run(ctx => ctx.db.insert('mailDrafts', { householdId, createdBy: 'test|parent', mailRoutineBindings: [binding], messageId, mailboxId, sourceVersion: 1, sourceHash: binding.sourceHash, connectionId, connectionVersion: 1, accountKey, accountEmail: 'parent@example.test', version: 1, input: reply, instruction: 'Parent reviewed exact reply.', preparationKey: `synthetic-${saved}`, status: saved ? 'saved' : 'review', createdAt: Date.now(), expiresAt: binding.expiresAt, ...(saved ? { gmailDraftId: 'synthetic-saved-draft', operationKey: hash('synthetic-save'), approvedHash: hash(JSON.stringify(reply)), approvedAt: Date.now(), verifiedAt: Date.now() } : {}) }))
  const draftId = await insertDraft(), savedDraftId = await insertDraft(true)
  const { sourceId, jobId, actionId } = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Parent-selected shared trip details only.', hash: 'synthetic-reviewed-share', revision: 1, expiresAt: binding.expiresAt })
    const jobId = await ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, mailRoutineBindings: [binding], preparing: false, cancelled: false, clarification: 'Shared reviewed calendar preparation.' })
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, status: 'review', payload: event })
    return { sourceId, jobId, actionId }
  })
  const approveCalendar = () => parent.mutation(api.jobs.approve, { actions: [{ id: actionId, revision: 1, selectionVersion: 1 }] })
  const approveAndClaim = async () => {
    await parent.mutation(api.mailDrafts.approveSave, { id: draftId, version: 1, input: reply })
    await t.mutation(internal.mailDrafts.claimSave, { id: draftId, version: 2, lease: 'save', readOnly: false })
    await parent.mutation(api.mailSending.approve, { id: savedDraftId, version: 1, input: reply })
    await t.mutation(internal.mailSending.claim, { id: savedDraftId, version: 2, lease: 'send', readOnly: false })
    await approveCalendar()
    const a = (await t.run(ctx => ctx.db.get(actionId)))!
    return (await t.mutation(internal.execution.claim, { actionId, approvalId: a.approvalId! }))!
  }
  return { t, parent, other, householdId, connectionId, mailboxId, messageId, routineId, binding, snapshot, draftId, savedDraftId, sourceId, jobId, actionId, approveCalendar, approveAndClaim }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function change(f: Fixture, kind: string) {
  if (kind === 'pause') return f.parent.mutation(api.mailRoutines.setPaused, { id: f.routineId, version: 2, paused: true })
  if (kind === 'edit') return f.parent.mutation(api.mailRoutines.update, { id: f.routineId, version: 2, definition: { ...definition, instruction: 'Prepare a different reviewed task.' } })
  if (kind === 'remove') return f.parent.mutation(api.mailRoutines.remove, { id: f.routineId, version: 2 })
  await f.t.run(async ctx => {
    if (kind === 'rebind') await ctx.db.patch(f.routineId, { mailboxVersion: 2 })
    if (kind === 'source') await ctx.db.patch(f.messageId, { version: 2, contentHash: 'corrected-source' })
    if (kind === 'expiry') await ctx.db.patch(f.messageId, { expiresAt: Date.now() })
    if (kind === 'dismiss') await ctx.db.patch(f.messageId, { dismissed: true })
    if (kind === 'mailbox') await ctx.db.patch(f.mailboxId, { state: 'paused', version: 2 })
    if (kind === 'grant') await ctx.db.patch(f.connectionId, { version: 2, status: 'revoked' })
    if (kind === 'household') await ctx.db.patch(f.householdId, { deleted: true })
    if (kind === 'member') { const row = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(row!._id) }
    if (kind === 'thread') { const { _id, _creationTime, ...m } = (await ctx.db.get(f.messageId))!; await ctx.db.insert('mailMessages', { ...m, providerId: 'newer-source', receivedAt: Date.now() + 1 }) }
  })
}

it('keeps private routine references out of shared jobs and isolates private drafts and settings by adult', async () => {
  const f = await fixture()
  const shared = await f.other.query(api.jobs.list, {})
  expect(shared).toHaveLength(1)
  expect(shared[0]).not.toHaveProperty('mailRoutineBindings')
  expect(JSON.stringify(shared)).not.toMatch(/Private source body|Private school routine|synthetic-private-source|definitionHash|activatedAt/)
  expect(await f.other.query(api.mailDrafts.list, {})).toEqual([])
  expect(await f.other.query(api.mailRoutines.list, {})).toEqual([])
  await expect(f.other.query(api.mailRoutines.history, { id: f.routineId })).rejects.toThrow('unavailable')
  await expect(f.other.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: reply })).rejects.toThrow('unavailable')
})
it.each(['pause', 'edit', 'remove', 'rebind'])('blocks fresh review/edit/save/send/shared approval after routine %s and never reactivates an old binding on replay', async kind => {
  const f = await fixture(); await change(f, kind)
  await expect(f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: reply })).rejects.toThrow('routine')
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id: f.draftId, version: 1, input: reply })).rejects.toThrow('routine')
  await expect(f.parent.mutation(api.mailSending.approve, { id: f.savedDraftId, version: 1, input: reply })).rejects.toThrow('routine')
  await expect(f.approveCalendar()).rejects.toThrow('routine')
  await expect(f.parent.mutation(api.jobs.edit, { actionId: f.actionId, revision: 1, payload: event })).rejects.toThrow('routine')
  await expect(f.parent.mutation(api.jobs.reviseSource, { jobId: f.jobId, revision: 1, text: 'Try to reuse stale work.' })).rejects.toThrow('routine')
  await expect(f.parent.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: event })).rejects.toThrow('routine')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  if (kind === 'pause') { await f.parent.mutation(api.mailRoutines.setPaused, { id: f.routineId, version: 3, paused: false }); await expect(f.approveCalendar()).rejects.toThrow('routine') }
})
it.each(['pause', 'edit', 'remove', 'rebind', 'source', 'expiry', 'dismiss', 'mailbox', 'grant', 'household', 'member', 'thread'])('stops already-approved private saves, sends and shared calendar dispatch after %s changes', async kind => {
  const f = await fixture(), claim = await f.approveAndClaim(); await change(f, kind)
  expect(await f.t.query(internal.mailDrafts.permitted, { id: f.draftId, version: 2, lease: 'save' })).toBe(false)
  expect(await f.t.mutation(internal.mailDrafts.dispatch, { id: f.draftId, version: 2, lease: 'save' })).toBe(false)
  expect(await f.t.query(internal.mailSending.permitted, { id: f.savedDraftId, version: 2, lease: 'send', readOnly: false })).toBe(false)
  expect(await f.t.mutation(internal.mailSending.dispatch, { id: f.savedDraftId, version: 2, lease: 'send' })).toBe(false)
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim.attemptId })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it.each(['pause', 'edit', 'remove', 'grant'])('records already-dispatched save/send/calendar truth after %s without allowing another dispatch', async kind => {
  const f = await fixture(), claim = await f.approveAndClaim()
  expect(await f.t.mutation(internal.mailDrafts.dispatch, { id: f.draftId, version: 2, lease: 'save' })).toBe(true)
  expect(await f.t.mutation(internal.mailSending.dispatch, { id: f.savedDraftId, version: 2, lease: 'send' })).toBe(true)
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim.attemptId })).toBe(true)
  const save = (await f.t.run(ctx => ctx.db.get(f.draftId)))!, send = (await f.t.run(ctx => ctx.db.get(f.savedDraftId)))!
  await change(f, kind)
  expect(await f.t.mutation(internal.mailDrafts.recordProviderId, { id: f.draftId, version: 2, lease: 'save', operationKey: save.operationKey!, gmailDraftId: 'synthetic-returned-draft' })).toBe(true)
  expect(await f.t.mutation(internal.mailDrafts.finished, { id: f.draftId, version: 2, lease: 'save', operationKey: save.operationKey!, verified: true, gmailDraftId: 'synthetic-returned-draft' })).toBe(true)
  expect(await f.t.mutation(internal.mailSending.recordId, { id: f.savedDraftId, version: 2, lease: 'send', operationKey: send.sendOperationKey!, sentMessageId: 'synthetic-returned-send' })).toBe(true)
  expect(await f.t.mutation(internal.mailSending.finished, { id: f.savedDraftId, version: 2, lease: 'send', operationKey: send.sendOperationKey!, verified: true, sentMessageId: 'synthetic-returned-send' })).toBe(true)
  await f.t.mutation(internal.execution.finish, { attemptId: claim.attemptId, status: 'succeeded', providerId: 'synthetic-returned-event', etag: 'synthetic-etag' })
  await f.t.mutation(internal.execution.finish, { attemptId: claim.attemptId, status: 'succeeded', providerId: 'synthetic-returned-event', etag: 'synthetic-etag' })
  expect((await f.t.run(ctx => ctx.db.get(f.draftId)))!.status).toBe('saved')
  expect((await f.t.run(ctx => ctx.db.get(f.savedDraftId)))!.status).toBe('sent')
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(1)
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim.attemptId })).toBe(false)
})
it('rejects valid routine bindings transplanted to another source or another adult’s shared job', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const { _id, _creationTime, ...m } = (await ctx.db.get(f.messageId))!
    const secondId = await ctx.db.insert('mailMessages', { ...m, providerId: 'another-source', threadId: 'another-thread' })
    await ctx.db.patch(f.draftId, { mailRoutineBindings: [{ ...f.binding, messageId: secondId }] })
    await ctx.db.patch(f.jobId, { createdBy: 'test|other' })
  })
  await expect(f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: reply })).rejects.toThrow('binding changed')
  await expect(f.other.mutation(api.jobs.approve, { actions: [{ id: f.actionId, revision: 1 }] })).rejects.toThrow('binding changed')
})
it('serializes concurrent review edits and cannot reset a stale failed send for a fresh approval', async () => {
  const f = await fixture()
  const edits = await Promise.allSettled(Array.from({ length: 20 }, () => f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: reply })))
  expect(edits.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  await f.t.run(ctx => ctx.db.patch(f.savedDraftId, { status: 'send_failed' }))
  await change(f, 'pause')
  await expect(f.parent.mutation(api.mailSending.reviewAgain, { id: f.savedDraftId, version: 1 })).rejects.toThrow('routine')
  expect((await f.t.run(ctx => ctx.db.get(f.savedDraftId)))!.status).toBe('send_failed')
})

it('redacts expired decision references past existing tombstones and preserves hashed deduplication across source reimports', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const key = routineMessageKey((await ctx.db.get(f.messageId))!)
    for (let i = 0; i < 101; i++) await ctx.db.insert('mailRoutineDecisions', { householdId: f.householdId, createdBy: 'test|parent', routineId: f.routineId, routineVersion: 2, key: `old-tombstone-${i}`, decision: 'skipped', createdAt: now })
    for (let i = 0; i < 150; i++) await ctx.db.insert('mailRoutineDecisions', { householdId: f.householdId, createdBy: 'test|parent', routineId: f.routineId, routineVersion: 2, key: i ? `expired-${i}` : key, decision: 'prepared', createdAt: now, mailboxId: f.mailboxId, messageId: f.messageId, sourceVersion: 1, sourceHash: f.binding.sourceHash, proposalIds: [], expiresAt: now })
  })
  await f.t.mutation(internal.privacy.expireSources, {})
  await f.t.mutation(internal.mailRoutineRetention.expire, {})
  const decisions = await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())
  expect(decisions).toHaveLength(251)
  expect(decisions.every(row => row.expiresAt === undefined && row.messageId === undefined && row.mailboxId === undefined && row.sourceHash === undefined && row.proposalIds === undefined)).toBe(true)
  expect(JSON.stringify(decisions)).not.toMatch(/Private source body|synthetic-private-source|Private school routine|permission form/)
  const eligible = await f.t.run(async ctx => availableRoutineMessages(ctx, [f.snapshot], [(await ctx.db.get(f.messageId))!]))
  expect(eligible).toEqual([])
  const history = await f.parent.query(api.mailRoutines.history, { id: f.routineId })
  expect(history).toHaveLength(30); expect(history.every(row => row.status === 'expired' && !row.runId)).toBe(true)
})
it('redacts source-bound history on mailbox removal while keeping content-free replay protection', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (let i = 0; i < 150; i++) await ctx.db.insert('mailRoutineDecisions', { householdId: f.householdId, createdBy: 'test|parent', routineId: f.routineId, routineVersion: 2, key: `mailbox-${i}`, decision: 'prepared', createdAt: now, mailboxId: f.mailboxId, messageId: f.messageId, sourceVersion: 1, sourceHash: f.binding.sourceHash, expiresAt: now + 86400_000 })
  })
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId }); await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  const decisions = await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())
  expect(decisions).toHaveLength(150); expect(decisions.every(row => !row.mailboxId && !row.messageId && !row.expiresAt)).toBe(true)
  expect(await f.t.run(ctx => ctx.db.query('mailMessages').collect())).toEqual([])
  await expect(f.approveCalendar()).rejects.toThrow('routine')
})
it('expires raw email and private replies, scrubs shared evidence, and leaves only content-free decision history', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    await ctx.db.insert('mailRoutineDecisions', { householdId: f.householdId, createdBy: 'test|parent', routineId: f.routineId, routineVersion: 2, key: routineMessageKey((await ctx.db.get(f.messageId))!), decision: 'prepared', createdAt: now, mailboxId: f.mailboxId, messageId: f.messageId, sourceVersion: 1, sourceHash: f.binding.sourceHash, expiresAt: f.binding.expiresAt })
    await ctx.db.patch(f.actionId, { payload: { ...event, evidence: { date: 'Private source body. Return the permission form.' } } })
  })
  vi.setSystemTime(now + 86400_001)
  await f.t.mutation(internal.privacy.expireSources, {})
  await f.t.mutation(internal.mailDrafts.purgeExpired, {})
  expect(await f.t.run(ctx => ctx.db.get(f.messageId))).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('mailDrafts').collect())).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(f.sourceId)))!.text).toBeUndefined()
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))!.payload.evidence).toEqual({})
  const row = (await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').first()))!
  expect(row.messageId).toBeUndefined(); expect(row.sourceHash).toBeUndefined(); expect(row.expiresAt).toBeUndefined()
  expect(JSON.stringify(await f.other.query(api.jobs.list, {}))).not.toMatch(/Private source body|Private school routine|mailRoutineBindings/)
  const history = await f.parent.query(api.mailRoutines.history, { id: f.routineId })
  expect(history).toMatchObject([{ status: 'expired', summary: 'The original email has expired.' }])
})
it('erases routine definitions and all decision batches with their household', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (let i = 0; i < 151; i++) await ctx.db.insert('mailRoutineDecisions', { householdId: f.householdId, createdBy: 'test|parent', routineId: f.routineId, routineVersion: 2, key: `erase-${i}`, decision: 'skipped', createdAt: now })
  })
  await f.parent.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  const deletion = (await f.t.run(ctx => ctx.db.query('deletionJobs').first()))!
  for (let i = 0; i < 4; i++) await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion._id })
  expect(await f.t.run(ctx => ctx.db.query('mailRoutines').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(f.householdId))).toBeNull()
})
