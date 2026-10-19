import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { hash } from '../shared/daymark'
import { event } from '../tests/fixtures/calendar'
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'teacher@example.test,alex@example.test'); vi.stubEnv('RESEND_API_KEY', 'synthetic-only'); vi.stubEnv('DAYMARK_EMAIL_FROM', 'test@example.test'); vi.stubEnv('DAYMARK_WEB_URL', 'https://example.test') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const user = t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice', email: 'parent@example.test', emailVerified: true })
  const householdId = await user.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const values = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic notice', hash: 'notice', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|alice', preparing: false, cancelled: false, clarification: '' })
    const caregiverId = await ctx.db.insert('caregivers', { householdId, name: 'Alex', email: 'alex@example.test', childIds: ['maya'] })
    const connectionId = await ctx.db.insert('connections', { householdId, subject: 'test|alice', status: 'active', version: 1, scopes: ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/gmail.send'], calendarId: 'synthetic-calendar' })
    return { sourceId, jobId, caregiverId, connectionId }
  })
  return { t, user, householdId, ...values }
}
it('versioned school contacts reject stale edits and other households', async () => {
  const f = await fixture(), value = { kind: 'contact', childId: 'maya', name: 'Teacher', email: 'teacher@example.test', role: 'Class teacher' }
  const id = await f.user.mutation(api.memory.save, { value })
  await f.user.mutation(api.memory.save, { id, version: 1, value: { ...value, role: 'Office' } })
  await expect(f.user.mutation(api.memory.save, { id, version: 1, value })).rejects.toThrow('changed')
  const other = f.t.withIdentity({ subject: 'bob' }); await other.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await expect(other.mutation(api.memory.remove, { id, version: 2 })).rejects.toThrow('unavailable')
  const fact = await f.t.run(ctx => ctx.db.get(id)); expect(fact).toMatchObject({ version: 2, confirmed: true, source: 'Adult-confirmed household settings' })
})
it('binds email files to the job, reviewed name and fingerprint, and blocks expiry after approval', async () => {
  const f = await fixture()
  const fileId = await f.t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(['synthetic attachment']))
    const id = await ctx.db.insert('attachments', { householdId: f.householdId, subject: 'test|alice', storageId, name: 'notice.pdf', size: 100, mediaType: 'application/pdf', hash: 'fingerprint', status: 'ready', sourceId: f.sourceId, expiresAt: Date.now() + 10000 })
    await ctx.db.patch(f.sourceId, { attachmentIds: [id] }); return id
  })
  const payload = { kind: 'email', childId: 'maya', to: 'teacher@example.test', subject: 'Trip', body: 'Please see the notice.', requirement: '', evidence: {}, attachments: [{ id: fileId, name: 'notice.pdf', hash: 'wrong' }] }
  const id = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload })
  await expect(f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 1 }] })).rejects.toThrow('changed or expired')
  await f.user.mutation(api.jobs.edit, { actionId: id, revision: 1, payload: { ...payload, attachments: [{ id: fileId, name: 'notice.pdf', hash: 'fingerprint' }] } })
  await f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 2 }] })
  const approval = (await f.t.run(ctx => ctx.db.query('approvals').collect()))[0]
  const claim = await f.t.mutation(internal.execution.claim, { actionId: id, approvalId: approval._id })
  await f.t.run(ctx => ctx.db.patch(fileId, { expiresAt: Date.now() - 1 }))
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim!.attemptId })).toBe(false)
})
it('only verified acceptance unlocks the exact approved calendar dependency', async () => {
  const f = await fixture()
  const payload = { kind: 'pickup', childId: 'maya', caregiverId: f.caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'School gate', deadline: '2027-05-05T13:00:00Z', message: 'Please pick up Maya.', evidence: {}, calendarUpdate: { ...event, date: '2027-05-05', endDate: '2027-05-05', notes: 'Pickup: Alex' } }
  const id = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload })
  await f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 1 }] })
  const dependency = (await f.t.run(ctx => ctx.db.query('actions').collect())).find(a => a.dependsOn === id)!
  expect(dependency.status).toBe('waiting')
  expect(await f.t.mutation(internal.execution.claim, { actionId: dependency._id, approvalId: dependency.approvalId! })).toBeNull()
  const secret = 'a'.repeat(64), session = 'b'.repeat(64)
  await f.t.run(async ctx => {
    await ctx.db.patch(id, { status: 'waiting' })
    await ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId: id, revision: 1, caregiverId: f.caregiverId, tokenHash: hash(secret), expiresAt: Date.now() + 10000, status: 'waiting', sessionHash: hash(session), sessionExpiresAt: Date.now() + 10000 })
  })
  await f.t.mutation(api.pickups.respond, { secret, session, response: 'accept', suggestion: '' })
  expect((await f.t.run(ctx => ctx.db.get(dependency._id)))?.status).toBe('queued')
  const claim = await f.t.mutation(internal.execution.claim, { actionId: dependency._id, approvalId: dependency.approvalId! })
  expect(claim?.action.payload).toEqual(payload.calendarUpdate)
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { version: 2, status: 'revoked' }))
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim!.attemptId })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(id)))?.status).toBe('succeeded')
  expect(await f.t.run(ctx => ctx.db.query('planEvents').collect())).toHaveLength(0)
})
it.each(['google', 'microsoft'] as const)('preserves caregiver acceptance across an interrupted conditional %s calendar write and records reconciliation only once', async provider => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.connectionId, { provider, scopes: [provider === 'google' ? 'https://www.googleapis.com/auth/calendar.app.created' : 'Calendars.ReadWrite'] }))
  await f.user.mutation(api.connections.choose, { id: f.connectionId, purpose: 'calendar', version: 0 })
  const calendar = { ...event, date: '2027-05-05', endDate: '2027-05-05', notes: 'Pickup arranged with Alex after verified acceptance.' }
  const payload = { kind: 'pickup', childId: 'maya', caregiverId: f.caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'School gate', deadline: '2027-05-05T13:00:00Z', message: 'Please pick up Maya.', evidence: {}, calendarUpdate: calendar }
  const id = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload })
  await f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 1, selectionVersion: 1 }] })
  const dependent = (await f.t.run(ctx => ctx.db.query('actions').collect())).find(a => a.dependsOn === id)!
  const secret = 'c'.repeat(64), session = 'd'.repeat(64)
  await f.t.run(async ctx => {
    await ctx.db.patch(id, { status: 'waiting' })
    await ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId: id, revision: 1, caregiverId: f.caregiverId, payload, tokenHash: hash(secret), expiresAt: Date.now() + 10000, status: 'waiting', sessionHash: hash(session), sessionExpiresAt: Date.now() + 10000 })
  })
  await f.t.mutation(api.pickups.respond, { secret, session, response: 'accept', suggestion: '' })
  const claim = (await f.t.mutation(internal.execution.claim, { actionId: dependent._id, approvalId: dependent.approvalId! }))!
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: claim.attemptId })).toBe(true)
  await f.t.mutation(internal.execution.interrupted, { attemptId: claim.attemptId })
  expect((await f.t.run(ctx => ctx.db.get(dependent._id)))!.status).toBe('uncertain')
  expect((await f.t.run(ctx => ctx.db.get(id)))!.status).toBe('succeeded')
  expect((await f.user.query(api.pickups.arrangements, {}))[0].status).toBe('accepted')
  expect(await f.user.query(api.jobs.plan, {})).toEqual([])
  expect(await f.t.mutation(internal.execution.claim, { actionId: dependent._id, approvalId: dependent.approvalId! })).toBeNull()
  await f.t.mutation(internal.execution.reconciled, { actionId: dependent._id, providerId: 'synthetic-conditional-event', etag: 'verified-new-etag' })
  await f.t.mutation(internal.execution.reconciled, { actionId: dependent._id, providerId: 'synthetic-conditional-event', etag: 'verified-new-etag' })
  expect((await f.user.query(api.jobs.plan, {}))[0]).toMatchObject({ provider, connectionId: f.connectionId, connectionVersion: 1, payload: { ...calendar, evidence: {} } })
  expect((await f.t.run(ctx => ctx.db.query('receipts').collect())).map(r => r.outcome).sort()).toEqual(['caregiver_accepted_not_pickup_completed', 'calendar_read_back_verified'].sort())
  await expect(f.t.mutation(api.pickups.respond, { secret, session, response: 'accept', suggestion: '' })).rejects.toThrow('no longer')
})
it('explicit unavailability blocks a request without turning routines into consent', async () => {
  const f = await fixture()
  await f.user.mutation(api.memory.save, { value: { kind: 'availability', caregiverId: f.caregiverId, date: '2027-05-05', start: '14:00', end: '16:00', available: false } })
  const id = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: { kind: 'pickup', childId: 'maya', caregiverId: f.caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'Gate', deadline: '2027-05-05T13:00:00Z', message: 'Pickup?', evidence: {} } })
  await expect(f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 1 }] })).rejects.toThrow('unavailable')
})
it('forwarding is scoped, deduplicated, and cannot commit after account deletion', async () => {
  vi.stubEnv('DAYMARK_INBOUND_DOMAIN', 'inbound.example.test'); vi.stubEnv('RESEND_WEBHOOK_SECRET', 'synthetic-only')
  const f = await fixture()
  await f.user.mutation(api.inbound.enable, {})
  const info = await f.user.query(api.inbound.current, {})
  expect(info.sender).toBe('parent@example.test'); expect(info.address).toMatch(/^[a-f0-9]{48}@/)
  const input = { to: [info.address!], providerId: 'synthetic-message' }
  await f.t.mutation(internal.inbound.received, input); await f.t.mutation(internal.inbound.received, input)
  const items = await f.t.run(ctx => ctx.db.query('inbound').collect()); expect(items).toHaveLength(1)
  await f.t.run(ctx => ctx.db.patch(f.householdId, { deleted: true }))
  expect(await f.t.mutation(internal.inbound.commit, { id: items[0]._id, text: 'Synthetic', sender: info.sender!, title: 'School notice', files: [] })).toBe(false)
})
it('notification delivery deduplicates a job revision and suppresses while the parent is active', async () => {
  const f = await fixture()
  await f.user.mutation(api.notifications.save, { enabled: true, quietStart: '00:00', quietEnd: '00:00', token: 'a'.repeat(64) })
  await f.t.run(ctx => ctx.db.patch(f.jobId, { preparing: true }))
  await f.t.mutation(internal.jobs.prepared, { jobId: f.jobId, sourceRevision: 1, actions: [event], clarification: '' })
  await f.t.mutation(internal.jobs.prepared, { jobId: f.jobId, sourceRevision: 1, actions: [event], clarification: '' })
  const notices = await f.t.run(ctx => ctx.db.query('notifications').collect()); expect(notices).toHaveLength(1)
  expect(await f.t.mutation(internal.notifications.claim, { id: notices[0]._id })).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(notices[0]._id)))?.status).toBe('suppressed')
})
it('the one approved follow-up is claimed once and cancelled when caregiver eligibility changes', async () => {
  const f = await fixture(), at = new Date(Date.now() + 3600000).toISOString()
  const id = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: { kind: 'pickup', childId: 'maya', caregiverId: f.caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'Gate', deadline: '2027-05-05T13:00:00Z', followUpAt: at, message: 'Pickup?', evidence: {} } })
  await f.user.mutation(api.jobs.approve, { actions: [{ id, revision: 1 }] })
  await f.t.run(ctx => ctx.db.patch(id, { status: 'executing' }))
  const request = await f.t.mutation(internal.pickups.prepareRequest, { actionId: id, tokenHash: hash('a'.repeat(64)) })
  await f.t.mutation(internal.pickups.sent, { requestId: request.requestId })
  await f.t.run(ctx => ctx.db.patch(id, { status: 'waiting' }))
  await f.t.mutation(internal.pickups.scheduleFollowup, { requestId: request.requestId, cipher: 'synthetic-cipher' })
  vi.setSystemTime(Date.parse(at) + 1)
  const claimed = await f.t.mutation(internal.pickups.claimFollowup, { requestId: request.requestId })
  expect(claimed?.email).toBe('alex@example.test')
  expect(await f.t.mutation(internal.pickups.claimFollowup, { requestId: request.requestId })).toBeNull()
  await f.t.run(ctx => ctx.db.patch(request.requestId, { followUpStatus: 'scheduled', followUpCipher: 'synthetic-cipher' }))
  await f.user.mutation(api.pickups.updateCaregiver, { id: f.caregiverId, name: 'Alex', email: 'alex@example.test', childIds: [] })
  expect(await f.t.mutation(internal.pickups.claimFollowup, { requestId: request.requestId })).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(request.requestId)))?.followUpStatus).toBe('cancelled')
})
it('prevents contacting two caregivers for the same pickup and cancels dependent work after decline', async () => {
  const f = await fixture(), payload = { kind: 'pickup', childId: 'maya', caregiverId: f.caregiverId, date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'School gate', deadline: '2027-05-05T13:00:00Z', message: 'Pickup?', evidence: {}, calendarUpdate: { ...event, date: '2027-05-05', endDate: '2027-05-05' } }
  const first = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload })
  const second = await f.user.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: { ...payload, message: 'Another request' } })
  await f.user.mutation(api.jobs.approve, { actions: [{ id: first, revision: 1 }] })
  await expect(f.user.mutation(api.jobs.approve, { actions: [{ id: second, revision: 1 }] })).rejects.toThrow('already an active')
  const secret = 'c'.repeat(64), session = 'd'.repeat(64)
  await f.t.run(async ctx => {
    await ctx.db.patch(first, { status: 'waiting' })
    await ctx.db.insert('pickupRequests', { householdId: f.householdId, actionId: first, revision: 1, caregiverId: f.caregiverId, tokenHash: hash(secret), expiresAt: Date.now() + 10000, status: 'waiting', sessionHash: hash(session), sessionExpiresAt: Date.now() + 10000 })
  })
  await f.t.mutation(api.pickups.respond, { secret, session, response: 'decline', suggestion: '' })
  const dependent = (await f.t.run(ctx => ctx.db.query('actions').collect())).find(a => a.dependsOn === first)!
  expect(dependent.status).toBe('cancelled'); expect(dependent.approvalId).toBeUndefined()
  await expect(f.t.mutation(api.pickups.respond, { secret, session, response: 'accept', suggestion: '' })).rejects.toThrow('no longer available')
  await f.user.mutation(api.jobs.approve, { actions: [{ id: second, revision: 1 }] })
})
