import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { event } from '../tests/fixtures/calendar'
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
async function fixture(native = false) {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const phone = '11111111-1111-4111-8111-111111111111'
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic museum notice', hash: 'notice', revision: 1, expiresAt: Date.now() + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    const actionId = await ctx.db.insert('actions', { householdId, jobId, payload: event, sourceRevision: 1, revision: 1, status: 'review' })
    const connectionId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: native ? 'apple' : 'google', status: 'active', version: 1, scopes: [native ? 'calendar.local.full' : 'https://www.googleapis.com/auth/calendar.app.created'], calendarId: 'synthetic-calendar', ...(native ? { nativeDeviceId: phone } : {}) })
    return { actionId, connectionId }
  })
  if (native) await parent.mutation(api.connections.choose, { purpose: 'calendar', id: ids.connectionId, version: 0 })
  await parent.mutation(api.jobs.approve, { actions: [{ id: ids.actionId, revision: 1, ...(native ? { selectionVersion: 1, nativeCalendar: { calendarId: 'synthetic-calendar', version: 1 } } : {}) }] })
  const approval = (await t.run(ctx => ctx.db.query('approvals').collect()))[0]
  return { t, parent, householdId, phone, approval, ...ids }
}
it('pins the reviewed tool and blocks an unsupported tool version before reserving execution', async () => {
  const f = await fixture()
  expect(f.approval).toMatchObject({ toolName: 'calendar.google.commit', toolVersion: 1 })
  await f.t.run(ctx => ctx.db.patch(f.approval._id, { toolVersion: 2 }))
  expect(await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: f.approval._id })).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('review')
})
it('rechecks tool binding at the native dispatch boundary rather than relying on the cloud dispatcher', async () => {
  const f = await fixture(true)
  const claim = await f.parent.action(api.apple.claim, { actionId: f.actionId, deviceId: f.phone })
  expect(claim).not.toBeNull()
  expect(await f.t.run(ctx => ctx.db.get(claim!.attemptId))).toMatchObject({ toolName: 'calendar.apple.commit', toolVersion: 1, dispatched: false })
  await f.t.run(ctx => ctx.db.patch(f.approval._id, { toolName: 'calendar.google.commit' }))
  expect(await f.parent.action(api.apple.dispatch, { actionId: f.actionId, deviceId: f.phone, attemptId: claim!.attemptId })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(claim!.attemptId)))?.dispatched).toBe(false)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('rejects a same-household approval attached to the wrong action even when its content matches', async () => {
  const f = await fixture()
  const wrong = await f.t.run(async ctx => {
    const original = (await ctx.db.get(f.actionId))!
    const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId: original.jobId, payload: original.payload, sourceRevision: 1, revision: 1, status: 'queued', approvalId: f.approval._id })
    return actionId
  })
  expect(await f.t.mutation(internal.execution.claim, { actionId: wrong, approvalId: f.approval._id })).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
})
it('bounds repeated pre-dispatch attempts for one approval even if a worker bypasses preflight', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (let i = 0; i < 8; i++) await ctx.db.insert('attempts', { householdId: f.householdId, actionId: f.actionId, approvalId: f.approval._id, startedAt: Date.now(), dispatched: false, finished: true })
  })
  expect(await f.t.mutation(internal.execution.claim, { actionId: f.actionId, approvalId: f.approval._id })).toBeNull()
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toHaveLength(8)
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.error).toMatch(/execution limit/)
})
