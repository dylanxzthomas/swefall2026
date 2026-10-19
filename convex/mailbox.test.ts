import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { gmailReadScope } from '../shared/emailWatches'
import { mailboxIntervalMs } from '../shared/mailbox'
import type { GmailReplyRouting } from '../shared/gmailReply'

const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-06T12:00:00Z')
const extraction = { format: 'plain' as const, incomplete: false, truncated: false, attachments: false, issues: [] }
const mail = (providerId = 'message-1') => ({ providerId, threadId: 'thread-1', sender: 'school@example.test', subject: 'A private reminder', receivedAt: now - 1000, text: 'Please return the trip form by October 12. Private health details stay private.', extraction, labels: ['INBOX'] })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'parent@example.test,other@example.test'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('DAYMARK_MODEL', '') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' }), outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'parent@example.test' }))
  const enable = () => parent.mutation(api.mailbox.enable, { connectionId, connectionVersion: 1, lookbackDays: 30, consent: true })
  const mailboxId = await enable(), mailbox = (await t.run(ctx => ctx.db.get(mailboxId)))!, runId = mailbox.activeRunId!
  let serial = 0
  const claim = async (id = runId, version = 1) => { const args = { id, version, lease: `lease-${++serial}` }; const result = await t.mutation(internal.mailbox.claim, args); return { args, result } }
  const finish = async (args: { id: Id<'mailRuns'>; version: number; lease: string }, messages: (ReturnType<typeof mail> & { replyRouting?: GmailReplyRouting })[] = [mail()]) => {
    const finished = await t.mutation(internal.mailbox.finishBatch, { ...args, messages, removedIds: [], baselineHistoryId: '123' })
    const row = await t.run(ctx => ctx.db.get(args.id))
    // Most cases concern provider state. Complete the configured no-model fallback;
    // preparation recovery cases call finishBatch directly to stop before this step.
    if (finished && row?.status === 'complete' && /^(enable|poll):/.test(row.requestId)) {
      await t.action(internal.gmailMailbox.summarize, { id: args.id, version: args.version })
      await t.mutation(internal.mailbox.resumePrepared, { id: args.id, version: args.version })
    }
    return finished
  }
  const summarySources = async () => (await t.query(internal.mailbox.summaryContext, { id: runId, version: 1 }))!.messages.map(m => ({ id: m._id, version: m.version, hash: m.contentHash }))
  return { t, parent, other, outsider, householdId, connectionId, mailboxId, runId, enable, claim, finish, summarySources }
}

it('persists validated reply routing as versioned source evidence and clears removed routing on a later read', async () => {
  const f = await fixture(), { args } = await f.claim()
  const replyRouting = { threadId: 'thread-1', inReplyTo: '<notice@school.example>', references: ['<notice@school.example>'], subject: 'Re: A private reminder' }
  await f.finish(args, [{ ...mail(), replyRouting }])
  const first = (await f.t.run(ctx => ctx.db.query('mailMessages').collect()))[0]
  expect(first.replyRouting).toEqual(replyRouting)
  const nextId = await f.parent.mutation(api.mailbox.request, { requestId: 'synthetic-routing-reread', kind: 'check', query: '', lookbackDays: 30, request: 'Check my email' })
  const next = await f.claim(nextId)
  await f.finish(next.args)
  const second = (await f.t.run(ctx => ctx.db.get(first._id)))!
  expect(second.replyRouting).toBeUndefined()
  expect(second.version).toBe(first.version + 1)
  expect(second.contentHash).not.toBe(first.contentHash)
})
it.each(['thread', 'subject', 'headers'] as const)('rejects worker reply routing with invalid %s binding', async change => {
  const f = await fixture(), { args } = await f.claim()
  const replyRouting = { threadId: change === 'thread' ? 'other-thread' : 'thread-1', inReplyTo: change === 'headers' ? '<notice@school.example>\r\nBcc: hidden@example.test' : '<notice@school.example>', references: ['<notice@school.example>'], subject: change === 'subject' ? 'Re: Another subject' : 'Re: A private reminder' }
  await expect(f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: [{ ...mail(), replyRouting }], removedIds: [] })).rejects.toThrow('invalid message content')
  expect(await f.t.run(ctx => ctx.db.query('mailMessages').collect())).toEqual([])
})

it('requires source snapshots for model summaries and hides legacy unbound answers', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args)
  const message = (await f.parent.query(api.mailbox.messages, {}))[0]
  expect(await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, answer: 'Old model output must not become current.', evidence: [{ messageId: message.id, quote: 'Please return the trip form' }] })).toBe(false)
  await f.t.run(ctx => ctx.db.patch(f.runId, { answer: 'Legacy sensitive summary with no provenance.', summarySources: undefined, evidence: [{ messageId: message.id, quote: 'Please return the trip form' }] }))
  const visible = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(visible.answer).not.toContain('Legacy sensitive')
  expect(visible.answer).toContain('Check Gmail again')
  expect((await f.parent.query(api.mailbox.messages, {}))[0].text).toBe(mail().text)
})

it('never accepts invented findings when the checked window has no readable messages', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args, [])
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, sources: [], answer: 'A made-up trip is due tomorrow.', evidence: [] })
  const run = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(run.answer).toContain('No new or changed readable messages')
  expect(run.answer).not.toContain('made-up')
  expect(run.answer).toContain('does not establish that the whole mailbox is clear')
})

it('bounds repeated failed checks, deduplicates failures and requires explicit continuation after exhaustion', async () => {
  const f = await fixture()
  const delays = [15, 30, 60, 120, 120]
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { args, result } = await f.claim()
    expect(result).not.toBeNull()
    const accepted = await Promise.all(Array.from({ length: 20 }, () => f.t.mutation(internal.mailbox.failed, { ...args, reconnect: false, failure: { stage: 'message', code: 'provider_unavailable', status: 503 }, issue: 'synthetic-secret private-provider-body' })))
    expect(accepted.filter(Boolean)).toHaveLength(1)
    const run = (await f.t.run(ctx => ctx.db.get(f.runId)))!
    expect(run).toMatchObject({ status: 'failed', consecutiveFailures: attempt, scanned: attempt * 10, lastFailure: { stage: 'message', code: 'provider_unavailable', status: 503 } })
    expect(JSON.stringify(run)).not.toMatch(/synthetic-secret|private-provider-body/)
    expect((await f.claim()).result).toBeNull()
    if (attempt < 6) {
      expect(run.nextAttemptAt).toBe(Date.now() + delays[attempt - 1] * 60_000)
      vi.setSystemTime(run.nextAttemptAt!)
    } else {
      expect(run.nextAttemptAt).toBeUndefined()
      expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.nextCheckAt).toBeUndefined()
      vi.setSystemTime(Date.now() + 86400_000)
      await f.t.mutation(internal.mailbox.poll, {})
      expect((await f.claim()).result).toBeNull()
      expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(1)
    }
  }
  await expect(f.other.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })).rejects.toThrow('unavailable')
  await f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })
  const resumed = await f.claim(f.runId, 2)
  expect(resumed.result).not.toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!.consecutiveFailures).toBe(0)
  await f.finish(resumed.args, [])
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!.status).toBe('complete')
})

