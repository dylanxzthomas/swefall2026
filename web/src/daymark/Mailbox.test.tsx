// @vitest-environment node
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GmailConnection, MailDraft } from './Mailbox'
import type { PrivateMailDraft } from '../../../shared/mailbox'
import type { DaymarkClient, DaymarkState } from './types'

const client = { connectEmailWatch: async () => {} } as DaymarkClient
function render(status: string, revocationPending = false) {
  const state = { mailboxSettings: { configured: true, modelConfigured: false, mailbox: null, connection: { id: 'synthetic', version: 2, email: 'synthetic@example.test', status, revocationPending, readAllowed: false, composeAllowed: false } } } as DaymarkState
  return renderToStaticMarkup(<GmailConnection state={state} client={client} />)
}
it('explains unconfirmed provider revocation without claiming Google access was removed', () => {
  const html = render('revocation_unconfirmed')
  expect(html).toContain('role="alert"')
  expect(html).toContain('Google’s revocation could not be confirmed')
  expect(html).toContain('https://myaccount.google.com/connections')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).not.toContain('Enable email help')
})
it('prevents reconnecting while provider disconnection is still finishing', () => {
  const html = render('revoked', true)
  expect(html).toContain('role="status"')
  expect(html).toContain('Finishing disconnection with Google')
  expect(html).toMatch(/<button disabled="">Connect<\/button>/)
  expect(html).not.toContain('Google’s revocation could not be confirmed')
})
it('shows the remaining private consent after Google connects, without enabling it or requiring a model', () => {
  const enableMailbox = () => { throw new Error('Rendering must never grant consent or start a scan.') }
  const state = { mailboxSettings: { configured: true, modelConfigured: false, mailbox: null, connection: { id: 'synthetic', version: 2, email: 'synthetic@example.test', status: 'active', readAllowed: true, composeAllowed: false } } } as DaymarkState
  const html = renderToStaticMarkup(<GmailConnection state={state} client={{ ...client, enableMailbox } as DaymarkClient} />)
  expect(html).toContain('Finish setup')
  expect(html).toContain('Only I can see it unless I choose to share')
  expect(html).toContain('You can still read retrieved messages')
  expect(html).toMatch(/<button class="dm-primary" disabled="">Enable email help<\/button>/)
  expect(html).not.toContain('checked=""')
})

