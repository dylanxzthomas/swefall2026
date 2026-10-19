import { useEffect, useRef, useState } from 'react'
import { checkedMailProposal, type MailProposalInput, type PrivateMailProposal } from '../../../shared/mailFollowthrough'
import type { DaymarkClient } from './types'
import { connectorErrorMessage } from '../../../shared/connectorErrors'
import { CaretRight } from '@phosphor-icons/react'
import { conversationTargetId } from './conversation'

const inputOf = (p: PrivateMailProposal): MailProposalInput => ({ kind: p.kind, messageId: p.messageId, title: p.title, details: p.details, dueDate: p.dueDate, date: p.date, startTime: p.startTime, endTime: p.endTime, timezone: p.timezone, location: p.location, question: p.question, replyBody: p.replyBody, evidence: p.evidence, ...(p.routineRefs ? { routineRefs: p.routineRefs } : {}) })
const calendarText = (p: MailProposalInput) => [`Prepare this calendar change for review: ${p.title}`, p.date && `Date: ${p.date}`, p.startTime && `Start: ${p.startTime}`, p.endTime && `End: ${p.endTime}`, p.timezone && `Timezone: ${p.timezone}`, p.location && `Location: ${p.location}`, p.details, p.question && `Unresolved: ${p.question}`].filter(Boolean).join('\n')
function Review({ proposal: p, client, close, openSource, shared }: { proposal: PrivateMailProposal; client: DaymarkClient; close(): void; openSource?(id: string): void; shared?(id: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false)
  const [version, setVersion] = useState(p.version), [input, setInput] = useState(() => inputOf(p)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [sharing, setSharing] = useState(false), [consent, setConsent] = useState(false), [preview, setPreview] = useState(() => calendarText(p))
  useEffect(() => { const el = dialog.current; if (el && !el.open) el.showModal(); return () => el?.close() }, [])
  const stale = p.stale || p.version > version || p.expiresAt <= Date.now(), dirty = JSON.stringify(input) !== JSON.stringify(inputOf(p))
  const run = async (work: () => Promise<unknown>, finish = true) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await work(); if (finish) close() } catch (e) { setError(connectorErrorMessage(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  const field = (key: keyof MailProposalInput, value: string) => { setInput(old => ({ ...old, [key]: value })); setConsent(false); setSaved(false) }
  return <dialog ref={dialog} className="dm-sheet dm-mail-sheet" aria-label="Private follow-up" onCancel={e => { e.preventDefault(); if (!busy) close() }}>
    <header><h2>Private follow-up</h2><button disabled={busy} onClick={close}>Done</button></header>
    <p className="dm-mail-private">Only you can see this. Nothing has been sent or added to a calendar.</p>
    <p className="dm-muted">This private follow-up stays with its email source until {new Date(p.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.</p>
    {p.kind === 'task' && <p className="dm-muted">Keep the reviewed task to save it privately in Tasks until you remove it, even after this email expires.</p>}
    {stale && <p role="alert" className="dm-mail-issue">The source, family context or connection changed. Check Gmail again before using this preparation.</p>}
    <fieldset disabled={busy || stale} className="dm-mail-proposal-fields">
      <label>Title<input value={input.title} maxLength={200} onChange={e => field('title', e.target.value)} /></label>
      <label>Details<textarea rows={3} value={input.details} maxLength={2000} onChange={e => field('details', e.target.value)} /></label>
      {p.kind === 'task' && <label>Due date<input type="date" value={input.dueDate} onChange={e => field('dueDate', e.target.value)} /></label>}
      {p.kind === 'calendar' && <><label>Date<input type="date" value={input.date} onChange={e => field('date', e.target.value)} /></label><label>Start<input type="time" value={input.startTime} onChange={e => field('startTime', e.target.value)} /></label><label>End<input type="time" value={input.endTime} onChange={e => field('endTime', e.target.value)} /></label><label>Timezone<input value={input.timezone} maxLength={100} onChange={e => field('timezone', e.target.value)} /></label><label>Location<input value={input.location} maxLength={300} onChange={e => field('location', e.target.value)} /></label></>}
      {p.kind === 'reply' && <label>Reply<textarea rows={7} value={input.replyBody} maxLength={4000} onChange={e => field('replyBody', e.target.value)} /></label>}
      <label>Still needed<input value={input.question} maxLength={500} placeholder="No unresolved details" onChange={e => field('question', e.target.value)} /></label>
    </fieldset>
    <details><summary>Source evidence</summary>{p.evidence.map((e, i) => <blockquote key={i}>{e.quote}</blockquote>)}{openSource && <button onClick={() => { close(); openSource(p.messageId) }}>Open private email</button>}</details>
    <div className="dm-actions">
      {dirty && <button disabled={busy || stale || p.version !== version || !client.editMailProposal} onClick={() => void run(async () => { const next = await client.editMailProposal!(p.id, version, checkedMailProposal(input)); setVersion(next); setConsent(false); setSaved(true) }, false)}>{busy ? 'Saving…' : 'Save private edits'}</button>}
      {p.kind === 'task' && p.status === 'review' && <button className="dm-primary" disabled={busy || stale || p.version !== version || dirty || !client.decideMailProposal} onClick={() => void run(() => client.decideMailProposal!(p.id, version, 'keep'))}>Keep private task</button>}
      {p.kind === 'task' && ['kept', 'done'].includes(p.status) && <button disabled={busy || stale || p.version !== version || dirty || !client.decideMailProposal} onClick={() => void run(() => client.decideMailProposal!(p.id, version, p.status === 'done' ? 'reopen' : 'done'))}>{p.status === 'done' ? 'Reopen task' : 'Mark my task done'}</button>}
      {p.kind === 'reply' && <button className="dm-primary" disabled={busy || stale || p.version !== version || dirty || !!input.question || !client.reviewMailProposalReply} onClick={() => void run(async () => { await client.reviewMailProposalReply!(p.id, version); openSource?.(p.messageId) })}>Review email draft</button>}
      {p.kind === 'calendar' && <button disabled={busy || stale || p.version !== version || dirty || !client.shareMailProposalCalendar} onClick={() => { setPreview(calendarText(input)); setSharing(true); setConsent(false); setSaved(false) }}>Prepare calendar review</button>}
      {p.status === 'review' && <button disabled={busy || stale || p.version !== version || dirty || p.expiresAt <= Date.now() + 86400_000 || !client.decideMailProposal} onClick={() => void run(() => client.decideMailProposal!(p.id, version, 'snooze', Date.now() + 86400_000))}>Tomorrow</button>}
      <button disabled={busy || !client.decideMailProposal} onClick={() => void run(() => client.decideMailProposal!(p.id, p.version, 'dismiss'))}>Dismiss</button>
    </div>
    {sharing && <div className="dm-mail-share"><h3>Choose what your household sees</h3><label>Text to share<textarea rows={7} value={preview} maxLength={20000} disabled={busy} onChange={e => { setPreview(e.target.value); setConsent(false); setSaved(false) }} /></label><label className="dm-check"><input type="checkbox" checked={consent} disabled={busy || stale || dirty} onChange={e => setConsent(e.target.checked)} />Share only this edited text and prepare a calendar draft for review.</label><p>Calendar changes still need separate approval. Your inbox and other private details stay private.</p><button className="dm-primary" disabled={busy || stale || p.version !== version || dirty || !consent || !preview.trim()} onClick={() => void run(async () => { const id = await client.shareMailProposalCalendar!(p.id, version, preview); shared?.(id) })}>Share & prepare calendar draft</button></div>}
    {saved && !dirty && <p role="status" className="dm-muted">Private edits saved.</p>}
    {error && <p role="alert" className="dm-error">{error}</p>}
  </dialog>
}
export function visibleMailFollowups(proposals: PrivateMailProposal[], filter: 'all' | 'you' | 'assistant' | 'finished' = 'all', search = '') {
  return proposals.filter(p => !p.privateTaskId && p.status !== 'dismissed' && p.status !== 'withdrawn' && (p.status !== 'snoozed' || (p.snoozedUntil ?? Infinity) <= Date.now()) && (filter === 'finished' ? p.kind === 'task' && p.status === 'done' : filter === 'assistant' ? p.status === 'review' && p.kind !== 'task' : filter === 'you' ? p.status === 'review' || p.kind === 'task' && p.status !== 'done' : true) && (!search || `${p.title} ${p.details}`.toLowerCase().includes(search.toLowerCase())))
}
export function PrivateMailFollowups({ proposals, client, openSource, openProposal, shared, filter = 'all', search = '' }: { proposals: PrivateMailProposal[]; client: DaymarkClient; openSource?(id: string): void; openProposal?(id: string): void; shared?(id: string): void; filter?: 'all' | 'you' | 'assistant' | 'finished'; search?: string }) {
  const [selected, setSelected] = useState<string | null>(null), p = proposals.find(p => p.id === selected && !p.privateTaskId)
  const visible = visibleMailFollowups(proposals, filter, search)
  if (!visible.length && !p) return null
  return <section className="dm-private-followups" aria-label="Private email follow-ups">{visible.map(p => {
    const details = <><strong>{p.title}</strong><span>{p.stale ? 'Source changed · check Gmail again' : p.status === 'done' ? 'Your task · Done' : p.status === 'kept' ? 'For you · Private' : p.kind === 'task' ? 'For you · Ready to review · Private' : p.kind === 'calendar' ? 'Calendar preparation · Ready to review · Private' : 'Reply preparation · Ready to review · Private'}</span>{p.question && <span>{p.question}</span>}</>
    return openProposal ? <button className="dm-mail-source-row" key={p.id} onClick={() => openProposal(p.id)}>{details}</button> : <div className="dm-mail-source-row" key={p.id} id={conversationTargetId(`mail-proposal:${p.id}`)} tabIndex={-1} role="group" aria-label={`Email follow-up: ${p.title}`}>{details}<button className="dm-conversation-review" aria-label={`Review follow-up: ${p.title}`} onClick={() => setSelected(p.id)}>Review follow-up<CaretRight size={15} aria-hidden="true" /></button></div>
  })}{p && <Review key={p.id} proposal={p} client={client} close={() => setSelected(null)} openSource={openSource} shared={shared} />}</section>
}
