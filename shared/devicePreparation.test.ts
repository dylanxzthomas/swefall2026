import { describe, expect, it } from 'vitest'
import { prepareOnDevice } from './devicePreparation.js'

const context = { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }, { id: 'leo', name: 'Leo' }], caregivers: [{ _id: 'alex', name: 'Alex', childIds: ['maya'] }] }
describe('literal device preparation', () => {
  it('extracts explicit facts and preserves the source without assuming a duration', () => {
    const text = 'Event: Maya’s museum trip\nDate: October 8, 2026\nTime: 8:30 AM to 2:30 PM\nLocation: North gate'
    const { actions } = prepareOnDevice(text, context)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'calendar', childId: 'maya', title: 'Maya’s museum trip', date: '2026-10-08', startTime: '08:30', endTime: '14:30', location: 'North gate', timezone: context.timezone, notes: text })
    expect(prepareOnDevice('Maya has an event on 2026-10-08 at 9 AM.', context).actions[0]).toMatchObject({ startTime: '09:00', endTime: null })
  })
  it('does not guess relative dates, invalid dates, similar names, or ambiguous children', () => {
    for (const text of ['Mayabelle has an event tomorrow.', 'Maya and Leo have an event Friday.', 'Maya has an event on 2026-02-30.']) {
      expect(prepareOnDevice(text, context).actions[0]).toMatchObject({ date: '', startTime: null, endTime: null })
    }
    expect(prepareOnDevice('Mayabelle has an event.', context).actions[0].childId).toBeNull()
    expect(prepareOnDevice('Maya and Leo have an event.', context).actions[0].childId).toBeNull()
    expect(prepareOnDevice('Amaya has an event.', context).actions[0].childId).toBeNull()
  })
  it('only marks an explicit all-day notice as all day', () => {
    expect(prepareOnDevice('Maya deadline 2026-10-08', context).actions[0]).toMatchObject({ allDay: false, startTime: null, endTime: null })
    expect(prepareOnDevice('Maya deadline 2026-10-08 all-day', context).actions[0]).toMatchObject({ allDay: true, date: '2026-10-08' })
  })
  it('preserves email wording and an outstanding portal requirement', () => {
    const { actions, clarification } = prepareOnDevice('Draft email to teacher@example.test\nSubject: Maya RSVP\nBody: We will attend. The permission form is still outstanding.', context)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'email', to: 'teacher@example.test', subject: 'Maya RSVP', body: 'We will attend. The permission form is still outstanding.', childId: 'maya', requirement: expect.stringContaining('Complete that requirement separately') })
    expect(clarification).toContain('Nothing has been sent')
  })
  it('prepares independent drafts and uses only an explicitly named eligible caregiver', () => {
    const { actions } = prepareOnDevice('Maya dismissal event on 2026-10-08 at 2 PM. Ask Alex about pickup. Draft email to teacher@example.test.', context)
    expect(actions.map(a => a.kind)).toEqual(['calendar', 'email', 'pickup'])
    expect(actions[2]).toMatchObject({ childId: 'maya', caregiverId: 'alex', date: '2026-10-08', time: '14:00', deadline: '' })
    expect(prepareOnDevice('Ask Alex to pick up Leo on 2026-10-08 at 2 PM.', context).actions[0]).toMatchObject({ childId: 'leo', caregiverId: null })
  })
})
