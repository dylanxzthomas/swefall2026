import { expect, it } from 'vitest'
import { nextNotificationTime } from './notifications.js'
import { availabilityAt } from './memory.js'
it('defers ordinary alerts across midnight and DST in household time', () => {
  expect(new Date(nextNotificationTime(Date.parse('2026-11-01T03:30:00Z'), 'America/Los_Angeles')).toISOString()).toBe('2026-11-01T15:00:00.000Z')
  const noon = Date.parse('2026-10-01T19:00:00Z')
  expect(nextNotificationTime(noon, 'America/Los_Angeles')).toBe(noon)
  expect(nextNotificationTime(noon, 'UTC', '00:00', '00:00')).toBe(noon)
})
it('never infers availability from a routine or an empty plan', () => {
  expect(availabilityAt([], 'alex', '2027-05-05', '15:00', 'UTC')).toBe('unknown')
  expect(availabilityAt([{ kind: 'routine', childId: 'maya', caregiverId: 'alex', weekday: 3, time: '15:00', location: 'Gate' }], 'alex', '2027-05-05', '15:00', 'UTC')).toBe('unknown')
})
