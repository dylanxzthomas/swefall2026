import { useEffect, useRef, useState } from 'react'
import { CaretRight, Repeat } from '@phosphor-icons/react'
import { nextOccurrence, routineDefinitionSchema, type Routine, type RoutineDefinition, type RoutineRun } from '../../../shared/routines'
import { emptyRoutine, routineScheduleLabel } from '../../../shared/routineIntent'
import { assistantName } from '../../../shared/persona'
import type { DaymarkClient, DaymarkState } from './types'
import MailRoutineEditor from './MailRoutines'
import type { MailRoutine } from '../../../shared/mailRoutines'
import './routines.css'

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const dateLabel = (at: number, timezone: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(at)
const failure = (error: unknown) => error && typeof error === 'object' && 'issues' in error ? (error.issues as { message: string }[])[0]?.message ?? 'Confirm the routine details.' : error instanceof Error ? error.message : 'This routine could not be saved. Your edits are still here.'

export function RoutineEditor({ state, client, routine, initial, note, close, saved }: { state: DaymarkState; client: DaymarkClient; routine?: Routine; initial?: RoutineDefinition; note?: string; close(): void; saved(): void }) {
  const [value, set] = useState<RoutineDefinition>(() => structuredClone(routine?.definition ?? initial ?? emptyRoutine(state.household?.timezone ?? 'UTC')))
  const [version] = useState(routine?.version), [error, setError] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false)
  const [exceptions, setExceptions] = useState((value.schedule.exceptDates ?? []).join('\n')), [runs, setRuns] = useState<RoutineRun[] | null>(null), [historyError, setHistoryError] = useState('')
  const pending = useRef(false), attempt = useRef<{ content: string; id: string }>(), dialog = useRef<HTMLDialogElement>(null)
  const name = assistantName(state.preferences), current = routine && state.routines?.find(r => r.id === routine.id)
  const stale = !!routine && (!current || current.version !== version), readOnly = !!routine && !routine.canEdit
  const label = routine ? 'Routine details' : 'Review routine'
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => element?.close() }, [])
  useEffect(() => {
    if (!routine || !client.routineOccurrences) return
    let active = true
    client.routineOccurrences(routine.id).then(result => { if (active) setRuns(result) }).catch(e => { if (active) setHistoryError(failure(e)) })
    return () => { active = false }
  }, [routine?.id, current?.updatedAt, state.personalTasks, state.jobs])
  const schedule = (changes: Partial<RoutineDefinition['schedule']>) => set({ ...value, schedule: { ...value.schedule, ...changes } })
  const prepared = () => routineDefinitionSchema.parse({ ...value, schedule: { ...value.schedule, exceptDates: exceptions.split(/[\s,]+/).filter(Boolean) } })
  let next: number | undefined
  try { next = nextOccurrence(prepared().schedule, Date.now())?.at } catch { /* Invalid draft remains editable. */ }
  const run = async (operation: () => Promise<unknown>) => {
    if (pending.current || stale || readOnly) return
    pending.current = true; setBusy(true); setError('')
    try { await operation(); saved(); close() } catch (e) { setError(failure(e)) } finally { pending.current = false; setBusy(false) }
  }
  const save = () => run(async () => {
    const definition = prepared()
    if (routine) {
      if (!client.updateRoutine) throw new Error('Routine editing is unavailable.')
      await client.updateRoutine(routine.id, version!, definition)
    } else {
      if (!client.createRoutine) throw new Error('Routines are unavailable in this workspace.')
      const content = JSON.stringify(definition)
      if (attempt.current?.content !== content) attempt.current = { content, id: crypto.randomUUID() }
      await client.createRoutine(definition, attempt.current.id)
    }
  })
  return <dialog ref={dialog} className="dm-sheet dm-routine-sheet" aria-label={label} onCancel={e => { e.preventDefault(); if (!pending.current) close() }}>
    <header><h2>{label}</h2><button disabled={busy} onClick={close} aria-label="Close routine details">Done</button></header>
    {note && !routine && <p className="dm-task-form-note">{note}</p>}
    {stale && <p className="dm-notice" role="alert">This routine changed elsewhere. Your edits are still here. Close and reopen it before saving.</p>}
    {readOnly && <p className="dm-notice">Only the adult who saved this routine can change it.</p>}
    {current?.issue && <p className="dm-notice">{current.issue}</p>}
    <form onSubmit={e => { e.preventDefault(); void save() }}>
      <fieldset className="dm-task-form-fields" disabled={busy || readOnly}>
        <label>Routine name<input value={value.title} required maxLength={200} placeholder="Sunday school bags" onChange={e => set({ ...value, title: e.target.value })} /></label>
        <div className="dm-segmented dm-task-owner" role="group" aria-label="Routine outcome">
          <button type="button" aria-pressed={value.outcome.kind === 'personal_task'} onClick={() => { if (value.outcome.kind !== 'personal_task') set({ ...value, outcome: { kind: 'personal_task', task: { title: '', notes: '' }, dueAfterDays: 0 } }) }}>Task for you</button>
          <button type="button" aria-pressed={value.outcome.kind === 'prepare_request'} onClick={() => { if (value.outcome.kind !== 'prepare_request') set({ ...value, outcome: { kind: 'prepare_request', instruction: '' } }) }}>{name} prepares</button>
        </div>
        {value.outcome.kind === 'personal_task' ? <>
          <label>Task to add<input required maxLength={200} value={value.outcome.task.title} placeholder="Pack school bags" onChange={e => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, title: e.target.value } } }) }} /></label>
          <p className="dm-task-form-note">{name} adds this to Tasks. You check it off when it’s done; this does not schedule a phone alert.</p>
        </> : <>
          <label>What should {name} prepare?<textarea required rows={3} maxLength={20000} value={value.outcome.instruction} onChange={e => set({ ...value, outcome: { kind: 'prepare_request', instruction: e.target.value } })} placeholder="Draft a school reply with the details I provide…" /></label>
          <p className="dm-task-form-note">Each occurrence prepares work for review. Messages and calendar changes still need your approval.</p>
          {state.storage !== 'device' && state.routineSettings?.preparationModelConfigured === false && <p className="dm-notice">AI preparation is not connected yet. The request will be saved with that limitation until the model is configured.</p>}
          {state.storage === 'device' && <p className="dm-task-form-note">Device preparation uses explicit details in your request. It cannot read your inbox or infer missing details.</p>}
        </>}
        <div className="dm-task-field-pair"><label>Repeat<select value={value.schedule.frequency} onChange={e => schedule(e.target.value === 'daily' ? { frequency: 'daily', weekdays: undefined } : { frequency: 'weekly', weekdays: [7] })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Time<input type="time" value={value.schedule.time} required onChange={e => schedule({ time: e.target.value })} /></label></div>
        {value.schedule.frequency === 'weekly' && <div className="dm-routine-days" role="group" aria-label="Days of the week">{days.map((day, i) => <button type="button" key={day} aria-pressed={value.schedule.weekdays?.includes(i + 1) ?? false} onClick={() => schedule({ weekdays: value.schedule.weekdays?.includes(i + 1) ? value.schedule.weekdays.filter(d => d !== i + 1) : [...value.schedule.weekdays ?? [], i + 1].sort((a,b) => a-b) })}>{day}</button>)}</div>}
        <label>Routine timezone<input value={value.schedule.timezone} required onChange={e => schedule({ timezone: e.target.value })} /></label>
        <details className="dm-routine-options"><summary>Dates and details</summary>
          <div className="dm-task-field-pair"><label>Starts<input type="date" required value={value.schedule.startDate} onChange={e => schedule({ startDate: e.target.value })} /></label><label>Ends <span className="dm-task-optional">Optional</span><input type="date" value={value.schedule.endDate ?? ''} onChange={e => schedule({ endDate: e.target.value || undefined })} /></label></div>
          <label>Skip dates<textarea rows={2} value={exceptions} placeholder="2026-12-25" onChange={e => setExceptions(e.target.value)} /><span className="dm-task-form-note">YYYY-MM-DD, separated by commas or new lines.</span></label>
          {value.outcome.kind === 'personal_task' && <>
            <label>Task notes<textarea rows={2} maxLength={2000} value={value.outcome.task.notes} onChange={e => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, notes: e.target.value } } }) }} /></label>
            <div className="dm-task-field-pair"><label>Child<select value={value.outcome.task.childId ?? ''} onChange={e => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, childId: e.target.value || undefined } } }) }}><option value="">Whole family</option>{state.household?.children.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Due after (days)<input type="number" min={0} max={30} value={value.outcome.dueAfterDays} onChange={e => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, dueAfterDays: Number(e.target.value) } }) }} /></label></div>
          </>}
        </details>
      </fieldset>
      {next && <p className="dm-task-form-note">{routine && current?.state !== 'active' ? 'If enabled, next' : 'Next'}: {dateLabel(next, value.schedule.timezone)} · {value.schedule.timezone}</p>}
      {state.storage === 'device' && <p className="dm-notice">On this device, routines run when Daymark is open. After time away, only the latest missed occurrence is added.</p>}
      {state.storage !== 'device' && <p className="dm-task-form-note">Runs even when the app is closed. After an interruption, only the latest missed occurrence is prepared.</p>}
      {routine && <p className="dm-task-form-note">Changing or pausing this routine stops unfinished work from its earlier version. Completed tasks and recorded results remain.</p>}
      {error && <p className="dm-error" role="alert">{error}</p>}
      {!readOnly && <button type="submit" className="dm-primary dm-task-submit" disabled={busy || stale}>{busy ? 'Saving…' : routine ? 'Save changes' : 'Save routine'}</button>}
    </form>
    {routine && !readOnly && <><button className="dm-task-complete" disabled={busy || stale || !client.setRoutinePaused} onClick={() => void run(() => client.setRoutinePaused!(routine.id, version!, current?.state === 'active'))}>{current?.state === 'active' ? 'Pause routine' : 'Resume routine'}</button><div className="dm-task-remove">{removing ? <><p>Remove this routine? Existing tasks and results stay saved.</p><div className="dm-actions"><button disabled={busy || stale || !client.removeRoutine} onClick={() => void run(() => client.removeRoutine!(routine.id, version!))}>Remove routine</button><button disabled={busy} onClick={() => setRemoving(false)}>Keep it</button></div></> : <button className="dm-text-button" disabled={busy || stale} onClick={() => setRemoving(true)}>Remove routine</button>}</div></>}
    {routine && <details className="dm-routine-history"><summary>Recent occurrences</summary>{historyError && <p role="alert">{historyError}</p>}{runs === null && !historyError ? <p>Loading history…</p> : !runs?.length ? <p>No occurrences yet.</p> : <ul>{runs.map(r => <li key={r.id}><time>{r.localDate}</time><p>{r.summary}</p>{r.caughtUpFrom && <p className="dm-task-form-note">Latest missed occurrence after time away.</p>}{r.issue && <p>{r.issue}</p>}</li>)}</ul>}<p className="dm-task-form-note">Shows the latest 50 occurrences. A created task is not a completed chore.</p></details>}
  </dialog>
}

