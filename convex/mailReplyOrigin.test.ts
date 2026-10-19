import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { gmailComposeScope } from '../shared/mailbox'
import type { Id } from './_generated/dataModel'
import type { MailProposalInput } from '../shared/mailFollowthrough'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T08:00:00Z')
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development')
  vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test')
  vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'school@example.test')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

async function fixture() {
  vi.setSystemTime(now)
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope, gmailComposeScope], email: 'parent@example.test', cipher: 'synthetic-unused' }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const routineId = await parent.mutation(api.mailRoutines.create, { requestId: 'reply-origin', definition: { title: 'School replies', condition: 'New trip messages', instruction: 'Prepare a reply using the current trip details.' } })
  await parent.mutation(api.mailRoutines.setPaused, { id: routineId, version: 1, paused: false })
  vi.setSystemTime(now + 1000)
  const message = (providerId: string, text: string, receivedAt: number) => t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId, threadId: 'trip-thread', sender: 'school@example.test', subject: 'Trip', text, receivedAt, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(text), dismissed: false, expiresAt: now + 86400_000 }))
  const secondaryId = await message('trip-details', 'The coach departs at 09:00.', now + 100)
  const messageId = await message('reply-request', 'Please confirm Maya can attend.', now + 500)
  const runId = await t.run(ctx => ctx.db.insert('mailRuns', { householdId, createdBy: 'test|parent', mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey, requestId: 'reply-origin', requestHash: 'synthetic', request: 'Prepare a trip reply', kind: 'check', query: '', lookbackDays: 30, mode: 'baseline', scope: 'inbox', status: 'complete', version: 1, scanned: 1, segmentScanned: 1, from: now - 86400_000, through: now + 1000, createdAt: now, expiresAt: now + 86400_000, messageIds: [messageId], hasMore: false }))
  const primary = (await t.run(ctx => ctx.db.get(messageId)))!
  const agentId = (await t.mutation(internal.mailFollowthrough.start, { runId, runVersion: 1, sources: [{ id: messageId, version: 1, hash: primary.contentHash }] }))!
  const advance = async (version: number, result: unknown) => {
    expect(await t.mutation(internal.mailFollowthrough.claim, { id: agentId, version, lease: `step-${version}` })).not.toBeNull()
    expect(await t.mutation(internal.mailFollowthrough.advance, { id: agentId, version, lease: `step-${version}`, result: JSON.stringify(result) })).toBe(true)
  }
  await advance(1, { tool: 'read_thread', messageId, answer: '', evidence: [], proposals: [] })
  await advance(2, { tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] })
  const evidence = [{ messageId, quote: 'Please confirm Maya can attend.' }, { messageId: secondaryId, quote: 'The coach departs at 09:00.' }]
  const reply: MailProposalInput = { routineRefs: [{ id: routineId, version: 2 }], kind: 'reply', messageId, title: 'Confirm the trip', details: 'Maya’s coach leaves at 09:00.', dueDate: '', date: '', startTime: '', endTime: '', timezone: '', location: '', question: '', replyBody: 'Maya can attend. We noted the 09:00 departure.', evidence }
  const task: MailProposalInput = { ...reply, kind: 'task', title: 'Prepare for the trip', replyBody: '' }
  await advance(3, { tool: 'finish', messageId: '', answer: 'Review the reply for Maya’s 09:00 trip.', evidence, proposals: [reply, task] })
  const proposal = (await parent.query(api.mailFollowthrough.list, {})).find(p => p.kind === 'reply')!
  const draftId = await parent.mutation(api.mailFollowthrough.reviewReply, { id: proposal.id as Id<'mailProposals'>, version: proposal.version })
  const draft = (await t.run(ctx => ctx.db.get(draftId)))!
  expect(draft.mailProposalBinding).toEqual({ id: proposal.id, version: proposal.version + 1 })
  const input = draft.input
  const claimSave = async () => {
    const version = await parent.mutation(api.mailDrafts.approveSave, { id: draftId, version: 1, input })
    expect(await t.mutation(internal.mailDrafts.claimSave, { id: draftId, version, lease: 'save', readOnly: false })).not.toBeNull()
    return { id: draftId, version, lease: 'save' }
  }
  const save = async () => {
    const args = await claimSave()
    expect(await t.mutation(internal.mailDrafts.dispatch, args)).toBe(true)
    const saved = (await t.run(ctx => ctx.db.get(draftId)))!
    expect(await t.mutation(internal.mailDrafts.finished, { ...args, operationKey: saved.operationKey!, verified: true, gmailDraftId: 'synthetic-saved-draft' })).toBe(true)
    return (await t.run(ctx => ctx.db.get(draftId)))!
  }
  const claimSend = async () => {
    const saved = await save()
    const version = await parent.mutation(api.mailSending.approve, { id: draftId, version: saved.version, input })
    expect(await t.mutation(internal.mailSending.claim, { id: draftId, version, lease: 'send', readOnly: false })).not.toBeNull()
    return { id: draftId, version, lease: 'send' }
  }
  let freshPass = 0
  const refresh = async (kind: 'reply' | 'task' = 'reply') => {
    const freshRunId = await t.run(async ctx => { const { _id, _creationTime, ...run } = (await ctx.db.get(runId))!; return ctx.db.insert('mailRuns', { ...run, requestId: `fresh-pass-${++freshPass}` }) })
    const primary = (await t.run(ctx => ctx.db.get(messageId)))!
    const freshAgentId = (await t.mutation(internal.mailFollowthrough.start, { runId: freshRunId, runVersion: 1, sources: [{ id: messageId, version: primary.version, hash: primary.contentHash }] }))!
    const step = async (version: number, result: unknown) => {
      const claim = await t.mutation(internal.mailFollowthrough.claim, { id: freshAgentId, version, lease: `fresh-${version}` })
      expect(claim).not.toBeNull()
      expect(claim!.routines.every(r => !r.eligibleMessageIds.includes(messageId))).toBe(true)
      expect(await t.mutation(internal.mailFollowthrough.advance, { id: freshAgentId, version, lease: `fresh-${version}`, result: JSON.stringify(result) })).toBe(true)
    }
    await step(1, { tool: 'read_thread', messageId, answer: '', evidence: [], proposals: [] })
    await step(2, { tool: 'family_context', messageId: '', answer: '', evidence: [], proposals: [] })
    const secondary = (await t.run(ctx => ctx.db.get(secondaryId)))!
    const freshEvidence = [{ messageId, quote: primary.text }, { messageId: secondaryId, quote: secondary.text }]
    const freshInput = { ...(kind === 'reply' ? reply : task), routineRefs: undefined, details: secondary.text, replyBody: kind === 'reply' ? `Maya can attend. ${secondary.text}` : '', evidence: freshEvidence }
    await step(3, { tool: 'finish', messageId: '', answer: 'Review the current trip details.', evidence: freshEvidence, proposals: [freshInput] })
    return (await parent.query(api.mailFollowthrough.list, {})).find(p => p.kind === kind)!
  }
  return { t, parent, householdId, messageId, secondaryId, routineId, proposalId: proposal.id as Id<'mailProposals'>, draftId, input, claimSave, save, claimSend, refresh }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function change(f: Fixture, kind: 'secondary' | 'family') {
  if (kind === 'secondary') await f.t.run(ctx => ctx.db.patch(f.secondaryId, { version: 2, text: 'Correction: coach departs at 10:00.', contentHash: sourceHash('Correction: coach departs at 10:00.') }))
  else await f.parent.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  expect((await f.parent.query(api.mailFollowthrough.list, {})).find(p => p.id === f.proposalId)!.stale).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(f.messageId)))!.version).toBe(1)
}