it('blocks authorization failures without automatic retry and keeps failure diagnostics private', async () => {
  const f = await fixture(), { args } = await f.claim()
  await f.t.mutation(internal.mailbox.failed, { ...args, reconnect: true, failure: { stage: 'authorization', code: 'permission', status: 401 } })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!).toMatchObject({ state: 'blocked' })
  const run = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(run.lastFailure).toMatchObject({ stage: 'authorization', code: 'permission', status: 401, at: now })
  expect(run.nextAttemptAt).toBeUndefined()
  expect(await f.other.query(api.mailbox.runs, {})).toEqual([])
  vi.setSystemTime(now + 86400_000)
  expect((await f.claim()).result).toBeNull()
  await expect(f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })).rejects.toThrow()
})

it('resets failure backoff after a successful durable page and rejects an abandoned lease’s late failure', async () => {
  const f = await fixture(), first = await f.claim()
  await f.t.mutation(internal.mailbox.failed, { ...first.args, reconnect: false, failure: { stage: 'listing', code: 'rate_limit', status: 429 } })
  const failed = (await f.t.run(ctx => ctx.db.get(f.runId)))!
  vi.setSystemTime(failed.nextAttemptAt!)
  const second = await f.claim()
  expect(await f.t.mutation(internal.mailbox.failed, { ...first.args, reconnect: false, failure: { stage: 'message', code: 'unknown' } })).toBe(false)
  await f.t.mutation(internal.mailbox.finishBatch, { ...second.args, messages: [mail()], removedIds: [], processed: 1, nextPageToken: 'next-page', baselineHistoryId: '123' })
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!).toMatchObject({ status: 'queued', consecutiveFailures: 0, lastFailure: { code: 'rate_limit' } })
  const third = await f.claim()
  await f.t.mutation(internal.mailbox.failed, { ...third.args, reconnect: false, failure: { stage: 'message', code: 'timeout', status: 408 } })
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!).toMatchObject({ consecutiveFailures: 1, nextAttemptAt: Date.now() + 15 * 60_000 })
  expect(await f.parent.query(api.mailbox.messages, {})).toHaveLength(1)
})

it('requires exact account consent, pauses selected-sender scans and permits private reading without a model', async () => {
  const f = await fixture()
  expect(await f.enable()).toBe(f.mailboxId)
  await expect(f.other.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 1, lookbackDays: 30, consent: true })).rejects.toThrow('own Gmail')
  await expect(f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 0, lookbackDays: 30, consent: true })).rejects.toThrow()
  await expect(f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 1, lookbackDays: 30, consent: false as true })).rejects.toThrow()
  const watchId = await f.parent.mutation(api.emailWatches.create, { requestId: 'legacy-watch', connectionId: f.connectionId, title: 'Legacy school mail', senders: ['school@example.test'], instruction: 'Prepare dates.', consent: true })
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  await f.enable()
  expect(await f.t.run(ctx => ctx.db.get(watchId))).toMatchObject({ state: 'paused', version: 2 })
  const settings = await f.parent.query(api.mailbox.settings, {})
  expect(settings.modelConfigured).toBe(false)
  const active = (await f.t.run(ctx => ctx.db.get(settings.mailbox!.id as Id<'mailboxes'>)))!
  expect((await f.claim(active.activeRunId!)).result).toMatchObject({ maxReads: 10, request: { kind: 'check', lookbackDays: 30 } })
})

it('keeps raw email, runs and summaries out of the shared household and other adults’ queries', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args)
  const rows = await f.parent.query(api.mailbox.messages, {})
  expect(rows).toHaveLength(1)
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, sources: await f.summarySources(), answer: 'The school asks for a trip form.', evidence: [{ messageId: rows[0].id, quote: 'Please return the trip form' }] })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].coverage).toContain('not the whole mailbox')
  for (const reader of [f.other, f.outsider]) {
    expect(await reader.query(api.mailbox.messages, {})).toEqual([])
    expect(await reader.query(api.mailbox.runs, {})).toEqual([])
    expect((await reader.query(api.mailbox.settings, {})).mailbox).toBeNull()
    await expect(reader.mutation(api.mailbox.dismissMessage, { id: rows[0].id as Id<'mailMessages'>, version: 1, dismissed: true })).rejects.toThrow('unavailable')
  }
  for (const table of ['jobs', 'sources', 'actions', 'personalTasks', 'notifications'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
  expect(JSON.stringify(await f.t.run(ctx => ctx.db.query('memoryFacts').collect()))).not.toContain('trip form')
  await expect(f.t.query(api.mailbox.messages, {})).rejects.toThrow('Sign in')
})

it('shares only the edited preview after explicit consent, once, without external approval', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args)
  const message = (await f.parent.query(api.mailbox.messages, {}))[0], id = message.id as Id<'mailMessages'>, text = 'Return the field trip form by October 12.'
  await expect(f.parent.mutation(api.mailbox.shareMessage, { id, version: 1, text, consent: false as true })).rejects.toThrow()
  await expect(f.other.mutation(api.mailbox.shareMessage, { id, version: 1, text, consent: true })).rejects.toThrow('unavailable')
  const ids = await Promise.all(Array.from({ length: 20 }, () => f.parent.mutation(api.mailbox.shareMessage, { id, version: 1, text, consent: true })))
  expect(new Set(ids).size).toBe(1)
  const shared = await f.other.query(api.jobs.list, {})
  expect(shared).toHaveLength(1); expect(shared[0].source?.text).toBe(text)
  expect(shared[0].source?.email).toBeUndefined()
  expect(JSON.stringify(shared)).not.toContain('Private health')
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  await expect(f.parent.mutation(api.mailbox.shareMessage, { id, version: 1, text: 'Different sharing content', consent: true })).rejects.toThrow('already shared')
})

