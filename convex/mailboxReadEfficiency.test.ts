import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import { sourceHash } from '../shared/daymark'
import { gmailReadScope } from '../shared/emailWatches'
import schema from './schema'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T08:00:00Z')
const extraction = { format: 'plain' as const, incomplete: false, truncated: false, attachments: false, issues: [] }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
async function fixture() {
  const t = convexTest(schema, modules)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test' }))
  const mailboxId = await t.run(ctx => ctx.db.insert('mailboxes', { householdId, createdBy: 'test|parent', connectionId, connectionVersion: 1, accountKey: 'synthetic-account', version: 1, state: 'active', lookbackDays: 30, consentedAt: now, createdAt: now }))
  const base = { householdId, createdBy: 'test|parent', mailboxId, mailboxVersion: 1, connectionId, connectionVersion: 1, accountKey: 'synthetic-account', requestId: 'explicit', requestHash: 'synthetic-request', request: 'Check my inbox', kind: 'check' as const, query: '', lookbackDays: 30, mode: 'baseline' as const, scope: 'inbox' as const, status: 'complete' as const, version: 1, scanned: 1, segmentScanned: 1, from: now - 86400_000, through: now, createdAt: now, expiresAt: now + 86400_000, messageIds: [] as Id<'mailMessages'>[], hasMore: false }
  const message = { householdId, createdBy: 'test|parent', mailboxId, connectionId, connectionVersion: 1, accountKey: 'synthetic-account', providerId: 'synthetic-message', sender: 'school@example.test', subject: 'Private school notice', receivedAt: now, text: 'Private field trip reminder.', extraction, labels: ['INBOX'], version: 1, contentHash: sourceHash('Private field trip reminder.'), dismissed: false, expiresAt: now + 86400_000 }
  const measured = () => parent.query(async ctx => {
    const value = await ctx.runQuery(api.mailbox.runs, {})
    return { value, metrics: await ctx.meta.getTransactionMetrics() }
  })
  return { t, parent, other, householdId, mailboxId, base, message, measured }
}

it('bounds database reads for ten visible checks despite a thousand hidden polls and repeated large sources', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const ids: Id<'mailMessages'>[] = [], text = 'x'.repeat(16_000), hash = sourceHash(text)
    for (let i = 0; i < 120; i++) ids.push(await ctx.db.insert('mailMessages', { ...f.message, providerId: `mail-${i}`, receivedAt: now + i, text, contentHash: hash }))
    const sources = ids.slice(0, 20), refs = sources.map(id => ({ id, version: 1, hash }))
    for (let i = 0; i < 10; i++) await ctx.db.insert('mailRuns', { ...f.base, requestId: `visible-${i}`, quiet: i % 2 ? false : undefined, messageIds: sources, summarySources: refs, answer: 'Source-bound answer.' })
    for (let i = 0; i < 1000; i++) await ctx.db.insert('mailRuns', { ...f.base, requestId: `poll:${i}`, quiet: true, scanned: 0 })
  })
  const { value, metrics } = await f.measured()
  expect(value).toHaveLength(10)
  expect(value.every(run => run.answer === 'Source-bound answer.' && run.messages.length === 30)).toBe(true)
  // 100 recent bodies + 20 older bound sources, each once across all ten runs.
  // Transaction metrics count actual database access, not output array size.
  expect(metrics.documentsRead.used).toBeGreaterThanOrEqual(120)
  expect(metrics.documentsRead.used).toBeLessThanOrEqual(160)
  expect(metrics.databaseQueries.used).toBeLessThanOrEqual(50)
  expect(metrics.bytesRead.used).toBeLessThan(2_100_000)
})

it('merges legacy and explicit visible runs in creation order past newer quiet history without changing stored history', async () => {
  const f = await fixture(), expected: Id<'mailRuns'>[] = []
  await f.t.run(async ctx => {
    for (let i = 0; i < 24; i++) expected.push(await ctx.db.insert('mailRuns', { ...f.base, requestId: `visible-${i}`, quiet: i % 3 ? false : undefined }))
    for (let i = 0; i < 1000; i++) await ctx.db.insert('mailRuns', { ...f.base, requestId: `poll:${i}`, quiet: true, scanned: 0 })
  })
  expect((await f.measured()).value.map(run => run.id)).toEqual(expected.slice(-10).reverse())
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(1024)
  expect(await f.other.query(api.mailbox.runs, {})).toEqual([])
})

