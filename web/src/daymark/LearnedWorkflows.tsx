import { useRef, useState } from 'react'
import type { LearnedProposal } from '../../../shared/learnedWorkflows'
import { learnedCandidateSchema } from '../../../shared/learnedWorkflows'
import type { FamilyFact } from '../../../shared/memory'
import type { RoutineDefinition } from '../../../shared/routines'
import type { MailRoutineDefinition } from '../../../shared/mailRoutines'
import { assistantName } from '../../../shared/persona'
import type { DaymarkState } from './types'
import FamilyFactFields from './FamilyFactFields'
import { MailRoutineFields } from './MailRoutines'

type LearnedValue = FamilyFact | RoutineDefinition | MailRoutineDefinition

export type LearnedWorkflowActions = {
  onUpdate(id: string, version: number, value: LearnedValue): Promise<number>
  onApprove(id: string, version: number, value: LearnedValue, shareConfirmed: boolean): Promise<unknown>
  onDismiss(id: string, version: number): Promise<unknown>
}
export default function LearnedWorkflows({ proposals, state, ...actions }: { proposals: LearnedProposal[]; state: DaymarkState } & LearnedWorkflowActions) {
  const [selected, setSelected] = useState<string | null>(null)
  if (!proposals.length) return null
  return <section aria-label="Learning suggestions"><h3>A little less to repeat</h3><p className="dm-muted">Private suggestions. Nothing is remembered or scheduled until you review it.</p>{proposals.map(proposal => <section className="dm-setting-item" key={proposal._id}>{selected === proposal._id ? <LearningReview proposal={proposal} state={state} {...actions} close={() => setSelected(null)} /> : <><strong>{proposal.title}</strong><p className="dm-muted">{proposal.reason}</p><button onClick={() => setSelected(proposal._id)}>Review suggestion</button></>}</section>)}</section>
}
function LearningReview({ proposal, state, close, onUpdate, onApprove, onDismiss }: { proposal: LearnedProposal; state: DaymarkState; close(): void } & LearnedWorkflowActions) {
  const [value, setValue] = useState<LearnedValue>(() => structuredClone(proposal.value)), [version, setVersion] = useState(proposal.version), [share, setShare] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false)
  const pending = useRef(false), stale = proposal.version !== version, expired = proposal.expiresAt <= Date.now(), privateRoutine = proposal.kind === 'mail_routine'
  const set = (next: LearnedValue) => { setValue(next); setShare(false); setSaved(false) }
  const run = async (operation: () => Promise<unknown>) => { if (pending.current || stale || expired) return; pending.current = true; setBusy(true); setError(''); try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your edits are still here. Try again.') } finally { pending.current = false; setBusy(false) } }
  const checked = () => learnedCandidateSchema.parse({ kind: proposal.kind, title: proposal.title, reason: proposal.reason, quote: proposal.quote, value }).value
  return <section className="dm-fields" aria-label="Review learning suggestion"><h4>{proposal.title}</h4><blockquote>{proposal.quote}</blockquote><p className="dm-muted">{proposal.reason}</p>
    {stale && <p role="alert">This suggestion changed. Your edits are preserved; close and reopen it before saving.</p>}
    <fieldset disabled={busy || stale || expired}>
      {proposal.kind === 'fact' ? <FamilyFactFields state={state} value={value as FamilyFact} onChange={set} disabled={busy || stale} /> : privateRoutine ? <MailRoutineFields value={value as MailRoutineDefinition} onChange={set} name={assistantName(state.preferences)} /> : <RoutineFields value={value as RoutineDefinition} set={set} state={state} />}
      {!privateRoutine && <label><input type="checkbox" checked={share} onChange={event => setShare(event.target.checked)} />Share this exact reviewed {proposal.kind === 'fact' ? 'detail' : 'routine'} with the adults in my household.</label>}
      <p className="dm-muted">{proposal.kind === 'fact' ? 'Confirming adds this to household memory. It does not replace existing details.' : privateRoutine ? 'Saved privately and paused. Activate it in Routines for new emails received from then on, using only your connected Gmail. Sending emails and changing calendars still need your approval.' : 'Saved routines start paused. Review the schedule and enable it in Routines. Only the latest missed occurrence is prepared; each external action still needs approval.'}</p>
    </fieldset>
    {saved && <p role="status">{privateRoutine ? 'Edits saved privately. Save the paused routine when you’re ready.' : 'Edits saved. Confirm sharing when you’re ready.'}</p>}{error && <p role="alert">{error}</p>}
    <div className="dm-actions"><button disabled={busy || stale || expired} onClick={() => void run(async () => { setVersion(await onUpdate(proposal._id, version, checked())); setShare(false); setSaved(true) })}>{busy ? 'Saving…' : 'Save edits'}</button><button disabled={busy || stale || expired || !privateRoutine && !share} onClick={() => void run(async () => { await onApprove(proposal._id, version, checked(), privateRoutine ? false : share); close() })}>{proposal.kind === 'fact' ? 'Confirm and remember' : privateRoutine ? 'Save private routine' : 'Save paused routine'}</button><button disabled={busy || stale || expired} onClick={() => void run(async () => { await onDismiss(proposal._id, version); close() })}>Dismiss</button><button disabled={busy} onClick={close}>Review later</button></div>
  </section>
}
function RoutineFields({ value, set, state }: { value: RoutineDefinition; set(value: RoutineDefinition): void; state: DaymarkState }) {
  const schedule = (change: Partial<RoutineDefinition['schedule']>) => set({ ...value, schedule: { ...value.schedule, ...change } })
  return <><label>Routine name<input maxLength={200} value={value.title} onChange={event => set({ ...value, title: event.target.value })} /></label>
    <label>Outcome<select value={value.outcome.kind} onChange={event => set({ ...value, outcome: event.target.value === 'personal_task' ? { kind: 'personal_task', task: { title: '', notes: '' }, dueAfterDays: 0 } : { kind: 'prepare_request', instruction: '' } })}><option value="personal_task">Add a task for me</option><option value="prepare_request">Prepare work for review</option></select></label>
    {value.outcome.kind === 'personal_task' ? <><label>Task<input maxLength={200} value={value.outcome.task.title} onChange={event => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, title: event.target.value } } }) }} /></label><label>Notes<textarea maxLength={2000} value={value.outcome.task.notes} onChange={event => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, notes: event.target.value } } }) }} /></label><label>Child<select value={value.outcome.task.childId ?? ''} onChange={event => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, task: { ...value.outcome.task, childId: event.target.value || undefined } } }) }}><option value="">Whole family</option>{state.household?.children.map(child => <option value={child.id} key={child.id}>{child.name}</option>)}</select></label><label>Due after (days)<input type="number" min={0} max={30} value={value.outcome.dueAfterDays} onChange={event => { if (value.outcome.kind === 'personal_task') set({ ...value, outcome: { ...value.outcome, dueAfterDays: Number(event.target.value) } }) }} /></label></> : <label>What to prepare<textarea maxLength={20000} value={value.outcome.instruction} onChange={event => set({ ...value, outcome: { kind: 'prepare_request', instruction: event.target.value } })} /></label>}
    <label>Repeat<select value={value.schedule.frequency} onChange={event => schedule(event.target.value === 'daily' ? { frequency: 'daily', weekdays: undefined } : { frequency: 'weekly', weekdays: [1] })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Time<input type="time" value={value.schedule.time} onChange={event => schedule({ time: event.target.value })} /></label><label>Timezone<input value={value.schedule.timezone} onChange={event => schedule({ timezone: event.target.value })} /></label>
    {value.schedule.frequency === 'weekly' && <div role="group" aria-label="Routine weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => <button type="button" key={day} aria-pressed={value.schedule.weekdays?.includes(i + 1) ?? false} onClick={() => schedule({ weekdays: value.schedule.weekdays?.includes(i + 1) ? value.schedule.weekdays.filter(d => d !== i + 1) : [...value.schedule.weekdays ?? [], i + 1] })}>{day}</button>)}</div>}
    <label>Starts<input type="date" value={value.schedule.startDate} onChange={event => schedule({ startDate: event.target.value })} /></label><label>Ends (optional)<input type="date" value={value.schedule.endDate ?? ''} onChange={event => schedule({ endDate: event.target.value || undefined })} /></label><label>Skip dates<textarea value={(value.schedule.exceptDates ?? []).join('\n')} onChange={event => schedule({ exceptDates: event.target.value.split(/[\s,]+/).filter(Boolean) })} placeholder="YYYY-MM-DD" /></label>
  </>
}
