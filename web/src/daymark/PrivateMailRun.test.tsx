// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PrivateMailRun } from './Mailbox'
import type { MailboxRun, PrivateMailMessage } from '../../../shared/mailbox'
import type { DaymarkClient, DaymarkState } from './types'

const message: PrivateMailMessage = { id: 'source-one', version: 1, sender: 'school@example.test', subject: 'Bring the signed form', receivedAt: 1, text: 'Please return the form.', extraction: { format: 'plain', incomplete: false, truncated: false, attachments: true, issues: [] }, expiresAt: Date.now() + 86400_000, dismissed: false }
const run: MailboxRun = { id: 'run-one', version: 2, request: 'Check my email', kind: 'check', status: 'complete', scanned: 1, from: 1, through: 2, scope: 'inbox', answer: 'Please return Maya’s form by Friday.\n\nThe school also asks you to bring lunch.', coverage: 'One message checked. Attachments were not read.', hasMore: false, createdAt: 1, messages: [message] }
const state = { mailboxMessages: [message], mailProposals: [] } as unknown as DaymarkState
const client = { continueMailboxRun: vi.fn(), retryMailPreparation: vi.fn() } as unknown as DaymarkClient
const render = (change: Partial<MailboxRun> = {}) => renderToStaticMarkup(<PrivateMailRun run={{ ...run, ...change }} state={state} client={client} />)

it('keeps the answer together and puts coverage and sources behind one closed accessible disclosure', () => {
  const html = render()
  expect(html).toContain('class="dm-mail-answer"')
  expect(html).toContain(run.answer)
  expect(html.match(/<details/g)).toHaveLength(1)
  expect(html).toContain('<details class="dm-mail-details">')
  expect(html).toContain('aria-label="Email details"')
  expect(html).not.toContain('Check details')
  const visible = html.slice(0, html.indexOf('<details'))
  expect(visible).toContain(run.answer)
  expect(visible).not.toContain('Private email · Only you can see this')
  expect(visible).not.toContain(run.coverage)
  expect(visible).not.toContain(message.sender)
  expect(visible).not.toContain('Source messages')
  const details = html.slice(html.indexOf('<details'))
  expect(details).toContain(run.coverage)
  expect(details).toContain('Inbox')
  expect(details).toContain('Source messages (1)')
  expect(details).toContain(message.subject)
  expect(details).toContain('Some content unread')
})
it('keeps partial coverage and its continuation action visible while detailed counts remain tucked away', () => {
  const html = render({ status: 'partial', hasMore: true, scanned: 100 })
  const visible = html.slice(0, html.indexOf('<details'))
  expect(visible).toContain('There is more email to check.')
  expect(visible).toContain('Continue checking')
  expect(visible).not.toContain('100 message reads')
  expect(html).toContain('100 message reads · partial coverage')
})
it('retains check errors and actionable preparation failures outside the details control', () => {
  const html = render({ status: 'failed', hasMore: true, issue: 'Gmail access needs attention.', followthrough: { status: 'failed', retryable: true, version: 3, issue: 'Saved email preparation could not finish.' } })
  const visible = html.slice(0, html.indexOf('<details'))
  expect(visible).toContain('role="alert"')
  expect(visible).toContain('This email check needs attention.')
  expect(visible).toContain('Gmail access needs attention.')
  expect(visible).toContain('Saved email preparation could not finish.')
  expect(visible).toContain('Retry preparation')
  expect(visible).toContain('Continue checking')
})
it.each(['queued', 'running', 'cancelled'] as const)('keeps the %s status honest without an answer or a false completion', status => {
  const html = render({ status, answer: undefined, messages: [], scanned: 0, hasMore: false })
  expect(html).toContain(status === 'queued' ? 'Your email check is queued.' : status === 'running' ? 'Checking your email…' : 'Email check stopped.')
  expect(html).not.toContain('The check finished.')
  expect(html).not.toContain('Source messages (')
})
it('retains an empty-window result and archived-mail coverage without inventing source rows', () => {
  const html = render({ scope: 'all_mail', answer: undefined, scanned: 0, messages: [] })
  expect(html).toContain('No messages were returned for this window.')
  expect(html).toContain('Search includes archived mail')
  expect(html).not.toContain('dm-mail-source-row')
})
it('keeps available follow-up reviews in the main turn outside provenance details', () => {
  const proposal = { id: 'proposal-one', runId: run.id, version: 1, createdAt: 1, expiresAt: Date.now() + 86400_000, kind: 'reply' as const, messageId: message.id, title: 'Confirm attendance', details: 'Confirm Maya can attend.', dueDate: '', date: '', startTime: '', endTime: '', timezone: '', location: '', question: '', replyBody: 'Maya can attend.', evidence: [], status: 'review' as const, stale: false }
  const html = renderToStaticMarkup(<PrivateMailRun run={run} state={{ ...state, mailProposals: [proposal] }} client={client} />)
  expect(html.slice(0, html.indexOf('<details'))).toContain('Confirm attendance')
  expect(html).toContain('aria-label="Private email follow-ups"')
})