it.each(['pause', 'revoke', 'membership', 'account', 'allowlist'] as const)('rejects late worker and summary results after %s changes', async change => {
  const f = await fixture(), { args } = await f.claim()
  if (change === 'pause') await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  else if (change === 'revoke') await f.t.run(ctx => ctx.db.patch(f.connectionId, { status: 'revoked', version: 2 }))
  else if (change === 'account') await f.t.run(ctx => ctx.db.patch(f.connectionId, { email: 'other@example.test' }))
  else if (change === 'allowlist') vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'other@example.test')
  else await f.t.run(async ctx => { const m = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(m!._id) })
  expect(await f.t.query(internal.mailbox.permitted, args)).toBe(false)
  expect(await f.finish(args)).toBe(false)
  expect(await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, answer: 'Should not persist.', evidence: [] })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('mailMessages').collect())).toEqual([])
})

it('deduplicates concurrent user requests and refuses a reused identifier with changed scope', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args, [])
  const request = { requestId: 'same-request', kind: 'search' as const, query: 'field trip', lookbackDays: 365, request: 'Find email about the field trip.' }
  const ids = await Promise.all(Array.from({ length: 40 }, () => f.parent.mutation(api.mailbox.request, request)))
  expect(new Set(ids).size).toBe(1)
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(2)
  await expect(f.parent.mutation(api.mailbox.request, { ...request, query: 'health' })).rejects.toThrow('different mailbox')
  await expect(f.parent.mutation(api.mailbox.request, { ...request, requestId: 'another-request' })).rejects.toThrow('already open')
  await expect(f.other.mutation(api.mailbox.continueRun, { id: ids[0], version: 1 })).rejects.toThrow('unavailable')
})

it('persists pages and deduplicates replayed messages without advancing history until durable completion', async () => {
  const f = await fixture(), first = await f.claim()
  expect((await f.claim()).result).toBeNull()
  await f.t.mutation(internal.mailbox.finishBatch, { ...first.args, messages: [mail()], removedIds: [], processed: 1, nextPageToken: 'page-2', baselineHistoryId: '123' })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBeUndefined()
  const second = await f.claim()
  expect(second.result?.pageToken).toBe('page-2')
  expect(await f.finish(first.args)).toBe(false)
  await f.finish(second.args)
  expect(await f.parent.query(api.mailbox.messages, {})).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ historyId: '123', lastCheckedAt: now, dayReadCount: 2 })
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'complete', scanned: 2 })
})

it('preserves the explicit 100-read segment and its exact continuation cursor', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.runId, { requestId: 'manual-check' }))
  for (let n = 0; n < 10; n++) {
    const { args } = await f.claim()
    await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: Array.from({ length: 10 }, (_, i) => mail(`m-${n}-${i}`)), removedIds: [], processed: 10, nextPageToken: `page-${n + 1}`, baselineHistoryId: '123' })
  }
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'partial', scanned: 100, pageToken: 'page-10' })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].messages).toHaveLength(20)
  expect((await f.parent.query(api.mailbox.messages, {}))).toHaveLength(30)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBeUndefined()
  vi.setSystemTime(now + mailboxIntervalMs)
  await f.t.mutation(internal.mailbox.poll, {})
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'queued', version: 2, segmentScanned: 0, pageToken: 'page-10' })
  const { args, result } = await f.claim(f.runId, 2)
  expect(result?.pageToken).toBe('page-10')
  await f.finish(args, [mail('last')])
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'complete', scanned: 101 })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBe('123')
})

it('counts skipped provider reads and conservatively budgets interrupted attempts until the next UTC day', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.mailboxId, { readDay: Math.floor(now / 86400_000), dayReadCount: 999 }))
  const first = await f.claim(); expect(first.result?.maxReads).toBe(1)
  await f.t.mutation(internal.mailbox.finishBatch, { ...first.args, messages: [], removedIds: ['gone'], processed: 1, nextPageToken: 'remaining', baselineHistoryId: '123' })
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'partial', scanned: 1 })
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ dayReadCount: 1000, nextCheckAt: Date.parse('2026-10-07T00:00:00Z') })
  await f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })
  expect((await f.claim(f.runId, 2)).result).toBeNull()
  vi.setSystemTime(Date.parse('2026-10-07T00:00:00Z'))
  await f.t.mutation(internal.mailbox.poll, {})
  const resumed = await f.claim(f.runId, 3)
  expect(resumed.result?.maxReads).toBe(10)
  vi.setSystemTime(Date.now() + 120_001)
  const recovered = await f.claim(f.runId, 3)
  expect(recovered.result?.run.scanned).toBe(11)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.dayReadCount).toBe(20)
})

it('drains pending history message IDs before advancing the checkpoint, and removes archived or deleted inbox sources', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args, [mail('old')])
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const runId = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, delta = await f.claim(runId)
  expect(delta.result).toMatchObject({ historyId: '123', run: { mode: 'history' } })
  await f.t.mutation(internal.mailbox.finishBatch, { ...delta.args, messages: [mail('new')], removedIds: ['old'], processed: 1, pendingProviderIds: ['pending'], nextPageToken: 'history-page-2', historyId: '456' })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBe('123')
  const next = await f.claim(runId)
  expect(next.result).toMatchObject({ historyId: '123', pendingProviderIds: ['pending'], pageToken: 'history-page-2', run: { resultHistoryId: '456' } })
  await f.t.mutation(internal.mailbox.finishBatch, { ...next.args, messages: [{ ...mail('new'), labels: ['ARCHIVED'] }], removedIds: [], processed: 1, pendingProviderIds: [], historyId: '789' })
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBe('789')
})

it('handles expired history with disclosed bounded resynchronization and preserves deduplication', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const runId = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, delta = await f.claim(runId)
  await f.t.mutation(internal.mailbox.resetCursor, { ...delta.args, resetHistory: true })
  const reset = await f.claim(runId)
  expect(reset.result).toMatchObject({ run: { mode: 'baseline', recoveredHistory: true } })
  expect(reset.result?.historyId).toBeUndefined()
  await f.finish(reset.args)
  expect(await f.parent.query(api.mailbox.messages, {})).toHaveLength(1)
  await f.t.mutation(internal.mailbox.finishSummary, { id: runId, version: 1, answer: 'Unused model copy.', evidence: [], issue: 'model_unconfigured' })
  const run = (await f.parent.query(api.mailbox.runs, {}))[0]
  expect(run.coverage).toContain('earlier coverage is incomplete')
  expect(run.answer).toContain('No new or changed readable messages')
})