it.each(['secondary', 'family'] as const)('blocks editing and fresh Gmail approvals after %s context changes following private handoff', async kind => {
  const f = await fixture(); await change(f, kind)
  await expect(f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: f.input })).rejects.toThrow('supporting email preparation changed')
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id: f.draftId, version: 1, input: f.input })).rejects.toThrow('supporting email preparation changed')
})
it.each(['secondary', 'family'] as const)('blocks an already-saved Gmail draft send after %s context changes', async kind => {
  const f = await fixture(), saved = await f.save(); await change(f, kind)
  await expect(f.parent.mutation(api.mailSending.approve, { id: f.draftId, version: saved.version, input: f.input })).rejects.toThrow('supporting email preparation changed')
  expect((await f.t.run(ctx => ctx.db.get(f.draftId)))!.gmailDraftId).toBe('synthetic-saved-draft')
})
it.each(['secondary', 'family'] as const)('stops already-approved Gmail save and send dispatch after %s context changes', async kind => {
  const saving = await fixture(), saveArgs = await saving.claimSave(); await change(saving, kind)
  expect(await saving.t.query(internal.mailDrafts.permitted, saveArgs)).toBe(false)
  expect(await saving.t.mutation(internal.mailDrafts.dispatch, saveArgs)).toBe(false)
  const sending = await fixture(), sendArgs = await sending.claimSend(); await change(sending, kind)
  expect(await sending.t.query(internal.mailSending.permitted, { ...sendArgs, readOnly: false })).toBe(false)
  expect(await sending.t.mutation(internal.mailSending.dispatch, sendArgs)).toBe(false)
})
it.each(['secondary', 'family'] as const)('records authoritative already-dispatched save/send results despite later %s context changes', async kind => {
  const f = await fixture(), args = await f.claimSave()
  expect(await f.t.mutation(internal.mailDrafts.dispatch, args)).toBe(true)
  const before = (await f.t.run(ctx => ctx.db.get(f.draftId)))!
  await change(f, kind)
  expect(await f.t.mutation(internal.mailDrafts.recordProviderId, { ...args, operationKey: before.operationKey!, gmailDraftId: 'synthetic-returned-draft' })).toBe(true)
  expect(await f.t.mutation(internal.mailDrafts.finished, { ...args, operationKey: before.operationKey!, gmailDraftId: 'synthetic-returned-draft', verified: true })).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(f.draftId)))!.status).toBe('saved')
  const sending = await fixture(), sendArgs = await sending.claimSend()
  expect(await sending.t.mutation(internal.mailSending.dispatch, sendArgs)).toBe(true)
  const dispatched = (await sending.t.run(ctx => ctx.db.get(sending.draftId)))!
  await change(sending, kind)
  expect(await sending.t.mutation(internal.mailSending.recordId, { ...sendArgs, operationKey: dispatched.sendOperationKey!, sentMessageId: 'synthetic-sent-message' })).toBe(true)
  expect(await sending.t.mutation(internal.mailSending.finished, { ...sendArgs, operationKey: dispatched.sendOperationKey!, sentMessageId: 'synthetic-sent-message', verified: true })).toBe(true)
  expect((await sending.t.run(ctx => ctx.db.get(sending.draftId)))!.status).toBe('sent')
})
it('invalidates replaced/deleted proposal origins and rejects a transplanted draft backlink', async () => {
  for (const kind of ['replace', 'delete', 'backlink'] as const) {
    const f = await fixture()
    await f.t.run(async ctx => {
      if (kind === 'delete') await ctx.db.delete(f.proposalId)
      else if (kind === 'replace') await ctx.db.patch(f.proposalId, { version: 3 })
      else await ctx.db.patch(f.proposalId, { draftId: undefined })
    })
    await expect(f.parent.mutation(api.mailDrafts.approveSave, { id: f.draftId, version: 1, input: f.input })).rejects.toThrow('supporting email preparation changed')
  }
})
it('cannot reset a stale origin into a newly approved send', async () => {
  const f = await fixture(), saved = await f.save()
  await f.t.run(ctx => ctx.db.patch(f.draftId, { status: 'send_failed' }))
  await change(f, 'secondary')
  await expect(f.parent.mutation(api.mailSending.reviewAgain, { id: f.draftId, version: saved.version })).rejects.toThrow('supporting email preparation changed')
})
it('keeps legacy independent drafts compatible without inventing a proposal dependency', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.draftId, { mailProposalBinding: undefined, mailRoutineBindings: undefined }))
  await change(f, 'secondary')
  expect(await f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: f.input })).toBe(2)
})

