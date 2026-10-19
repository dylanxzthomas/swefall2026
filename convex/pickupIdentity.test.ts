import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { pickupEmailProof } from '../shared/pickupEmail'
import { hash, payloadHash } from '../shared/daymark'

const modules = import.meta.glob('./**/*.ts')
const secret = 'a'.repeat(64)
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2027-05-05T08:00:00Z')) })
afterEach(() => { vi.useRealTimers() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent', email: 'parent@example.test', emailVerified: true })
  const caregiver = t.withIdentity({ subject: 'caregiver', tokenIdentifier: 'test|caregiver', email: '  ALEX@EXAMPLE.TEST  ', emailVerified: true })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const caregiverId = await parent.mutation(api.pickups.addCaregiver, { name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Private family source', hash: 'source', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    const payload = { kind: 'pickup' as const, childId: 'maya', caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
    const actionId = await ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, status: 'waiting', payload })
    const approvalId = await ctx.db.insert('approvals', { householdId, actionId, revision: 1, sourceRevision: 1, payloadHash: payloadHash(payload), subject: 'test|parent', destination: 'alex@example.test', expiresAt: Date.now() + 600000, deliveryChannel: 'email', emailTransport: 'gmail', verificationMethod: 'identity', pickupEmail: pickupEmailProof(payload, 'Maya', 'https://response.example.test', 'parent@example.test', 'alex@example.test') })
    await ctx.db.patch(actionId, { approvalId })
    const requestId = await ctx.db.insert('pickupRequests', { householdId, actionId, caregiverId, revision: 1, tokenHash: hash(secret), expiresAt: Date.parse(payload.deadline), status: 'waiting', deliveryChannel: 'email', emailTransport: 'gmail', verificationMethod: 'identity', recipientEmail: 'alex@example.test', senderAccountEmail: 'parent@example.test', payload })
    return { sourceId, jobId, actionId, approvalId, requestId }
  })
  return { t, parent, caregiver, householdId, caregiverId, ...ids }
}
it('lets a verified caregiver without a household view only the assigned request and records independent identity evidence once', async () => {
  const f = await fixture()
  expect(await f.t.query(api.pickupIdentity.method, { secret })).toEqual({ method: 'identity' })
  expect(await f.t.query(api.pickupIdentity.view, { secret })).toBeNull()
  const view = await f.caregiver.query(api.pickupIdentity.view, { secret })
  expect(view).toEqual({ child: 'Maya', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', message: 'Can you pick up Maya?', deadline: '2027-05-05T12:00:00Z' })
  expect(await f.t.run(ctx => ctx.db.query('memberships').collect())).toHaveLength(1)
  await f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })
  expect(await f.t.run(ctx => ctx.db.get(f.requestId))).toMatchObject({ status: 'accepted', responderSubject: 'test|caregiver', responderEmail: 'alex@example.test', identityVerifiedAt: Date.now() })
  expect((await f.t.run(ctx => ctx.db.query('receipts').collect())).map(r => r.outcome)).toEqual(['caregiver_accepted_not_pickup_completed'])
  await expect(f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow()
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret })).toBeNull()
})
it('rejects signed-out, wrong and unverified accounts even when they hold the private link', async () => {
  const f = await fixture()
  for (const client of [f.t, f.parent, f.t.withIdentity({ subject: 'alex', tokenIdentifier: 'test|alex', email: 'alex@example.test', emailVerified: false }), f.t.withIdentity({ subject: 'alex', tokenIdentifier: 'test|alex', emailVerified: true })]) {
    expect(await client.query(api.pickupIdentity.view, { secret })).toBeNull()
    await expect(client.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow()
  }
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it.each(['cancel', 'source', 'revision', 'expiry', 'household', 'recipient', 'destination', 'eligibility', 'approval'])('blocks %s before disclosure or response', async change => {
  const f = await fixture()
  await f.t.run(async ctx => {
    if (change === 'cancel') await ctx.db.patch(f.jobId, { cancelled: true })
    if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 })
    if (change === 'revision') await ctx.db.patch(f.actionId, { revision: 2 })
    if (change === 'expiry') await ctx.db.patch(f.requestId, { expiresAt: Date.now() - 1 })
    if (change === 'household') await ctx.db.patch(f.householdId, { deleted: true })
    if (change === 'recipient') await ctx.db.patch(f.caregiverId, { email: 'other@example.test' })
    if (change === 'destination') await ctx.db.patch(f.approvalId, { destination: 'other@example.test' })
    if (change === 'eligibility') await ctx.db.patch(f.caregiverId, { childIds: [] })
    if (change === 'approval') await ctx.db.patch(f.actionId, { approvalId: undefined })
  })
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret })).toBeNull()
  await expect(f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('does not offer code verification for Gmail requests and leaves legacy email verification available', async () => {
  const f = await fixture()
  await expect(f.t.mutation(internal.pickups.challenge, { secret, codeHash: 'synthetic-code' })).rejects.toThrow()
  await f.t.run(ctx => ctx.db.patch(f.requestId, { emailTransport: undefined, verificationMethod: undefined, recipientEmail: undefined }))
  expect(await f.t.query(api.pickupIdentity.method, { secret })).toEqual({ method: 'code' })
  await expect(f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow()
  await f.t.mutation(internal.pickups.challenge, { secret, codeHash: 'synthetic-code' })
})
it('keeps in-app links and malformed or unknown secrets undisclosed', async () => {
  const f = await fixture()
  for (const value of ['', 'a'.repeat(63), 'A'.repeat(64), 'b'.repeat(64), `${secret}&redirect=https://other.example.test`]) expect(await f.t.query(api.pickupIdentity.method, { secret: value })).toBeNull()
  await f.t.run(ctx => ctx.db.patch(f.requestId, { deliveryChannel: 'app' }))
  expect(await f.t.query(api.pickupIdentity.method, { secret })).toBeNull()
  expect(await f.caregiver.query(api.pickupIdentity.view, { secret })).toBeNull()
})
it('reuses current availability checks atomically and lets a suggestion return to parent review', async () => {
  const f = await fixture()
  await f.parent.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: f.caregiverId, date: '2027-05-05', start: '14:00', end: '16:00', available: false } })
  await expect(f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow('availability changed')
  expect((await f.t.run(ctx => ctx.db.get(f.requestId)))?.identityVerifiedAt).toBeUndefined()
  await f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'suggest', suggestion: 'South gate at 16:00?' })
  expect(await f.t.run(ctx => ctx.db.get(f.actionId))).toMatchObject({ status: 'review', revision: 2 })
  expect(await f.t.run(ctx => ctx.db.get(f.requestId))).toMatchObject({ status: 'suggested', responderSubject: 'test|caregiver' })
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('refuses overlapping acceptance without writing identity evidence or bypassing existing arrangement rules', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    const existing = (await ctx.db.get(f.requestId))!
    const { _id, _creationTime, ...fields } = existing
    await ctx.db.insert('pickupRequests', { ...fields, tokenHash: hash('b'.repeat(64)), status: 'accepted', response: 'accept' })
  })
  await expect(f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'accept', suggestion: '' })).rejects.toThrow('overlaps another confirmed pickup')
  expect(await f.t.run(ctx => ctx.db.get(f.requestId))).toMatchObject({ status: 'waiting' })
  expect((await f.t.run(ctx => ctx.db.get(f.requestId)))?.identityVerifiedAt).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})
it('decline records the caregiver identity and returns the action for fresh parent review', async () => {
  const f = await fixture()
  await f.caregiver.mutation(api.pickupIdentity.respond, { secret, response: 'decline', suggestion: '' })
  expect(await f.t.run(ctx => ctx.db.get(f.requestId))).toMatchObject({ status: 'declined', responderSubject: 'test|caregiver', responderEmail: 'alex@example.test' })
  expect(await f.t.run(ctx => ctx.db.get(f.actionId))).toMatchObject({ status: 'review', revision: 2 })
  expect((await f.t.run(ctx => ctx.db.get(f.actionId)))?.approvalId).toBeUndefined()
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toEqual([])
})


it('discloses the approved child name snapshot after a post-send household rename', async () => {
  const f = await fixture()
  await f.parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Private changed name' }] })
  const view = await f.caregiver.query(api.pickupIdentity.view, { secret })
  expect(view?.child).toBe('Maya')
  expect(JSON.stringify(view)).not.toContain('Private changed name')
})
