import { describe, expect, it } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash } from '../shared/daymark'
const modules = import.meta.glob('./**/*.ts')
async function fixture() {
  const t = convexTest(schema, modules)
  const result = await t.run(async ctx => {
    const householdId = await ctx.db.insert('households', { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }, { id: 'leo', name: 'Leo' }], deleted: false })
    const caregiverId = await ctx.db.insert('caregivers', { householdId, name: 'Alex', email: 'alex@example.test', childIds: ['maya', 'leo'] })
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic pickup', hash: 'fixture', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'alice', cancelled: false, preparing: false, clarification: '' })
    const payload = { kind: 'pickup', childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'School gate', deadline: '2027-05-05T13:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, payload, status: 'waiting' })
    const secret = 'a'.repeat(64), session = 'b'.repeat(64)
    const requestId = await ctx.db.insert('pickupRequests', { householdId, actionId, caregiverId, revision: 1, tokenHash: hash(secret), expiresAt: Date.now() + 100000, status: 'waiting', codeHash: hash(`${secret}:123456`), codeExpiresAt: Date.now() + 100000 })
    return { householdId, caregiverId, jobId, payload, actionId, requestId, secret, session }
  })
  return { t, ...result }
}
describe('verified private caregiver responses', () => {
  it('requires mailbox code before details and scopes access to one request', async () => {
    const f = await fixture()
    expect(await f.t.query(api.pickups.view, { secret: f.secret, session: f.session })).toBeNull()
    expect(await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '123456' })).toBe(true)
    expect(await f.t.query(api.pickups.view, { secret: f.secret, session: f.session })).toMatchObject({ child: 'Maya', location: 'School gate' })
    await f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'accept', suggestion: '' })
    expect((await f.t.run(ctx => ctx.db.get(f.requestId)))?.status).toBe('accepted')
    expect((await f.t.run(ctx => ctx.db.query('receipts').first()))?.outcome).toBe('caregiver_accepted_not_pickup_completed')
    await expect(f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'decline', suggestion: '' })).rejects.toThrow('no longer')
  })
  it('commits failed-code limits and rejects expired or obsolete requests', async () => {
    const f = await fixture()
    for (let i = 0; i < 5; i++) expect(await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '000000' })).toBe(false)
    expect(await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '123456' })).toBe(false)
    expect((await f.t.run(ctx => ctx.db.get(f.requestId)))?.verificationAttempts).toBe(5)
    await f.t.run(ctx => ctx.db.patch(f.actionId, { revision: 2 }))
    expect(await f.t.query(api.pickups.view, { secret: f.secret, session: f.session })).toBeNull()
  })
  it('suggested time goes back to parent; overlap cannot falsely confirm another child', async () => {
    const f = await fixture()
    await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '123456' })
    await f.t.run(async ctx => {
      const other = await ctx.db.insert('actions', { householdId: f.householdId, jobId: f.jobId, sourceRevision: 1, revision: 1, payload: { ...f.payload, childId: 'leo' }, status: 'succeeded' })
      await ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId: other, caregiverId: f.caregiverId, revision: 1, tokenHash: 'other', expiresAt: Date.now() + 10000, status: 'accepted' })
    })
    await expect(f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'accept', suggestion: '' })).rejects.toThrow('overlaps')
    await f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'suggest', suggestion: 'Could we use 15:45?' })
    expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('review')
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
  })
  it('duplicate legacy caregiver records cannot bypass an accepted request snapshot', async () => {
    const f = await fixture()
    await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '123456' })
    await f.t.run(async ctx => {
      const duplicate = await ctx.db.insert('caregivers', { householdId: f.householdId, name: 'Alex legacy record', email: 'ALEX@example.test', childIds: ['leo'] })
      const accepted = { ...f.payload, caregiverId: duplicate, childId: 'leo' }
      // The arrangement snapshot must survive later changes to its backing draft.
      const actionId = await ctx.db.insert('actions', { householdId: f.householdId, jobId: f.jobId, sourceRevision: 1, revision: 2, payload: { ...accepted, time: '18:00' }, status: 'succeeded' })
      await ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId, caregiverId: duplicate, revision: 1, payload: accepted, tokenHash: 'legacy', expiresAt: Date.now() + 10000, status: 'accepted' })
    })
    await expect(f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'accept', suggestion: '' })).rejects.toThrow('overlaps')
    expect((await f.t.run(ctx => ctx.db.get(f.requestId)))?.status).toBe('waiting')
    expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
  })
  it('prevents new duplicate caregiver mailboxes without changing existing records', async () => {
    const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
    await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
    const alex = await parent.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
    await expect(parent.mutation(api.pickups.addCaregiver, { name: 'Alex again', email: 'ALEX@example.test', childIds: ['maya'] })).rejects.toThrow('already saved')
    const jordan = await parent.mutation(api.pickups.addCaregiver, { name: 'Jordan', email: 'jordan@example.test', childIds: ['maya'] })
    await expect(parent.mutation(api.pickups.updateCaregiver, { id: jordan, name: 'Jordan', email: 'alex@example.test', childIds: ['maya'] })).rejects.toThrow('already saved')
    await parent.mutation(api.pickups.updateCaregiver, { id: alex, name: 'Alex updated', email: 'ALEX@example.test', childIds: ['maya'] })
    expect((await t.run(ctx => ctx.db.get(jordan)))?.email).toBe('jordan@example.test')
    expect(await t.run(ctx => ctx.db.query('caregivers').collect())).toHaveLength(2)
  })
  it('keeps accepted coverage when the email worker times out before recording delivery', async () => {
    const f = await fixture()
    const attemptId = await f.t.run(async ctx => {
      const approvalId = await ctx.db.insert('approvals', { householdId: f.householdId, actionId: f.actionId, revision: 1, sourceRevision: 1, payloadHash: 'synthetic', subject: 'alice', destination: 'alex@example.test', expiresAt: Date.now() + 100000 })
      const id = await ctx.db.insert('attempts', { householdId: f.householdId, actionId: f.actionId, approvalId, dispatched: true, finished: false, startedAt: Date.now() - 150000 })
      await ctx.db.patch(f.actionId, { status: 'executing', approvalId, attemptId: id })
      return id
    })
    await f.t.mutation(api.pickups.verify, { secret: f.secret, session: f.session, code: '123456' })
    await f.t.mutation(api.pickups.respond, { secret: f.secret, session: f.session, response: 'accept', suggestion: '' })
    await f.t.mutation(internal.execution.interrupted, { attemptId })
    expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.status).toBe('succeeded')
    expect((await f.t.run(ctx => ctx.db.get(attemptId)))?.finished).toBe(true)
    expect((await f.t.run(ctx => ctx.db.query('receipts').collect())).map(r => r.outcome)).toEqual(['caregiver_accepted_not_pickup_completed'])
  })
})
