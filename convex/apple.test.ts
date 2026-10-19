import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import workflow from '@convex-dev/workflow/test'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
const phone = '11111111-1111-4111-8111-111111111111', otherPhone = '22222222-2222-4222-8222-222222222222'
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function setup() {
  const t = convexTest(schema, modules), alice = t.withIdentity({ subject: 'alice' }), bob = t.withIdentity({ subject: 'bob' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await bob.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const connection = await alice.mutation(api.apple.register, { deviceId: phone, calendarId: 'synthetic-calendar', title: 'Synthetic', account: 'Synthetic iCloud' })
  await alice.mutation(api.connections.choose, { id: connection.id, purpose: 'calendar', version: 0 })
  const actionId = await t.run(async ctx => {
    const member = (await ctx.db.query('memberships').withIndex('by_household', q => q.eq('householdId', householdId)).first())!
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic school fixture', hash: 'test-source', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: member.subject, preparing: false, cancelled: false, clarification: '' })
    return ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, status: 'review', payload: { kind: 'calendar', title: 'Maya school trip', childId: 'maya', date: '2026-10-08', startTime: '08:30', endDate: '2026-10-08', endTime: '14:30', allDay: false, timezone: 'UTC', location: 'North gate', notes: '', targetId: null, evidence: {} } })
  })
  await alice.mutation(api.jobs.approve, { actions: [{ id: actionId, revision: 1, selectionVersion: 1, nativeCalendar: { calendarId: 'synthetic-calendar', version: connection.version } }] })
  return { t, alice, bob, actionId, connection }
}
it('binds Apple execution to the approving adult and originating iPhone', async () => {
  const { t, alice, bob, actionId } = await setup()
  expect(await alice.query(api.apple.pending, { deviceId: phone })).toEqual([{ id: actionId, approvalId: expect.any(String), status: 'queued', revision: 1 }])
  expect(await alice.query(api.apple.pending, { deviceId: otherPhone })).toEqual([])
  expect(await bob.query(api.apple.pending, { deviceId: phone })).toEqual([])
  await expect(alice.action(api.apple.claim, { actionId, deviceId: otherPhone })).rejects.toThrow('another review or iPhone')
  await expect(bob.action(api.apple.claim, { actionId, deviceId: phone })).rejects.toThrow('unavailable')
  expect(await t.run(ctx => ctx.db.query('attempts').collect())).toEqual([])
})
it('requires dispatch evidence and reconciles uncertainty without another write attempt', async () => {
  const { t, alice, actionId } = await setup()
  const attempt = (await alice.action(api.apple.claim, { actionId, deviceId: phone }))!
  const args = { actionId, deviceId: phone, attemptId: attempt.attemptId }
  await expect(alice.mutation(api.apple.finish, { ...args, status: 'verified', eventId: 'fixture-event', fingerprint: 'readback-fingerprint' })).rejects.toThrow('read-back')
  expect(await alice.action(api.apple.dispatch, args)).toBe(true)
  expect(await alice.action(api.apple.dispatch, args)).toBe(false)
  await alice.mutation(api.apple.finish, { ...args, status: 'uncertain', message: 'Synthetic interrupted return' })
  await alice.mutation(api.apple.finish, { ...args, status: 'verified', eventId: 'fixture-event', fingerprint: 'readback-fingerprint' })
  await alice.mutation(api.apple.finish, { ...args, status: 'verified', eventId: 'fixture-event', fingerprint: 'readback-fingerprint' })
  const saved = await t.run(async ctx => ({ action: await ctx.db.get(actionId), receipts: await ctx.db.query('receipts').collect(), attempts: await ctx.db.query('attempts').collect(), plan: await ctx.db.query('planEvents').collect() }))
  expect(saved.action?.status).toBe('succeeded'); expect(saved.receipts).toHaveLength(1); expect(saved.attempts).toHaveLength(1)
  expect(saved.receipts[0].outcome).toBe('apple_calendar_readback'); expect(saved.plan[0].etag).toBe('readback-fingerprint'); expect(saved.plan[0].provider).toBe('apple')
})
it('blocks an approved native operation when its selected destination changes before dispatch', async () => {
  const { t, alice, actionId } = await setup()
  const attempt = (await alice.action(api.apple.claim, { actionId, deviceId: phone }))!
  await alice.mutation(api.apple.register, { deviceId: phone, calendarId: 'changed-calendar', title: 'Changed', account: 'Synthetic iCloud' })
  expect(await alice.action(api.apple.dispatch, { actionId, deviceId: phone, attemptId: attempt.attemptId })).toBe(false)
  const saved = await t.run(async ctx => ({ action: await ctx.db.get(actionId), attempt: await ctx.db.get(attempt.attemptId), receipts: await ctx.db.query('receipts').collect() }))
  expect(saved.action?.status).toBe('review'); expect(saved.attempt?.dispatched).toBe(false); expect(saved.receipts).toEqual([])
})

