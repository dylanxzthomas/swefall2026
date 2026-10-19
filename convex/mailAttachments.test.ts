import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { attachmentDescriptors, mailAttachmentLimits } from '../shared/mailAttachments'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import { completedAttachmentContext, validAttachmentReferences } from './mailAttachments'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test'); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-key-not-a-credential'); vi.stubEnv('DAYMARK_MODEL', 'synthetic-model') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(mimeType = 'text/plain') {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test' }))
  const accountKey = sourceHash(JSON.stringify([connectionId, 'parent@example.test']))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey, version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const text = 'The permission form is attached.'
  const messageId = await t.run(ctx => ctx.db.insert('mailMessages', { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey, providerId: 'mail-one', threadId: 'thread-one', sender: 'school@example.test', subject: 'Trip permission', text, receivedAt: now - 1000, extraction: { format: 'plain', incomplete: true, truncated: false, attachments: true, issues: ['Attachment not read.'] }, labels: ['INBOX'], version: 1, contentHash: sourceHash(text), expiresAt: now + 86400_000, dismissed: false }))
  const descriptors = attachmentDescriptors({ parts: [{ partId: '1', filename: 'Form.txt', mimeType, body: { attachmentId: 'attached_one', size: 100 } }] }).descriptors
  const args = { messageId, messageVersion: 1, messageHash: sourceHash(text), mailboxVersion: 1, descriptors }
  await t.mutation(internal.mailAttachments.discovered, args)
  const row = (await parent.query(api.mailAttachments.list, { messageId }))[0]
  const id = row.id as Id<'mailAttachments'>
  const read = (version = row.version) => parent.mutation(api.mailAttachments.read, { id, version, descriptorHash: descriptors[0].descriptorHash, consent: true })
  const claim = (version = 2, lease = 'test-lease') => t.mutation(internal.mailAttachments.claim, { id, version, lease })
  const finish = (version = 2, lease = 'test-lease', extractionMethod: 'utf8' | 'model' = 'utf8') => t.mutation(internal.mailAttachments.finish, { id, version, lease, output: JSON.stringify({ text: 'Return the form by October 16.', summary: '', incomplete: false, issues: [] }), byteHash: 'a'.repeat(64), extractionMethod })
  return { t, parent, other, householdId, mailboxId, connectionId, messageId, id, args, row, read, claim, finish }
}
it('keeps discovery private and does not read attachments until exact descriptor consent', async () => {
  const f = await fixture()
  expect(f.row).toMatchObject({ filename: 'Form.txt', status: 'available', version: 1 })
  expect(await f.other.query(api.mailAttachments.list, {})).toEqual([])
  await expect(f.t.query(api.mailAttachments.list, {})).rejects.toThrow('Sign in')
  await expect(f.other.query(api.mailAttachments.discoveryContext, { messageId: f.messageId, version: 1 })).rejects.toThrow('unavailable')
  expect(await f.claim(1)).toBeNull()
  await expect(f.parent.mutation(api.mailAttachments.read, { id: f.id, version: 1, descriptorHash: 'forged', consent: true })).rejects.toThrow('changed')
  await expect(f.other.mutation(api.mailAttachments.read, { id: f.id, version: 1, descriptorHash: f.row.descriptorHash, consent: true })).rejects.toThrow('unavailable')
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.attempts).toBe(0)
})
it('coalesces 50 read clicks, leases and completions into one extraction without provider writes or shared records', async () => {
  const f = await fixture()
  expect(new Set(await Promise.all(Array.from({ length: 50 }, () => f.read())))).toEqual(new Set([2]))
  const leases = await Promise.all(Array.from({ length: 50 }, (_, i) => f.claim(2, `concurrent-${i}`)))
  expect(leases.filter(Boolean)).toHaveLength(1)
  const row = (await f.t.run(ctx => ctx.db.get(f.id)))!
  const finished = await Promise.all(Array.from({ length: 50 }, () => f.finish(2, row.lease!)))
  expect(finished.filter(Boolean)).toHaveLength(1)
  expect((await f.parent.query(api.mailAttachments.list, {}))[0]).toMatchObject({ status: 'complete', text: 'Return the form by October 16.', extractionMethod: 'utf8', incomplete: false, version: 3 })
  expect(await f.read(1)).toBe(3)
  for (const table of ['jobs', 'actions', 'approvals', 'attempts', 'mailDrafts', 'mailProposals', 'personalTasks'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it.each(['source', 'mailbox', 'connection', 'membership', 'expiry', 'dismissal'] as const)('rejects in-flight output and derived context after %s changes', async change => {
  const f = await fixture(); await f.read(); await f.claim()
  if (change === 'source') await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2 }))
  if (change === 'mailbox') await f.t.run(ctx => ctx.db.patch(f.mailboxId, { state: 'paused', version: 2 }))
  if (change === 'connection') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
  if (change === 'membership') await f.t.run(async ctx => { const m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(m!._id) })
  if (change === 'expiry') vi.setSystemTime(now + 86400_000 + 1)
  if (change === 'dismissal') await f.t.run(ctx => ctx.db.patch(f.messageId, { dismissed: true }))
  expect(await f.finish()).toBe(false)
  expect(await f.t.run(ctx => completedAttachmentContext(ctx, f.householdId, 'test|parent'))).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.text).toBeUndefined()
})
it('labels model transcription unverified and binds future context to extraction/source versions and expiry', async () => {
  const f = await fixture('application/pdf'); await f.read(); await f.claim(); expect(await f.finish(2, 'test-lease', 'model')).toBe(true)
  const rows = await f.t.run(ctx => completedAttachmentContext(ctx, f.householdId, 'test|parent'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ messageId: f.messageId, extractionMethod: 'model', incomplete: true, issues: [expect.stringContaining('Machine transcription')] })
  expect(JSON.stringify(rows)).not.toMatch(/access_token|refresh_token|cipher|accountKey|attachmentId/)
  expect(await f.t.run(ctx => validAttachmentReferences(ctx, f.householdId, 'test|parent', rows))).toBe(true)
  expect(await f.t.run(ctx => validAttachmentReferences(ctx, f.householdId, 'test|other', rows))).toBe(false)
  await f.t.run(ctx => ctx.db.patch(f.messageId, { version: 2 }))
  expect(await f.t.run(ctx => validAttachmentReferences(ctx, f.householdId, 'test|parent', rows))).toBe(false)
  expect(await f.parent.query(api.mailAttachments.list, {})).toEqual([])
})
it('does not repeat completed work after rediscovery and invalidates consent when a descriptor changes', async () => {
  const f = await fixture(); await f.read(); await f.claim(); await f.finish()
  await f.t.mutation(internal.mailAttachments.discovered, f.args)
  expect((await f.parent.query(api.mailAttachments.list, {}))[0]).toMatchObject({ status: 'complete', version: 3 })
  const descriptors = attachmentDescriptors({ parts: [{ partId: '1', filename: 'Revised.txt', mimeType: 'text/plain', body: { attachmentId: 'different', size: 100 } }] }).descriptors
  await f.t.mutation(internal.mailAttachments.discovered, { ...f.args, descriptors })
  expect((await f.parent.query(api.mailAttachments.list, {}))[0]).toMatchObject({ filename: 'Revised.txt', status: 'available', version: 4 })
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.consentedAt).toBeUndefined()
  expect(await f.t.run(ctx => completedAttachmentContext(ctx, f.householdId, 'test|parent'))).toEqual([])
})
it('rejects late results after lease expiry and keeps recovery within three attempts', async () => {
  const f = await fixture(); await f.read(); await f.claim()
  vi.setSystemTime(now + mailAttachmentLimits.leaseMs + 1)
  expect(await f.finish()).toBe(false)
  expect(await f.claim(2, 'second')).not.toBeNull()
  expect(await f.t.mutation(internal.mailAttachments.failed, { id: f.id, version: 2, lease: 'test-lease', code: 'unavailable' })).toBe(false)
  vi.setSystemTime(Date.now() + mailAttachmentLimits.leaseMs + 1)
  expect(await f.claim(2, 'third')).not.toBeNull()
  vi.setSystemTime(Date.now() + mailAttachmentLimits.leaseMs + 1)
  expect(await f.claim(2, 'fourth')).toBeNull()
  expect((await f.parent.query(api.mailAttachments.list, {}))[0]).toMatchObject({ status: 'failed', retryable: false })
})
it('preserves fixed error categories and permits a bounded user retry without disclosing provider exceptions', async () => {
  const f = await fixture(); await f.read(); await f.claim()
  await f.t.mutation(internal.mailAttachments.failed, { id: f.id, version: 2, lease: 'test-lease', code: 'model_unavailable' })
  const row = (await f.parent.query(api.mailAttachments.list, {}))[0]
  expect(row).toMatchObject({ status: 'failed', retryable: true, version: 3 })
  expect(row.issue).toContain('No task or external action')
  expect(await f.read(3)).toBe(4)
  expect((await f.claim(4))?.attempts).toBe(1)
})
it('removes unavailable descriptor records after provider metadata no longer lists them', async () => {
  const f = await fixture()
  expect(await f.t.mutation(internal.mailAttachments.discovered, { ...f.args, descriptors: [] })).toBe(true)
  expect(await f.parent.query(api.mailAttachments.list, {})).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toBeNull()
})
