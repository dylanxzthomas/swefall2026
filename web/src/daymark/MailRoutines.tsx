import { useEffect, useRef, useState } from 'react'
import { mailRoutineDefinitionSchema, type MailRoutine, type MailRoutineDefinition, type MailRoutineOccurrence } from '../../../shared/mailRoutines'
import { assistantName } from '../../../shared/persona'
import type { DaymarkClient, DaymarkState } from './types'

const empty: MailRoutineDefinition = { title: '', condition: '', instruction: '' }
const failure = (error: unknown) => error && typeof error === 'object' && 'issues' in error ? (error.issues as { message: string }[])[0]?.message ?? 'Review these routine details.' : error instanceof Error ? error.message : 'This routine could not be saved. Your edits are still here.'
const dateLabel = (at: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)

export function MailRoutineFields({ value, onChange, name }: { value: MailRoutineDefinition; onChange(value: MailRoutineDefinition): void; name: string }) {
  return <>
    <label>Routine name<input required maxLength={200} value={value.title} placeholder="School forms" onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <label>When a new email…<textarea required rows={3} maxLength={1000} value={value.condition} placeholder="asks for a school permission form or a parent reply" onChange={event => onChange({ ...value, condition: event.target.value })} /></label>
    <label>What should {name} prepare?<textarea required rows={4} maxLength={4000} value={value.instruction} placeholder="Pull out the deadline and prepare a task for me, with a reply to review if one is needed." onChange={event => onChange({ ...value, instruction: event.target.value })} /></label>
  </>
}