it('never persists raw provider errors and retries with safe backoff', async () => {
  const f = await fixture(), { args } = await f.claim()
  await f.t.mutation(internal.mailbox.failed, { ...args, reconnect: false, issue: 'Sensitive simulated provider payload' })
  expect(JSON.stringify(await f.parent.query(api.mailbox.runs, {}))).not.toContain('Sensitive')
  expect((await f.claim()).result).toBeNull()
  await f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })
  const resumed = await f.claim(f.runId, 2); expect(resumed.result).not.toBeNull()
  await f.t.mutation(internal.mailbox.failed, { ...resumed.args, reconnect: true })
  expect((await f.parent.query(api.mailbox.settings, {})).mailbox?.state).toBe('blocked')
})

it('rejects oversized, mismatched-window and hidden-label results before persisting a completed check', async () => {
  const f = await fixture(), { args } = await f.claim()
  for (const messages of [Array.from({ length: 11 }, (_, i) => mail(`m-${i}`)), [{ ...mail(), receivedAt: now - 31 * 86400_000 }], [{ ...mail(), text: 'x'.repeat(16001) }]]) await expect(f.t.mutation(internal.mailbox.finishBatch, { ...args, messages, removedIds: [] })).rejects.toThrow()
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
  await f.finish(args, [{ ...mail(), labels: ['INBOX', 'SPAM'] }])
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
})

it('makes private decisions stale after message content changes and preserves explicit dismissal', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const message = (await f.parent.query(api.mailbox.messages, {}))[0], id = message.id as Id<'mailMessages'>
  await f.parent.mutation(api.mailbox.dismissMessage, { id, version: 1, dismissed: true })
  await expect(f.parent.mutation(api.mailbox.dismissMessage, { id, version: 1, dismissed: false })).rejects.toThrow('changed')
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const next = await f.claim((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!)
  await f.finish(next.args, [{ ...mail(), text: 'The deadline changed to October 13.' }])
  expect((await f.parent.query(api.mailbox.messages, {}))[0]).toMatchObject({ version: 3, dismissed: true })
  await expect(f.parent.mutation(api.mailbox.shareMessage, { id, version: 2, text: 'Old text', consent: true })).rejects.toThrow('changed')
})

it('uses current owner evidence, keeps automatic empty deltas quiet and includes cached context only on explicit checks', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, sources: await f.summarySources(), answer: 'The trip is cancelled.', evidence: [{ messageId: 'someone-elses-message', quote: 'trip is cancelled' }] })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].answer).toContain('could not verify')
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const runId = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, delta = await f.claim(runId)
  await f.finish(delta.args, [])
  const context = await f.t.query(internal.mailbox.summaryContext, { id: runId, version: 1 })
  expect(context).toMatchObject({ freshCount: 0, cachedCount: 0, messages: [] })
  expect((await f.parent.query(api.mailbox.runs, {})).find(run => run.id === runId)).toBeUndefined() // Empty automatic checks stay quiet.
  const explicitId = await f.parent.mutation(api.mailbox.request, { requestId: 'manual-empty-check', kind: 'check', query: '', lookbackDays: 30, request: 'Check my email' })
  await f.finish((await f.claim(explicitId)).args, [])
  expect((await f.parent.query(api.mailbox.runs, {})).find(run => run.id === explicitId)?.messages).toMatchObject([{ text: mail().text }])
  for (let n = 1; n <= 11; n++) {
    vi.setSystemTime(now + (n + 1) * mailboxIntervalMs)
    await f.t.mutation(internal.mailbox.poll, {})
    const autoId = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!
    await f.finish((await f.claim(autoId)).args, [])
  }
  expect((await f.parent.query(api.mailbox.runs, {})).some(run => run.id === explicitId)).toBe(true)
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  expect(await f.t.query(internal.mailbox.summaryContext, { id: runId, version: 1 })).toBeNull()
})

it('never mixes two actual private mailboxes in the same household or accepts the other mailbox’s evidence', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const connectionId = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|other', provider: 'google', status: 'active', version: 1, scopes: [gmailReadScope], email: 'other@example.test' }))
  const mailboxId = await f.other.mutation(api.mailbox.enable, { connectionId, connectionVersion: 1, lookbackDays: 30, consent: true })
  const runId = (await f.t.run(ctx => ctx.db.get(mailboxId)))!.activeRunId!, otherClaim = await f.claim(runId)
  await f.finish(otherClaim.args, [{ ...mail('other-private'), text: 'Other parent medical appointment.', subject: 'Other private message' }])
  expect((await f.parent.query(api.mailbox.messages, {})).map(m => m.subject)).toEqual(['A private reminder'])
  expect((await f.other.query(api.mailbox.messages, {})).map(m => m.subject)).toEqual(['Other private message'])
  const otherMessage = (await f.other.query(api.mailbox.messages, {}))[0]
  expect(JSON.stringify(await f.t.query(internal.mailbox.summaryContext, { id: f.runId, version: 1 }))).not.toContain('Other parent medical')
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, sources: await f.summarySources(), answer: 'Other parent medical appointment.', evidence: [{ messageId: otherMessage.id, quote: 'Other parent medical appointment.' }] })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].answer).toContain('could not verify')
})

it('keeps dismissal restorable and blocks hiding an active or uncertain private draft', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const message = (await f.t.run(ctx => ctx.db.query('mailMessages').first()))!
  const draftId = await f.t.run(ctx => ctx.db.insert('mailDrafts', { householdId: f.householdId, createdBy: 'test|parent', mailboxId: f.mailboxId, messageId: message._id, sourceVersion: message.version, sourceHash: message.contentHash, connectionId: f.connectionId, connectionVersion: 1, accountKey: message.accountKey, accountEmail: 'parent@example.test', instruction: 'Draft a reply.', preparationKey: 'synthetic-prepare', version: 1, input: { to: 'school@example.test', subject: 'Form', body: 'I will return it.' }, status: 'uncertain', createdAt: now, expiresAt: now + 86400_000 }))
  for (const status of ['uncertain', 'sending', 'send_uncertain'] as const) {
    await f.t.run(ctx => ctx.db.patch(draftId, { status }))
    await expect(f.parent.mutation(api.mailbox.dismissMessage, { id: message._id, version: 1, dismissed: true })).rejects.toThrow('uncertain reply')
  }
  await f.t.run(ctx => ctx.db.patch(draftId, { status: 'review' }))
  await f.parent.mutation(api.mailbox.dismissMessage, { id: message._id, version: 1, dismissed: true })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].messages).toMatchObject([{ dismissed: true, version: 2 }])
  expect((await f.t.query(internal.mailbox.summaryContext, { id: f.runId, version: 1 }))?.messages).toEqual([])
  await f.parent.mutation(api.mailbox.dismissMessage, { id: message._id, version: 2, dismissed: false })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].messages).toMatchObject([{ dismissed: false, version: 3 }])
})

