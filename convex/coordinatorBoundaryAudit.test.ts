import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { event } from '../tests/fixtures/calendar'
import { sourceHash } from '../shared/daymark'
import { coordinatorLimits } from '../shared/assistantCoordinator'
import { attachmentDescriptors } from '../shared/mailAttachments'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic'); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

async function fixture(text = 'My private note is synthetic-secret. Prepare a school trip on October 20.') {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text, hash: 'synthetic-parent-turn', revision: 1, expiresAt: now + 86400000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const id = (await t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!
  const lease = { id, version: 1, lease: 'coordinator' }
  const tool = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...extra })
  const advance = (result: unknown, held = lease) => t.mutation(internal.assistantCoordinator.advance, { ...held, result: JSON.stringify(result) })
  return { t, owner, other, householdId, sourceId, jobId, id, lease, tool, advance, text }
}

async function privateAttachment(f: Awaited<ReturnType<typeof fixture>>) {
  const connectionId = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', provider: 'google', email: 'parent@example.test', status: 'active', version: 1, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await f.t.run(ctx => ctx.db.insert('mailboxes', { householdId: f.householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const text = 'Synthetic permission form attached.', expiresAt = now + 60000
  const messageId = await f.t.run(ctx => ctx.db.insert('mailMessages', { householdId: f.householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: 'synthetic_attachment_parent', sender: 'school@example.test', subject: 'Form', text, receivedAt: now, extraction: { format: 'plain', incomplete: true, truncated: false, attachments: true, issues: [] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(text), dismissed: false, expiresAt }))
  const descriptors = attachmentDescriptors({ parts: [{ partId: '1', filename: 'Form.txt', mimeType: 'text/plain', body: { attachmentId: 'synthetic_attachment', size: 100 } }] }).descriptors
  await f.t.mutation(internal.mailAttachments.discovered, { messageId, messageVersion: 1, messageHash: sourceHash(text), mailboxVersion: 1, descriptors })
  const row = (await f.t.run(ctx => ctx.db.query('mailAttachments').collect()))[0]
  return { id: row._id, descriptorHash: row.descriptorHash, messageId, mailboxId, expiresAt }
}

it('refuses delegated notice input and completion on an ordinary coordinator lease', async () => {
  const f = await fixture(); await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  expect(await f.t.mutation(internal.assistantCoordinator.noticeInput, f.lease)).toBeNull()
  expect(await f.t.mutation(internal.assistantCoordinator.noticeFinished, { ...f.lease, result: JSON.stringify({ actions: [event], clarification: 'A notice worker must not complete this ordinary run.' }) })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
})

it('refuses the ordinary advance endpoint while the delegated notice worker holds its lease', async () => {
  const f = await fixture(); await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('prepare_notice'))
  const delegated = { id: f.id, version: 2, lease: 'notice' }
  await f.t.mutation(internal.assistantCoordinator.claim, { ...delegated, phase: 'notice' })
  expect(await f.advance(f.tool('finish', { answer: 'An ordinary worker cannot replace notice completion.' }), delegated)).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.status).toBe('running')
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it('does not expose a private coordinator source through the legacy manual draft endpoint', async () => {
  const f = await fixture(); await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('finish', { answer: 'The private conversation is saved.' }))
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
  await expect(f.owner.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: event })).rejects.toThrow()
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it.each(['expiry', 'deletion'] as const)('rejects completion after parent source %s without persisting an answer or any learning', async change => {
  const f = await fixture('Maya attends Oak School. Please suggest remembering this.')
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('learn_process'))
  const next = { id: f.id, version: 2, lease: 'finish' }
  await f.t.mutation(internal.assistantCoordinator.claim, next)
  if (change === 'expiry') await f.t.run(ctx => ctx.db.patch(f.sourceId, { expiresAt: now }))
  else await f.t.run(ctx => ctx.db.delete(f.sourceId))
  expect(await f.advance(f.tool('finish', { answer: 'Remember Oak School.' }), next)).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.answer).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('workflowCurations').collect())).toEqual([])
  expect((await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).map(row => row.key).sort()).toEqual(['children', 'timezone'])
})

it('automatically queues learning from the parent request rather than private observations or the model answer', async () => {
  const f = await fixture('Maya attends Oak School. Please suggest remembering this.')
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('learn_process'))
  const next = { id: f.id, version: 2, lease: 'finish' }
  await f.t.mutation(internal.assistantCoordinator.claim, next)
  await f.advance(f.tool('finish', { answer: 'Assistant text is not a new source: Maya attends Invented School.' }), next)
  const curations = await f.t.run(ctx => ctx.db.query('workflowCurations').collect())
  expect(curations).toHaveLength(1)
  expect(curations[0]).toMatchObject({ sourceId: f.sourceId, sourceRevision: 1, sourceHash: sourceHash(f.text), createdBy: 'test|parent', status: 'queued' })
  const input = await f.t.mutation(internal.learnedWorkflows.claim, { id: curations[0]._id, version: 1, lease: 'curation' })
  expect(input?.parentText).toBe(f.text)
  expect(JSON.stringify(input)).not.toContain('Invented School')
  expect((await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).map(row => row.key).sort()).toEqual(['children', 'timezone'])
  expect(await f.other.query(api.learnedWorkflows.list, {})).toEqual([])
})

