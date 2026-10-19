import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { extractStructured } from '../server/model'
import { gmailReadScope } from '../shared/emailWatches'
import { sourceHash } from '../shared/daymark'
import { unavailableMailContext } from './mailConversation'
import { event } from '../tests/fixtures/calendar'
import { coordinatorStep } from '../shared/assistantCoordinator'
import { unavailableConversationResponse } from '../server/modelMessages'
vi.mock('../server/model', async importOriginal => ({ ...await importOriginal<typeof import('../server/model')>(), extractStructured: vi.fn() }))
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-08T07:00:00Z')
const body = 'Please return Maya’s museum trip form by October 12. The bus leaves at 8 AM.'
const answer = (text: string) => coordinatorStep.parse({ tool: 'finish', query: '', id: '', from: '', through: '', answer: text, drafts: [] })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.mocked(extractStructured).mockReset()
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test')
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test', cipher: 'must-not-enter-model' }))
  const mailboxId = await parent.mutation(api.mailbox.enable, { connectionId, connectionVersion: 1, lookbackDays: 30, consent: true })
  const runId = (await t.run(ctx => ctx.db.get(mailboxId)))!.activeRunId!
  const args = { id: runId, version: 1, lease: 'synthetic-lease' }
  await t.mutation(internal.mailbox.claim, args)
  await t.mutation(internal.mailbox.finishBatch, { ...args, messages: [{ providerId: 'synthetic-message', sender: 'school@example.test', subject: 'Museum trip form', receivedAt: now - 1000, text: body, extraction: { format: 'plain', incomplete: false, truncated: false, attachments: false, issues: [] }, labels: ['INBOX'] }], removedIds: [], baselineHistoryId: '123' })
  const message = (await parent.query(api.mailbox.messages, {}))[0]
  const source = (await t.run(ctx => ctx.db.get(message.id as import('./_generated/dataModel').Id<'mailMessages'>)))!
  await t.mutation(internal.mailbox.finishSummary, { id: runId, version: 1, sources: [{ id: source._id, version: source.version, hash: source.contentHash }], answer: 'Maya’s museum trip form needs a reply by October 12.', evidence: [{ messageId: message.id, quote: 'Please return Maya’s museum trip form by October 12.' }] })
  // Keep the question after its email check in the durable chronology.
  vi.setSystemTime(now + 1000)
  const question = () => parent.mutation(api.jobs.submit, { text: 'Which one needs a reply?' })
  return { t, parent, other, householdId, connectionId, mailboxId, runId, messageId: message.id as import('./_generated/dataModel').Id<'mailMessages'>, question }
}