it('preserves the incremental checkpoint on same-account grant resume and cannot bypass daily limits by changing the window', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  expect((await f.parent.query(api.mailbox.settings, {})).mailbox?.connectionVersion).toBe(1)
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 1, paused: true })
  await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 2, paused: false })
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ connectionVersion: 2, version: 3 })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBe('123')
  await f.t.run(ctx => ctx.db.patch(f.mailboxId, { readDay: Math.floor(now / 86400_000), dayReadCount: 1000 }))
  const newId = await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 90, consent: true })
  expect((await f.t.run(ctx => ctx.db.get(newId)))?.dayReadCount).toBe(1000)
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
})

it('uses a historical baseline for changed lookback without skipping the existing incremental checkpoint', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const runId = await f.parent.mutation(api.mailbox.request, { requestId: 'historical-check', kind: 'check', query: '', lookbackDays: 90, request: 'Check my email over the last 90 days.' })
  const historical = await f.claim(runId)
  expect(historical.result?.run).toMatchObject({ mode: 'baseline', updateCheckpoint: false })
  expect(historical.result?.from).toBe(now - 90 * 86400_000)
  await f.t.mutation(internal.mailbox.finishBatch, { ...historical.args, messages: [], removedIds: [], processed: 0, baselineHistoryId: '999' })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.historyId).toBe('123')
  const freshRunId = await f.parent.mutation(api.mailbox.request, { requestId: 'fresh-check', kind: 'check', query: '', lookbackDays: 30, request: 'Check my email.' })
  expect((await f.claim(freshRunId)).result?.run).toMatchObject({ mode: 'baseline', updateCheckpoint: false, from: now - 30 * 86400_000 })
})

it('expires private sources and summaries and removes mailbox history without deleting explicitly shared work', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const message = (await f.parent.query(api.mailbox.messages, {}))[0]
  await f.parent.mutation(api.mailbox.shareMessage, { id: message.id as Id<'mailMessages'>, version: 1, text: 'Explicitly shared form task.', consent: true })
  await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
  expect(await f.parent.query(api.mailbox.runs, {})).toEqual([])
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  expect(await f.t.run(ctx => ctx.db.query('mailMessages').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toEqual([])
  expect(await f.parent.query(api.jobs.list, {})).toHaveLength(1)
  const g = await fixture(), gclaim = await g.claim(); await g.finish(gclaim.args)
  vi.setSystemTime(now + 31 * 86400_000)
  expect(await g.parent.query(api.mailbox.messages, {})).toEqual([])
  await g.t.mutation(internal.privacy.expireSources, {})
  expect(await g.t.run(ctx => ctx.db.query('mailMessages').collect())).toEqual([])
  expect(await g.t.run(ctx => ctx.db.query('mailRuns').collect())).toEqual([])
})

it('erases all private mailbox tables with the household', async () => {
  const f = await fixture(), { args } = await f.claim(); await f.finish(args)
  const deletion = await f.t.run(async ctx => { await ctx.db.patch(f.householdId, { deleted: true }); return ctx.db.insert('deletionJobs', { householdId: f.householdId, requestedAt: now, status: 'pending', identityStatus: 'deleted' }) })
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion })
  for (const table of ['mailboxes', 'mailRuns', 'mailMessages'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})


it('prepares every automatic source in bounded batches before continuing and coalesces duplicate continuation', async () => {
  const f = await fixture(), seen = new Set<string>()
  for (let version = 1; version <= 3; version++) {
    const count = version === 3 ? 5 : 20
    for (let offset = 0; offset < count; offset += 10) {
      const { args, result } = await f.claim(f.runId, version)
      expect(result).not.toBeNull()
      const rows = Array.from({ length: Math.min(10, count - offset) }, (_, i) => mail(`batch-${version}-${offset + i}`))
      const more = version !== 3 || offset + rows.length < count
      await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: rows, removedIds: [], processed: rows.length, ...(more ? { nextPageToken: `cursor-${version}-${offset}` } : {}), baselineHistoryId: '123' })
    }
    const run = (await f.t.run(ctx => ctx.db.get(f.runId)))!
    expect(run).toMatchObject({ status: version < 3 ? 'partial' : 'complete', version })
    const context = (await f.t.query(internal.mailbox.summaryContext, { id: f.runId, version }))!
    expect(context.messages).toHaveLength(count)
    expect(context.cachedCount).toBe(0)
    for (const m of context.messages) { expect(seen.has(m.providerId)).toBe(false); seen.add(m.providerId) }
    // No cursor advancement while preparation is absent or unverified, including explicit Continue.
    if (version < 3) {
      vi.setSystemTime(Date.now() + mailboxIntervalMs)
      await f.t.mutation(internal.mailbox.poll, {})
      expect((await f.t.run(ctx => ctx.db.get(f.runId)))?.version).toBe(version)
      await expect(f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version })).rejects.toThrow('preparation')
      expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version })).toBe(false)
    }
    const sources = context.messages.map(m => ({ id: m._id, version: m.version, hash: m.contentHash }))
    await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version, sources, answer: 'These messages ask for trip forms.', evidence: [{ messageId: context.messages[0]._id, quote: 'Please return the trip form' }] })
    if (version < 3) {
      expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version })).toBe(true)
      expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version })).toBe(false)
      expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ version: version + 1, messageIds: [], status: 'queued' })
    }
  }
  expect(seen.size).toBe(45)
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ historyId: '123', dayReadCount: 45 })
})

it('does not discard a failed preparation batch, but can continue disclosed raw reading when a model is unconfigured', async () => {
  const f = await fixture(), { args } = await f.claim()
  await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: [mail()], removedIds: [], processed: 1, nextPageToken: 'next', partial: true, baselineHistoryId: '123' })
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, answer: 'Unused', evidence: [], issue: 'model_failed' })
  expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version: 1 })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))?.messageIds).toHaveLength(1)
  await f.t.mutation(internal.mailbox.finishSummary, { id: f.runId, version: 1, answer: 'Unused', evidence: [], issue: 'model_unconfigured' })
  expect((await f.parent.query(api.mailbox.runs, {}))[0].answer).toContain('AI summaries are not connected')
  expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version: 1 })).toBe(true)
})

