import { useRef, useState } from 'react'
import { emailWatchSchema, type EmailWatchDefinition, type EmailWatchSettings, type EmailWatchSummary } from '../../../shared/emailWatches'
import type { EmailCheck } from '../../../shared/emailTriage'
import type { EmailTaskSuggestion } from '../../../shared/emailTasks'
import { personalTaskSchema, type PersonalTaskInput } from '../../../shared/tasks'
import './emailChecks.css'

type Props = {
  watches?: EmailWatchSummary[]
  settings?: EmailWatchSettings | null
  onConnect?(): Promise<unknown>
  onCreate?(definition: EmailWatchDefinition, requestId: string, connectionId: string): Promise<unknown>
  onUpdate?(id: string, version: number, definition: EmailWatchDefinition): Promise<unknown>
  onPause?(id: string, version: number, paused: boolean): Promise<unknown>
  onRemove?(id: string, version: number): Promise<unknown>
  onCheck?(id: string, version: number): Promise<unknown>
  checks?: EmailCheck[]
  suggestions?: EmailTaskSuggestion[]
  children?: { id: string; name: string }[]
  onReviewMessage?(jobId: string, sourceRevision: number): Promise<unknown>
  onSaveTask?(id: string, version: number, sourceRevision: number, input: PersonalTaskInput): Promise<unknown>
  onDismissTask?(id: string, version: number, sourceRevision: number): Promise<unknown>
  onHandleMessage?(jobId: string, sourceRevision: number, handlingVersion: number, operation: 'dismiss' | 'snooze' | 'restore', until?: number): Promise<unknown>
  onRetryMessage?(jobId: string, sourceRevision: number): Promise<unknown>
}
const defaultInstruction = 'Find school and activity dates, deadlines, and requests that need my attention. Prepare calendar changes or email drafts for me to review. Ask if anything is missing.'
const time = (value?: number) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not checked yet'
type TaskCardProps = Pick<Props, 'onSaveTask' | 'onDismissTask' | 'children'> & { suggestion: EmailTaskSuggestion; busy: boolean; run(fn: () => Promise<unknown>, success?: string): Promise<void> }
function EmailTaskCard({ suggestion, children = [], busy, run, onSaveTask, onDismissTask }: TaskCardProps) {
  const [reviewed, setReviewed] = useState(() => ({ version: suggestion.version, sourceRevision: suggestion.sourceRevision }))
  const [input, setInput] = useState<PersonalTaskInput>(() => ({ ...suggestion.input }))
  const [acknowledged, setAcknowledged] = useState<'saved' | 'dismissed' | null>(null), [error, setError] = useState('')
  const stale = reviewed.version !== suggestion.version || reviewed.sourceRevision !== suggestion.sourceRevision
  const status = acknowledged ?? suggestion.status
  const blocked = busy || !!acknowledged || !suggestion.canSave || stale
  async function submit(operation: 'save' | 'dismiss') {
    if (blocked) return
    const parsed = personalTaskSchema.safeParse(input)
    if (operation === 'save' && !parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the task details.'); return }
    setError('')
    await run(async () => {
      try {
        if (operation === 'save') {
          if (!onSaveTask || !parsed.success) throw new Error('Saving this task is unavailable.')
          await onSaveTask(suggestion.id, reviewed.version, reviewed.sourceRevision, parsed.data)
          setAcknowledged('saved')
        } else {
          if (!onDismissTask) throw new Error('Dismissing this suggestion is unavailable.')
          await onDismissTask(suggestion.id, reviewed.version, reviewed.sourceRevision)
          setAcknowledged('dismissed')
        }
      } catch (e) { setError(e instanceof Error ? e.message : 'This suggestion could not be updated. Your edits are still here.') }
    })
  }
  return <section className="dm-email-task" aria-label={`Suggested task: ${suggestion.input.title}`}>
    <h4>{status === 'proposed' ? 'For you to do' : status === 'saved' ? 'Saved responsibility' : 'Set aside'}</h4>
    {status === 'proposed' ? <form onSubmit={e => { e.preventDefault(); void submit('save') }}>
      <p className="dm-muted">A suggestion from this email. Check the details before adding it to your tasks.</p>
      {!!suggestion.evidence.length && <details className="dm-email-task-evidence"><summary>Why this task?</summary>{suggestion.evidence.slice(0, 3).map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</details>}
      {suggestion.issue && <p className="dm-email-task-issue">{suggestion.issue}</p>}
      <label>Task title<input disabled={busy} value={input.title} maxLength={200} onChange={e => setInput({ ...input, title: e.target.value })} /></label>
      <label>Notes<textarea disabled={busy} rows={2} value={input.notes} maxLength={2000} onChange={e => setInput({ ...input, notes: e.target.value })} /></label>
      <div className="dm-email-task-fields">
        <label>Due date<input disabled={busy} type="date" value={input.dueDate ?? ''} onChange={e => setInput({ ...input, dueDate: e.target.value || undefined })} /></label>
        <label>Child<select disabled={busy} value={input.childId ?? ''} onChange={e => setInput({ ...input, childId: e.target.value || undefined })}>
          <option value="">Household</option>
          {input.childId && !children.some(child => child.id === input.childId) && <option value={input.childId}>Choose a child</option>}
          {children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}
        </select></label>
      </div>
      {stale && <div className="dm-email-task-issue"><p>This suggestion changed while you were editing. Your edits are still here. Review the latest version before saving.</p><button type="button" disabled={busy} onClick={() => { setReviewed({ version: suggestion.version, sourceRevision: suggestion.sourceRevision }); setInput({ ...suggestion.input }); setError('') }}>Load latest suggestion</button></div>}
      {!suggestion.canSave && <p className="dm-muted">This suggestion cannot be saved right now. Its source or access may have changed; review the original email.</p>}
      <div className="dm-actions"><button type="submit" className="dm-primary" disabled={blocked || !onSaveTask}>Add to my tasks</button><button type="button" disabled={blocked || !onDismissTask} onClick={() => void submit('dismiss')}>Dismiss suggestion</button></div>
    </form> : <><p className="dm-email-task-title">{acknowledged === 'saved' ? input.title : suggestion.input.title}</p><p className="dm-muted">{status === 'saved' ? 'Added to your tasks · saving did not complete the work' : 'Suggestion dismissed · no task added'}</p></>}
    {error && <p className="dm-error" role="alert">{error}</p>}
  </section>
}
export function EmailTaskReviews({ suggestions = [], children = [], onSaveTask, onDismissTask }: Pick<Props, 'suggestions' | 'children' | 'onSaveTask' | 'onDismissTask'>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  const proposed = suggestions.filter(suggestion => suggestion.status === 'proposed')
  async function run(fn: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'This suggestion could not be updated.') }
    finally { pending.current = false; setBusy(false) }
  }
  if (!proposed.length) return null
  return <section className="dm-email-task-reviews" aria-label="Tasks suggested from email"><h2>From your email</h2><p className="dm-muted">Responsibilities to review and add to your list.</p>{proposed.map(suggestion => <EmailTaskCard key={suggestion.id} suggestion={suggestion} children={children} busy={busy} run={run} onSaveTask={onSaveTask} onDismissTask={onDismissTask} />)}{error && <p className="dm-error" role="alert">{error}</p>}</section>
}
export default function EmailWatches({ watches = [], settings, checks = [], suggestions = [], children = [], onReviewMessage, onSaveTask, onDismissTask, onHandleMessage, onRetryMessage, onConnect, onCreate, onUpdate, onPause, onRemove, onCheck }: Props) {
  const [editing, setEditing] = useState<EmailWatchSummary | 'new' | null>(null), [title, setTitle] = useState('School & activity updates'), [senders, setSenders] = useState(''), [instruction, setInstruction] = useState(defaultInstruction), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('')
  const requestId = useRef(crypto.randomUUID()), pending = useRef(false)
  async function run(fn: () => Promise<unknown>, success = '') {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setSaved('')
    try { await fn(); setSaved(success) } catch (e) { setError(e instanceof Error ? e.message : 'This watch could not be saved. Try again.') } finally { pending.current = false; setBusy(false) }
  }
  function edit(watch?: EmailWatchSummary) {
    setEditing(watch ?? 'new'); setTitle(watch?.title ?? 'School & activity updates'); setSenders(watch?.senders.join('\n') ?? ''); setInstruction(watch?.instruction ?? defaultInstruction); setConsent(false); setError(''); setSaved(''); requestId.current = crypto.randomUUID()
  }
  async function save() {
    const parsed = emailWatchSchema.safeParse({ title, senders: senders.split(/[\n,;]/).map(s => s.trim()).filter(Boolean), instruction })
    if (!parsed.success) { setError('Enter a title, one to five exact email addresses, and what you want Sola to look for.'); return }
    if (!consent || !settings?.connection?.readAllowed) return
    await run(async () => {
      if (editing && editing !== 'new') { if (!onUpdate) throw new Error('Watch editing is unavailable.'); await onUpdate(editing.id, editing.version, parsed.data) }
      else { if (!onCreate) throw new Error('Watch setup is unavailable.'); await onCreate(parsed.data, requestId.current, settings.connection!.id) }
      setEditing(null); setConsent(false); requestId.current = crypto.randomUUID()
    }, editing && editing !== 'new' ? 'Changes saved. Resume when you are ready to use this watch.' : 'Watch enabled. Its first check has not completed yet.')
  }
  return <details className="dm-email-watches"><summary>Email watch</summary>
    <p>Sola can read messages from the Gmail senders you choose and prepare useful follow-ups for review. Clear informational messages stay quiet; uncertain or incomplete messages still need your review.</p>
    {!settings ? <p className="dm-muted">Email watches need a connected workspace. This device workspace is not reading your inbox. You can paste an email into Assistant instead.</p> : <>
      {!settings.configured && <p className="dm-muted">Gmail connection setup is still needed. No inbox is being checked.</p>}
      {!settings.modelConfigured && <p className="dm-muted">Automatic preparation is not connected yet. Watches will wait without reading messages until it is available.</p>}
      {!settings.connection?.readAllowed && <>
        <p className="dm-muted">Reading permission is separate from sending. Google grants read access to Gmail; Sola limits checks to the exact senders you select. Connecting does not enable a watch.</p>
        <button disabled={busy || !settings.configured || !onConnect} onClick={() => void run(() => onConnect!())}>Connect Gmail reading</button>
      </>}
      {settings.connection?.readAllowed && <p className="dm-muted">Reading connected{settings.connection.email ? ` · ${settings.connection.email}` : ''}</p>}
      {watches.map(w => <section className="dm-setting-item" key={w.id} aria-label={w.title}>
        <h3>{w.title}</h3><p>{w.state === 'active' ? w.checking ? 'Checking selected senders…' : 'Enabled · checks about every 15 minutes' : w.state === 'paused' ? 'Paused' : 'Needs attention'}</p>
        <p className="dm-muted">{w.senders.join(', ')}</p>
        <p className="dm-muted">Last completed check: {time(w.lastCheckedAt)}</p>
        {w.issue && <p role="status">{w.issue}</p>}
        <div className="dm-actions">
          <button disabled={busy || !onPause || (w.state !== 'active' && !settings.connection?.readAllowed)} onClick={() => void run(() => onPause!(w.id, w.version, w.state === 'active'))}>{w.state === 'active' ? 'Pause watch' : 'Resume watch'}</button>
          <button disabled={busy || !onUpdate} onClick={() => edit(w)}>Edit watch</button>
          {w.state === 'active' && <button disabled={busy || w.checking || !onCheck} onClick={() => void run(() => onCheck!(w.id, w.version), 'Check requested. The completed-check time will update only after Gmail responds.')}>Check now</button>}
          <button disabled={busy || !onRemove} onClick={() => void run(() => onRemove!(w.id, w.version), 'Watch removed. Saved drafts remain, and no further checks will run.')}>Remove watch</button>
        </div>
      </section>)}
      {!watches.length && !editing && <button disabled={busy || !settings.connection?.readAllowed || !onCreate} onClick={() => edit()}>Set up email watch</button>}
      {editing && <form onSubmit={event => { event.preventDefault(); void save() }}>
        <label>Watch name<input disabled={busy} value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /></label>
        <label>Sender email addresses<textarea disabled={busy} rows={3} value={senders} placeholder="school@example.com" onChange={e => setSenders(e.target.value)} /></label>
        <p className="dm-muted">One to five exact addresses, separated by commas or new lines. No whole-domain or whole-inbox searches.</p>
        <label>What should Sola look for?<textarea disabled={busy} rows={4} value={instruction} maxLength={1000} onChange={e => setInstruction(e.target.value)} /></label>
        <p className="dm-muted">The first check covers the last 24 hours. Later checks cover new messages, up to the last seven days after downtime, five per batch. Attachments and linked pages are not read. Resuming starts with new messages.</p>
        <label className="dm-check"><input disabled={busy} type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Allow Sola to read text from these senders and save it as household-visible work for review. Original text expires after 30 days. Nothing is sent or added to a calendar without approval.</label>
        <div className="dm-actions"><button className="dm-primary" disabled={busy || !consent || !settings.connection?.readAllowed}>{editing === 'new' ? 'Enable this watch' : 'Save changes & pause'}</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
      </form>}
      {!!watches.length && <p className="dm-muted">Pause or remove a watch to stop new checks. Existing drafts stay saved; changes to a watch stop its old approvals. To remove Google access entirely, disconnect Google in Connections.</p>}
      {!!checks.length && <details className="dm-email-checks"><summary>Recent email checks</summary>
        <p className="dm-muted">Up to 20 recent messages. Filtered messages stay here for 30 days so you can check what Sola set aside. This is not an all-clear for your inbox.</p>
        {checks.map(check => <section className="dm-setting-item" key={check.jobId} aria-label={check.subject}>
          <h3>{check.subject}</h3>
          <p className="dm-muted">{check.sender} · {time(check.receivedAt)}</p>
          <p>{check.status === 'quiet' ? 'Kept quiet · no task created' : check.status === 'preparing' ? 'Preparing for review' : check.status === 'cancelled' ? 'Cancelled' : check.status === 'dismissed' ? 'Set aside · no work marked done' : check.status === 'snoozed' ? `Snoozed${check.snoozedUntil ? ` until ${time(check.snoozedUntil)}` : ''}` : 'Available in Tasks · check its current progress'}</p>
          {check.reason && <p>{check.reason}</p>}
          {!!check.evidence.length && <details><summary>Email excerpts</summary>{check.evidence.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</details>}
          {!!check.related?.length && <details className="dm-email-related"><summary>Related emails ({Math.min(check.related.length, 3)})</summary><ul>{check.related.slice(0, 3).map(related => <li key={related.jobId}><span>{related.subject}</span><time dateTime={new Date(related.receivedAt).toISOString()}>{time(related.receivedAt)}</time></li>)}</ul><p className="dm-muted">Context only. Each message keeps its own review.</p></details>}
          {suggestions.filter(suggestion => suggestion.jobId === check.jobId).map(suggestion => <EmailTaskCard key={suggestion.id} suggestion={suggestion} children={children} busy={busy} run={run} onSaveTask={onSaveTask} onDismissTask={onDismissTask} />)}
          {check.status === 'quiet' && <><button disabled={busy || !check.canReview || !onReviewMessage} onClick={() => void run(() => onReviewMessage!(check.jobId, check.sourceRevision), 'Preparation requested. Look in Tasks for the result; nothing has been sent.')}>Prepare for review</button>{!check.canReview && <p className="dm-muted">This watch or its access changed. You can paste the original email into Assistant.</p>}</>}
          <div className="dm-actions dm-email-message-actions">
            {check.canHandle && Number.isSafeInteger(check.handlingVersion) && onHandleMessage && (check.status === 'dismissed' || check.status === 'snoozed' ? <button disabled={busy} onClick={() => void run(() => onHandleMessage(check.jobId, check.sourceRevision, check.handlingVersion!, 'restore'), 'Message restored. Check its current progress above.')}>Restore message</button> : <>
              <button disabled={busy} onClick={() => void run(() => onHandleMessage(check.jobId, check.sourceRevision, check.handlingVersion!, 'snooze', Date.now() + 86400_000), 'Message snoozed for one day. Existing tasks stay unchanged.')}>Snooze for a day</button>
              <button disabled={busy} onClick={() => void run(() => onHandleMessage(check.jobId, check.sourceRevision, check.handlingVersion!, 'dismiss'), 'Message set aside. No work has been marked done.')}>Dismiss message</button>
            </>)}
            {check.canRetry && onRetryMessage && <button disabled={busy} onClick={() => void run(() => onRetryMessage(check.jobId, check.sourceRevision), 'Preparation requested again. Nothing has been sent.')}>Try preparation again</button>}
          </div>
        </section>)}
      </details>}
    </>}
    {error && <p className="dm-error" role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
  </details>
}
