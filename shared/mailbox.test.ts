import { expect, it } from 'vitest'
import { mailDraftReviewKey, type PrivateMailDraft, type MailboxSettings, mailboxRequestSchema, mailboxQuery, parseMailboxRequest, privateReplySchema } from './mailbox.js'
it('recognizes email checks without capturing unrelated household requests', () => {
  for (const v of ['Check my email', 'Scan my inbox', 'Review Gmail', 'What did I miss in my email?', 'Summarize my emails please']) expect(parseMailboxRequest(v)).toMatchObject({ kind: 'check', query: '', lookbackDays: 30 })
  for (const v of ['Check my calendar', 'Write an email to the school', 'Find a pickup for Maya', 'What did I miss?', 'Can you read my emails?', 'Can you read my entire inbox?']) expect(parseMailboxRequest(v)).toBeNull()
})
it('recognizes mailbox search and bounds search text', () => {
  expect(parseMailboxRequest('Search my email for field trips')).toMatchObject({ kind: 'search', query: 'field trips' })
  expect(parseMailboxRequest('Find emails about field trips')).toMatchObject({ kind: 'search', query: 'field trips' })
  expect(parseMailboxRequest('Find emails from school@example.test')).toMatchObject({ kind: 'search', query: 'from:(school@example.test)' })
  expect(parseMailboxRequest('Search my email for ' + 'a'.repeat(400))?.query).toHaveLength(300)
})
it('builds inbox-wide queries with an explicit time range and no sender restriction', () => {
  expect(mailboxQuery({ kind: 'check', query: '', lookbackDays: 30 }, 1000, 2000)).toBe('in:inbox after:1 before:3 -in:spam -in:trash -in:drafts')
  expect(mailboxQuery({ kind: 'search', query: 'field trip OR from:school@example.test', lookbackDays: 365 }, 1000, 2000)).toContain('(field trip OR from:school@example.test) after:1')
  expect(() => mailboxQuery({ kind: 'check', query: '', lookbackDays: 30 }, 3000, 2000)).toThrow()
  expect(() => mailboxQuery({ kind: 'check', query: '', lookbackDays: 30 }, NaN, 2000)).toThrow()
})
it('requires a useful search and rejects unsupported request or reply fields', () => {
  expect(mailboxRequestSchema.safeParse({ kind: 'search', query: '' }).success).toBe(false)
  expect(mailboxRequestSchema.safeParse({ kind: 'check', query: '', approved: true }).success).toBe(false)
  expect(mailboxRequestSchema.safeParse({ kind: 'check', lookbackDays: 3651 }).success).toBe(false)
  expect(privateReplySchema.safeParse({ to: 'school@example.test', subject: 'Hi\nBcc: victim@example.test', body: 'Test' }).success).toBe(false)
  expect(privateReplySchema.safeParse({ to: 'school@example.test', subject: 'Hi', body: 'Test', send: true }).success).toBe(false)
})
it('allows explicit historical ranges through the composer without a setup form', () => {
  expect(parseMailboxRequest('Check my inbox from the last 90 days')).toMatchObject({ kind: 'check', lookbackDays: 90 })
  expect(parseMailboxRequest('Could you read my entire inbox?')).toMatchObject({ kind: 'check', lookbackDays: 30 })
  expect(parseMailboxRequest('Search my email for field trips from the last year')).toMatchObject({ kind: 'search', query: 'field trips', lookbackDays: 365 })
  expect(parseMailboxRequest('Check my inbox over the past 2 weeks')).toMatchObject({ kind: 'check', lookbackDays: 14 })
  expect(parseMailboxRequest('Check my inbox from the last 9999 years')).toBeNull()
})
it('recognizes natural mailbox questions without stealing reply instructions or general messages', () => {
  expect(parseMailboxRequest('Any emails from school@example.test?')).toMatchObject({ kind: 'search', query: 'from:(school@example.test)' })
  expect(parseMailboxRequest('Did I get any emails about field trips?')).toMatchObject({ kind: 'search', query: 'field trips' })
  expect(parseMailboxRequest('Are there any new emails in my inbox?')).toMatchObject({ kind: 'check', lookbackDays: 30 })
  expect(parseMailboxRequest('Have I received any emails from the school over the past 2 weeks?')).toMatchObject({ kind: 'search', query: 'from:(the school)', lookbackDays: 14 })
  for (const value of ['Draft a reply to that email', 'Any messages from my assistant?', 'Did I get any tasks done?', 'What did that email say?']) {
    expect(parseMailboxRequest(value)).toBeNull()
  }
})

const reviewedDraft: PrivateMailDraft = { id: 'draft', messageId: 'message', connectionId: 'google', connectionVersion: 2, version: 4, status: 'saved', to: 'school@example.test', subject: 'Synthetic trip', body: 'We can attend.', accountEmail: 'parent@example.test', createdAt: 1 }
const reviewedSettings: MailboxSettings = { configured: true, modelConfigured: true, connection: { id: 'google', version: 2, status: 'active', email: 'parent@example.test', readAllowed: true, composeAllowed: true }, mailbox: { id: 'mailbox', version: 3, connectionVersion: 2, state: 'active', lookbackDays: 30 } }
it('invalidates checked write approval across account, grant, mailbox and exact draft changes', () => {
  const key = mailDraftReviewKey(reviewedDraft, reviewedSettings)
  expect(key).not.toBeNull()
  for (const change of [{ id: 'replacement' }, { version: 3 }, { email: 'another@example.test' }, { readAllowed: false }, { composeAllowed: false }, { status: 'revoked' }, { revocationPending: true }]) {
    expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, connection: { ...reviewedSettings.connection!, ...change } })).toBeNull()
  }
  for (const state of ['paused', 'blocked', 'removed'] as const) expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, mailbox: { ...reviewedSettings.mailbox!, state } })).toBeNull()
  expect(mailDraftReviewKey(reviewedDraft)).toBeNull()
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, connection: null })).toBeNull()
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, mailbox: null })).toBeNull()
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, mailbox: { ...reviewedSettings.mailbox!, connectionVersion: 1 } })).toBeNull()
  for (const change of [{ version: 5 }, { to: 'other@example.test' }, { subject: 'Edited' }, { body: 'Edited reply' }, { status: 'review' as const }]) expect(mailDraftReviewKey({ ...reviewedDraft, ...change }, reviewedSettings)).not.toBe(key)
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, mailbox: { ...reviewedSettings.mailbox!, version: 4 } })).not.toBe(key)
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, mailbox: { ...reviewedSettings.mailbox!, id: 'replacement' } })).not.toBe(key)
  expect(mailDraftReviewKey(reviewedDraft, { ...reviewedSettings, connection: { ...reviewedSettings.connection!, email: ' PARENT@EXAMPLE.TEST ' } })).toBe(key)
})
