import { describe, expect, it } from 'vitest'
import { headerAvatarMood, jobAvatarMood } from './avatar.js'
import type { Task } from './assistant.js'
import type { ActionStatus, EmailDraft, PickupDraft } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'

const base: Task = { preparing: false, cancelled: false, clarification: '', actions: [] }
const email: EmailDraft = { kind: 'email', childId: 'maya', to: 'teacher@example.test', subject: 'School reply', body: 'Maya will attend.', requirement: '', evidence: {} }
const pickup: PickupDraft = { kind: 'pickup', childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
const action = (status: ActionStatus, outcome?: string, payload: Task['actions'][number]['payload'] = event) => ({ status, payload, receipts: outcome ? [{ outcome }] : [] })
const mood = (...actions: Task['actions']) => jobAvatarMood({ ...base, actions })

describe('honest assistant expressions', () => {
  it('waits for scheduled, cancelled, queued, and caregiver work', () => {
    expect(jobAvatarMood({ ...base, scheduledFor: 1000 })).toBe('resting')
    expect(jobAvatarMood({ ...base, cancelled: true })).toBe('resting')
    for (const status of ['queued', 'waiting', 'cancelled'] as const) expect(mood(action(status))).toBe('resting')
    expect(mood(action('waiting', 'request_email_accepted', pickup))).toBe('resting')
  })
  it('only uses the pleased expression for the corresponding recorded result', () => {
    for (const receipt of ['calendar_read_back_verified', 'calendar_deletion_verified', 'apple_calendar_readback', 'apple_calendar_deleted']) expect(mood(action('succeeded', receipt))).toBe('done')
    for (const receipt of ['gmail_accepted', 'microsoft_accepted']) expect(mood(action('succeeded', receipt, email))).toBe('done')
    expect(mood(action('succeeded', 'caregiver_accepted_not_pickup_completed', pickup))).toBe('done')
    expect(mood(action('saved', 'saved_on_device'))).toBe('done')
    expect(mood(action('succeeded'))).toBe('review')
    expect(mood(action('saved'))).toBe('review')
    expect(mood(action('succeeded', 'gmail_accepted'))).toBe('review')
    expect(mood(action('succeeded', 'request_email_accepted', pickup))).toBe('review')
  })
  it('never celebrates copied drafts, uncertain results, or partial failures', () => {
    for (const payload of [email, pickup]) expect(mood(action('saved', 'saved_on_device', payload))).toBe('review')
    for (const status of ['failed', 'uncertain', 'review'] as const) expect(mood(action('succeeded', 'calendar_read_back_verified'), action(status, undefined, email))).toBe('review')
    expect(mood(action('succeeded', 'calendar_read_back_verified'), action('queued', undefined, email))).toBe('resting')
    expect(mood(action('succeeded', 'calendar_read_back_verified'), action('cancelled', undefined, email))).toBe('done')
    expect(jobAvatarMood(base)).toBe('review')
  })
  it('shows preparation and review without pretending a conversation is a completed action', () => {
    expect(jobAvatarMood({ ...base, preparing: true })).toBe('working')
    expect(mood({ ...action('review'), revisionRequest: { instruction: 'Shorter' } })).toBe('working')
    expect(mood(action('executing'))).toBe('working')
    expect(jobAvatarMood({ ...base, conversation: true })).toBe('idle')
  })
  it('responds to composition and pending work without replaying old celebrations in the header', () => {
    const done = { ...base, actions: [action('succeeded', 'calendar_read_back_verified')] }
    expect(headerAvatarMood([done], false, false)).toBe('idle')
    expect(headerAvatarMood([base], false, false)).toBe('review')
    expect(headerAvatarMood([base], true, false)).toBe('listening')
    expect(headerAvatarMood([base], true, true)).toBe('working')
    expect(headerAvatarMood([{ ...base, scheduledFor: 1000 }], false, false)).toBe('resting')
    expect(headerAvatarMood([{ ...base, conversation: true }], false, false)).toBe('idle')
  })
})
