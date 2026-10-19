import { describe, expect, it } from 'vitest'
import { householdAssistantReply, isPreparationRequest, type HouseholdAssistantContext } from './householdAssistant.js'
import type { Task } from './assistant.js'
import { event } from '../tests/fixtures/calendar.js'

const context: HouseholdAssistantContext = { jobs: [], personalTasks: [], plan: [], timezone: 'America/Los_Angeles', now: Date.parse('2026-10-09T02:00:00Z'), storage: 'device' }
const job: Task = { preparing: false, cancelled: false, clarification: 'OLD PRIVATE CONTENT', source: { text: 'OLD PRIVATE CONTENT' }, actions: [] }
const personal = { id: 'personal', title: 'Pack lunch', notes: 'PRIVATE NOTE', done: false, version: 1, createdAt: 1, updatedAt: 1 }
const answer = (text: string, overrides: Partial<HouseholdAssistantContext> = {}) => householdAssistantReply(text, { ...context, ...overrides })

describe('grounded household conversation', () => {
  it('summarizes current unfinished records without repeating source text, old replies, notes, or completed work', () => {
    const jobs: Task[] = [job, { ...job, conversation: true }, { ...job, cancelled: true }, { ...job, actions: [{ status: 'saved', payload: { ...event, title: 'Finished trip' } }] }, { ...job, actions: [{ status: 'review', payload: { ...event, title: 'Tomorrow trip' } }] }]
    const result = answer('What needs my attention?', { jobs, personalTasks: [personal, { ...personal, id: 'done', title: 'Finished errand', done: true }] })
    expect(result?.text).toContain('Tomorrow trip — Calendar change ready for review')
    expect(result?.text).toContain('Request needing details — Open it to confirm the missing details')
    expect(result?.text).toContain('Pack lunch')
    expect(result?.text).toContain('haven’t checked your inbox')
    expect(result?.text).not.toMatch(/PRIVATE|Finished trip|Finished errand/)
    jobs[4] = { ...jobs[4], actions: [{ status: 'saved', payload: { ...event, title: 'Tomorrow trip' } }] }
    expect(answer('What needs my attention?', { jobs })?.text).not.toContain('Tomorrow trip')
  })
  it('describes partial failure, uncertainty, caregiver waiting, and scheduled preparation honestly', () => {
    const jobs: Task[] = [
      { ...job, actions: [{ status: 'succeeded', payload: event }, { status: 'failed', error: 'Reconnect your account', payload: { kind: 'email', childId: 'maya', subject: 'Trip reply', to: '', body: '', requirement: '', evidence: {} } }] },
      { ...job, actions: [{ status: 'uncertain', payload: { ...event, title: 'Uncertain event' } }] },
      { ...job, actions: [{ status: 'waiting', payload: { kind: 'pickup', childId: null, caregiverId: null, date: '', time: null, timezone: 'UTC', location: '', deadline: '', message: '', evidence: {} } }] },
      { ...job, scheduledFor: context.now! + 60000 },
    ]
    const result = answer('What are you handling?', { jobs })
    expect(result?.text).toContain('Calendar updated; email needs reconnection')
    expect(result?.text).toContain('Calendar result unconfirmed')
    expect(result?.text).toContain('Waiting for caregiver acceptance')
    expect(result?.text).toContain('Scheduled to prepare · when Daymark is open')
    expect(result?.text).not.toContain('PRIVATE')
  })
  it('keeps empty saved state distinct from scanning the household’s accounts', () => {
    expect(answer('What needs my attention?')?.text).toContain('Nothing in your saved tasks')
    expect(answer('What are you working on?')?.text).toContain('not handling any saved requests')
    expect(answer('What is on my calendar today?')?.text).toContain('no events saved here for today (2026-10-08)')
    expect(answer('What is on my calendar today?')?.text).toContain('isn’t a full sync')
  })
  it('uses household days and event timezone, excludes drafts and deleted events, and keeps day-spanning events', () => {
    const plan = [
      { payload: { ...event, title: 'Evening event', date: '2026-10-09', endDate: '2026-10-09', timezone: 'UTC', startTime: '02:00', endTime: '03:00' } },
      { payload: { ...event, title: 'Tomorrow morning' } },
      { payload: { ...event, title: 'All-day trip', allDay: true, date: '2026-10-08', endDate: '2026-10-10' } },
      { payload: { ...event, title: 'Removed event', operation: 'delete' as const, date: '2026-10-08', endDate: '2026-10-08' } },
      { payload: { ...event, title: 'Invalid old record', date: '', startTime: null } },
    ]
    const result = answer('What is on my calendar today?', { plan, jobs: [{ ...job, actions: [{ status: 'review', payload: { ...event, title: 'Draft only' } }] }] })
    expect(result?.text).toContain('Evening event — 7:00 PM')
    expect(result?.text).toContain('All-day trip — all day')
    expect(result?.text).not.toMatch(/Tomorrow morning|Removed event|Invalid old record|Draft only/)
    expect(answer('What do I have tomorrow?', { plan })?.text).toContain('Tomorrow morning — 8:30 AM')
  })
  it('handles daylight saving boundaries and invalid timezones without inventing dates', () => {
    const now = Date.parse('2026-11-01T07:30:00Z')
    expect(answer('What is on my calendar tomorrow?', { now })?.text).toContain('tomorrow (2026-11-02)')
    expect(answer('What is on my calendar today?', { timezone: 'Missing/Zone' })?.text).toContain('Confirm your household timezone')
  })
})