export default function Routines({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [editing, setEditing] = useState<Routine | 'new' | null>(null), [editingMail, setEditingMail] = useState<MailRoutine | 'new' | null>(null)
  const [notice, setNotice] = useState(''), [choosing, setChoosing] = useState(false)
  const routines = state.routines ?? [], mailRoutines = (state.mailRoutines ?? []).filter(row => row.state !== 'removed' && row.definition), count = routines.length + mailRoutines.length
  const selected = editing && editing !== 'new' ? editing : undefined
  if (!client.createRoutine && !client.createMailRoutine) return null
  return <section className="dm-routines" aria-label="Routines"><div className="dm-routine-heading"><h3><Repeat size={18} aria-hidden="true" />Routines</h3><button className="dm-text-button" aria-expanded={client.createMailRoutine ? choosing : undefined} onClick={() => { setNotice(''); if (client.createMailRoutine) setChoosing(value => !value); else setEditing('new') }}>Add routine</button></div>
    {choosing && <div className="dm-routine-choices" role="group" aria-label="Choose a routine trigger">{client.createRoutine && <button onClick={() => { setChoosing(false); setEditing('new') }}>On a schedule</button>}<button onClick={() => { setChoosing(false); setEditingMail('new') }}>When a new email arrives</button></div>}
    {notice && <p role="status" className="dm-task-form-note">{notice}</p>}
    {count > 0 && <details className="dm-routine-list" open={count <= 3}><summary>{count} saved {count === 1 ? 'routine' : 'routines'}</summary><ul>{routines.map(r => <li key={r.id}><button onClick={() => setEditing(r)} aria-label={`Open routine ${r.definition?.title}`}><span><strong>{r.definition?.title}</strong><span>{r.state === 'active' ? r.nextRunAt ? `Next ${dateLabel(r.nextRunAt, r.definition!.schedule.timezone)}` : 'Scheduled' : r.state === 'finished' ? 'Schedule ended' : r.state === 'blocked' ? 'Needs your attention' : 'Paused'}</span><span>{r.definition && routineScheduleLabel(r.definition)}</span></span><CaretRight size={16} aria-hidden="true" /></button></li>)}{mailRoutines.map(r => <li key={r.id}><button onClick={() => setEditingMail(r)} aria-label={`Open email routine ${r.definition!.title}`}><span><strong>{r.definition!.title}</strong><span>{r.issue ? 'Needs your attention' : r.state === 'active' ? 'Active for new emails' : 'Paused'}</span><span>New email · Private to you</span></span><CaretRight size={16} aria-hidden="true" /></button></li>)}</ul></details>}
    {editing && <RoutineEditor key={editing === 'new' ? editing : editing.id} state={state} client={client} routine={selected} close={() => setEditing(null)} saved={() => setNotice(editing === 'new' ? 'Routine saved.' : 'Routine updated.')} />}
    {editingMail && <MailRoutineEditor key={editingMail === 'new' ? 'new-email' : editingMail.id} state={state} client={client} routine={editingMail === 'new' ? undefined : editingMail} close={() => setEditingMail(null)} saved={setNotice} />}
  </section>
}