it('preserves pending-poll suppression and visible failure history for legacy undefined quiet records', async () => {
  const f = await fixture()
  const ids = await f.t.run(async ctx => [
    await ctx.db.insert('mailRuns', { ...f.base, requestId: 'manual-empty', scanned: 0 }),
    await ctx.db.insert('mailRuns', { ...f.base, requestId: 'poll:empty', scanned: 0 }),
    await ctx.db.insert('mailRuns', { ...f.base, requestId: 'poll:pending', scanned: 0, status: 'running' }),
    await ctx.db.insert('mailRuns', { ...f.base, requestId: 'poll:failed', scanned: 0, status: 'failed', issue: 'Reading needs attention.' }),
    await ctx.db.insert('mailRuns', { ...f.base, requestId: 'agent-private', quiet: true }),
  ])
  expect((await f.measured()).value.map(run => run.id)).toEqual([ids[3], ids[0]])
})

it.each(['version', 'hash', 'dismissal', 'expiry', 'deletion', 'binding'] as const)('never retains a cached summary across a later source %s change', async change => {
  const f = await fixture()
  const { id, runId } = await f.t.run(async ctx => {
    const id = await ctx.db.insert('mailMessages', f.message)
    const runId = await ctx.db.insert('mailRuns', { ...f.base, messageIds: [id], summarySources: [{ id, version: 1, hash: f.message.contentHash }], answer: 'Sensitive source-backed answer.' })
    return { id, runId }
  })
  expect((await f.measured()).value[0].answer).toBe('Sensitive source-backed answer.')
  await f.t.run(async ctx => {
    if (change === 'version') await ctx.db.patch(id, { version: 2 })
    if (change === 'hash') await ctx.db.patch(id, { contentHash: 'corrected', text: 'Corrected source.' })
    if (change === 'dismissal') await ctx.db.patch(id, { dismissed: true })
    if (change === 'expiry') await ctx.db.patch(id, { expiresAt: now })
    if (change === 'deletion') await ctx.db.delete(id)
    if (change === 'binding') await ctx.db.patch(id, { accountKey: 'different-account' })
  })
  const changed = (await f.measured()).value.find(run => run.id === runId)!
  expect(changed.answer).toContain('source emails or saved work changed')
  expect(changed.answer).not.toContain('Sensitive')
  if (['expiry', 'deletion', 'binding'].includes(change)) expect(changed.messages).toEqual([])
  if (change === 'dismissal') expect(changed.messages).toMatchObject([{ dismissed: true }])
})

it('keeps owner checks on foreign source IDs even when other runs reuse those IDs', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const id = await ctx.db.insert('mailMessages', { ...f.message, createdBy: 'test|other', text: 'Other adult private information.' })
    for (let i = 0; i < 10; i++) await ctx.db.insert('mailRuns', { ...f.base, requestId: `foreign-${i}`, messageIds: [id], summarySources: [{ id, version: 1, hash: f.message.contentHash }], answer: 'Other adult private information.' })
  })
  const shown = await f.parent.query(api.mailbox.runs, {})
  expect(shown).toHaveLength(10)
  expect(shown.every(run => run.messages.length === 0 && run.answer?.includes('source emails or saved work changed'))).toBe(true)
  expect(JSON.stringify(shown)).not.toContain('Other adult private information')
  expect(await f.other.query(api.mailbox.runs, {})).toEqual([])
})

it('does not scan unrelated inbox bodies when the visible history contains only searches', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const id = await ctx.db.insert('mailMessages', f.message)
    for (let i = 0; i < 100; i++) await ctx.db.insert('mailMessages', { ...f.message, providerId: `unrelated-${i}`, receivedAt: now + i, text: 'x'.repeat(16_000) })
    for (let i = 0; i < 10; i++) await ctx.db.insert('mailRuns', { ...f.base, requestId: `search-${i}`, kind: 'search', scope: 'all_mail', messageIds: [id], summarySources: [{ id, version: 1, hash: f.message.contentHash }], answer: 'Search source answer.' })
  })
  const { value, metrics } = await f.measured()
  expect(value).toHaveLength(10)
  expect(value.every(run => run.messages[0]?.text === f.message.text)).toBe(true)
  expect(metrics.documentsRead.used).toBeLessThan(40)
  expect(metrics.bytesRead.used).toBeLessThan(40_000)
})