it.each(['secondary', 'family'] as const)('refreshes unaccepted %s corrections and retains the original routine provenance without replaying its decision', async kind => {
  const f = await fixture(); await change(f, kind)
  const fresh = await f.refresh()
  expect(fresh).toMatchObject({ id: f.proposalId, version: 3, status: 'review', stale: false, routineRefs: [{ id: f.routineId, version: 2 }] })
  const row = (await f.t.run(ctx => ctx.db.get(f.proposalId)))!
  expect(row.draftId).toBeUndefined()
  expect(row.mailRoutineBindings).toEqual([expect.objectContaining({ routineId: f.routineId, routineVersion: 2 })])
  expect(row.sources.find(s => s.id === f.secondaryId)!.version).toBe(kind === 'secondary' ? 2 : 1)
  if (kind === 'secondary') expect(fresh.replyBody).toContain('10:00')
  expect(await f.t.run(ctx => ctx.db.query('mailRoutineDecisions').collect())).toHaveLength(2)
  await expect(f.parent.mutation(api.mailDrafts.edit, { id: f.draftId, version: 1, input: f.input })).rejects.toThrow('supporting email preparation changed')
  const freshDraft = await f.parent.mutation(api.mailFollowthrough.reviewReply, { id: f.proposalId, version: fresh.version })
  expect(freshDraft).not.toBe(f.draftId)
  const current = (await f.t.run(ctx => ctx.db.get(freshDraft)))!
  await f.parent.mutation(api.mailRoutines.setPaused, { id: f.routineId, version: 2, paused: true })
  await expect(f.parent.mutation(api.mailDrafts.approveSave, { id: freshDraft, version: current.version, input: current.input })).rejects.toThrow('changed')
})
it.each(['pause', 'remove'] as const)('cannot erase %s routine provenance by refreshing corrected generic work', async kind => {
  const f = await fixture(); await change(f, 'secondary')
  if (kind === 'pause') await f.parent.mutation(api.mailRoutines.setPaused, { id: f.routineId, version: 2, paused: true })
  else await f.parent.mutation(api.mailRoutines.remove, { id: f.routineId, version: 2 })
  const old = (await f.t.run(ctx => ctx.db.get(f.proposalId)))!
  const fresh = await f.refresh()
  expect(fresh).toMatchObject({ id: f.proposalId, version: old.version, stale: true, routineRefs: old.input.routineRefs })
  expect((await f.t.run(ctx => ctx.db.get(f.proposalId)))!.mailRoutineBindings).toEqual(old.mailRoutineBindings)
})
it.each(['keep', 'dismiss', 'snooze'] as const)('preserves an explicit %s decision when only secondary context changes', async operation => {
  const f = await fixture(), task = (await f.parent.query(api.mailFollowthrough.list, {})).find(p => p.kind === 'task')!
  await f.parent.mutation(api.mailFollowthrough.decide, { id: task.id as Id<'mailProposals'>, version: task.version, operation, ...(operation === 'snooze' ? { until: now + 3600_000 } : {}) })
  const decided = (await f.t.run(ctx => ctx.db.get(task.id as Id<'mailProposals'>)))!
  if (operation === 'keep') {
    await f.parent.mutation(api.privateTasks.remove, { id: decided.privateTaskId!, version: 1 })
  }
  await change(f, 'secondary')
  const fresh = await f.refresh('task')
  expect(fresh).toMatchObject({ id: task.id, version: decided.version, status: decided.status })
  expect((await f.parent.query(api.privateTasks.list, {})).tasks).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(task.id as Id<'mailProposals'>))).toEqual(decided)
})
