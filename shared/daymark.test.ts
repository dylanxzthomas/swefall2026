import { describe, expect, it } from 'vitest'
import { blockers, calendarTimes, eventBody, sameEvent, sourceHash, type CalendarDraft } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'

describe('calendar rules', () => {
  it('keeps unknown duration blocked and requires confirmed child', () => {
    expect(blockers({ ...event, endTime: null }, [{ id: 'maya' }])).toContain('Confirm the start and end time. No duration has been assumed.')
    expect(blockers(event, [{ id: 'mia' }])).toContain('Confirm the child.')
  })
  it('uses household timezone and inclusive all-day dates', () => {
    expect(calendarTimes(event).start).toEqual({ dateTime: '2026-10-09T15:30:00Z', timeZone: event.timezone })
    expect(calendarTimes({ ...event, allDay: true }).end).toEqual({ date: '2026-10-10' })
  })
  it('rejects impossible, ambiguous and daylight-saving-skipped times', () => {
    for (const p of [{ date: '2026-02-30' }, { date: '2026-11-01', startTime: '01:30' }, { date: '2026-03-08', startTime: '02:30' }]) expect(() => calendarTimes({ ...event, ...p })).toThrow()
  })
  it('requires read-back of all important fields and operation revision', () => {
    const body = eventBody(event, 'action', 1)
    expect(sameEvent(body, body)).toBe(true)
    expect(sameEvent({ ...body, description: 'different' }, body)).toBe(false)
    expect(sameEvent({ ...body, status: 'cancelled' }, body)).toBe(false)
    expect(sourceHash(' a\r\nb ')).toBe(sourceHash('a\nb'))
  })
})

it('blocks an enabled reminder without a time', () => {
  expect(blockers({ kind: 'pickup', childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'Gate', deadline: '2027-05-05T13:00:00Z', followUpAt: '', message: 'Pickup?', evidence: {} }, [{ id: 'maya' }], Date.parse('2027-05-01T12:00:00Z'))).not.toHaveLength(0)
})
