import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { event } from '../tests/fixtures/calendar'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts')
const email = { kind: 'email', childId: 'maya', to: 'teacher@example.test', subject: 'Trip RSVP', body: 'Maya will attend.', requirement: '', evidence: {} }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z')); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'teacher@example.test') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const ids = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic school notice', hash: 'notice', revision: 1, expiresAt: Date.now() + 86400000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    // Existing Google records intentionally omit the new provider field.
    const googleId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', status: 'active', version: 1, cipher: 'synthetic-only', scopes: ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/gmail.send'], calendarId: 'google-calendar', email: 'parent@google.example.test' })
    const microsoftId = await ctx.db.insert('connections', { householdId, subject: 'test|parent', provider: 'microsoft', status: 'active', version: 1, cipher: 'synthetic-only', scopes: ['Calendars.ReadWrite', 'Mail.Send'], calendarId: 'outlook-calendar', email: 'parent@outlook.example.test' })
    return { sourceId, jobId, googleId, microsoftId }
  })
  const calendarId = await parent.mutation(api.jobs.addDraft, { jobId: ids.jobId, payload: event })
  const emailId = await parent.mutation(api.jobs.addDraft, { jobId: ids.jobId, payload: email })
  return { t, parent, householdId, calendarId, emailId, ...ids }
}
async function claim(f: Awaited<ReturnType<typeof fixture>>, actionId: Id<'actions'>) {
  const a = (await f.t.run(ctx => ctx.db.get(actionId)))!
  return f.t.mutation(internal.execution.claim, { actionId, approvalId: a.approvalId! })
}

it('keeps legacy Google selections and existing approvals valid before any explicit account choice', async () => {
  const f = await fixture()
  const overview = await f.parent.query(api.connections.overview, {})
  expect(overview).toMatchObject({ calendarId: f.googleId, emailId: f.googleId, version: 0 })
  expect(overview.items.find(c => c.id === f.googleId)?.provider).toBe('google')
  expect(JSON.stringify(overview)).not.toContain('synthetic-only')
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1 }] })
  const approval = (await f.t.run(ctx => ctx.db.query('approvals').collect()))[0]
  await f.t.run(ctx => ctx.db.patch(approval._id, { provider: undefined, selectionVersion: undefined }))
  expect((await claim(f, f.calendarId))?.approval.connectionId).toBe(f.googleId)
})

it('chooses Outlook calendar independently from Gmail and binds each approval to its destination', async () => {
  const f = await fixture()
  await f.parent.mutation(api.connections.choose, { purpose: 'calendar', id: f.microsoftId, version: 0 })
  expect(await f.parent.query(api.connections.overview, {})).toMatchObject({ calendarId: f.microsoftId, emailId: f.googleId, version: 1 })
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1, selectionVersion: 1 }, { id: f.emailId, revision: 1, selectionVersion: 1 }] })
  expect((await claim(f, f.calendarId))?.approval).toMatchObject({ provider: 'microsoft', connectionId: f.microsoftId, destination: 'outlook-calendar', selectionVersion: 1 })
  expect((await claim(f, f.emailId))?.approval).toMatchObject({ provider: 'google', connectionId: f.googleId, destination: 'teacher@example.test', selectionVersion: 1 })
})

it('never switches a legacy Google destination just because a Microsoft consent callback finishes', async () => {
  const f = await fixture()
  await f.t.mutation(internal.connections.connected, { id: f.microsoftId, version: 1, cipher: 'new-synthetic-token', scopes: ['Calendars.ReadWrite'], calendarId: 'outlook-calendar', email: 'parent@outlook.example.test' })
  expect(await f.parent.query(api.connections.overview, {})).toMatchObject({ calendarId: f.googleId, emailId: f.googleId })
})

it('denies choosing or disconnecting another household’s connection', async () => {
  const f = await fixture(), other = f.t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await other.mutation(api.households.save, { timezone: 'UTC', children: [] })
  expect((await other.query(api.connections.overview, {})).items).toEqual([])
  await expect(other.mutation(api.connections.choose, { purpose: 'calendar', id: f.microsoftId, version: 0 })).rejects.toThrow('before choosing')
  await expect(other.mutation(api.connections.disconnect, { id: f.microsoftId })).rejects.toThrow('unavailable')
  expect((await f.t.run(ctx => ctx.db.get(f.microsoftId)))?.status).toBe('active')
})

