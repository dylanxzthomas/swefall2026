import { MailAttachments } from './MailAttachments'
import { PrivateMailFollowups } from './MailFollowthrough'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EnvelopeSimple, Info, LockSimple } from '@phosphor-icons/react'
import { mailDraftReviewKey, privateReplySchema, type MailboxRun, type PrivateMailMessage, type PrivateMailDraft, type PrivateReplyInput } from '../../../shared/mailbox'
import type { DaymarkState, DaymarkClient } from './types'
import './mailbox.css'
import './privateMailRun.css'
import { connectorErrorMessage } from '../../../shared/connectorErrors'
import type { PrivateMailProposal } from '../../../shared/mailFollowthrough'

type Workspace = { state: DaymarkState; client: DaymarkClient }
const date = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const day = (value: number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
function useOperation() {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  async function run(fn: () => Promise<unknown>, success = '') {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn(); setNotice(success); return true } catch (e) { setError(connectorErrorMessage(e)); return false }
    finally { pending.current = false; setBusy(false) }
  }
  return { busy, error, notice, run, setError }
}
function Result({ error, notice }: { error: string; notice: string }) { return <>{error && <p role="alert" className="dm-error">{error}</p>}{notice && <p role="status" className="dm-muted">{notice}</p>}</> }

export function GmailConnection({ state, client }: Workspace) {
  const operation = useOperation(), settings = state.mailboxSettings, connection = settings?.connection, mailbox = settings?.mailbox
  const [consent, setConsent] = useState(false), [disconnecting, setDisconnecting] = useState(false)
  const connectionKey = `${connection?.id ?? ''}:${connection?.version ?? ''}`
  const [consentedConnection, setConsentedConnection] = useState('')
  const connected = !!connection?.readAllowed, enabled = mailbox && mailbox.state !== 'removed'
  const needsReview = connected && mailbox?.connectionVersion !== undefined && mailbox.connectionVersion !== connection.version
  const canConnect = !connection?.revocationPending && (state.storage === 'device' ? state.accountAvailable : settings?.configured && !!client.connectEmailWatch)
  const connect = () => operation.run(() => state.storage === 'device' ? client.signIn() : client.connectEmailWatch!())
  return <section className="dm-gmail-connection" aria-label="Gmail connection">
    <div className="dm-gmail-row"><EnvelopeSimple size={22} aria-hidden="true" /><div><h3>Gmail</h3><p className="dm-muted">{connected ? connection.email ?? 'Connected account' : 'Email help, just for you'}{needsReview ? ' · Review access' : connected && !enabled ? ' · Finish setup' : connected && mailbox?.state === 'paused' ? ' · Paused' : connected && mailbox?.state === 'blocked' ? ' · Needs attention' : ''}</p></div><button disabled={operation.busy || !connected && !canConnect} onClick={() => connected ? setDisconnecting(!disconnecting) : void connect()}>{connected ? 'Disconnect' : 'Connect'}</button></div>
    {connection?.revocationPending ? <p className="dm-muted" role="status">Sola’s access is stopped. Finishing disconnection with Google…</p> : connection?.status === 'revocation_unconfirmed' ? <p className="dm-mail-issue" role="alert">Sola’s access is stopped and its saved credentials were removed. Google’s revocation could not be confirmed. <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Remove Sola from your Google account’s connections</a> before reconnecting.</p> : !connected && !canConnect && <p className="dm-muted">Gmail connection setup is not available yet.</p>}
    {connected && (!enabled || needsReview) && <div className="dm-gmail-consent">
      {needsReview && <p>Gmail access changed. Confirm it below to refresh the source messages before preparing more work.</p>}
      <label className="dm-check"><input type="checkbox" checked={consent && consentedConnection === connectionKey} disabled={operation.busy} onChange={e => { setConsent(e.target.checked); setConsentedConnection(connectionKey) }} />Let Sola read my inbox and use AI to prepare private answers. Email text stays for up to 30 days. Only I can see it unless I choose to share.</label>
      <p className="dm-muted">Starts with the last 30 days, across all senders. Attachments and linked pages are not read.</p>
      <button className="dm-primary" disabled={operation.busy || !consent || consentedConnection !== connectionKey || !client.enableMailbox} onClick={() => void operation.run(() => client.enableMailbox!(connection!.id, connection!.version, 30), 'Email help enabled. Its first check is queued; results will appear in your conversation.')}>Enable email help</button>
      {!settings?.modelConfigured && <p className="dm-muted">Private summaries are not available yet. You can still read retrieved messages.</p>}
    </div>}
    {enabled && connected && !needsReview && <details className="dm-gmail-more"><summary>More</summary>
      <p className="dm-muted">{mailbox.lastCheckedAt ? `Last completed inbox check: ${date(mailbox.lastCheckedAt)}.` : 'No inbox check has completed yet.'}</p>
      {mailbox.issue && <p>{mailbox.issue}</p>}
      <p className="dm-muted">{connection.composeAllowed ? 'Gmail drafts and sending are enabled. Every save, update and send still needs your approval.' : 'Reading is connected. Drafts and sending need additional Google permission; saving a draft never approves sending it.'}</p>
      {!connection.composeAllowed && <button disabled={operation.busy || !client.connectMailDrafts} onClick={() => void operation.run(() => client.connectMailDrafts!())}>Allow Gmail drafts and sending</button>}
      <div className="dm-actions"><button disabled={operation.busy || !client.setMailboxPaused} onClick={() => void operation.run(() => client.setMailboxPaused!(mailbox.id, mailbox.version, mailbox.state === 'active'), mailbox.state === 'active' ? 'Email help paused.' : 'Email help resumed. New results will appear in your conversation.')}>{mailbox.state === 'active' ? 'Pause email help' : 'Resume email help'}</button><button disabled={operation.busy || !client.removeMailbox} onClick={() => void operation.run(() => client.removeMailbox!(mailbox.id, mailbox.version), 'Private email help removed. Previously shared household work remains.')}>Remove private email history</button></div>
    </details>}
    {disconnecting && connected && <div className="dm-gmail-disconnect"><p>Disconnect {connection.email ?? 'this Google account'}? Its Gmail help, email sending and Google calendar connection will stop. Saved events and sent messages stay in Google.</p><div className="dm-actions"><button disabled={operation.busy} onClick={() => void operation.run(async () => { await client.disconnect(connection.id); setDisconnecting(false) }, 'Sola’s Google access is stopped. Provider revocation is being checked.')}>Disconnect Google account</button><button disabled={operation.busy} onClick={() => setDisconnecting(false)}>Keep connected</button></div></div>}
    <Result {...operation} />
  </section>
}

