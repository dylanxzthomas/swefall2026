import { expect, it } from 'vitest'
import { nativeEventPayload, nativeOperation, validateNativeDestination, type NativeCalendarState, type NativeEvent } from './nativeCalendar.js'
import type { CalendarDraft } from './daymark.js'
const payload: CalendarDraft = { kind: 'calendar', title: 'Maya school trip', childId: 'maya', date: '2026-11-01', startTime: '10:00', endDate: '2026-11-01', endTime: '11:00', allDay: false, timezone: 'America/Los_Angeles', location: 'North gate', notes: '', targetId: null, evidence: {} }
const state: NativeCalendarState = { available: true, permission: 'granted', calendars: [{ id: 'icloud-test', title: 'Test', account: 'iCloud' }], selectedId: 'icloud-test', version: 4 }
it('binds native approvals to content, source, destination version, and unique action revision', () => {
  const a = nativeOperation('action', 1, 1, payload, { calendarId: 'icloud-test', version: 4 })
  expect(new Date(a.start).toISOString()).toBe('2026-11-01T18:00:00.000Z')
  expect(nativeOperation('action', 1, 1, payload, { calendarId: 'icloud-test', version: 4 })).toEqual(a)
  for (const b of [nativeOperation('action', 1, 2, payload, { calendarId: 'icloud-test', version: 4 }), nativeOperation('action', 1, 1, payload, { calendarId: 'icloud-test', version: 5 }), nativeOperation('action', 1, 1, { ...payload, location: 'South gate' }, { calendarId: 'icloud-test', version: 4 })]) expect(b.approvalHash).not.toBe(a.approvalHash)
  expect(nativeOperation('action', 2, 1, payload, { calendarId: 'icloud-test', version: 4 }).operationId).not.toBe(a.operationId)
})
it('rejects stale or revoked selection and a local plan target with no native before image', () => {
  expect(() => validateNativeDestination(state, { calendarId: 'icloud-test', version: 4 })).not.toThrow()
  for (const current of [state, { ...state, permission: 'denied' as const }, { ...state, version: 5 }, { ...state, calendars: [] }]) expect(() => validateNativeDestination(current, { calendarId: 'icloud-test', version: 3 })).toThrow('selection changed')
  expect(() => validateNativeDestination(state)).toThrow('selection changed')
  expect(() => nativeOperation('a', 1, 1, { ...payload, targetId: 'local-plan' }, { calendarId: 'icloud-test', version: 4 })).toThrow('original Apple Calendar')
  expect(() => validateNativeDestination(undefined)).not.toThrow()
})
it('keeps all-day boundaries across daylight saving and displays refreshed provider details', () => {
  const operation = nativeOperation('a', 1, 1, { ...payload, allDay: true, startTime: null, endTime: null }, { calendarId: 'icloud-test', version: 4 })
  expect(operation.end - operation.start).toBe(25 * 3600000)
  const event: NativeEvent = { ...operation, eventId: 'test-event', fingerprint: 'version2', title: 'Corrected at school' }
  const refreshed = nativeEventPayload(event, payload)
  expect(refreshed.title).toBe('Corrected at school')
  expect(refreshed.date).toBe('2026-11-01'); expect(refreshed.endDate).toBe('2026-11-01'); expect(refreshed.startTime).toBeNull()
})

it('deletes only the captured native target even when irrelevant draft dates are blank', () => {
  const before: NativeEvent = { eventId: 'existing', calendarId: 'icloud-test', fingerprint: 'current', title: 'Existing trip', location: 'North gate', notes: '', start: Date.parse('2026-10-08T08:30Z'), end: Date.parse('2026-10-08T14:30Z'), allDay: false, timezone: 'UTC' }
  const operation = nativeOperation('delete', 1, 1, { ...payload, operation: 'delete', targetId: 'plan', title: '', date: '', endDate: '', timezone: '' }, { calendarId: 'icloud-test', version: 4 }, before)
  expect(operation.operation).toBe('delete'); expect(operation.title).toBe('Existing trip'); expect(operation.start).toBe(before.start); expect(operation.eventId).toBe('existing'); expect(operation.expectedFingerprint).toBe('current')
})