it('rejects stale reviewed account choices and prevents queued work from switching providers', async () => {
  const f = await fixture()
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1 }] })
  await f.parent.mutation(api.connections.choose, { purpose: 'calendar', id: f.microsoftId, version: 0 })
  expect(await claim(f, f.calendarId)).toBeNull()
  expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))?.status).toBe('review')
  await expect(f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1, selectionVersion: 0 }] })).rejects.toThrow('account changed')
  await expect(f.parent.mutation(api.connections.choose, { purpose: 'email', id: f.microsoftId, version: 0 })).rejects.toThrow('choices changed')
  expect(await f.t.run(ctx => ctx.db.query('attempts').collect())).toHaveLength(0)
  expect(await f.t.run(ctx => ctx.db.query('receipts').collect())).toHaveLength(0)
})

it('revalidates account choices immediately before dispatch', async () => {
  const f = await fixture()
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1 }] })
  const attempt = await claim(f, f.calendarId)
  await f.parent.mutation(api.connections.choose, { purpose: 'calendar', id: f.microsoftId, version: 0 })
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: attempt!.attemptId })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(attempt!.attemptId)))?.dispatched).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))?.status).toBe('review')
})

it('disconnects only work approved against that provider and preserves the other selected account', async () => {
  const f = await fixture()
  await f.parent.mutation(api.connections.choose, { purpose: 'calendar', id: f.microsoftId, version: 0 })
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.calendarId, revision: 1, selectionVersion: 1 }, { id: f.emailId, revision: 1, selectionVersion: 1 }] })
  await f.parent.mutation(api.connections.disconnect, { id: f.googleId })
  expect((await f.t.run(ctx => ctx.db.get(f.emailId)))?.status).toBe('cancelled')
  expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))?.status).toBe('queued')
  expect((await claim(f, f.calendarId))?.approval.provider).toBe('microsoft')
})

it('records Graph acceptance and request reference without inventing a message ID', async () => {
  const f = await fixture()
  await f.parent.mutation(api.connections.choose, { purpose: 'email', id: f.microsoftId, version: 0 })
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.emailId, revision: 1, selectionVersion: 1 }] })
  const attempt = await claim(f, f.emailId)
  await expect(f.t.mutation(internal.execution.finish, { attemptId: attempt!.attemptId, status: 'succeeded', outcome: 'microsoft_accepted' })).rejects.toThrow('provider receipt')
  await f.t.mutation(internal.execution.dispatch, { attemptId: attempt!.attemptId })
  await f.t.mutation(internal.execution.finish, { attemptId: attempt!.attemptId, status: 'succeeded', outcome: 'microsoft_accepted', requestId: 'synthetic-graph-request' })
  await f.t.mutation(internal.execution.finish, { attemptId: attempt!.attemptId, status: 'succeeded', outcome: 'microsoft_accepted', requestId: 'synthetic-graph-request' })
  const receipts = await f.t.run(ctx => ctx.db.query('receipts').collect())
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ outcome: 'microsoft_accepted', requestId: 'synthetic-graph-request' })
  expect(receipts[0].providerId).toBeUndefined()
  expect((await f.t.run(ctx => ctx.db.get(f.emailId)))?.status).toBe('succeeded')
})

it('selects, approves and dispatches Gmail sending with compose, then refuses removed permission', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.googleId, { scopes: ['https://www.googleapis.com/auth/gmail.compose'] }))
  await f.parent.mutation(api.connections.choose, { purpose: 'email', id: f.googleId, version: 0 })
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: f.emailId, revision: 1, selectionVersion: 1 }] })
  const attempt = await claim(f, f.emailId)
  expect(attempt?.approval).toMatchObject({ provider: 'google', connectionId: f.googleId, destination: email.to })
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: attempt!.attemptId })).toBe(true)

  const secondId = await f.parent.mutation(api.jobs.addDraft, { jobId: f.jobId, payload: { ...email, subject: 'Second synthetic reply' } })
  await f.parent.mutation(api.jobs.approve, { actions: [{ id: secondId, revision: 1, selectionVersion: 1 }] })
  const second = await claim(f, secondId)
  await f.t.run(ctx => ctx.db.patch(f.googleId, { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }))
  expect(await f.t.mutation(internal.execution.dispatch, { attemptId: second!.attemptId })).toBe(false)
  expect((await f.t.run(ctx => ctx.db.get(second!.attemptId)))?.dispatched).toBe(false)
  await expect(f.parent.mutation(api.connections.choose, { purpose: 'email', id: f.googleId, version: 1 })).rejects.toThrow()
})