it('supplies source-backed email context to conversation and persists only an adult-private reply', async () => {
  const f = await fixture(), id = await f.question()
  vi.mocked(extractStructured).mockResolvedValue(answer('The Museum trip form email needs your response by October 12.'))
  await f.t.action(internal.preparation.prepare, { jobId: id, sourceRevision: 1 })
  const run = (await f.parent.query(api.assistantCoordinator.list, {})).find(r => r.jobId === id)!
  await f.t.action(internal.coordinatorWorker.step, { id: run.id as import('./_generated/dataModel').Id<'assistantRuns'>, version: run.version })
  const input = vi.mocked(extractStructured).mock.calls[0][2] as any
  expect(input.assistant.privateMail).toMatchObject({ summary: 'Maya’s museum trip form needs a reply by October 12.', messages: [{ subject: 'Museum trip form', text: body }] })
  expect(JSON.stringify(input)).not.toContain('must-not-enter-model')
  expect(input.assistant).not.toHaveProperty('mailContext')
  expect(vi.mocked(extractStructured).mock.calls[0][0]).toBe(coordinatorStep)
  expect(vi.mocked(extractStructured).mock.calls[0][1]).toContain('sharing into household work requires a separate exact-text review')
  const job = (await f.parent.query(api.jobs.list, {}))[0]
  expect(job).toMatchObject({ conversation: true, preparing: false, mailContext: { mailboxId: f.mailboxId }, actions: [] })
  expect(job.source!.expiresAt).toBeLessThanOrEqual((await f.t.run(ctx => ctx.db.get(f.messageId)))!.expiresAt)
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
  await expect(f.parent.mutation(api.jobs.addDraft, { jobId: id, payload: event })).rejects.toThrow('stays private')
  await expect(f.parent.mutation(api.jobs.reviseSource, { jobId: id, revision: 1, text: 'Prepare a shared event from the private email.' })).rejects.toThrow('stays private')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('keeps source discussion on a fresh client and excludes it from new household preparation', async () => {
  const f = await fixture(), first = await f.question()
  vi.mocked(extractStructured).mockResolvedValue(answer('Return the form by October 12.'))
  await f.t.action(internal.preparation.prepare, { jobId: first, sourceRevision: 1 })
  const run = (await f.parent.query(api.assistantCoordinator.list, {})).find(r => r.jobId === first)!
  await f.t.action(internal.coordinatorWorker.step, { id: run.id as import('./_generated/dataModel').Id<'assistantRuns'>, version: run.version })
  vi.setSystemTime(now + 2000)
  const fresh = f.t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const next = await fresh.mutation(api.jobs.submit, { text: 'Could you draft a reply to that email?' })
  const context = await f.t.query(internal.jobs.context, { jobId: next })
  expect(context?.assistant?.privateMail?.messages[0].text).toBe(body)
  expect(context?.assistant?.history.at(-1)?.response).toBe('Return the form by October 12.')
  const notice = await fresh.mutation(api.jobs.submit, { text: 'Event: Maya appointment\nDate: 2026-10-12\nTime: 8 AM to 9 AM' })
  const publicContext = await f.t.query(internal.jobs.context, { jobId: notice })
  expect(publicContext?.assistant?.privateMail).toBeUndefined()
  expect(publicContext?.assistant?.history).not.toContainEqual(expect.objectContaining({ response: 'Return the form by October 12.' }))
  const otherId = await f.other.mutation(api.jobs.submit, { text: 'Which one needs a reply?' })
  expect((await f.t.query(internal.jobs.context, { jobId: otherId }))?.assistant?.privateMail).toBeUndefined()
})

it.each(['pause', 'revoke', 'account', 'source', 'dismiss', 'expire', 'summary', 'run-version'] as const)('refuses late model output and later reuse after %s changes', async change => {
  const f = await fixture(), id = await f.question()
  const provenance = (await f.t.query(internal.jobs.context, { jobId: id }))!.assistant!.mailContext!
  await f.t.run(async ctx => {
    if (change === 'pause') await ctx.db.patch(f.mailboxId, { state: 'paused', version: 2 })
    if (change === 'revoke') await ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 })
    if (change === 'account') await ctx.db.patch(f.connectionId, { email: 'different@example.test' })
    if (change === 'source') await ctx.db.patch(f.messageId, { text: 'Changed source', version: 2, contentHash: sourceHash('Changed source') })
    if (change === 'dismiss') await ctx.db.patch(f.messageId, { dismissed: true })
    if (change === 'expire') await ctx.db.patch(f.messageId, { expiresAt: Date.now() })
    if (change === 'summary') await ctx.db.patch(f.runId, { answer: 'Changed summary' })
    if (change === 'run-version') await ctx.db.patch(f.runId, { version: 2 })
  })
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'A late private model answer must not be saved.', mailContext: provenance })
  expect((await f.t.run(ctx => ctx.db.get(id)))?.clarification).toBe(unavailableMailContext)
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
})

it('hides prior private answers after access changes and erases derived content on mailbox removal', async () => {
  const f = await fixture(), id = await f.question()
  const provenance = (await f.t.query(internal.jobs.context, { jobId: id }))!.assistant!.mailContext!
  await f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'Sensitive synthetic detail from the email.', mailContext: provenance })
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toBe(unavailableMailContext)
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 2 })
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  const job = (await f.t.run(ctx => ctx.db.get(id)))!
  expect(job.clarification).not.toContain('Sensitive synthetic')
  expect(job.mailContext).toBeUndefined()
  expect((await f.t.run(ctx => ctx.db.get(job.sourceId)))?.text).toBeUndefined()
})