it('updates read/unread labels without invalidating source evidence or preparing the same mail again', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args, [{ ...mail(), labels: ['INBOX', 'UNREAD'] }])
  const original = (await f.t.run(ctx => ctx.db.query('mailMessages').collect()))[0]
  // A legacy hash also stays stable through this source-neutral update.
  await f.t.run(ctx => ctx.db.patch(original._id, { contentHash: 'legacy-source-hash', preparationHash: 'legacy-source-hash' }))
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const id = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, delta = await f.claim(id)
  await f.finish(delta.args, [{ ...mail(), labels: ['STARRED', 'INBOX'] }])
  expect(await f.t.run(ctx => ctx.db.get(original._id))).toMatchObject({ version: original.version, contentHash: 'legacy-source-hash', labels: ['STARRED', 'INBOX'] })
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ quiet: true, status: 'complete', messageIds: [], scanned: 1 })
  expect((await f.t.query(internal.mailbox.summaryContext, { id, version: 1 }))?.messages).toEqual([])
  expect((await f.parent.query(api.mailbox.runs, {})).some(r => r.id === id)).toBe(false)
})

it('replaces an expired active run with a fresh check instead of repeatedly scheduling an impossible lease', async () => {
  const f = await fixture(), first = await f.claim()
  await f.t.run(ctx => ctx.db.patch(f.runId, { expiresAt: now - 1 }))
  expect((await f.claim()).result).toBeNull() // existing lease still owns this instant
  vi.setSystemTime(now + mailboxIntervalMs)
  await f.t.mutation(internal.mailbox.poll, {})
  const box = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!
  expect(box.activeRunId).not.toBe(f.runId)
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'cancelled', version: 2 })
  expect(await f.finish(first.args)).toBe(false)
  expect((await f.claim(box.activeRunId!)).result).not.toBeNull()
})

it('bounds repeated cursor resets even when zero messages were read, and requires a deliberate retry afterward', async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) {
    const { args } = await f.claim()
    expect(await f.t.mutation(internal.mailbox.resetCursor, args)).toBe(true)
  }
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'failed', cursorResets: 4, consecutiveFailures: 6 })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.nextCheckAt).toBeUndefined()
  expect((await f.claim()).result).toBeNull()
  await f.parent.mutation(api.mailbox.continueRun, { id: f.runId, version: 1 })
  expect((await f.claim(f.runId, 2)).result).not.toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))?.cursorResets).toBe(0)
})


it('recovers a lost final preparation dispatch before releasing the automatic run', async () => {
  const f = await fixture(), { args } = await f.claim()
  await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: [mail()], removedIds: [], baselineHistoryId: '123' })
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'complete', messageIds: [expect.any(String)] })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(f.runId)
  const summaries = () => f.t.run(async ctx => (await ctx.db.system.query('_scheduled_functions').collect()).filter(timer => timer.name === 'gmailMailbox:summarize').length)
  const initial = await summaries()
  vi.setSystemTime(now + mailboxIntervalMs)
  await f.t.mutation(internal.mailbox.poll, {})
  expect(await summaries()).toBe(initial + 1)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.activeRunId).toBe(f.runId)
  await f.t.action(internal.gmailMailbox.summarize, { id: f.runId, version: 1 }) // Actual no-model action, no provider credentials.
  expect(await f.t.mutation(internal.mailbox.resumePrepared, { id: f.runId, version: 1 })).toBe(true)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))?.activeRunId).toBeUndefined()
  const message = (await f.t.run(ctx => ctx.db.query('mailMessages').collect()))[0]
  expect(message.preparationHash).toBe(message.contentHash)
})

it('schedules no model preparation for a label-only update after the source was already handled', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const scheduledPreparation = () => f.t.run(async ctx => (await ctx.db.system.query('_scheduled_functions').collect()).filter(timer => ['gmailMailbox:summarize', 'mailAgent:step'].includes(timer.name)).length)
  const before = await scheduledPreparation()
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const id = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, { args } = await f.claim(id)
  await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: [{ ...mail(), labels: ['INBOX', 'UNREAD'] }], removedIds: [], historyId: '456' })
  expect(await scheduledPreparation()).toBe(before)
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ quiet: true, preparedVersion: 1 })
  expect(await f.t.mutation(internal.mailbox.resumePrepared, { id, version: 1 })).toBe(true)
  expect(await f.t.run(ctx => ctx.db.query('mailAgents').collect())).toEqual([])
})

it('does not mistake a manually cached message omitted from its summary for already prepared mail', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const manualId = await f.parent.mutation(api.mailbox.request, { requestId: 'manual-large', kind: 'check', query: '', lookbackDays: 30, request: 'Check my inbox' })
  for (let page = 0; page < 3; page++) {
    const { args } = await f.claim(manualId)
    const messages = Array.from({ length: page === 2 ? 1 : 10 }, (_, i) => mail(`manual-${page * 10 + i}`))
    await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages, removedIds: [], ...(page < 2 ? { nextPageToken: `manual-page-${page}` } : {}), baselineHistoryId: '123' })
  }
  const context = (await f.t.query(internal.mailbox.summaryContext, { id: manualId, version: 1 }))!
  expect(context.messages.some(m => m.providerId === 'manual-0')).toBe(false)
  await f.t.mutation(internal.mailbox.finishSummary, { id: manualId, version: 1, answer: 'Unused', evidence: [], issue: 'model_unconfigured' })
  const omitted = (await f.t.run(ctx => ctx.db.query('mailMessages').collect())).find(m => m.providerId === 'manual-0')!
  expect(omitted.preparationHash).toBeUndefined()
  vi.setSystemTime(now + mailboxIntervalMs); await f.t.mutation(internal.mailbox.poll, {})
  const id = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, { args } = await f.claim(id)
  await f.t.mutation(internal.mailbox.finishBatch, { ...args, messages: [mail('manual-0')], removedIds: [], historyId: '456' })
  expect((await f.t.query(internal.mailbox.summaryContext, { id, version: 1 }))?.messages.map(m => m.providerId)).toEqual(['manual-0'])
  expect(await f.t.run(ctx => ctx.db.get(omitted._id))).toMatchObject({ version: omitted.version, contentHash: omitted.contentHash })
})