function MailSheet({ title, close, children, busy = false }: { title: string; close(): void; children: ReactNode; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className="dm-sheet dm-mail-sheet" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) close() }}><header><h2>{title}</h2><button disabled={busy} onClick={close}>Done</button></header>{children}</dialog>
}
export function visiblePrivateMailDrafts(drafts: PrivateMailDraft[], filter: 'all' | 'you' | 'assistant' | 'finished' = 'all', search = '') {
  const needle = search.trim().toLocaleLowerCase()
  return drafts.filter(d => (filter === 'finished' ? d.status === 'sent' : filter === 'you' ? ['review', 'saved', 'failed', 'send_failed', 'uncertain', 'send_uncertain'].includes(d.status) : filter === 'assistant' ? d.status !== 'sent' : true) && (!needle || `${d.subject} ${d.to} ${d.body}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(a.status === 'sent') - Number(b.status === 'sent') || b.createdAt - a.createdAt)
}
export const privateReplyStatus: Record<PrivateMailDraft['status'], string> = {
  preparing: 'Sola is preparing', review: 'Ready for your review', saving: 'Saving approved draft', saved: 'Saved in Gmail · not sent', uncertain: 'Check draft result', failed: 'Needs your attention', sending: 'Sending approved reply', sent: 'Sent copy verified', send_uncertain: 'Check send result', send_failed: 'Review before sending',
}
export function PrivateMailDrafts({ state, client, filter = 'all', search = '', openDraft }: Workspace & { filter?: 'all' | 'you' | 'assistant' | 'finished'; search?: string; openDraft?(id: string): void }) {
  const [selected, setSelected] = useState<string | null>(null)
  const drafts = visiblePrivateMailDrafts(state.mailDrafts ?? [], filter, search), draft = state.mailDrafts?.find(d => d.id === selected)
  if (!drafts.length && !draft) return null
  return <section aria-label="Private email replies"><h3>Email replies</h3>{drafts.map(d => <button className="dm-mail-source-row" key={d.id} aria-label={`Open email reply: ${d.subject}`} onClick={() => openDraft ? openDraft(d.id) : setSelected(d.id)}><strong>{d.subject}</strong><span>{privateReplyStatus[d.status]} · Private</span><span>To {d.to}</span></button>)}{draft && <PrivateMailReplyReview draft={draft} state={state} client={client} close={() => setSelected(null)} />}</section>
}
export function PrivateMailReplyReview({ draft, state, client, close }: Workspace & { draft: PrivateMailDraft; close(): void }) {
  const source = state.mailboxMessages?.find(m => m.id === draft.messageId) ?? state.mailboxRuns?.flatMap(r => r.messages).find(m => m.id === draft.messageId)
  const sourceChanged = !source || source.dismissed || source.expiresAt <= Date.now() || draft.sourceVersion !== undefined && source.version !== draft.sourceVersion
  return <MailSheet title="Private email reply" close={close}><p className="dm-mail-private"><LockSimple size={14} aria-hidden="true" />Only you can see this</p>{sourceChanged && !['sent', 'preparing'].includes(draft.status) && <p className="dm-muted">The source email changed or is no longer available here. You can still check an earlier Gmail result; a new save or send needs a fresh source review.</p>}<MailDraft key={draft.id} draft={draft} state={state} client={client} sourceChanged={sourceChanged} /></MailSheet>
}
export function MailDraft({ draft, state, client, sourceChanged }: Workspace & { draft: PrivateMailDraft; sourceChanged: boolean }) {
  const operation = useOperation()
  const [version, setVersion] = useState(draft.version), [input, setInput] = useState<PrivateReplyInput>({ to: draft.to, subject: draft.subject, body: draft.body }), [approvedKey, setApprovedKey] = useState<string | null>(null), [sendApprovedKey, setSendApprovedKey] = useState<string | null>(null)
  const dirty = input.to !== draft.to || input.subject !== draft.subject || input.body !== draft.body
  const stale = version !== draft.version || sourceChanged, editable = ['review', 'saved', 'failed'].includes(draft.status), connected = state.mailboxSettings?.connection
  const reviewKey = sourceChanged ? null : mailDraftReviewKey(draft, state.mailboxSettings)
  const approved = reviewKey !== null && approvedKey === reviewKey, sendApproved = reviewKey !== null && sendApprovedKey === reviewKey
  useEffect(() => {
    setApprovedKey(null); setSendApprovedKey(null)
    // Adopt our verified save completion, preserving any newer unsaved edits.
    if (draft.status === 'saved' && !dirty && version + 1 === draft.version) setVersion(draft.version)
  }, [draft.version, draft.status, dirty, version, reviewKey])
  const update = (changes: Partial<PrivateReplyInput>) => { setInput({ ...input, ...changes }); setApprovedKey(null); setSendApprovedKey(null) }
  async function save(toGmail: boolean) {
    if (operation.busy || stale || !editable || toGmail && (!approved || !reviewKey)) return
    const parsed = privateReplySchema.safeParse(input)
    if (!parsed.success) { operation.setError('Check the recipient, subject and message before saving.'); return }
    if (toGmail && !client.approveMailDraft || !toGmail && !client.editMailDraft) { operation.setError('Draft saving is unavailable.'); return }
    await operation.run(async () => {
      const nextVersion = await (toGmail ? client.approveMailDraft!(draft.id, version, parsed.data) : client.editMailDraft!(draft.id, version, parsed.data))
      setVersion(nextVersion); setApprovedKey(null)
    }, toGmail ? 'Draft save approved. Check the status below; nothing is sent.' : 'Private edits saved.')
  }
  return <section className="dm-mail-draft" aria-label="Private Gmail draft">
    <h3>{draft.status === 'preparing' ? 'Preparing a reply' : draft.status === 'saved' ? 'Saved in Gmail Drafts' : draft.status === 'saving' ? 'Saving to Gmail Drafts' : draft.status === 'uncertain' ? 'Draft save unconfirmed' : draft.status === 'sending' ? 'Sending your approved reply' : draft.status === 'sent' ? 'Sent copy verified' : draft.status === 'send_uncertain' ? 'Send result unconfirmed' : ['failed', 'send_failed'].includes(draft.status) ? 'Reply needs attention' : draft.gmailDraftId ? 'Review draft changes' : 'Review your reply'}</h3>
    <p className="dm-muted">{draft.accountEmail ? `${draft.accountEmail} · ` : ''}{draft.status === 'review' ? draft.gmailDraftId ? 'Changes not yet saved in Gmail' : 'Private draft · not saved in Gmail' : draft.status === 'saved' ? 'Saved as a draft · not sent' : draft.status === 'sent' ? 'Gmail accepted it and the sent copy matches your approval. Recipient delivery is unconfirmed.' : draft.status === 'sending' ? 'Approved · waiting for a verified result' : draft.status === 'send_uncertain' ? 'Check the result before trying any other send.' : 'Nothing has been sent.'}</p>
    {draft.replyInThread && <p className="dm-muted">{draft.status === 'sent' ? 'Verified in the original Gmail conversation.' : 'This reply is addressed to the original Gmail conversation.'}</p>}
    {draft.accountEmail && (['saved', 'sent'].includes(draft.status) || draft.status === 'failed' && draft.gmailDraftId) && <p><a href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(draft.accountEmail)}#${draft.status === 'sent' ? 'sent' : 'drafts'}`} target="_blank" rel="noopener noreferrer">{draft.status === 'sent' ? 'Open Gmail Sent Mail' : 'Open Gmail Drafts'}</a></p>}
    {draft.issue && <p className="dm-mail-issue">{draft.issue}</p>}
    {editable ? <form onSubmit={e => { e.preventDefault(); void save(true) }}>
      <label>To<input type="email" disabled={operation.busy} value={input.to} maxLength={254} onChange={e => update({ to: e.target.value })} /></label>
      <label>Subject<input disabled={operation.busy} value={input.subject} maxLength={300} onChange={e => update({ subject: e.target.value })} /></label>
      <label>Reply<textarea aria-label="Reply" disabled={operation.busy} rows={7} value={input.body} maxLength={12000} onChange={e => update({ body: e.target.value })} /></label>
      {stale && <p className="dm-mail-issue">{version > draft.version ? 'Waiting for the saved version…' : 'This draft changed. Your edits are still here. Reopen it to review the latest version.'}</p>}
      <div className="dm-actions"><button type="button" disabled={operation.busy || stale || !client.editMailDraft} onClick={() => void save(false)}>Save private edits</button></div>
      {connected?.composeAllowed && !reviewKey && <p className="dm-mail-issue">Gmail access changed or email help is paused. Resume and check the source again before approving a write. Your edits are still here.</p>}
      {!connected?.composeAllowed ? <><p className="dm-muted">Allow Gmail draft access before saving. Google’s permission also permits sending; this review only saves a draft. Changing permission requires a fresh source review.</p><button type="button" disabled={operation.busy || !client.connectMailDrafts} onClick={() => void operation.run(() => client.connectMailDrafts!())}>Allow Gmail drafts</button></> : <><label className="dm-check"><input type="checkbox" checked={approved} disabled={operation.busy || stale || !reviewKey || draft.status === 'saved' && !dirty} onChange={e => setApprovedKey(e.target.checked ? reviewKey : null)} />Save this exact reply in Gmail Drafts. Do not send it.</label><button className="dm-primary" type="submit" disabled={operation.busy || stale || !approved || !client.approveMailDraft || draft.status === 'saved' && !dirty}>{draft.gmailDraftId ? 'Approve & update Gmail draft' : 'Approve & save Gmail draft'}</button></>}
    </form> : draft.status !== 'preparing' && <details><summary>Reply preview</summary><p><strong>To:</strong> {draft.to}</p><p><strong>Subject:</strong> {draft.subject}</p><p className="dm-mail-body">{draft.body}</p></details>}
    {draft.status === 'uncertain' && <><p className="dm-muted">Sola will check for the existing draft. It will not create another copy.</p><button disabled={operation.busy || !client.reconcileMailDraft} onClick={() => void operation.run(async () => { setVersion(await client.reconcileMailDraft!(draft.id, draft.version)) }, 'Draft status check requested.')}>Check draft status</button></>}
    {draft.status === 'saved' && <div className="dm-mail-send-review">
      {dirty && <p className="dm-muted">Save and verify these changes in Gmail Drafts before approving a send.</p>}
      <label className="dm-check"><input type="checkbox" checked={sendApproved} disabled={operation.busy || stale || dirty || !reviewKey} onChange={e => setSendApprovedKey(e.target.checked ? reviewKey : null)} />Send this exact reply to {draft.to} from {draft.accountEmail}. This is separate from saving a draft.</label>
      <button className="dm-primary" disabled={operation.busy || stale || dirty || !reviewKey || !sendApproved || !client.approveMailSend} onClick={() => { if (!reviewKey || !sendApproved || stale || dirty) return; void operation.run(async () => { setVersion(await client.approveMailSend!(draft.id, version, input)); setSendApprovedKey(null) }, 'Send approved. Wait for the verified result below.'); }}>Approve & send email</button>
    </div>}
    {draft.status === 'send_uncertain' && <button disabled={operation.busy || !client.reconcileMailSend} onClick={() => void operation.run(async () => { setVersion(await client.reconcileMailSend!(draft.id, draft.version)) }, 'Checking the sent copy. Nothing will be sent again.')}>Check send result</button>}
    {draft.status === 'send_failed' && <button disabled={operation.busy || !client.reviewMailSendAgain} onClick={() => void operation.run(async () => { setVersion(await client.reviewMailSendAgain!(draft.id, draft.version)) }, 'Review the saved draft again. Sending requires a new approval.')}>Review send again</button>}
    <Result {...operation} />
  </section>
}
export function MessageReview({ message, state, client, close, shared }: Workspace & { message: PrivateMailMessage; close(): void; shared?(id: string): void }) {
  const operation = useOperation(), [version] = useState(message.version), [sharing, setSharing] = useState(false), [consent, setConsent] = useState(false), [text, setText] = useState(`${message.subject}\n\n${message.text}`), [instruction, setInstruction] = useState('')
  const stale = message.version !== version || message.expiresAt <= Date.now()
  const drafts = (state.mailDrafts ?? []).filter(draft => draft.messageId === message.id)
  const preparing = drafts.some(draft => ['preparing', 'review', 'saving', 'uncertain', 'sending', 'send_uncertain'].includes(draft.status))
  return <MailSheet title="Private email" close={close} busy={operation.busy}>
    <p className="dm-mail-private"><LockSimple size={14} aria-hidden="true" />Only you can see this</p><h3>{message.subject}</h3><p className="dm-muted">{message.sender} · {date(message.receivedAt)}</p>
    {stale && <p className="dm-mail-issue">This email changed or expired. Close this review and open the current source.</p>}
    <details className="dm-mail-source"><summary>Original email text</summary>{message.expiresAt > Date.now() ? <p className="dm-mail-body">{message.text}</p> : <p>The original text has expired.</p>}<p className="dm-muted">Attachments and linked pages have not been read.</p>{message.extraction.issues.map((issue, index) => <p className="dm-muted" key={index}>{issue}</p>)}</details>
    {(message.extraction.incomplete || message.extraction.truncated || message.extraction.attachments) && <p className="dm-mail-issue">Some source content has not been read. Check the original before relying on dates or requirements.</p>}
    {drafts.map(draft => <MailDraft key={`${draft.id}:${draft.status === 'preparing' ? 'preparing' : 'ready'}`} draft={draft} state={state} client={client} sourceChanged={stale || draft.sourceVersion !== undefined && draft.sourceVersion !== message.version} />)}
    {!preparing && !stale && <details className="dm-mail-compose"><summary>{drafts.length ? 'Prepare another reply' : 'Prepare a reply'}</summary><label>What would you like to say?<textarea aria-label="Reply instructions" rows={3} value={instruction} maxLength={2000} disabled={operation.busy} placeholder="Let them know we can attend…" onChange={e => setInstruction(e.target.value)} /></label><button disabled={operation.busy || !instruction.trim() || !client.prepareMailReply} onClick={() => void operation.run(() => client.prepareMailReply!(message.id, version, instruction), 'Reply preparation requested. Review the result before saving anything to Gmail.')}>Prepare reply</button></details>}
    <MailAttachments messageId={message.id} messageVersion={message.version} attachments={state.mailAttachments ?? []} discover={client.discoverMailAttachments} read={client.readMailAttachment}/><div className="dm-actions dm-mail-source-actions"><button disabled={operation.busy || stale || !client.shareMailboxMessage} onClick={() => { setSharing(!sharing); setConsent(false) }}>Prepare household work</button><button disabled={operation.busy || stale || drafts.some(draft => ['preparing', 'saving', 'uncertain', 'sending', 'send_uncertain'].includes(draft.status)) || !client.dismissMailboxMessage} onClick={() => void operation.run(async () => { await client.dismissMailboxMessage!(message.id, version, !message.dismissed); close() })}>{message.dismissed ? 'Restore message' : 'Set aside'}</button></div>
    {sharing && <form className="dm-mail-share" onSubmit={e => { e.preventDefault(); if (consent && !stale && text.trim()) void operation.run(async () => { const id = await client.shareMailboxMessage!(message.id, version, text); close(); shared?.(id) }) }}><h3>Choose what to share</h3><p>Only the text below will become household work. Remove anything you want to keep private.</p><label>Text to share<textarea aria-label="Text to share" rows={7} value={text} maxLength={20000} disabled={operation.busy} onChange={e => { setText(e.target.value); setConsent(false) }} /></label><label className="dm-check"><input type="checkbox" checked={consent} disabled={operation.busy || stale} onChange={e => setConsent(e.target.checked)} />Share this edited text with my household and let Sola prepare it for review.</label><p className="dm-muted">Sharing does not approve a calendar change or send an email.</p><button className="dm-primary" disabled={operation.busy || stale || !consent || !text.trim() || !client.shareMailboxMessage}>Share & prepare</button></form>}
    <Result {...operation} />
  </MailSheet>
}