it('retains only the parent’s own topic after Gmail access stops, never revoked derived email text', async () => {
  const f = await fixture(), first = await f.question()
  const provenance = (await f.t.query(internal.jobs.context, { jobId: first }))!.assistant!.mailContext!
  await f.t.mutation(internal.jobs.prepared, { jobId: first, sourceRevision: 1, conversation: true, actions: [], clarification: 'Sensitive synthetic detail from the email.', mailContext: provenance })
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  vi.advanceTimersByTime(1)
  const next = await f.parent.mutation(api.jobs.submit, { text: 'What should I do about it?' })
  const context = (await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!
  expect(context.privateMail).toBeUndefined()
  expect(context.history.at(-1)).toEqual({ request: 'Which one needs a reply?', response: unavailableConversationResponse, sourceOnly: true })
  expect(JSON.stringify(context)).not.toContain('Sensitive synthetic detail')
  expect(JSON.stringify(context)).not.toContain(body)
  const runId = await f.t.mutation(internal.assistantCoordinator.start, { jobId: next, sourceRevision: 1 })
  const run = (await f.t.run(ctx => ctx.db.get(runId!)))!
  expect(JSON.stringify(run.contextBindings)).not.toContain(String(f.mailboxId))
  expect(run.refs.some((ref: any) => ref.kind === 'mail')).toBe(false)
  expect(JSON.parse(run.baseContext!).history.at(-1)).toMatchObject({ sourceOnly: true })
})

it('bounds email excerpts, skips empty polls, and never imports a future check into an earlier question', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    await ctx.db.patch(f.messageId, { text: body + 'x'.repeat(12000) })
    const run = (await ctx.db.get(f.runId))!, { _id, _creationTime, ...data } = run
    await ctx.db.insert('mailRuns', { ...data, requestId: 'poll:empty', requestHash: 'empty', createdAt: now + 500, messageIds: [], answer: 'No changes', evidence: [] })
    await ctx.db.insert('mailRuns', { ...data, requestId: 'future', requestHash: 'future', request: 'A future search', createdAt: now + 10000 })
  })
  const id = await f.question(), context = (await f.t.query(internal.jobs.context, { jobId: id }))!
  expect(context.assistant!.privateMail!.request).toBe('Check my inbox')
  expect(context.assistant!.privateMail!.messages[0].text).toHaveLength(2000)
  expect(context.assistant!.privateMail!.messages[0].extraction.truncated).toBe(true)
})

it.each(['automatic', 'explicit'] as const)('a newer %s mail result handles conversation focus without stealing an unrelated topic', async kind => {
  const f = await fixture()
  const dinner = await f.parent.mutation(api.jobs.submit, { text: 'Suggest two easy dinners.' })
  await f.t.mutation(internal.jobs.prepared, { jobId: dinner, sourceRevision: 1, conversation: true, actions: [], clarification: 'Try tacos or a rice bowl.' })
  await f.t.run(async ctx => {
    const run = (await ctx.db.get(f.runId))!, { _id, _creationTime, ...data } = run
    await ctx.db.insert('mailRuns', { ...data, requestId: kind === 'automatic' ? 'poll:later' : 'user-check:later', requestHash: `later-${kind}`, createdAt: now + 1500,
      // A parent's explicit search of older mail is still the newest topic.
      through: kind === 'explicit' ? now - 500 : now + 1500 })
  })
  vi.setSystemTime(now + 2000)
  const next = await f.parent.mutation(api.jobs.submit, { text: kind === 'automatic' ? 'just in general' : 'Which one needs a reply?' })
  const context = (await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!
  if (kind === 'automatic') {
    expect(context.privateMail).toBeUndefined()
    expect(context.history.at(-1)).toMatchObject({ request: 'Suggest two easy dinners.', response: 'Try tacos or a rice bowl.' })
    expect(JSON.stringify(context)).not.toContain(body)
  } else expect(context.privateMail?.messages[0].text).toBe(body)
})

it('rejects model-created actions and concurrent replays of private conversation persistence', async () => {
  const f = await fixture(), id = await f.question()
  const provenance = (await f.t.query(internal.jobs.context, { jobId: id }))!.assistant!.mailContext!
  await expect(f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: false, actions: [event], clarification: 'Injected shared event', mailContext: provenance })).rejects.toThrow('cannot create')
  await Promise.all(Array.from({ length: 50 }, () => f.t.mutation(internal.jobs.prepared, { jobId: id, sourceRevision: 1, conversation: true, actions: [], clarification: 'The form needs a reply.', mailContext: provenance })))
  expect((await f.parent.query(api.jobs.list, {}))).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
})

