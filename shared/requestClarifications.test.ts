import { expect, it } from 'vitest'
import { event } from '../tests/fixtures/calendar.js'
import { sourceHash } from './daymark.js'
import { askedClarificationFields, clarificationPayloadHash, directClarificationAnswer, validateClarificationRevision, applyClarificationPatch, clarificationRevisionSchema } from './requestClarifications.js'
const partial = { ...event, startTime: null, endTime: null }
const answer = '3 PM to 4 PM.'
const binding = { questionKey: 'synthetic', question: 'What time does it start and end?', fields: ['startTime', 'endTime'], originalPayloadHash: clarificationPayloadHash(partial), originalActionRevision: 1, sourceRevision: 1, answerJobId: 'answer', answerSourceId: 'source', answerSourceRevision: 1, answerHash: sourceHash(answer) }
const revised = { ...partial, startTime: '15:00', endTime: '16:00', evidence: { ...partial.evidence, startTime: '3 PM', endTime: '4 PM' } }
it('binds an ordinary short answer to actual missing details named in the current question', () => {
  expect(directClarificationAnswer(answer)).toBe(true)
  expect(askedClarificationFields(binding.question, partial)).toEqual(binding.fields)
  expect(askedClarificationFields('Ready for review.', partial)).toEqual([])
  expect(askedClarificationFields('What time?', event)).toEqual([])
  expect(askedClarificationFields('What time does it start?', partial)).toEqual(['startTime'])
  expect(askedClarificationFields('What time does it end?', partial)).toEqual(['endTime'])
  expect(validateClarificationRevision(binding, partial, revised, answer)).toBe(true)
  expect(validateClarificationRevision(binding, partial, partial, answer)).toBe(true)
})
it.each(['New topic: 3 PM', 'What should we eat?', 'The email says 3 PM', '> 3 PM', '"3 PM"', '3 PM; send it', '3 PM; delete everything', 'Approve 3 PM', 'School notice: 3 PM to 4 PM', 'For example, 3 PM to 4 PM', 'For instance, 3 PM', 'Sarah said 3 PM to 4 PM', 'My husband wrote 3 PM', 'Hypothetically 3 PM', 'Email: 3 PM'])('does not treat instructions, quoted data or unrelated questions as a direct answer: %s', text => expect(directClarificationAnswer(text)).toBe(false))
it.each([{ title: 'Different' }, { date: '2030-01-01' }, { operation: 'delete' }, { childId: 'someone-else' }, { targetId: 'another-calendar' }, { allDay: true }, { notes: 'Injected' }])('rejects every unasked payload change: %o', change => {
  expect(validateClarificationRevision(binding, partial, { ...revised, ...change }, answer)).toBe(false)
})
it('requires unchanged original evidence and literal parent evidence for changed fields', () => {
  expect(validateClarificationRevision(binding, partial, { ...revised, evidence: { date: 'invented', startTime: '3 PM', endTime: '4 PM' } }, answer)).toBe(false)
  expect(validateClarificationRevision(binding, partial, { ...revised, evidence: { ...partial.evidence, startTime: '5 PM', endTime: '4 PM' } }, answer)).toBe(false)
  expect(validateClarificationRevision(binding, partial, { ...revised, evidence: partial.evidence }, answer)).toBe(false)
  expect(validateClarificationRevision(binding, partial, { ...revised, startTime: '22:00' }, answer)).toBe(false)
  expect(validateClarificationRevision(binding, partial, revised, '5 PM to 6 PM.')).toBe(false)
  expect(validateClarificationRevision({ ...binding, fields: ['title'] }, partial, revised, answer)).toBe(false)
})
it('applies only a constrained missing-field patch, preserving optional operation and every unrelated field', () => {
  const original = { ...partial, operation: 'save' as const }, bound = { ...binding, originalPayloadHash: clarificationPayloadHash(original) }
  const patch = { updates: [{ field: 'startTime' as const, value: '15:00', quote: '3 PM' }], clarification: 'What time does it end?' }
  expect(applyClarificationPatch(bound, original, patch, answer)).toEqual({ ...original, startTime: '15:00', evidence: { ...original.evidence, startTime: '3 PM' } })
  expect(original.startTime).toBeNull()
  expect(() => applyClarificationPatch(bound, original, { ...patch, updates: [...patch.updates, ...patch.updates] }, answer)).toThrow()
  expect(() => applyClarificationPatch(bound, original, { ...patch, updates: [{ field: 'title', value: 'Wrong event', quote: '3 PM' }] }, answer)).toThrow()
  expect(() => applyClarificationPatch(bound, original, { ...patch, updates: [{ field: 'startTime', value: '22:00', quote: '3 PM' }] }, answer)).toThrow()
  expect(clarificationRevisionSchema.safeParse({ ...patch, payload: original }).success).toBe(false)
  expect(applyClarificationPatch(bound, original, { updates: [], clarification: 'What time?' }, answer)).toEqual(original)
})