it('refuses an old lease after retry and preserves the original attempt ceiling during recovery', async () => {
  const f = await fixture(); await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.t.mutation(internal.assistantCoordinator.fail, f.lease)
  await f.owner.mutation(api.assistantCoordinator.retry, { id: f.id, version: 1 })
  expect(await f.advance(f.tool('finish', { answer: 'An obsolete attempt cannot finish.' }))).toBe(false)
  await f.t.run(ctx => ctx.db.patch(f.id, { attempts: coordinatorLimits.attempts }))
  vi.setSystemTime(now + 15001)
  expect(await f.t.mutation(internal.assistantCoordinator.claim, { id: f.id, version: 2, lease: 'replacement' })).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.status).toBe('cancelled')
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})

it('does not let the coordinator turn discovered metadata into attachment reading consent', async () => {
  const f = await fixture('Read the permission form if I have allowed it.'), attachment = await privateAttachment(f)
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('read_attachment', { id: attachment.id }))
  const input = await f.t.mutation(internal.assistantCoordinator.claim, { id: f.id, version: 2, lease: 'after-discovery' })
  expect(JSON.stringify(input?.observations)).toContain('review attachment processing first')
  expect((await f.t.run(ctx => ctx.db.get(attachment.id)))?.consentedAt).toBeUndefined()
  expect((await f.t.run(ctx => ctx.db.get(attachment.id)))?.attempts).toBe(0)
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('discloses saved email extraction gaps and model-context body truncation', async () => {
  const f = await fixture('Check the saved permission form.'), attachment = await privateAttachment(f)
  const text = 'Synthetic permission form. ' + 'Body detail. '.repeat(500)
  await f.t.run(ctx => ctx.db.patch(attachment.messageId, { text, contentHash: sourceHash(text), extraction: { format: 'plain', incomplete: true, truncated: false, attachments: true, issues: ['Attachment not read.'] } }))
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('mail_search', { query: 'permission form' }))
  const input = await f.t.mutation(internal.assistantCoordinator.claim, { id: f.id, version: 2, lease: 'check-coverage' })
  const observations = input?.observations as { result?: { messages?: unknown[] } }[]
  expect(observations[0].result?.messages).toEqual([expect.objectContaining({ textTruncated: true, extraction: expect.objectContaining({ incomplete: true, attachments: true, issues: ['Attachment not read.'] }) })])
})

it('withdraws completed attachment-derived work when its email is deleted and refuses sharing it', async () => {
  const f = await fixture('Help me prepare a calendar draft from the attachment.'), attachment = await privateAttachment(f)
  await f.owner.mutation(api.mailAttachments.read, { id: attachment.id, version: 1, descriptorHash: attachment.descriptorHash, consent: true })
  await f.t.mutation(internal.mailAttachments.claim, { id: attachment.id, version: 2, lease: 'attachment' })
  await f.t.mutation(internal.mailAttachments.finish, { id: attachment.id, version: 2, lease: 'attachment', output: JSON.stringify({ text: 'The private trip is October 20.', summary: '', incomplete: false, issues: [] }), byteHash: 'a'.repeat(64), extractionMethod: 'utf8' })
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('read_attachment', { id: attachment.id }))
  const next = { id: f.id, version: 2, lease: 'finish' }
  await f.t.mutation(internal.assistantCoordinator.claim, next)
  await f.advance(f.tool('finish', { answer: 'The private trip is October 20.', drafts: [{ kind: 'calendar', title: 'Trip', text: 'Prepare the trip date for review.', evidence: [{ sourceId: attachment.id, quote: 'The private trip is October 20.' }] }] }), next)
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0]).toMatchObject({ stale: false, drafts: [expect.objectContaining({ kind: 'calendar' })] })
  await f.t.run(ctx => ctx.db.delete(attachment.messageId))
  expect((await f.owner.query(api.assistantCoordinator.list, {}))[0]).toMatchObject({ stale: true, drafts: [] })
  expect(JSON.stringify(await f.owner.query(api.jobs.list, {}))).not.toContain('The private trip is October 20.')
  await expect(f.owner.mutation(api.assistantCoordinator.review, { id: f.id, version: 2, index: 0, operation: 'share', text: 'Prepare the trip date for review.', consent: true })).rejects.toThrow('changed')
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})

it('erases a derived private answer when its shorter-lived email source expires', async () => {
  const f = await fixture('Check the saved permission form.'), attachment = await privateAttachment(f)
  await f.t.mutation(internal.assistantCoordinator.claim, f.lease)
  await f.advance(f.tool('mail_search', { query: 'permission form' }))
  const next = { id: f.id, version: 2, lease: 'finish' }
  await f.t.mutation(internal.assistantCoordinator.claim, next)
  await f.advance(f.tool('finish', { answer: 'Synthetic permission form attached.' }), next)
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.expiresAt).toBe(attachment.expiresAt)
  vi.setSystemTime(attachment.expiresAt + 1)
  await f.t.mutation(internal.privacy.expireSources, {})
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.jobId)))?.clarification).not.toContain('Synthetic permission form attached.')
  // The parent's original source has its own longer retention; only the derived
  // answer bound to expired private email must be erased here.
  expect((await f.t.run(ctx => ctx.db.get(f.sourceId)))?.text).toBe(f.text)
  expect(await f.other.query(api.jobs.list, {})).toEqual([])
})
