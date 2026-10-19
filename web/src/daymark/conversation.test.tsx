import { expect, it } from 'vitest'
import { conversationActivity, conversationReply, conversationUpdates } from './conversation'
import type { DaymarkState, Job, Receipt } from './types'
import { event } from '../../../tests/fixtures/calendar'

const receipt: Receipt = { _id: 'r1', revision: 2, outcome: 'calendar_read_back_verified', providerId: 'event-one', verifiedAt: 200 }
const job: Job = { _id: 'j1', createdAt: 100, preparing: false, cancelled: false, clarification: '', source: { text: 'Private synthetic request', revision: 1 }, actions: [{ _id: 'a1', revision: 2, payload: event, status: 'succeeded', receipts: [receipt] }] }
const state = (jobs = [job]): DaymarkState => ({ configured: true, signedIn: true, household: { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] }, jobs, caregivers: [{ _id: 'alex', name: 'Alex', email: 'synthetic@example.test', childIds: ['maya'] }], arrangements: [], plan: [], connection: null })
it('deduplicates repeated readbacks by action/revision/outcome/provider, retaining the original chronological timestamp', () => {
  const original = conversationUpdates(state())
  const duplicate = { ...receipt, _id: 'r2', verifiedAt: 900 }
  const repeated = conversationUpdates(state([{ ...job, actions: [{ ...job.actions[0], receipts: [duplicate, receipt, duplicate] }] }]))
  expect(repeated).toEqual(original)
  expect(repeated).toHaveLength(1)
  expect(repeated[0]).toMatchObject({ at: 200, text: 'Your calendar was updated.' })
})
it('does not turn an old receipt into confirmation of a corrected action or expose that newer payload', () => {
  const corrected = { ...job, actions: [{ ...job.actions[0], revision: 3, status: 'review' as const, payload: { ...event, title: 'Unapproved changed event' } }] }
  expect(conversationUpdates(state([corrected]))).toEqual([])
  expect(conversationUpdates(state([{ ...job, actions: [{ ...job.actions[0], receipts: [{ ...receipt, revision: undefined }] }] }]))).toEqual([])
})
it('removes derived updates with the authorized job and never keeps a separate private history', () => {
  expect(conversationUpdates(state())).toHaveLength(1)
  expect(conversationUpdates(state([]))).toEqual([])
  const expired = { ...job, source: null }
  expect(conversationUpdates(state([expired]))[0].text).not.toContain('Private synthetic')
})
it.each(['review', 'queued', 'executing', 'waiting', 'uncertain', 'failed', 'succeeded'] as const)('never infers a completion update from %s without authoritative receipts', status => {
  expect(conversationUpdates(state([{ ...job, actions: [{ ...job.actions[0], status, receipts: [] }] }]))).toEqual([])
})
it('orders a caregiver answer as its own message after request sending without claiming pickup completion', () => {
  const pickup = { kind: 'pickup' as const, childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Synthetic pickup', evidence: {} }
  const sending = { ...receipt, outcome: 'request_email_accepted', providerId: 'mail-one', verifiedAt: 200 }
  const acceptance = { ...receipt, outcome: 'caregiver_accepted_not_pickup_completed', providerId: 'request-one', verifiedAt: 400 }
  const result = conversationUpdates(state([{ ...job, actions: [{ ...job.actions[0], payload: pickup, receipts: [acceptance, sending] }] }]))
  expect(result.map(r => r.at)).toEqual([200, 400])
  expect(result[0].text).toContain('Waiting for the caregiver’s answer')
  expect(result[1].text).toBe('Alex accepted Maya’s pickup.')
  expect(result[1].text).not.toMatch(/completed|picked up|happened/i)
})
it('preserves a verified partial result alongside uncertainty and cancellation without inventing all-work success', () => {
  const partial = { ...job, cancelled: true, actions: [...job.actions, { ...job.actions[0], _id: 'a2', status: 'uncertain' as const, receipts: [] }] }
  expect(conversationUpdates(state([partial])).map(u => u.text)).toEqual(['Your calendar was updated.'])
  expect(conversationReply(partial)).toContain('cancelled')
  expect(conversationActivity(partial)).toBeNull()
})
it('keeps local plan saves distinct from external calendar writes', () => {
  const local = state([{ ...job, actions: [{ ...job.actions[0], status: 'saved', receipts: [{ ...receipt, revision: undefined, outcome: 'saved_on_device' }] }] }])
  expect(conversationUpdates(local)).toEqual([])
  expect(conversationUpdates({ ...local, storage: 'device' })[0].text).toBe('The event was saved to this device’s plan.')
})
it('uses concise activity only for actual preparation/execution and preserves model questions', () => {
  expect(conversationReply({ ...job, actions: [], clarification: 'Which gate should Alex use?' })).toBe('Which gate should Alex use?')
  expect(conversationReply({ ...job, clarification: 'I found the existing event and prepared your change.' })).toContain('existing event')
  expect(conversationActivity({ ...job, preparing: true })).toBe('Working on your request…')
  expect(conversationActivity({ ...job, actions: [{ ...job.actions[0], status: 'executing' }] })).toBe('Updating your calendar…')
  expect(conversationActivity(job)).toBeNull()
})
it('ignores unrecognized checks, invalid timestamps, and provider outcomes for the wrong action kind', () => {
  const receipts = [{ ...receipt, outcome: 'nothing_changed' }, { ...receipt, verifiedAt: NaN }, { ...receipt, outcome: 'gmail_accepted' }]
  expect(conversationUpdates(state([{ ...job, actions: [{ ...job.actions[0], receipts }] }]))).toEqual([])
})
it.each([['declined', 'decline'], ['suggested', 'suggest']] as const)('shows an observed %s response to the earlier request without confirming revised work', (status, response) => {
  const s = state([{ ...job, actions: [{ ...job.actions[0], status: 'review', revision: 3, receipts: [] }] }])
  s.arrangements = [{ id: 'request-old', actionId: 'a1', status, response, respondedAt: 500, caregiver: 'Alex', payload: { kind: 'pickup', childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Original request', evidence: {} } }]
  const updates = conversationUpdates(s)
  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({ at: 500, jobId: 'j1' })
  expect(updates[0].text).toContain('earlier pickup request')
  expect(updates[0].text).not.toMatch(/accepted|confirmed|sent|completed/i)
  expect(conversationUpdates({ ...s, jobs: [] })).toEqual([])
  expect(conversationUpdates({ ...s, arrangements: [{ ...s.arrangements[0], respondedAt: undefined }] })).toEqual([])
})
