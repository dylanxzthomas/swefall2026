import { expect, it } from 'vitest'
import { blockers, extractionSchema } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'
import { fixtures } from '../tests/evals/notices.js'
import { scoreNotice } from '../tests/evals/noticeScore.js'

it('keeps a timed event with an unknown end editable but blocks approval and requires clarification in evaluation', () => {
  const fixture = fixtures.find(f => f.id === 'synthetic-07')!
  const draft = { ...event, childId: 'maya', date: '2027-05-12', endDate: '2027-05-12', startTime: '16:00', endTime: null, evidence: { startTime: '16:00' } }
  const output = extractionSchema.parse({ actions: [draft], clarification: '' })
  expect(blockers(output.actions[0], [{ id: 'maya' }])).toContain('Confirm the start and end time. No duration has been assumed.')
  expect(scoreNotice(fixture, output)).toEqual(['missing_clarification'])
  expect(scoreNotice(fixture, { ...output, clarification: 'What time does the exhibition end?' })).toEqual([])
})

it('keeps an unlisted caregiver draft blocked without silently substituting the listed caregiver', () => {
  const fixture = fixtures.find(f => f.id === 'synthetic-59')!
  const output = extractionSchema.parse({ actions: [{ kind: 'pickup', childId: 'maya', caregiverId: null, date: '2027-05-14', time: '15:00', timezone: 'UTC', location: 'front gate', deadline: '2027-05-14T12:00:00Z', message: 'Could you collect Maya?', evidence: { location: 'front gate' } }], clarification: 'Add Sam as an eligible caregiver or choose a listed caregiver.' })
  expect(scoreNotice(fixture, output)).toEqual([])
  expect(blockers(output.actions[0], [{ id: 'maya' }], Date.parse('2027-05-01T12:00:00Z'))).toContain('Choose an eligible caregiver.')
  expect(scoreNotice(fixture, { ...output, clarification: 'Please provide Sam’s household ID.' })).toContain('internal_id_request')
  expect(scoreNotice(fixture, { ...output, actions: [] })).toContain('missing_required_artifact')
})

it('never treats empty or fabricated source evidence as a quality pass', () => {
  const fixture = fixtures.find(f => f.id === 'synthetic-07')!
  const draft = { ...event, childId: 'maya', date: '2027-05-12', endDate: '2027-05-12', startTime: '16:00', endTime: null, evidence: {} }
  expect(scoreNotice(fixture, { actions: [draft], clarification: 'What time does it end?' })).toContain('missing_evidence')
  expect(scoreNotice(fixture, { actions: [{ ...draft, evidence: { endTime: 'It ends at 17:00.' } }], clarification: 'What time does it end?' })).toContain('ungrounded_evidence')
})

it('aligns the relative-date development fixture clock without changing its expected date or holdout membership', () => {
  const fixture = fixtures.find(f => f.id === 'synthetic-09')!
  expect(fixture).toMatchObject({ now: '2027-05-13T12:00:00Z', expected: { date: '2027-05-14' }, split: 'development' })
  expect(fixtures.filter(f => f.split === 'holdout')).toHaveLength(30)
  expect(fixtures.filter(f => f.split === 'holdout').every(f => !f.now && Number(f.id.slice(-2)) % 2 === 0)).toBe(true)
})