it.each(['version', 'hash', 'dismissed', 'expired', 'deleted'] as const)('refuses a summary generated from %s source content even if its quote still matches', async change => {
  const f = await fixture()
  const m = (await f.t.run(ctx => ctx.db.get(f.messageId)))!
  const sources = [{ id: m._id, version: m.version, hash: m.contentHash }]
  await f.t.run(async ctx => {
    if (change === 'version') await ctx.db.patch(m._id, { version: 2 })
    if (change === 'hash') await ctx.db.patch(m._id, { contentHash: 'changed' })
    if (change === 'dismissed') await ctx.db.patch(m._id, { dismissed: true })
    if (change === 'expired') await ctx.db.patch(m._id, { expiresAt: Date.now() })
    if (change === 'deleted') await ctx.db.delete(m._id)
  })
  expect(await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, sources, answer: 'Late incorrect answer', evidence: [{ messageId: m._id, quote: 'Please return Maya’s museum trip form by October 12.' }] })).toBe(false)
  const results = await f.parent.query(api.mailbox.runs, {})
  expect(results[0].answer).not.toBe('Late incorrect answer')
  expect(results[0].answer).toContain('source emails or saved work changed')
})

it('invalidates private follow-up answers when an uncited summary source changes during model preparation', async () => {
  const f = await fixture()
  const secondId = await f.t.run(async ctx => {
    const first = (await ctx.db.get(f.messageId))!, { _id, _creationTime, ...data } = first
    const second = await ctx.db.insert('mailMessages', { ...data, providerId: 'uncited-message', text: 'The museum deadline is revised.', contentHash: 'uncited-v1' })
    await ctx.db.patch(f.runId, { summarySources: [{ id: first._id, version: first.version, hash: first.contentHash }, { id: second, version: 1, hash: 'uncited-v1' }] })
    return second
  })
  const id = await f.question()
  expect((await f.t.query(internal.jobs.context, { jobId: id }))?.assistant?.privateMail?.summary).toContain('October 12')
  vi.mocked(extractStructured).mockImplementationOnce(async () => {
    await f.t.run(ctx => ctx.db.patch(secondId, { version: 2, contentHash: 'uncited-v2' }))
    return answer('The stale summary said October 12.')
  })
  await f.t.action(internal.preparation.prepare, { jobId: id, sourceRevision: 1 })
  const run = (await f.parent.query(api.assistantCoordinator.list, {})).find(r => r.jobId === id)!
  await f.t.action(internal.coordinatorWorker.step, { id: run.id as import('./_generated/dataModel').Id<'assistantRuns'>, version: run.version })
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).toContain('supporting context changed')
  expect((await f.parent.query(api.jobs.list, {}))[0].clarification).not.toContain('The stale summary said October 12.')
  expect((await f.parent.query(api.assistantCoordinator.list, {})).find(r => r.jobId === id)).toMatchObject({ stale: true, drafts: [] })
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect((await f.parent.query(api.mailbox.runs, {}))[0].answer).toContain('source emails or saved work changed')
  const next = await f.question()
  expect((await f.t.query(internal.jobs.context, { jobId: next }))?.assistant?.privateMail).toBeUndefined()
})

