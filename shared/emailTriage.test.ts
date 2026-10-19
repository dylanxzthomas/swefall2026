import { expect, it } from 'vitest'
import { emailBody, emailTriageSchema, guardEmailTriage } from './emailTriage.js'
import { emailFixtures, gradeEmail } from '../tests/evals/emailTriage.js'
const body = 'Our October newsletter celebrates last month’s completed activities. There is nothing to sign or return.'
const quiet = { decision: 'quiet' as const, reason: 'A recap of completed activities; no action requested.', evidence: ['There is nothing to sign or return.'] }
const complete = { format: 'html' as const, incomplete: false, truncated: false, attachments: false }
it('allows a grounded, complete, action-free informational email to stay quiet', () => {
  expect(guardEmailTriage(quiet, body, complete, 0, '')).toEqual(quiet)
})
it.each([
  { ...complete, incomplete: true }, { ...complete, truncated: true }, { ...complete, attachments: true },
  { ...complete, format: 'snippet' as const }, { ...complete, format: 'unavailable' as const }, undefined,
])('keeps missing coverage visible: %j', coverage => {
  expect(guardEmailTriage(quiet, body, coverage, 0, '').decision).toBe('uncertain')
})
it('rejects quiet when the model also prepared work or asked for clarification', () => {
  expect(guardEmailTriage(quiet, body, complete, 1, '').decision).toBe('uncertain')
  expect(guardEmailTriage(quiet, body, complete, 0, 'Check the deadline.').decision).toBe('uncertain')
})
it('cannot ground filtering in the parent instruction, subject or fabricated excerpts', () => {
  for (const evidence of [[], ['Prepare school work'], ['The school trip was cancelled']]) expect(guardEmailTriage({ ...quiet, evidence }, body, complete, 0, '').decision).toBe('uncertain')
  expect(guardEmailTriage(quiet, undefined, complete, 0, '').decision).toBe('uncertain')
})
it('keeps explicit dates, deadlines and requests visible even when the model tries to hide them', () => {
  for (const text of ['Pay the fee by October 12.', 'Field trip on 2026-10-09.', 'Please reply with attendance.', 'Dismissal is at 1pm.']) expect(guardEmailTriage({ ...quiet, evidence: [text] }, text, complete, 0, '').decision).toBe('uncertain')
  expect(guardEmailTriage(quiet, body, complete, 0, '', 'Permission form deadline')).toMatchObject({ decision: 'uncertain' })
})
it('drops fabricated evidence and avoids showing an unsupported explanation', () => {
  expect(guardEmailTriage({ decision: 'actionable', reason: 'Your trip is cancelled.', evidence: ['Fake cancellation'] }, body, complete, 0, '')).toMatchObject({ decision: 'actionable', evidence: [], reason: expect.stringContaining('not been supported') })
})
it('only extracts the recorded body; legacy and invalid offsets cannot support quiet results', () => {
  expect(emailBody({ text: 'Instruction\nEmail body', email: { bodyOffset: 12 } })).toBe('Email body')
  for (const bodyOffset of [undefined, -1, 0.5, Infinity, 1000]) expect(emailBody({ text: body, email: { bodyOffset } })).toBeUndefined()
  expect(emailBody({ text: body })).toBeUndefined()
})
it('rejects oversized or authority-bearing classification payloads', () => {
  expect(emailTriageSchema.safeParse({ ...quiet, approve: true }).success).toBe(false)
  expect(emailTriageSchema.safeParse({ ...quiet, reason: 'x'.repeat(301) }).success).toBe(false)
  expect(emailTriageSchema.safeParse({ ...quiet, evidence: Array(4).fill('x') }).success).toBe(false)
})
it('checks a fixed ten-message corpus including dates hidden in newsletters and unread files', () => {
  for (const fixture of emailFixtures) expect(gradeEmail(fixture, fixture.reference), fixture.id).toEqual([])
})
it('flags a falsely quiet deadline and fabricated completion in evaluation', () => {
  const deadline = emailFixtures.find(f => f.id === 'email-10')!
  expect(gradeEmail(deadline, { actions: [], clarification: '', triage: { ...quiet, evidence: ['pay the activity fee by October 12'] } })).toContain('wrong_relevance')
  const trip = emailFixtures[0], reference = trip.reference as { clarification: string }
  expect(gradeEmail(trip, { ...reference, clarification: 'Calendar updated. All handled.' })).toContain('unsupported_completion_claim')
})