export default function MailRoutineEditor({ state, client, routine, close, saved }: { state: DaymarkState; client: DaymarkClient; routine?: MailRoutine; close(): void; saved(message: string): void }) {
  const [value, setValue] = useState<MailRoutineDefinition>(() => structuredClone(routine?.definition ?? empty))
  const [version, setVersion] = useState(routine?.version), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false)
  const [history, setHistory] = useState<MailRoutineOccurrence[] | null>(null), [historyError, setHistoryError] = useState(''), [showHistory, setShowHistory] = useState(false)
  const pending = useRef(false), attempt = useRef<{ content: string; id: string }>(), dialog = useRef<HTMLDialogElement>(null)
  const name = assistantName(state.preferences), current = routine && state.mailRoutines?.find(row => row.id === routine.id)
  const stale = !!routine && (!current || current.state === 'removed' || current.version !== version)
  const dirty = !!routine && JSON.stringify(value) !== JSON.stringify(routine.definition)
  const settings = state.mailboxSettings, connection = settings?.connection, mailbox = settings?.mailbox
  const ready = !!connection?.readAllowed && mailbox?.state === 'active' && mailbox.connectionVersion === connection.version && !mailbox.issue
  const active = current?.state === 'active', historyVersion = current?.version, lastPreparedAt = current?.lastPreparedAt
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => element?.close() }, [])
  useEffect(() => {
    if (!showHistory || !routine || !client.mailRoutineHistory) return
    let mounted = true
    setHistoryError('')
    client.mailRoutineHistory(routine.id).then(result => { if (mounted) setHistory(result) }).catch(cause => { if (mounted) setHistoryError(failure(cause)) })
    return () => { mounted = false }
  }, [routine?.id, historyVersion, lastPreparedAt, showHistory])
  const run = async (operation: () => Promise<unknown>) => {
    if (pending.current || stale) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (cause) { setError(failure(cause)) } finally { pending.current = false; setBusy(false) }
  }
  const save = () => run(async () => {
    const definition = mailRoutineDefinitionSchema.parse(value)
    if (routine) {
      if (!client.updateMailRoutine) throw new Error('Email routine editing is unavailable.')
      await client.updateMailRoutine(routine.id, version!, definition)
      saved('Email routine updated. Earlier emails will not run again.')
    } else {
      if (!client.createMailRoutine) throw new Error('Email routines need a connected workspace.')
      const content = JSON.stringify(definition)
      if (attempt.current?.content !== content) attempt.current = { content, id: crypto.randomUUID() }
      await client.createMailRoutine(definition, attempt.current.id)
      saved('Email routine saved privately and paused. Open it when you’re ready to activate it.')
    }
    close()
  })
  const setPaused = (paused: boolean) => run(async () => {
    if (!routine || !client.setMailRoutinePaused || !paused && (dirty || !ready)) return
    setVersion(await client.setMailRoutinePaused(routine.id, version!, paused))
    setNotice(paused ? 'Routine paused. Your edits are still here.' : 'Routine active for new emails from now on. Prepared work will still need your review.')
  })
  return <dialog ref={dialog} className="dm-sheet dm-routine-sheet dm-mail-routine-sheet" aria-label={routine ? 'Email routine details' : 'New email routine'} onCancel={event => { event.preventDefault(); if (!pending.current) close() }}>
    <header><h2>{routine ? 'Email routine' : 'New email routine'}</h2><button disabled={busy} onClick={close} aria-label="Close email routine">Done</button></header>
    <p className="dm-task-form-note">Private to you. Uses only your connected Gmail{connection?.email ? ` (${connection.email})` : ''}.</p>
    {stale && <p className="dm-notice" role="alert">This routine changed elsewhere. Your edits are still here. Close and reopen it before saving.</p>}
    {current?.issue && <p className="dm-notice">{current.issue}</p>}
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="dm-task-form-fields" disabled={busy}>
        <MailRoutineFields value={value} onChange={next => { setValue(next); setNotice('') }} name={name} />
      </fieldset>
      <p className="dm-task-form-note">Starts with new emails received after activation. {name} prepares work privately; sending emails and changing calendars still need your approval.</p>
      {!routine && <p className="dm-task-form-note">Saved paused. You choose when to activate it.</p>}
      {routine && <p className="dm-task-form-note">Editing an active routine starts fresh with new emails. Editing or pausing stops unfinished preparation from the earlier version. Kept work and recorded results remain.</p>}
      {!ready && <p className="dm-notice">You can save this routine now. Before activating it, connect or resume your Gmail in Household → Connections.</p>}
      {error && <p className="dm-error" role="alert">{error}</p>}
      {notice && <p className="dm-task-form-note" role="status">{notice}</p>}
      <button type="submit" className="dm-primary dm-task-submit" disabled={busy || stale}>{busy ? 'Saving…' : routine ? 'Save changes' : 'Save paused routine'}</button>
    </form>
    {routine && <>
      <p className="dm-task-form-note">{current?.issue ? 'Needs your attention before new preparation' : active ? 'Active for new emails' : 'Paused'}{current?.activatedAt && active && !current.issue ? ` · Since ${dateLabel(current.activatedAt)}` : ''}</p>
      {dirty && (!active || current?.issue) && <p className="dm-task-form-note">Save your edits before activating this routine.</p>}
      {active && current?.issue && <button className="dm-task-complete" disabled={busy || stale || dirty || !ready || !client.setMailRoutinePaused} onClick={() => void setPaused(false)}>Resume with current Gmail access</button>}
      <button className="dm-task-complete" disabled={busy || stale || !client.setMailRoutinePaused || !active && (dirty || !ready)} onClick={() => void setPaused(!!active)}>{active ? 'Pause email routine' : 'Activate email routine'}</button>
      <div className="dm-task-remove">{removing ? <><p>Remove this routine? Unfinished preparation stops. Kept work and recorded results remain.</p><div className="dm-actions"><button disabled={busy || stale || !client.removeMailRoutine} onClick={() => void run(async () => { await client.removeMailRoutine!(routine.id, version!); saved('Email routine removed.'); close() })}>Remove email routine</button><button disabled={busy} onClick={() => setRemoving(false)}>Keep it</button></div></> : <button className="dm-text-button" disabled={busy || stale} onClick={() => setRemoving(true)}>Remove email routine</button>}</div>
      <details className="dm-routine-history" onToggle={event => setShowHistory(event.currentTarget.open)}><summary>Recent preparation</summary>
        {historyError ? <p role="alert">{historyError}</p> : history === null ? <p>Loading history…</p> : !history.length ? <p>No preparation yet. This routine starts with new emails after you activate it.</p> : <ul>{history.map(item => <li key={item.id}><time dateTime={new Date(item.createdAt).toISOString()}>{dateLabel(item.createdAt)}</time><p>{item.summary}</p><span className="dm-mail-routine-history-state">{item.status === 'prepared' ? 'Prepared for review' : item.status === 'superseded' ? 'Earlier version · no longer current' : 'Source expired · details unavailable'}</span></li>)}</ul>}
        <p className="dm-task-form-note">Your latest 30 preparations. Prepared does not mean sent or completed. Expired source details are no longer available.</p>
      </details>
    </>}
  </dialog>
}