it('drops private mailbox excerpts on a topic change and follows the new conversation instead', async () => {
  const f = await fixture(), first = await f.question()
  const mailContext = (await f.t.query(internal.jobs.context, { jobId: first }))!.assistant!.mailContext!
  await f.t.mutation(internal.jobs.prepared, { jobId: first, sourceRevision: 1, conversation: true, actions: [], clarification: 'The museum form is due October 12.', mailContext })
  vi.setSystemTime(now + 2000)
  const dinner = await f.parent.mutation(api.jobs.submit, { text: 'What should I order for dinner?' })
  const dinnerContext = (await f.t.query(internal.jobs.context, { jobId: dinner }))!.assistant!
  expect(dinnerContext.privateMail).toBeUndefined()
  expect(JSON.stringify(dinnerContext)).not.toContain('museum form')
  await f.t.mutation(internal.jobs.prepared, { jobId: dinner, sourceRevision: 1, conversation: true, actions: [], clarification: 'Try vegetable noodles or a burrito bowl.' })
  vi.setSystemTime(now + 3000)
  const next = await f.parent.mutation(api.jobs.submit, { text: 'Make those vegetarian' })
  const context = (await f.t.query(internal.jobs.context, { jobId: next }))!.assistant!
  expect(context.privateMail).toBeUndefined()
  expect(context.history.at(-1)?.response).toContain('vegetable noodles')
  expect(JSON.stringify(context)).not.toContain('museum form')
  const email = await f.parent.mutation(api.jobs.submit, { text: 'Which email needs a reply?' })
  expect((await f.t.query(internal.jobs.context, { jobId: email }))!.assistant!.privateMail?.messages[0].text).toBe(body)
})

it('skips the model for an explicit check with no readable source messages', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    // The fixture starts with an enable batch; this case exercises a manual check.
    await ctx.db.patch(f.runId, { requestId: 'manual-empty-check' })
    await ctx.db.delete(f.messageId)
  })
  await f.t.action(internal.gmailMailbox.summarize, { id: f.runId, version: 1 })
  expect(extractStructured).not.toHaveBeenCalled()
  const run = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(run.answer).toContain('no readable saved messages')
  expect(run.answer).toContain('does not establish that the whole mailbox is clear')
})
it('keeps an empty automatic batch quiet without claiming all saved mail was checked', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.delete(f.messageId))
  await f.t.action(internal.gmailMailbox.summarize, { id: f.runId, version: 1 })
  expect(extractStructured).not.toHaveBeenCalled()
  const run = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(run.answer).toContain('No new or changed readable messages')
  expect(run.answer).toContain('does not establish that the whole mailbox is clear')
})

it('preserves a visible email result through quiet polls and checks created after the question', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const run = (await ctx.db.get(f.runId))!, { _id, _creationTime, ...data } = run
    for (let i = 0; i < 50; i++) await ctx.db.insert('mailRuns', { ...data, requestId: `quiet-${i}`, requestHash: `quiet-${i}`, quiet: true, createdAt: now + 500, messageIds: [], answer: undefined, evidence: [] })
  })
  const question = await f.question()
  await f.t.run(async ctx => {
    const run = (await ctx.db.get(f.runId))!, { _id, _creationTime, ...data } = run
    for (let i = 0; i < 50; i++) await ctx.db.insert('mailRuns', { ...data, requestId: `future-${i}`, requestHash: `future-${i}`, createdAt: now + 5000, request: 'Future private email check' })
  })
  const context = await f.t.query(internal.jobs.context, { jobId: question })
  expect(context?.assistant?.privateMail?.request).toBe('Check my inbox')
  expect(context?.assistant?.privateMail?.messages[0].text).toBe(body)
})