/** Retained proposals remain reachable when their original run is outside the visible history. */
export function PrivateMailProposalConversation({ proposal, state, client, shared }: Workspace & { proposal: PrivateMailProposal; shared?(id: string): void }) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const message = state.mailboxMessages?.find(m => m.id === proposal.messageId) ?? state.mailboxRuns?.flatMap(run => run.messages).find(m => m.id === proposal.messageId)
  const stale = proposal.stale || !message || message.dismissed || message.expiresAt <= Date.now()
  return <><PrivateMailFollowups proposals={[{ ...proposal, stale }]} client={client} openSource={message ? () => setSourceOpen(true) : undefined} shared={shared} />{sourceOpen && message && <MessageReview key={message.id} message={message} state={state} client={client} close={() => setSourceOpen(false)} shared={shared} />}</>
}

export function PrivateMailRun({ run, state, client, shared }: Workspace & { run: MailboxRun; shared?(id: string): void }) {
  const operation = useOperation(), [selected, setSelected] = useState<string | null>(null)
  const message = selected ? state.mailboxMessages?.find(m => m.id === selected) ?? run.messages.find(m => m.id === selected) : undefined
  const status = run.status === 'queued' ? 'Your email check is queued.' : run.status === 'running' ? 'Checking your email…' : run.status === 'partial' ? 'There is more email to check.' : run.status === 'failed' ? 'This email check needs attention.' : run.status === 'cancelled' ? 'Email check stopped.' : run.hasMore ? 'There is more email to check.' : undefined
  const canContinue = run.canContinue ?? (run.hasMore && ['partial', 'failed'].includes(run.status))
  return <article className="dm-thread dm-private-mail-thread" aria-label="Private email conversation">
    <time className="dm-chat-time" dateTime={new Date(run.createdAt).toISOString()}>{date(run.createdAt)}</time><div className="dm-request-context"><p>{run.request}</p></div>
    <div className="dm-assistant-message dm-assistant-message-chat dm-mail-response">
      <div className="dm-mail-response-copy">
        {status && <p role={['queued', 'running'].includes(run.status) ? 'status' : run.status === 'failed' ? 'alert' : undefined}>{status}</p>}
        {run.answer && <p className="dm-mail-answer">{run.answer}</p>}
        {run.status === 'complete' && !run.answer && <p>{run.scanned ? 'The check finished. Review the source messages below.' : 'No messages were returned for this window.'}</p>}
        {run.followthrough && ['queued', 'running'].includes(run.followthrough.status) && <p role="status">{run.followthrough.status === 'queued' && run.followthrough.retryAfter ? 'Retry scheduled. Sola will use the saved emails when it resumes.' : 'Preparing useful follow-ups…'}</p>}
        {run.followthrough?.issue && <p className="dm-mail-issue">{run.followthrough.issue}</p>}
        {run.issue && <p className="dm-mail-issue">{run.issue}</p>}
        <Result {...operation} />
      </div>
      {run.followthrough?.status === 'failed' && run.followthrough.retryable && run.followthrough.version !== undefined && <button disabled={operation.busy || !client.retryMailPreparation} onClick={() => void operation.run(() => client.retryMailPreparation!(run.id, run.version, run.followthrough!.version!))}>{operation.busy ? 'Retrying…' : 'Retry preparation'}</button>}
      <PrivateMailFollowups proposals={(state.mailProposals ?? []).filter(p => p.runId === run.id)} client={client} openSource={setSelected} shared={shared} />
      {canContinue && <button disabled={operation.busy || !client.continueMailboxRun} onClick={() => void operation.run(() => client.continueMailboxRun!(run.id, run.version), 'Continuing this email check. More results will appear here.')}>Continue checking</button>}
      <details className="dm-mail-details">
        <summary aria-label="Email details"><Info size={16} aria-hidden="true" /><span>Details</span></summary>
        <div className="dm-mail-details-content">
          <p className="dm-mail-private"><LockSimple size={13} aria-hidden="true" />Private email · Only you can see this</p>
          <p className="dm-mail-coverage">{run.scope === 'inbox' ? 'Inbox' : 'Search includes archived mail'} · {day(run.from)}–{day(run.through)} · {run.scanned} message read{run.scanned === 1 ? '' : 's'}{run.status === 'partial' || run.hasMore ? ' · partial coverage' : ''}</p>
          {run.coverage && <p className="dm-mail-coverage-note">{run.coverage}</p>}
          {!!run.messages.length && <section className="dm-mail-detail-sources" aria-label="Source messages"><h4>Source messages ({run.messages.length})</h4>{run.messages.map(source => <button className="dm-mail-source-row" key={source.id} onClick={() => setSelected(source.id)}><strong>{source.subject}</strong><span>{source.sender} · {date(source.receivedAt)}</span><span>{source.dismissed ? 'Set aside' : source.extraction.incomplete || source.extraction.attachments || source.extraction.truncated ? 'Some content unread' : 'View email text'}</span></button>)}</section>}
        </div>
      </details>
    </div>
    {selected && message && <MessageReview key={message.id} message={message} state={state} client={client} close={() => setSelected(null)} shared={shared} />}
  </article>
}