it('renews the same account in place without erasing cached messages, private drafts, receipts or its incremental checkpoint', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const message = (await f.t.run(ctx => ctx.db.query('mailMessages').first()))!
  const draftId = await f.t.run(ctx => ctx.db.insert('mailDrafts', {
    householdId: f.householdId, createdBy: 'test|parent', mailboxId: f.mailboxId,
    messageId: message._id, sourceVersion: message.version, sourceHash: message.contentHash,
    connectionId: f.connectionId, connectionVersion: 1, accountKey: message.accountKey,
    accountEmail: 'parent@example.test', instruction: 'Synthetic saved receipt.', preparationKey: 'preserved-receipt',
    version: 3, input: { to: 'parent@example.test', subject: 'Test', body: 'Synthetic receipt.' }, status: 'sent',
    sentMessageId: 'synthetic-sent-id', sendVerifiedAt: now, createdAt: now, expiresAt: now + 86400_000,
  }))
  const before = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!, draftBefore = await f.t.run(ctx => ctx.db.get(draftId))
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  // A new grant cannot read the old source until the parent renews processing consent.
  await expect(f.parent.mutation(api.mailbox.dismissMessage, { id: message._id, version: message.version, dismissed: true })).rejects.toThrow('access changed')
  expect(await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })).toBe(f.mailboxId)
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ version: 2, state: 'active', connectionVersion: 2,
    historyId: before.historyId, lastCheckedAt: before.lastCheckedAt, nextCheckAt: before.nextCheckAt,
    readDay: before.readDay, dayReadCount: before.dayReadCount, createdAt: before.createdAt })
  expect(await f.t.run(ctx => ctx.db.get(message._id))).toMatchObject({ connectionVersion: 2, version: message.version,
    contentHash: message.contentHash, preparationHash: message.preparationHash, text: message.text, expiresAt: message.expiresAt })
  expect(await f.t.run(ctx => ctx.db.get(draftId))).toEqual(draftBefore)
  expect((await f.parent.query(api.mailDrafts.list, {})).map(d => d.id)).toContain(draftId)
  await f.t.mutation(internal.mailbox.eraseMailbox, { id: f.mailboxId })
  expect(await f.t.run(ctx => ctx.db.get(message._id))).not.toBeNull()
  expect(await f.t.run(ctx => ctx.db.get(draftId))).toEqual(draftBefore)
  vi.setSystemTime(before.nextCheckAt!)
  await f.t.mutation(internal.mailbox.poll, {})
  const next = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!
  const run = (await f.t.run(ctx => ctx.db.get(next.activeRunId!)))!
  expect(run).toMatchObject({ mode: 'history', historyId: '123', connectionVersion: 2 })
})

it('keeps a partially read cursor and charges abandoned reservations when the same grant is renewed', async () => {
  const f = await fixture(), first = await f.claim()
  await f.t.mutation(internal.mailbox.finishBatch, { ...first.args, messages: [mail()], removedIds: [], processed: 1,
    nextPageToken: 'cursor-preserved', pendingProviderIds: ['pending-message'], baselineHistoryId: '123' })
  const active = await f.claim()
  const oldRun = (await f.t.run(ctx => ctx.db.get(f.runId)))!, oldMailbox = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  const run = (await f.t.run(ctx => ctx.db.get(f.runId)))!
  expect(run).toMatchObject({ version: oldRun.version + 1, mailboxVersion: 2, connectionVersion: 2, status: 'queued',
    pageToken: 'cursor-preserved', pendingProviderIds: ['pending-message'], baselineHistoryId: '123',
    scanned: oldRun.scanned + oldRun.reservedReads!, segmentScanned: oldRun.segmentScanned + oldRun.reservedReads! })
  expect(run.lease).toBeUndefined(); expect(run.reservedReads).toBeUndefined()
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.dayReadCount).toBe(oldMailbox.dayReadCount)
  expect(await f.t.query(internal.mailbox.permitted, active.args)).toBe(false)
  expect(await f.t.mutation(internal.mailbox.finishBatch, { ...active.args, messages: [mail('late-result')], removedIds: [] })).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(1)
})

it('preserves rate-limit backoff, failure counts and exhaustion across repeated explicit grant refreshes', async () => {
  const f = await fixture(), first = await f.claim()
  await f.t.mutation(internal.mailbox.failed, { ...first.args, reconnect: false, failure: { stage: 'listing', code: 'rate_limit', status: 429 } })
  const failed = (await f.t.run(ctx => ctx.db.get(f.runId)))!, charged = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.dayReadCount
  for (const connectionVersion of [2, 3]) {
    await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: connectionVersion }))
    await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion, lookbackDays: 30, consent: true })
    const run = (await f.t.run(ctx => ctx.db.get(f.runId)))!
    expect(run).toMatchObject({ status: 'failed', consecutiveFailures: failed.consecutiveFailures, nextAttemptAt: failed.nextAttemptAt, lastFailure: failed.lastFailure })
    expect((await f.claim(f.runId, run.version)).result).toBeNull()
    expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ dayReadCount: charged, nextCheckAt: failed.nextAttemptAt })
  }
  await f.t.run(async ctx => { await ctx.db.patch(f.runId, { consecutiveFailures: 6, nextAttemptAt: undefined }); await ctx.db.patch(f.mailboxId, { nextCheckAt: undefined }); await ctx.db.patch(f.connectionId, { version: 4 }) })
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 4, lookbackDays: 30, consent: true })
  const exhausted = (await f.t.run(ctx => ctx.db.get(f.runId)))!
  expect(exhausted.consecutiveFailures).toBe(6)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.nextCheckAt).toBeUndefined()
  expect((await f.claim(f.runId, exhausted.version)).result).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(1)
})

it.each(['pause', 'remove', 'revoke', 'new-grant', 'account', 'membership', 'allowlist'] as const)('bounds cache rebinding and rejects its stale continuation after %s', async change => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const firstMessage = (await f.t.run(ctx => ctx.db.query('mailMessages').first()))!
  const lastId = await f.t.run(async ctx => {
    let id = firstMessage._id
    const { _id, _creationTime, ...fields } = firstMessage
    for (let i = 0; i < 101; i++) id = await ctx.db.insert('mailMessages', { ...fields, providerId: `cached-${i}` })
    return id
  })
  const page = await f.t.run(ctx => ctx.db.query('mailMessages').withIndex('by_mailbox', q => q.eq('mailboxId', f.mailboxId)).paginate({ cursor: null, numItems: 100 }))
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ state: 'blocked', version: 2 })
  expect((await f.t.run(ctx => ctx.db.get(lastId)))!.connectionVersion).toBe(1)
  if (change === 'pause') await f.parent.mutation(api.mailbox.setPaused, { id: f.mailboxId, version: 2, paused: true })
  if (change === 'remove') await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 2 })
  if (change === 'revoke') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 3, status: 'revoked' }))
  if (change === 'new-grant') await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 3 }))
  if (change === 'account') await f.t.run(ctx => ctx.db.patch(f.connectionId, { email: 'other@example.test' }))
  if (change === 'membership') await f.t.run(async ctx => { const membership = await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique(); await ctx.db.delete(membership!._id) })
  if (change === 'allowlist') vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'other@example.test')
  await f.t.mutation(internal.mailbox.refreshCachedConnection, { id: f.mailboxId, version: 2, connectionVersion: 2, cursor: page.continueCursor, resumeAt: now })
  expect((await f.t.run(ctx => ctx.db.get(lastId)))!.connectionVersion).toBe(1)
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.state).not.toBe('active')
})

