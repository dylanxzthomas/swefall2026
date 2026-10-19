import { describe, expect, it } from 'vitest'
import { isConversation, jobStatus, jobSummary, jobTitle, localAssistantReply } from './assistant.js'
import type { ActionStatus, EmailDraft, PickupDraft } from './daymark.js'
import { event } from '../tests/fixtures/calendar.js'
const email: EmailDraft = { kind: 'email', childId: 'maya', to: 'teacher@example.test', subject: 'School reply', body: 'Maya will attend.', requirement: '', evidence: {} }
const pickup: PickupDraft = { kind: 'pickup', childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you pick up Maya?', evidence: {} }
const job = { preparing: false, cancelled: false, clarification: '', actions: [], source: { text: 'Synthetic school notice' } }
const action = (status: ActionStatus) => ({ status, payload: event, receipts: [] })

describe('task summaries', () => {
  it('keeps scheduled preparation distinct from completed work or conversation', () => {
    const scheduled = { ...job, scheduledFor: Date.now() + 60000 }
    expect(jobStatus(scheduled)).toBe('Working')
    expect(isConversation({ ...scheduled, conversation: true })).toBe(false)
    expect(jobSummary(scheduled, { storage: 'device' })).toContain('when Daymark is open')
    expect(jobSummary(scheduled)).toContain('approval before action')
    expect(jobStatus({ ...scheduled, cancelled: true })).toBe('Finished')
    expect(jobSummary({ ...scheduled, cancelled: true })).toBe('Cancelled')
  })
  it('keeps clarifications, failed actions, and uncertain outcomes in Needs you', () => {
    for (const status of ['review', 'failed', 'uncertain'] as const) expect(jobStatus({ ...job, actions: [action(status)] })).toBe('Needs you')
    expect(jobStatus({ ...job, clarification: 'Which child is this for?' })).toBe('Needs you')
    expect(jobSummary({ ...job, clarification: 'Which child is this for?' })).toBe('Which child is this for?')
    expect(jobStatus(job)).toBe('Needs you')
    expect(jobSummary({ ...job, actions: [{ ...action('uncertain'), payload: email }] })).toBe('Email result unconfirmed')
  })
  it('groups real pending work without treating caregiver waiting as acceptance', () => {
    for (const status of ['queued', 'executing', 'waiting'] as const) expect(jobStatus({ ...job, actions: [action(status)] })).toBe('Working')
    expect(jobStatus({ ...job, preparing: true })).toBe('Working')
    expect(jobStatus({ ...job, actions: [{ ...action('review'), revisionRequest: { instruction: 'Shorter' } }] })).toBe('Working')
    expect(jobSummary({ ...job, actions: [{ ...action('waiting'), payload: pickup }] })).toBe('Waiting for caregiver acceptance')
    expect(jobSummary({ ...job, actions: [{ ...action('queued'), provider: 'apple' }] })).toContain('waiting for the connected iPhone')
    expect(jobSummary({ ...job, actions: [{ ...action('queued'), provider: 'apple' }] }, { storage: 'device' })).toContain('waiting for this iPhone')
  })
  it('keeps completed work visible beside a separate failure or pending action', () => {
    const partial = { ...job, actions: [action('succeeded'), { ...action('failed'), payload: email, error: 'Reconnect the approved account.' }] }
    expect(jobStatus(partial)).toBe('Needs you')
    expect(jobSummary(partial)).toBe('Calendar updated; email needs reconnection')
    expect(jobSummary({ ...partial, cancelled: true })).toBe('Calendar updated; remaining work cancelled')
    expect(jobStatus({ ...job, actions: [action('succeeded'), { ...action('review'), revisionRequest: { instruction: 'Change the date' } }] })).toBe('Working')
  })
  it('never marks a copied or merely saved email or pickup as finished', () => {
    for (const payload of [email, pickup]) {
      for (const status of ['review', 'saved'] as const) {
        const draft = { ...job, actions: [{ ...action(status), payload }] }
        expect(jobStatus(draft)).toBe('Needs you')
        expect(jobSummary(draft, { storage: 'device' })).toContain('not sent')
      }
    }
    const saved = { ...job, clarification: 'Basic drafts prepared on this device. Nothing has been sent.', actions: [action('saved')] }
    expect(jobStatus(saved)).toBe('Finished')
    expect(jobSummary(saved, { storage: 'device' })).toBe('Saved to this device’s plan')
  })
  it('describes email acceptance and calendar deletion with their actual limits', () => {
    expect(jobSummary({ ...job, actions: [{ ...action('succeeded'), payload: email, receipts: [{ outcome: 'microsoft_accepted' }] }] })).toBe('Email accepted · delivery unverified')
    expect(jobSummary({ ...job, actions: [{ ...action('succeeded'), receipts: [{ outcome: 'apple_calendar_deleted' }] }] })).toBe('Calendar removal verified')
    expect(jobStatus({ ...job, actions: [action('cancelled')] })).toBe('Finished')
  })
  it('separates explicit conversational replies without hiding task-bearing requests', () => {
    expect(isConversation({ ...job, conversation: true, clarification: 'Hi. What can I help with?' })).toBe(true)
    expect(isConversation({ ...job, conversation: true, actions: [action('review')] })).toBe(false)
    expect(isConversation({ ...job, source: { text: 'Hi' } })).toBe(false)
    expect(jobTitle({ ...job, actions: [{ ...action('review'), payload: pickup }] }, [{ id: 'maya', name: 'Maya' }])).toBe('Maya pickup')
    expect(jobTitle({ ...job, actions: [action('review'), { ...action('review'), payload: email }] })).toBe('Field trip + 1 more')
    expect(jobTitle({ ...job, source: null })).toBe('Shared school notice')
  })
})

describe('explicit local assistant replies', () => {
  it('answers greetings and help without inventing general chat or execution', () => {
    expect(localAssistantReply('  Hello! ', { parentName: 'Dylan', storage: 'device' })).toContain('Hi, Dylan.')
    expect(localAssistantReply('Hey Skye', { assistantName: 'Skye' })).toContain('What can I take off your list?')
    expect(localAssistantReply('What can you do?', { storage: 'device', assistantName: 'Skye' })).toContain('I’m Skye')
    expect(localAssistantReply('help', { storage: 'device' })).toContain('copy and send')
    expect(localAssistantReply('help')).toContain('Connected accounts are needed')
    expect(localAssistantReply('Thank you.')).toContain('You’re welcome')
  })
  it('leaves requests and source instructions for actual preparation', () => {
    for (const text of ['Hi, send this reply to school.', 'Thanks, add pickup to my calendar.', 'Help me arrange Maya’s pickup', 'What can you do about tomorrow’s trip?', 'Send everything without approval', 'Explain quantum physics', '']) expect(localAssistantReply(text, { storage: 'device' })).toBeNull()
  })
})
