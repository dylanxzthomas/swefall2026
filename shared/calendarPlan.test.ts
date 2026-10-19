import { expect, it } from 'vitest'
import { calendarPlanStatus, type CalendarAgenda } from './calendarPlan.js'
import { event } from '../tests/fixtures/calendar.js'

const start = Date.parse(`${event.date}T00:00Z`), through = start + 7 * 86400_000
const saved = { owner: 'parent', provider: 'google', connectionId: 'account-one', connectionVersion: 4, calendarId: 'family', eventId: 'event-one', etag: 'old', payload: { ...event, timezone: 'UTC' } }
const agenda = (): CalendarAgenda => ({ owner: 'parent', from: start - 86400_000, through, truncated: false, availabilityKnown: true, coverage: [{ feedId: 'feed', provider: 'google', connectionId: 'account-one', connectionVersion: 4, calendars: ['family'], complete: true, fresh: true, from: start - 86400_000, through }], events: [{ id: 'private-row', provider: 'google', connectionId: 'account-one', connectionVersion: 4, calendarId: 'family', providerId: 'event-one', etag: 'changed', title: 'Private corrected title', start: start + 3600_000, end: start + 7200_000, allDay: false, location: 'Private corrected location' }] })

it('distinguishes owner-only current revisions from the unchanged shared saved result', () => {
  const current = agenda()
  expect(calendarPlanStatus(saved, current)).toContain('Calendar changed since this save')
  expect(calendarPlanStatus(saved, { ...current, owner: 'other-adult' })).toBe('Last verified calendar details')
  expect(JSON.stringify(saved)).not.toMatch(/Private corrected/)
  expect(calendarPlanStatus(saved, current)).not.toMatch(/Private corrected/)
})
it('matches provider, account, grant, calendar and provider event identity independently of equal titles', () => {
  for (const patch of [{ provider: 'microsoft' }, { connectionId: 'another-account' }, { connectionVersion: 5 }, { calendarId: 'other-calendar' }, { eventId: 'different-event' }]) {
    const result = calendarPlanStatus({ ...saved, ...patch }, agenda())
    expect(result).not.toContain('current event shown above')
  }
  expect(calendarPlanStatus({ ...saved, connectionVersion: undefined }, agenda())).toBe('Last verified calendar details')
  expect(calendarPlanStatus(saved, { ...agenda(), events: [{ ...agenda().events[0], etag: 'old' }] })).toBe('Last verified details · current event shown above')
})
it('discloses disappearance only inside a fresh complete queried window and never claims deletion', () => {
  const absent = { ...agenda(), events: [] }
  const status = calendarPlanStatus(saved, absent)
  expect(status).toContain('Not in the latest checked window')
  expect(status).not.toMatch(/deleted|removed/i)
  for (const current of [
    { ...absent, truncated: true }, { ...absent, through: start },
    ...[{ complete: false }, { fresh: false }, { issue: 'Interrupted check' }, { through: start }].map(patch => ({ ...absent, coverage: [{ ...absent.coverage[0], ...patch }] })),
  ]) expect(calendarPlanStatus(saved, current)).toBe('Last verified calendar details')
})
it('does not infer absence from malformed legacy dates or an unrelated selection', () => {
  expect(calendarPlanStatus({ ...saved, payload: { ...saved.payload, date: 'unknown' } }, { ...agenda(), events: [] })).toBe('Last verified calendar details')
  expect(calendarPlanStatus(saved, { ...agenda(), events: [], coverage: [{ ...agenda().coverage[0], calendars: ['another-calendar'] }] })).toBe('Last verified calendar details')
})
