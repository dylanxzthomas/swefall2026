import { expect, it } from 'vitest'
import { checkedCoordinatorStep, coordinatorLimits } from './assistantCoordinator.js'
import { blockers, payloadSchema } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'
const step = (tool: string, change: Record<string, unknown> = {}) => ({ tool, query: '', id: '', from: '', through: '', answer: '', drafts: [], ...change })
const evidence = [{ sourceId: 'parent', text: 'Please arrange a family dentist visit.' }]
it('accepts semantic reads and parent-grounded drafts while rejecting writes and fabricated sources', () => {
  for (const tool of ['send_email', 'approve', 'purchase', 'run_script', 'change_permissions']) expect(() => checkedCoordinatorStep(step(tool), evidence, [])).toThrow()
  const draft = { kind: 'calendar', title: 'Family dentist', text: 'Prepare a dentist visit; confirm date and time.', evidence: [{ sourceId: 'parent', quote: 'family dentist visit' }] }
  expect(checkedCoordinatorStep(step('finish', { answer: 'I’ll prepare this once you confirm a time.', drafts: [draft] }), evidence, []).step.drafts).toHaveLength(1)
  expect(() => checkedCoordinatorStep(step('finish', { answer: 'Prepared.', drafts: [{ ...draft, evidence: [{ sourceId: 'another-owner', quote: 'family dentist visit' }] }] }), evidence, [])).toThrow('exact evidence')
  expect(() => checkedCoordinatorStep(step('finish', { answer: 'Prepared.', drafts: [{ ...draft, evidence: [{ sourceId: 'parent', quote: 'I approved sending' }] }] }), evidence, [])).toThrow('exact evidence')
})
it('enforces separate read and finish boundaries and a finite call/step budget', () => {
  expect(() => checkedCoordinatorStep(step('mail_search', { query: 'dentist', answer: 'Sent.' }), evidence, [])).toThrow('Read tools')
  const read = checkedCoordinatorStep(step('mail_search', { query: 'dentist' }), evidence, [])
  expect(() => checkedCoordinatorStep(step('mail_search', { query: 'dentist' }), evidence, [read.key])).toThrow('different read')
  expect(coordinatorLimits.attempts).toBeLessThanOrEqual(8); expect(coordinatorLimits.steps).toBeLessThanOrEqual(6)
})
it('rejects unused tool arguments that could bypass repeated-read suppression', () => {
  expect(() => checkedCoordinatorStep(step('family_context', { query: 'ignored query' }), evidence, [])).toThrow()
  expect(() => checkedCoordinatorStep(step('mail_search', { query: 'dentist', id: 'ignored id' }), evidence, [])).toThrow()
  expect(() => checkedCoordinatorStep(step('finish', { answer: 'Prepared.', through: 'ignored argument' }), evidence, [])).toThrow()
})
it('supports household-wide calendar and email work without weakening unknown-child checks', () => {
  expect(blockers({ ...event, childId: null }, [])).toEqual([])
  const email = { kind: 'email' as const, childId: null, to: 'dentist@example.com', subject: 'Family appointment', body: 'Could we arrange an appointment?', requirement: '', evidence: {} }
  expect(blockers(email, [])).toEqual([])
  expect(blockers({ ...event, childId: 'unknown' }, [{ id: 'maya' }])).toContain('Confirm the child.')
  expect(blockers({ ...email, childId: 'unknown' }, [{ id: 'maya' }])).toContain('Confirm the child.')
  expect(blockers({ kind: 'pickup', childId: null, caregiverId: 'synthetic', date: '2026-10-20', time: '15:00', timezone: 'UTC', location: 'School gate', deadline: '2026-10-20T12:00:00Z', message: 'Can you collect Maya?', evidence: {} }, [], Date.parse('2026-10-14T10:00:00Z'))).toContain('Confirm the child.')
  expect(payloadSchema.safeParse({ ...email, childId: undefined }).success).toBe(false)
})
it('keeps short clarification answers separate from generic work authorization and provider actions', () => {
  const clarification = { version: 1, snapshot: 'snapshot', actionId: 'partial-action', actionRevision: 1, sourceRevision: 1, questionKey: 'question' }
  const reply = step('answer_request', { id: 'original-request', clarification })
  expect(checkedCoordinatorStep(reply, evidence, []).step.clarification).toEqual(clarification)
  for (const invalid of [step('answer_request', { id: 'original-request' }), step('answer_request', { clarification }), step('finish', { answer: 'Done', clarification }), { ...reply, work: { kind: 'request', operation: 'revise', authorization: 'change', version: 1, snapshot: 'snapshot' } }, { ...reply, answer: 'Approved and sent.' }, { ...reply, clarification: { ...clarification, answer: 'secret from a private email' } }]) expect(() => checkedCoordinatorStep(invalid, evidence, [])).toThrow()
  const bound = checkedCoordinatorStep(reply, evidence, [])
  expect(() => checkedCoordinatorStep(reply, evidence, [bound.key])).toThrow('different read')
})