it('finishes a bounded cache refresh without changing evidence or reviving an old draft approval', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const message = (await f.t.run(ctx => ctx.db.query('mailMessages').first()))!
  await f.t.run(async ctx => { const { _id, _creationTime, ...fields } = message; for (let i = 0; i < 101; i++) await ctx.db.insert('mailMessages', { ...fields, providerId: `cached-${i}` }) })
  const page = await f.t.run(ctx => ctx.db.query('mailMessages').withIndex('by_mailbox', q => q.eq('mailboxId', f.mailboxId)).paginate({ cursor: null, numItems: 100 }))
  const draftId = await f.t.run(ctx => ctx.db.insert('mailDrafts', { householdId: f.householdId, createdBy: 'test|parent', mailboxId: f.mailboxId, messageId: message._id,
    sourceVersion: message.version, sourceHash: message.contentHash, connectionId: f.connectionId, connectionVersion: 1, accountKey: message.accountKey,
    accountEmail: 'parent@example.test', instruction: 'Synthetic.', preparationKey: 'old-approved', version: 2,
    input: { to: 'parent@example.test', subject: 'Test', body: 'Synthetic.' }, status: 'saving', approvedAt: now,
    approvedHash: 'old-hash', operationKey: 'old-operation', createdAt: now, expiresAt: now + 86400_000 }))
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  await f.t.mutation(internal.mailbox.refreshCachedConnection, { id: f.mailboxId, version: 2, connectionVersion: 2, cursor: page.continueCursor, resumeAt: now })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.state).toBe('active')
  for (const row of await f.t.run(ctx => ctx.db.query('mailMessages').collect())) expect(row).toMatchObject({ connectionVersion: 2, version: message.version, contentHash: message.contentHash })
  expect(await f.t.run(ctx => ctx.db.get(draftId))).toMatchObject({ connectionVersion: 1, operationKey: 'old-operation', approvedHash: 'old-hash' })
  expect(await f.t.mutation(internal.mailDrafts.claimSave, { id: draftId, version: 2, lease: 'late-old-approval', readOnly: false })).toBeNull()
})

it.each(['revoked', 'wrong-owner', 'wrong-account', 'removed'] as const)('never restores the old cache through a %s connection', async change => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  if (change === 'removed') await f.parent.mutation(api.mailbox.remove, { id: f.mailboxId, version: 1 })
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2, ...(change === 'revoked' ? { status: 'revoked' as const } : {}), ...(change === 'wrong-owner' ? { subject: 'test|other' } : {}), ...(change === 'wrong-account' ? { email: 'other@example.test' } : {}) }))
  const operation = f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  if (change === 'revoked' || change === 'wrong-owner') {
    await expect(operation).rejects.toThrow('own Gmail')
    expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.connectionVersion).toBe(1)
  } else {
    expect(await operation).not.toBe(f.mailboxId)
    expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.state).toBe('removed')
    expect(await f.parent.query(api.mailbox.messages, {})).toEqual([])
  }
})

it('retains a completed scan awaiting preparation instead of advancing past its unprepared messages', async () => {
  const f = await fixture(), first = await f.claim()
  await f.t.mutation(internal.mailbox.finishBatch, { ...first.args, messages: [mail()], removedIds: [], baselineHistoryId: '123' })
  const before = (await f.t.run(ctx => ctx.db.get(f.runId)))!
  expect(before.status).toBe('complete'); expect(before.preparedVersion).toBeUndefined()
  expect(before.messageIds).toHaveLength(1)
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId).toBe(f.runId)
  expect(await f.t.run(ctx => ctx.db.get(f.runId))).toMatchObject({ status: 'complete', version: 2,
    connectionVersion: 2, mailboxVersion: 2, messageIds: before.messageIds })
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!.preparedVersion).toBeUndefined()
  const context = await f.t.query(internal.mailbox.summaryContext, { id: f.runId, version: 2 })
  expect(context?.messages.map(m => m._id)).toEqual(before.messageIds)
  expect(await f.t.run(ctx => ctx.db.query('mailRuns').collect())).toHaveLength(1)
  expect(await f.t.query(internal.mailbox.summaryContext, { id: f.runId, version: 1 })).toBeNull()
})

it('does not reinterpret the same cached body as a new content version after refreshed consent', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  const before = (await f.t.run(ctx => ctx.db.query('mailMessages').first()))!
  const due = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.nextCheckAt!
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2 }))
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  vi.setSystemTime(due)
  await f.t.mutation(internal.mailbox.poll, {})
  const runId = (await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId!, next = await f.claim(runId)
  await f.finish(next.args)
  expect(await f.t.run(ctx => ctx.db.get(before._id))).toMatchObject({ version: before.version, contentHash: before.contentHash, connectionVersion: 2 })
})

it('rejects a regressed connection version without erasing the current mailbox', async () => {
  const f = await fixture(), first = await f.claim(); await f.finish(first.args)
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 0 }))
  await expect(f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 0, lookbackDays: 30, consent: true })).rejects.toThrow('permission changed')
  expect(await f.t.run(ctx => ctx.db.get(f.mailboxId))).toMatchObject({ version: 1, connectionVersion: 1, state: 'active', historyId: '123' })
  expect(await f.t.run(ctx => ctx.db.query('mailMessages').collect())).toHaveLength(1)
})

it('does not revive a scanner with stale mailbox bindings when processing fresh consent', async () => {
  const f = await fixture()
  await f.t.run(async ctx => { await ctx.db.patch(f.runId, { mailboxVersion: 0 }); await ctx.db.patch(f.connectionId, { version: 2 }) })
  await f.parent.mutation(api.mailbox.enable, { connectionId: f.connectionId, connectionVersion: 2, lookbackDays: 30, consent: true })
  expect((await f.t.run(ctx => ctx.db.get(f.runId)))!.status).toBe('cancelled')
  expect((await f.t.run(ctx => ctx.db.get(f.mailboxId)))!.activeRunId).not.toBe(f.runId)
})