const draft: PrivateMailDraft = { id: 'synthetic-draft', messageId: 'synthetic-message', connectionId: 'synthetic-google', connectionVersion: 2, version: 4, status: 'saved', to: 'school@example.test', subject: 'Re: Picnic', body: 'We can bring plates.', accountEmail: 'parent@example.test', gmailDraftId: 'synthetic-provider-draft', createdAt: 1 }
const mailState = { mailboxSettings: { connection: { id: 'synthetic-google', version: 2, status: 'active', email: 'parent@example.test', readAllowed: true, composeAllowed: true }, mailbox: { id: 'synthetic-mailbox', version: 1, connectionVersion: 2, state: 'active' } } } as DaymarkState
const mailClient = { ...client, editMailDraft: async () => 5, approveMailDraft: async () => 5, approveMailSend: async () => { throw new Error('Rendering must never send.') }, reconcileMailSend: async () => 5 } satisfies DaymarkClient
it('allows reviewing an existing Gmail draft and shows a distinct, initially disabled send approval', () => {
  const html = renderToStaticMarkup(<MailDraft draft={draft} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(html).toContain('Approve &amp; update Gmail draft')
  expect(html).toContain('Send this exact reply to school@example.test from parent@example.test')
  expect(html).toContain('This is separate from saving a draft')
  expect(html).toMatch(/<button class="dm-primary" disabled="">Approve &amp; send email<\/button>/)
  expect(html).not.toContain('checked=""')
  expect(html).toContain('Open Gmail Drafts')
})
it('offers optional compose setup from the connected Gmail settings without granting access or sending', () => {
  const state = { mailboxSettings: { connection: { id: 'synthetic', version: 2, readAllowed: true, composeAllowed: false }, mailbox: { id: 'synthetic-mailbox', version: 1, connectionVersion: 2, state: 'active' } } } as DaymarkState
  const html = renderToStaticMarkup(<GmailConnection state={state} client={{ ...client, connectMailDrafts: async () => { throw new Error('Rendering must not expand Google access.') } } as DaymarkClient} />)
  expect(html).toContain('Allow Gmail drafts and sending')
  expect(html).toContain('saving a draft never approves sending it')
  expect(html).not.toContain('Approve &amp; send email')
  const stale = renderToStaticMarkup(<GmailConnection state={{ ...state, mailboxSettings: { ...state.mailboxSettings!, connection: { ...state.mailboxSettings!.connection!, version: 3 } } }} client={client} />)
  expect(stale).toContain('Review access')
  expect(stale).not.toContain('Allow Gmail drafts and sending')
})
it('labels sent-copy verification as provider evidence rather than confirmed delivery', () => {
  const html = renderToStaticMarkup(<MailDraft draft={{ ...draft, status: 'sent', sentMessageId: 'synthetic-sent', sendVerifiedAt: 2 }} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(html).toContain('Sent copy verified')
  expect(html).toContain('Recipient delivery is unconfirmed')
  expect(html).not.toContain('Nothing has been sent')
  expect(html).not.toContain('Approve &amp; send email')
  expect(html).toContain('Open Gmail Sent Mail')
})
it('offers only read-only reconciliation for an ambiguous send', () => {
  const html = renderToStaticMarkup(<MailDraft draft={{ ...draft, status: 'send_uncertain' }} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(html).toContain('Check send result')
  expect(html).toContain('Send result unconfirmed')
  expect(html).not.toContain('Nothing has been sent')
  expect(html).not.toContain('Approve &amp; send email')
  expect(html).not.toContain('Review send again')
})

it('blocks write review after grant loss, reconnection or mailbox pause while preserving private edits', () => {
  for (const settings of [
    { ...mailState.mailboxSettings!, connection: null },
    { ...mailState.mailboxSettings!, connection: { ...mailState.mailboxSettings!.connection!, composeAllowed: false } },
    { ...mailState.mailboxSettings!, connection: { ...mailState.mailboxSettings!.connection!, version: 3 } },
    { ...mailState.mailboxSettings!, mailbox: { ...mailState.mailboxSettings!.mailbox!, state: 'paused' as const } },
  ]) {
    const html = renderToStaticMarkup(<MailDraft draft={draft} state={{ ...mailState, mailboxSettings: settings }} client={mailClient} sourceChanged={false} />)
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/>Send this exact reply/)
    expect(html).toMatch(/<button class="dm-primary" disabled="">Approve &amp; send email<\/button>/)
    expect(html).toContain('Save private edits')
    expect(html).toContain('We can bring plates.')
  }
})


it('distinguishes intended reply routing from verified sent conversation evidence', () => {
  const saved = renderToStaticMarkup(<MailDraft draft={{ ...draft, replyInThread: true }} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(saved).toContain('This reply is addressed to the original Gmail conversation.')
  expect(saved).not.toContain('Verified in the original Gmail conversation.')
  const sent = renderToStaticMarkup(<MailDraft draft={{ ...draft, status: 'sent', replyInThread: true }} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(sent).toContain('Verified in the original Gmail conversation.')
  const legacy = renderToStaticMarkup(<MailDraft draft={draft} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(legacy).not.toContain('original Gmail conversation')
})


it('keeps a known Gmail draft reachable after an undispatched edit conflict without claiming verification', () => {
  const html = renderToStaticMarkup(<MailDraft draft={{ ...draft, status: 'failed', issue: 'The Gmail draft changed after Sola verified it. Nothing was overwritten or sent.' }} state={mailState} client={mailClient} sourceChanged={false} />)
  expect(html).toContain('Open Gmail Drafts')
  expect(html).toContain('Nothing was overwritten or sent')
  expect(html).not.toContain('Sent copy verified')
  expect(html).not.toContain('Approve &amp; send email')
})
