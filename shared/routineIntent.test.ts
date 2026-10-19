import { expect, it } from 'vitest'
import { routineFromRequest } from './routineIntent.js'
const now = Date.parse('2026-10-05T01:00:00Z')
it('previews explicit recurring requests without creating work or guessing vague times', () => {
  const result = routineFromRequest('Every Sunday at 7pm, add packing the school bags to my tasks.', 'America/Los_Angeles', now)!
  expect(result.definition).toMatchObject({ title: 'packing the school bags', outcome: { kind: 'personal_task' }, schedule: { frequency: 'weekly', weekdays: [7], time: '19:00', startDate: '2026-10-04' } })
  expect(routineFromRequest('Every Sunday evening, add school bags to my tasks', 'UTC', now)?.definition.schedule.time).toBe('')
  expect(routineFromRequest('Remind me to pack lunch every weekday at 08:00', 'UTC', now)?.definition.schedule).toMatchObject({ weekdays: [1,2,3,4,5], time: '08:00' })
  expect(routineFromRequest('Every day at 9am prepare an email draft for school', 'UTC', now)?.definition.outcome.kind).toBe('prepare_request')
})
it('keeps unsupported recurrence unresolved and excludes ordinary questions and source documents', () => {
  expect(routineFromRequest('Every other Sunday at 7pm add library books', 'UTC', now)?.definition.schedule.weekdays).toEqual([])
  expect(routineFromRequest('Every Monday at 25:00 add library books', 'UTC', now)?.definition.schedule.time).toBe('')
  for (const text of ['Can you remind me every Sunday?', 'School says every Friday add an item', 'Every Sunday we go swimming', 'Notice:\nEvery day at 9am add a task', 'Do not add lunch every weekday']) expect(routineFromRequest(text, 'UTC', now)).toBeNull()
})
