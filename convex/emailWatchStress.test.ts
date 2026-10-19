import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { gmailReadScope, watchIntervalMs } from '../shared/emailWatches'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-06T12:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function setup() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'stress-parent', tokenIdentifier: 'synthetic|stress-parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const connectionId = await t.run(ctx => ctx.db.insert('connections', { householdId, subject: 'synthetic|stress-parent', provider: 'google', version: 1, status: 'active', email: 'synthetic@example.test', scopes: [gmailReadScope] }))
  const id = await parent.mutation(api.emailWatches.create, { requestId: 'stress-watch', connectionId, title: 'Synthetic stress watch', senders: ['school@example.test'], instruction: 'Prepare useful dates for review.', consent: true })
  return { t, parent, id }
}
it('revisits twenty full pages without duplicate jobs and advances only on the final page', async () => {
  const { t, parent, id } = await setup()
  for (let page = 0; page < 20; page++) {
    const lease = { id, version: 1, lease: `synthetic-${page}` }
    await t.mutation(internal.emailWatches.claim, lease)
    const messages = Array.from({ length: 5 }, (_, offset) => ({ id: `message-${page * 4 + offset}`, threadId: `thread-${page}`, sender: 'school@example.test', subject: 'Synthetic deadline', text: 'Please return the form by October 20.', receivedAt: now - 1000, truncated: false, extraction: { format: 'plain' as const, truncated: false, incomplete: false, attachments: false, issues: [] } }))
    const input = { ...lease, messages, ...(page < 19 ? { nextPageToken: `page-${page + 1}` } : {}) }
    expect(await t.mutation(internal.emailWatches.finish, input)).toBe(true)
    expect(await t.mutation(internal.emailWatches.finish, input)).toBe(false)
    expect((await parent.query(api.emailWatches.list, {}))[0].lastCheckedAt).toBe(page < 19 ? undefined : now)
    vi.setSystemTime(Date.now() + watchIntervalMs)
  }
  const state = await t.run(async ctx => ({ messages: await ctx.db.query('emailWatchMessages').collect(), jobs: await ctx.db.query('jobs').collect(), approvals: await ctx.db.query('approvals').collect(), attempts: await ctx.db.query('attempts').collect() }))
  expect(state.messages).toHaveLength(81); expect(state.jobs).toHaveLength(81)
  expect(state.approvals).toEqual([]); expect(state.attempts).toEqual([])
  expect(await parent.query(api.emailWatches.recentChecks, {})).toHaveLength(20)
}, 15000)
it('resets only a current permitted cursor while preserving the entire unfinished window', async () => {
  const { t, parent, id } = await setup(), first = { id, version: 1, lease: 'first' }
  await t.mutation(internal.emailWatches.claim, first)
  await t.mutation(internal.emailWatches.finish, { ...first, messages: [], nextPageToken: 'expired-page' })
  vi.setSystemTime(now + watchIntervalMs)
  const second = { ...first, lease: 'second' }
  expect(await t.mutation(internal.emailWatches.claim, second)).toMatchObject({ from: now - 86400_000, through: now, pageToken: 'expired-page' })
  expect(await t.mutation(internal.emailWatches.resetCursor, { ...second, lease: 'wrong' })).toBe(false)
  expect(await t.mutation(internal.emailWatches.resetCursor, second)).toBe(true)
  expect((await t.run(ctx => ctx.db.get(id)))).toMatchObject({ windowFrom: now - 86400_000, windowThrough: now })
  expect((await parent.query(api.emailWatches.list, {}))[0].lastCheckedAt).toBeUndefined()
  vi.setSystemTime(Date.now() + 60_000)
  expect(await t.mutation(internal.emailWatches.claim, { ...first, lease: 'restart' })).toMatchObject({ from: now - 86400_000, through: now })
  await parent.mutation(api.emailWatches.setPaused, { id, version: 1, paused: true })
  expect(await t.mutation(internal.emailWatches.resetCursor, { ...first, lease: 'restart' })).toBe(false)
})
