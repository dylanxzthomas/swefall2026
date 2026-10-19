import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, it } from 'vitest'
import { latestOccurrence, nextOccurrence, routineDefinitionSchema, routineScheduleSchema, type RoutineDefinition, type RoutineSchedule } from './routines.js'

const ms = (value: string) => Temporal.Instant.from(value).epochMilliseconds
const daily: RoutineSchedule = { frequency: 'daily', time: '08:00', timezone: 'UTC', startDate: '2026-10-05' }
const definition: RoutineDefinition = { title: ' Pack school bags ', outcome: { kind: 'personal_task', task: { title: ' Pack school bags ', notes: ' Include water bottles. ', childId: 'maya' }, dueAfterDays: 0 }, schedule: daily }
const occurrence = (iso: string, localDate: string) => ({ at: ms(iso), localDate })

describe('routine definitions', () => {
  it('normalizes text, weekdays and exceptions without mutating the submitted definition', () => {
    const raw = { ...definition, schedule: { ...daily, frequency: 'weekly', weekdays: [5, 1, 5, 3, 1, 7, 2, 4, 6], exceptDates: ['2026-10-12', '2026-10-06', '2026-10-12'] } }
    const parsed = routineDefinitionSchema.parse(raw)
    expect(parsed.title).toBe('Pack school bags')
    expect(parsed.outcome).toEqual({ kind: 'personal_task', task: { title: 'Pack school bags', notes: 'Include water bottles.', childId: 'maya' }, dueAfterDays: 0 })
    expect(parsed.schedule.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parsed.schedule.exceptDates).toEqual(['2026-10-06', '2026-10-12'])
    expect(raw.schedule.weekdays).toEqual([5, 1, 5, 3, 1, 7, 2, 4, 6])
    expect(raw.title).toBe(' Pack school bags ')
  })

  it('accepts preparation instructions but rejects execution or approval fields at every level', () => {
    const prepare = { title: 'Weekly calendar draft', outcome: { kind: 'prepare_request', instruction: ' Prepare next week’s activities. ' }, schedule: daily }
    expect(routineDefinitionSchema.parse(prepare).outcome).toEqual({ kind: 'prepare_request', instruction: 'Prepare next week’s activities.' })
    for (const invalid of [
      { ...definition, approved: true },
      { ...definition, schedule: { ...daily, interval: 2 } },
      { ...definition, outcome: { ...definition.outcome, sendAutomatically: true } },
      { ...definition, outcome: { kind: 'personal_task', task: { title: 'Pack bags', notes: '', done: true }, dueAfterDays: 1 } },
      { ...prepare, outcome: { kind: 'prepare_request', instruction: 'Prepare a reply.', approval: { allowed: true } } },
      { ...prepare, outcome: { kind: 'send_email', instruction: 'Send the reply.' } },
    ]) expect(routineDefinitionSchema.safeParse(invalid).success).toBe(false)
  })

  it('validates actual dates, times and named timezones instead of silently adjusting them', () => {
    for (const startDate of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-01', '26-01-01', '2026-10-05T00:00', 'garbage']) expect(routineScheduleSchema.safeParse({ ...daily, startDate }).success, startDate).toBe(false)
    expect(routineScheduleSchema.safeParse({ ...daily, startDate: '2028-02-29' }).success).toBe(true)
    for (const time of ['8:00', '24:00', '12:60', '08:00:01', '08:00Z', '08:30 AM']) expect(routineScheduleSchema.safeParse({ ...daily, time }).success, time).toBe(false)
    for (const timezone of ['', 'Not/A_Timezone', '+02:00', '-0530', '−05:00']) expect(routineScheduleSchema.safeParse({ ...daily, timezone }).success, timezone).toBe(false)
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Etc/GMT+5']) expect(routineScheduleSchema.safeParse({ ...daily, timezone }).success, timezone).toBe(true)
    expect(routineScheduleSchema.safeParse({ ...daily, endDate: '2026-10-04' }).success).toBe(false)
    expect(routineScheduleSchema.safeParse({ ...daily, exceptDates: ['2026-02-30'] }).success).toBe(false)
  })

  it('requires ISO weekdays only for weekly routines and bounds the saved outcome', () => {
    for (const schedule of [
      { ...daily, frequency: 'monthly' }, { ...daily, weekdays: [1] }, { ...daily, weekdays: [] },
      { ...daily, frequency: 'weekly' }, { ...daily, frequency: 'weekly', weekdays: [] },
      ...[[0], [8], [1.5], ['1']].map(weekdays => ({ ...daily, frequency: 'weekly', weekdays })),
    ]) expect(routineScheduleSchema.safeParse(schedule).success).toBe(false)
    for (const dueAfterDays of [-1, 31, 1.5, '2']) expect(routineDefinitionSchema.safeParse({ ...definition, outcome: { ...definition.outcome, dueAfterDays } }).success).toBe(false)
    for (const title of ['', ' ', 'x'.repeat(201)]) expect(routineDefinitionSchema.safeParse({ ...definition, title }).success).toBe(false)
    for (const instruction of ['', ' ', 'x'.repeat(20001)]) expect(routineDefinitionSchema.safeParse({ ...definition, outcome: { kind: 'prepare_request', instruction } }).success).toBe(false)
    expect(routineDefinitionSchema.safeParse({ ...definition, outcome: { kind: 'personal_task', task: { title: 'Pack bags', notes: 'x'.repeat(2001) }, dueAfterDays: 0 } }).success).toBe(false)
  })

  it('caps distinct exception dates while accepting duplicated dates to normalize', () => {
    const dates = Array.from({ length: 367 }, (_, index) => Temporal.PlainDate.from(daily.startDate).add({ days: index }).toString())
    expect(routineScheduleSchema.safeParse({ ...daily, exceptDates: dates }).success).toBe(false)
    expect(routineScheduleSchema.parse({ ...daily, exceptDates: [...dates.slice(0, 366), dates[0]] }).exceptDates).toHaveLength(366)
  })
})

describe('recurring occurrences', () => {
  it('uses an exclusive next boundary and inclusive catch-up boundaries', () => {
    const at = ms('2026-10-05T08:00:00Z')
    expect(nextOccurrence(daily, at - 1)).toEqual({ at, localDate: '2026-10-05' })
    expect(nextOccurrence(daily, at)).toEqual(occurrence('2026-10-06T08:00:00Z', '2026-10-06'))
    expect(latestOccurrence(daily, at, at)).toEqual({ at, localDate: '2026-10-05' })
    expect(latestOccurrence(daily, at, at + 1)).toBeNull()
    expect(latestOccurrence(daily, at - 1, ms('2026-10-01T00:00:00Z'))).toBeNull()
    expect(nextOccurrence(daily, ms('2000-01-01T00:00:00Z'))).toEqual({ at, localDate: '2026-10-05' })
  })

  it('applies inclusive end dates and exceptions in both directions', () => {
    const schedule = { ...daily, endDate: '2026-10-07', exceptDates: ['2026-10-06'] }
    expect(nextOccurrence(schedule, ms('2026-10-05T08:00:00Z'))).toEqual(occurrence('2026-10-07T08:00:00Z', '2026-10-07'))
    expect(nextOccurrence(schedule, ms('2026-10-07T08:00:00Z'))).toBeNull()
    expect(latestOccurrence(schedule, ms('2035-01-01T00:00:00Z'), ms('2020-01-01T00:00:00Z'))).toEqual(occurrence('2026-10-07T08:00:00Z', '2026-10-07'))
    expect(latestOccurrence(schedule, ms('2026-10-07T07:59:59Z'), ms('2026-10-05T08:00:00Z'))).toEqual(occurrence('2026-10-05T08:00:00Z', '2026-10-05'))
    expect(latestOccurrence(schedule, ms('2026-10-06T22:00:00Z'), ms('2026-10-05T08:00:00.001Z'))).toBeNull()
    const entirelyExcluded = { ...daily, endDate: daily.startDate, exceptDates: [daily.startDate] }
    expect(nextOccurrence(entirelyExcluded, ms('2026-10-01T00:00:00Z'))).toBeNull()
    expect(latestOccurrence(entirelyExcluded, ms('2026-10-06T00:00:00Z'), ms('2026-10-01T00:00:00Z'))).toBeNull()
  })

  it('selects only specified ISO weekdays across week and year boundaries', () => {
    const schedule: RoutineSchedule = { ...daily, frequency: 'weekly', startDate: '2026-12-31', weekdays: [1, 5] }
    expect(nextOccurrence(schedule, ms('2026-12-01T00:00:00Z'))).toEqual(occurrence('2027-01-01T08:00:00Z', '2027-01-01'))
    expect(nextOccurrence(schedule, ms('2027-01-01T08:00:00Z'))).toEqual(occurrence('2027-01-04T08:00:00Z', '2027-01-04'))
    expect(latestOccurrence(schedule, ms('2027-01-03T08:00:00Z'), ms('2026-12-01T00:00:00Z'))).toEqual(occurrence('2027-01-01T08:00:00Z', '2027-01-01'))
    expect(nextOccurrence({ ...schedule, endDate: '2026-12-31' }, ms('2026-12-01T00:00:00Z'))).toBeNull()
  })

  it('moves a spring gap forward without changing later wall-clock times or nominal identity', () => {
    const schedule: RoutineSchedule = { ...daily, timezone: 'America/Los_Angeles', startDate: '2026-03-07', time: '02:30' }
    const first = nextOccurrence(schedule, ms('2026-03-07T12:00:00Z'))!
    expect(first).toEqual(occurrence('2026-03-08T10:30:00Z', '2026-03-08'))
    expect(nextOccurrence(schedule, first.at)).toEqual(occurrence('2026-03-09T09:30:00Z', '2026-03-09'))
    expect(latestOccurrence(schedule, first.at, ms('2026-03-08T10:00:00Z'))).toEqual(first)
    expect(latestOccurrence(schedule, ms('2026-03-08T10:29:59Z'), ms('2026-03-08T00:00:00Z'))).toBeNull()
  })

  it('runs the first fall overlap instance exactly once', () => {
    const schedule: RoutineSchedule = { ...daily, timezone: 'America/Los_Angeles', startDate: '2026-11-01', time: '01:30' }
    const first = nextOccurrence(schedule, ms('2026-11-01T07:00:00Z'))!
    expect(first).toEqual(occurrence('2026-11-01T08:30:00Z', '2026-11-01'))
    expect(nextOccurrence(schedule, first.at)).toEqual(occurrence('2026-11-02T09:30:00Z', '2026-11-02'))
    expect(nextOccurrence(schedule, ms('2026-11-01T09:00:00Z'))).toEqual(occurrence('2026-11-02T09:30:00Z', '2026-11-02'))
    expect(latestOccurrence(schedule, ms('2026-11-01T09:45:00Z'), first.at)).toEqual(first)
    expect(latestOccurrence(schedule, ms('2026-11-01T09:45:00Z'), first.at + 1)).toBeNull()
  })

  it('uses local dates in non-hour-offset and date-line zones', () => {
    const india = { ...daily, timezone: 'Asia/Kolkata', time: '00:10' }
    expect(nextOccurrence(india, ms('2026-10-05T18:39:00Z'))).toEqual(occurrence('2026-10-05T18:40:00Z', '2026-10-06'))
    expect(latestOccurrence(india, ms('2026-10-05T18:40:00Z'), ms('2026-10-05T18:39:00Z'))).toEqual(occurrence('2026-10-05T18:40:00Z', '2026-10-06'))
    const islands = { ...daily, timezone: 'Pacific/Kiritimati', time: '00:10' }
    expect(nextOccurrence(islands, ms('2026-10-05T10:09:00Z'))).toEqual(occurrence('2026-10-05T10:10:00Z', '2026-10-06'))
  })

  it('keeps a skipped whole date as the occurrence identity and exception key', () => {
    const schedule: RoutineSchedule = { ...daily, timezone: 'Pacific/Apia', startDate: '2011-12-30', endDate: '2011-12-30', time: '09:00' }
    const expected = occurrence('2011-12-30T19:00:00Z', '2011-12-30')
    expect(nextOccurrence(schedule, ms('2011-12-30T18:00:00Z'))).toEqual(expected)
    expect(latestOccurrence(schedule, expected.at, expected.at)).toEqual(expected)
    expect(nextOccurrence({ ...schedule, exceptDates: ['2011-12-30'] }, ms('2011-12-30T18:00:00Z'))).toBeNull()
    expect(nextOccurrence({ ...schedule, exceptDates: ['2011-12-31'] }, ms('2011-12-30T18:00:00Z'))).toEqual(expected)
  })

  it('finds the latest missed occurrence without replaying intervening years', () => {
    const schedule: RoutineSchedule = { ...daily, startDate: '2000-01-01', frequency: 'weekly', weekdays: [1], exceptDates: ['2099-01-05'] }
    expect(latestOccurrence(schedule, ms('2099-01-06T12:00:00Z'), ms('2000-01-01T00:00:00Z'))).toEqual(occurrence('2098-12-29T08:00:00Z', '2098-12-29'))
    expect(nextOccurrence({ ...daily, startDate: '2099-01-01' }, ms('2000-01-01T00:00:00Z'))).toEqual(occurrence('2099-01-01T08:00:00Z', '2099-01-01'))
  })

  it('searches past 366 excluded weekly occurrences using bounded candidate jumps', () => {
    const start = Temporal.PlainDate.from(daily.startDate)
    const exceptDates = Array.from({ length: 366 }, (_, index) => start.add({ weeks: index }).toString())
    const schedule: RoutineSchedule = { ...daily, frequency: 'weekly', weekdays: [1], exceptDates }
    const nextDate = start.add({ weeks: 366 }).toString()
    expect(nextOccurrence(schedule, ms('2026-10-05T07:59:59Z'))).toEqual(occurrence(`${nextDate}T08:00:00Z`, nextDate))
    const reverseExceptions = Array.from({ length: 366 }, (_, index) => start.add({ weeks: index + 1 }).toString())
    expect(latestOccurrence({ ...schedule, exceptDates: reverseExceptions }, ms(`${nextDate}T08:00:00Z`), ms('2026-10-05T08:00:00Z'))).toEqual(occurrence('2026-10-05T08:00:00Z', '2026-10-05'))
  })

  it('supports bounded replay through nextOccurrence without deciding the catch-up policy', () => {
    const schedule: RoutineSchedule = { ...daily, endDate: '2026-10-10', exceptDates: ['2026-10-07'] }
    const results: string[] = []
    let cursor = ms('2026-10-05T07:00:00Z')
    for (let index = 0; index < 10; index++) {
      const next = nextOccurrence(schedule, cursor)
      if (!next) break
      results.push(next.localDate); cursor = next.at
    }
    expect(results).toEqual(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10'])
    expect(latestOccurrence(schedule, ms('2026-10-11T00:00:00Z'), ms('2026-10-05T07:00:00Z'))?.localDate).toBe('2026-10-10')
  })

  it('rejects invalid bounds and revalidates schedules at helper boundaries', () => {
    for (const bound of [NaN, Infinity, -Infinity, 0.1, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextOccurrence(daily, bound)).toThrow()
      expect(() => latestOccurrence(daily, ms('2026-10-05T08:00:00Z'), bound)).toThrow()
    }
    expect(() => nextOccurrence({ ...daily, startDate: '2026-02-30' }, 0)).toThrow()
    expect(() => latestOccurrence({ ...daily, frequency: 'weekly' }, ms('2026-10-05T08:00:00Z'), 0)).toThrow()
    const final = { ...daily, startDate: '9999-12-31' }
    expect(nextOccurrence(final, ms('9999-12-31T08:00:00Z'))).toBeNull()
  })
})