it('a native pre-write review failure invalidates its approval and uses a new operation identity', async () => {
  const { t, alice, actionId, connection } = await setup()
  const first = (await alice.action(api.apple.claim, { actionId, deviceId: phone }))!
  expect(await alice.action(api.apple.dispatch, { actionId, deviceId: phone, attemptId: first.attemptId })).toBe(true)
  await alice.mutation(api.apple.finish, { actionId, deviceId: phone, attemptId: first.attemptId, status: 'review', message: 'Synthetic native preflight changed' })
  const a = await t.run(ctx => ctx.db.get(actionId))
  expect(a?.status).toBe('review'); expect(a?.revision).toBe(2); expect(a?.approvalId).toBeUndefined()
  await expect(alice.action(api.apple.dispatch, { actionId, deviceId: phone, attemptId: first.attemptId })).rejects.toThrow('another review')
  await alice.mutation(api.jobs.approve, { actions: [{ id: actionId, revision: 2, selectionVersion: 1, nativeCalendar: { calendarId: 'synthetic-calendar', version: connection.version } }] })
  const second = (await alice.action(api.apple.claim, { actionId, deviceId: phone }))!
  expect(second.operation.operationId).not.toBe(first.operation.operationId)
  expect(await t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})

it('caregiver acceptance queues its approved Apple update until the original phone verifies it', async () => {
  vi.setSystemTime(new Date('2027-05-05T08:00:00Z'))
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'alex@example.test')
  const { t, alice, actionId, connection } = await setup(); workflow.register(t)
  const alex = t.withIdentity({ subject: 'alex', email: 'alex@example.test', emailVerified: true })
  await alex.mutation(api.households.save, { timezone: 'UTC', children: [] }); await alex.mutation(api.pickups.saveDeliverySettings, { channel: 'app' })
  const caregiverId = await alice.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
  const original = (await t.run(ctx => ctx.db.get(actionId)))!
  const payload = { kind: 'pickup', childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {}, calendarUpdate: { ...original.payload, date: '2027-05-05', endDate: '2027-05-05', startTime: '15:00', endTime: '16:00' } }
  const pickupId = await alice.mutation(api.jobs.addDraft, { jobId: original.jobId, payload })
  await alice.mutation(api.jobs.approve, { actions: [{ id: pickupId, revision: 1, selectionVersion: 1, deliveryChannel: 'app', nativeCalendar: { calendarId: 'synthetic-calendar', version: connection.version } }] })
  const pickup = (await t.run(ctx => ctx.db.get(pickupId)))!
  const dependent = (await t.run(ctx => ctx.db.query('actions').withIndex('by_job', q => q.eq('jobId', original.jobId)).collect())).find(a => a.dependsOn === pickupId)!
  expect(dependent.status).toBe('waiting')
  const delivery = (await t.mutation(internal.execution.claim, { actionId: pickupId, approvalId: pickup.approvalId! }))!
  await t.action(internal.pickups.send, { actionId: pickupId, attemptId: delivery.attemptId })
  const request = (await alex.query(api.pickups.inbox, {}))[0]
  await alex.mutation(api.pickups.respondInApp, { requestId: request.id, revision: 1, response: 'accept', suggestion: '' })
  await t.action(internal.google.execute, { actionId: dependent._id, approvalId: dependent.approvalId! })
  const waiting = await t.run(async ctx => ({ action: await ctx.db.get(dependent._id), attempts: await ctx.db.query('attempts').withIndex('by_action', q => q.eq('actionId', dependent._id)).collect(), receipts: await ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', dependent._id)).collect() }))
  expect(waiting.action?.status).toBe('queued'); expect(waiting.attempts).toEqual([]); expect(waiting.receipts).toEqual([])
  expect((await alice.query(api.apple.pending, { deviceId: phone })).some(a => a.id === dependent._id)).toBe(true)
  expect((await alice.query(api.apple.pending, { deviceId: otherPhone })).some(a => a.id === dependent._id)).toBe(false)
  const native = (await alice.action(api.apple.claim, { actionId: dependent._id, deviceId: phone }))!
  const args = { actionId: dependent._id, deviceId: phone, attemptId: native.attemptId }
  expect(await alice.action(api.apple.dispatch, args)).toBe(true)
  await alice.mutation(api.apple.finish, { ...args, status: 'verified', eventId: 'conditional-event', fingerprint: 'native-readback' })
  expect((await t.run(ctx => ctx.db.get(dependent._id)))?.status).toBe('succeeded')
  const receipts = await t.run(ctx => ctx.db.query('receipts').withIndex('by_action', q => q.eq('actionId', dependent._id)).collect())
  expect(receipts).toHaveLength(1); expect(receipts[0].outcome).toBe('apple_calendar_readback')
})

it('a fresh approval is visible to the phone even when the draft revision is unchanged', async () => {
  const { alice, actionId, connection } = await setup()
  const first = (await alice.query(api.apple.pending, { deviceId: phone }))[0]
  await alice.mutation(api.connections.choose, { id: connection.id, purpose: 'calendar', version: 1 })
  expect(await alice.action(api.apple.claim, { actionId, deviceId: phone })).toBeNull()
  await alice.mutation(api.jobs.approve, { actions: [{ id: actionId, revision: 1, selectionVersion: 2, nativeCalendar: { calendarId: 'synthetic-calendar', version: connection.version } }] })
  const next = (await alice.query(api.apple.pending, { deviceId: phone }))[0]
  expect(next.revision).toBe(first.revision)
  expect(next.approvalId).not.toBe(first.approvalId)
  expect(await alice.action(api.apple.claim, { actionId, deviceId: phone })).not.toBeNull()
})