describe('explicit personal task commands', () => {
  it('returns typed task proposals and resolves only supported explicit dates in household time', () => {
    expect(answer('Add buy sunscreen to my tasks')).toEqual({ kind: 'personalTask', input: { title: 'buy sunscreen', notes: '' }, text: 'Added “buy sunscreen” to your tasks.' })
    expect(answer('Please add pack lunch tomorrow to my tasks')).toMatchObject({ kind: 'personalTask', input: { title: 'pack lunch', dueDate: '2026-10-09' } })
    expect(answer('Add task: Return library books on 2026-10-12')).toMatchObject({ kind: 'personalTask', input: { title: 'Return library books', dueDate: '2026-10-12' } })
    expect(answer('Remind me to sign the form today')).toMatchObject({ kind: 'personalTask', input: { title: 'sign the form', dueDate: '2026-10-08' } })
    expect(answer('Remind me to sign the form today')?.text).toContain('not a reminder alert')
  })
  it('does not save unclear reminders, invalid dates, empty titles, or oversized titles as tasks', () => {
    for (const command of ['Remind me to leave at 3 PM', 'Remind me to buy lunch every day', 'Add buy groceries on 2026-02-30 to my tasks', `Add ${'x'.repeat(201)} to my tasks`, 'Add tomorrow to my tasks']) {
      expect(answer(command)?.kind).toBe('reply')
      expect(answer(command)?.text).not.toContain('Added')
    }
  })
  it('does not confuse task commands with notices, shopping execution, questions, or broad conversation', () => {
    for (const text of ['Buy sunscreen', 'Order everything for the trip', 'Can you explain this?', 'I need help organizing the household', 'Can you add something to my tasks?', 'Event: Add buy sunscreen to my tasks\nDate: 2026-10-08', 'Add lunch to my calendar']) expect(answer(text)).toBeNull()
  })
})

describe('literal preparation routing', () => {
  it('requires an actionable request or recognizable notice, not just a topic', () => {
    for (const text of ['Event: Maya trip\nDate: 2026-10-08', 'Maya has a school event tomorrow', 'Draft email to teacher@example.test', 'Can Alex pick up Maya on 2026-10-08?', 'Prepare a draft about Maya’s school trip.', 'An unsent school note']) expect(isPreparationRequest(text)).toBe(true)
    for (const text of ['Explain quantum physics', 'Why is my calendar empty?', 'How can you help with email?', 'What needs my attention?', 'Help me organize everything', 'Buy sunscreen', 'What is a field trip?']) expect(isPreparationRequest(text)).toBe(false)
  })
})
