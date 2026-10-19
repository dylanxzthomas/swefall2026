import AssistantWork from './AssistantWork'
import LearnedWorkflows from './LearnedWorkflows'
import PrivateTasks from './PrivateTasks'
import { MessageReview, PrivateMailDrafts, visiblePrivateMailDrafts } from './Mailbox'
import { PrivateMailFollowups, visibleMailFollowups } from './MailFollowthrough'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Routines from './Routines'
import { EmailTaskReviews } from './EmailWatches'
import { CaretRight, Check, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { ZodError } from 'zod'
import { isConversation, jobStatus, jobSummary, jobTitle, type TaskFilter } from '../../../shared/assistant'
import { instant } from '../../../shared/daymark'
import { assistantName } from '../../../shared/persona'
import { personalTaskSchema, validateSchedule, type PersonalTask, type PersonalTaskInput } from '../../../shared/tasks'
import AssistantAvatar from './AssistantAvatar'
import { jobAvatarMood } from '../../../shared/avatar'
import type { DaymarkClient, DaymarkState, Job } from './types'
import './tasks.css'

type Filter = 'all' | 'you' | 'assistant' | 'finished'
type Row = { kind: 'personal'; id: string; task: PersonalTask; createdAt: number } | { kind: 'assistant'; id: string; job: Job; createdAt: number }
const failureMessage = (error: unknown) => error instanceof ZodError ? error.issues[0]?.message ?? 'Check the task details.' : error instanceof Error ? error.message : 'This could not be saved. Your previous tasks are still available.'
const isScheduled = (job: Job) => Boolean(job.scheduledFor && !job.preparing && !job.actions.length && !job.cancelled)
const dueDate = (date: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
const scheduleDate = (time: number, timezone: string) => `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(time)} · ${timezone}`
function Sheet({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className="dm-sheet dm-task-sheet" aria-label={title} onCancel={event => { event.preventDefault(); close() }}><header><h2>{title}</h2><button onClick={close} aria-label="Close task details">Done</button></header>{children}</dialog>
}
function PersonalFields({ value, set, state }: { value: PersonalTaskInput; set(value: PersonalTaskInput): void; state: DaymarkState }) {
  return <div className="dm-task-fields">
    <label>Task<input value={value.title} maxLength={200} required placeholder="Return the permission slip" onChange={event => set({ ...value, title: event.target.value })} /></label>
    <label>Notes<textarea rows={3} value={value.notes} maxLength={2000} placeholder="Anything useful to remember" onChange={event => set({ ...value, notes: event.target.value })} /></label>
    <div className="dm-task-field-pair"><label>Due date <span className="dm-task-optional">Optional</span><input type="date" value={value.dueDate ?? ''} onChange={event => set({ ...value, dueDate: event.target.value || undefined })} /></label><label>Child<select value={value.childId ?? ''} onChange={event => set({ ...value, childId: event.target.value || undefined })}><option value="">Whole family</option>{state.household?.children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}</select></label></div>
  </div>
}
function NewTask({ state, client, close, compose, added }: { state: DaymarkState; client: DaymarkClient; close(): void; compose(text?: string): void; added(message: string): void }) {
  const name = assistantName(state.preferences), timezone = state.household?.timezone ?? 'UTC'
  const [owner, setOwner] = useState<'you' | 'assistant'>('you'), [value, setValue] = useState<PersonalTaskInput>({ title: '', notes: '' }), [request, setRequest] = useState(''), [later, setLater] = useState(false), [time, setTime] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), attempt = useRef<{ content: string; id: string }>()
  const submit = async () => {
    if (pending.current) return
    setError('')
    if (owner === 'assistant' && !later) { if (request.trim()) { close(); compose(request.trim()) } return }
    pending.current = true; setBusy(true)
    try {
      let content: string, input: PersonalTaskInput | undefined, runAt: number | undefined
      if (owner === 'you') { input = personalTaskSchema.parse(value); content = JSON.stringify(input) }
      else { const [date, clock] = time.split('T'); runAt = instant(date ?? '', clock ?? '', timezone).epochMilliseconds; validateSchedule(request, runAt); content = `${request.trim()}:${runAt}` }
      content = `${owner}:${content}`
      if (attempt.current?.content !== content) attempt.current = { content, id: crypto.randomUUID() }
      if (owner === 'you') {
        if (!client.createPersonalTask) throw new Error('Personal tasks are unavailable in this workspace.')
        await client.createPersonalTask(input!, attempt.current.id)
        added('Task added to your list.')
      } else {
        if (!client.scheduleRequest) throw new Error('Scheduled preparation is unavailable in this workspace.')
        await client.scheduleRequest(request.trim(), runAt!, attempt.current.id)
        added('Preparation scheduled. Any calendar change or message will still need your approval.')
      }
      close()
    } catch (error) { setError(failureMessage(error)) } finally { pending.current = false; setBusy(false) }
  }
  return <Sheet title="Add a task" close={() => { if (!pending.current) close() }}>
    <div className="dm-segmented dm-task-owner" role="group" aria-label="Task owner"><button aria-pressed={owner === 'you'} disabled={busy} onClick={() => { setOwner('you'); setError('') }}>For you</button><button aria-pressed={owner === 'assistant'} disabled={busy} onClick={() => { setOwner('assistant'); setError('') }}><AssistantAvatar name={name} avatar={state.preferences?.avatar} size={24} />{name}</button></div>
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <fieldset disabled={busy} className="dm-task-form-fields">{owner === 'you' ? <><p className="dm-task-form-note">Something for you to do. Check it off when it’s done.</p><PersonalFields value={value} set={setValue} state={state} /></> : <>
        <label>What should {name} prepare?<textarea rows={5} value={request} maxLength={20000} required placeholder="Draft a reply to school, prepare a calendar change, or arrange a pickup…" onChange={event => setRequest(event.target.value)} /></label>
        <label className="dm-check"><input type="checkbox" checked={later} onChange={event => setLater(event.target.checked)} />Prepare later</label>
        {later && <label>Preparation time<input type="datetime-local" required value={time} onChange={event => setTime(event.target.value)} /><span className="dm-task-form-note">In {timezone}.</span></label>}
        <p className="dm-task-form-note">{later ? 'This schedules preparation. Sending a message or changing a calendar still needs your approval.' : 'Continue in Assistant to send this request and review the prepared work.'}</p>
        {later && state.storage === 'device' && <p className="dm-notice">On this device, preparation runs when Daymark is open at or after the chosen time.</p>}
      </>}</fieldset>
      {error && <p role="alert" className="dm-error">{error}</p>}
      {owner === 'you' && !client.createPersonalTask && <p className="dm-notice">Personal tasks are unavailable in this workspace.</p>}
      {owner === 'assistant' && later && !client.scheduleRequest && <p className="dm-notice">Scheduled preparation is unavailable in this workspace.</p>}
      <button type="submit" className="dm-primary dm-task-submit" disabled={busy || (owner === 'you' ? !value.title.trim() || !client.createPersonalTask : !request.trim() || later && (!time || !client.scheduleRequest))}>{busy ? 'Saving…' : owner === 'you' ? 'Add task' : later ? 'Schedule preparation' : 'Continue in Assistant'}</button>
    </form>
  </Sheet>
}
function PersonalDetails({ task, state, client, close }: { task: PersonalTask; state: DaymarkState; client: DaymarkClient; close(): void }) {
  const [value, setValue] = useState<PersonalTaskInput>({ title: task.title, notes: task.notes, childId: task.childId, dueDate: task.dueDate }), [version, setVersion] = useState(task.version)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(''), [removing, setRemoving] = useState(false)
  const pending = useRef(false), stale = task.version > version, awaitingUpdate = task.version < version, blocked = stale || awaitingUpdate
  const run = async (operation: () => Promise<unknown>, removed = false, confirmation = 'Task saved.') => {
    if (pending.current || blocked) return
    pending.current = true; setBusy(true); setError(''); setSaved('')
    try { await operation(); if (removed) close(); else { setVersion(version + 1); setSaved(confirmation) } }
    catch (error) { setError(failureMessage(error)) } finally { pending.current = false; setBusy(false) }
  }
  return <Sheet title="Your task" close={() => { if (!pending.current) close() }}>
    <p className="dm-task-form-note">For you{task.done ? ' · Completed' : ''}</p>
    {stale && <p role="alert" className="dm-notice">This task changed elsewhere. Your edits are still here. Close and reopen it before saving, completing, or removing it.</p>}
    {awaitingUpdate && <p role="status" className="dm-muted">Updating your task…</p>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => { if (!client.updatePersonalTask) throw new Error('Task editing is unavailable in this workspace.'); await client.updatePersonalTask(task.id, version, personalTaskSchema.parse(value)) }) }}>
      <fieldset disabled={busy} className="dm-task-form-fields"><PersonalFields value={value} set={input => { setValue(input); setSaved('') }} state={state} /></fieldset>
      <button className="dm-primary dm-task-submit" type="submit" disabled={busy || blocked || !value.title.trim() || !client.updatePersonalTask}>Save task</button>
    </form>
    {saved && !blocked && <p role="status" className="dm-task-saved">{saved}</p>}
    {error && <p role="alert" className="dm-error">{error}</p>}
    <button className="dm-task-complete" disabled={busy || blocked || !client.setPersonalTaskDone} onClick={() => void run(() => client.setPersonalTaskDone!(task.id, version, !task.done), false, task.done ? 'Task marked as not done.' : 'Task marked complete.')}><Check size={18} aria-hidden="true" />{task.done ? 'Mark as not done' : 'Mark complete'}</button>
    <div className="dm-task-remove">{removing ? <><p>Remove this personal task?</p><div className="dm-actions"><button disabled={busy || blocked || !client.removePersonalTask} onClick={() => void run(() => client.removePersonalTask!(task.id, version), true)}>Remove task</button><button disabled={busy} onClick={() => setRemoving(false)}>Keep it</button></div></> : <button className="dm-text-button" disabled={busy || blocked || !client.removePersonalTask} onClick={() => setRemoving(true)}>Remove task</button>}</div>
  </Sheet>
}
export default function Tasks({ state, client, openJob, compose, openMailDraft, openMailProposal, initialFilter = 'All' }: { state: DaymarkState; client: DaymarkClient; openJob(id: string): void; compose(text?: string): void; openMailDraft?(id: string): void; openMailProposal?(id: string): void; initialFilter?: TaskFilter }) {
  const name = assistantName(state.preferences), timezone = state.household?.timezone ?? 'UTC'
  const [selectedMail, setSelectedMail] = useState<string | null>(null)
  const mailMessage = selectedMail ? state.mailboxMessages?.find(m => m.id === selectedMail) ?? state.mailboxRuns?.flatMap(r => r.messages).find(m => m.id === selectedMail) : undefined
  const [filter, setFilter] = useState<Filter>(initialFilter === 'Finished' ? 'finished' : initialFilter === 'Needs you' ? 'you' : initialFilter === 'Working' ? 'assistant' : 'all'), [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false), [selected, setSelected] = useState<{ kind: 'personal'; id: string } | null>(null), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const pending = useRef(false), personal = state.personalTasks ?? [], jobs = state.jobs.filter(job => !isConversation(job)), filters: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'you', label: 'For you' }, { id: 'assistant', label: name }, { id: 'finished', label: 'Finished' }]
  const rows: Row[] = [...personal.map(task => ({ kind: 'personal' as const, id: task.id, task, createdAt: task.createdAt })), ...jobs.map(job => ({ kind: 'assistant' as const, id: job._id, job, createdAt: job.createdAt ?? 0 }))]
  const needle = search.trim().toLocaleLowerCase()
  const privateMatches=(state.privateTasks ?? []).filter(task=>filter!=='assistant' && (filter!=='you'||!task.done) && (filter!=='finished'||task.done) && (!needle||`${task.title} ${task.text}`.toLocaleLowerCase().includes(needle)))
  const visible = rows.filter(row => {
    const finished = row.kind === 'personal' ? row.task.done : jobStatus(row.job) === 'Finished'
    const needsYou = row.kind === 'personal' ? !row.task.done : jobStatus(row.job) === 'Needs you'
    if (filter === 'you' && !needsYou || filter === 'assistant' && row.kind !== 'assistant' || filter === 'finished' && !finished) return false
    const text = row.kind === 'personal' ? `${row.task.title} ${row.task.notes} ${row.task.dueDate ?? ''} ${state.household?.children.find(child => child.id === row.task.childId)?.name ?? ''}` : `${jobTitle(row.job, state.household?.children)} ${jobSummary(row.job, state)} ${row.job.source?.text ?? ''} ${row.job.actions.map(action => state.household?.children.find(child => child.id === action.payload.childId)?.name ?? '').join(' ')}`
    return !needle || text.toLocaleLowerCase().includes(needle)
  }).sort((a, b) => Number(a.kind === 'personal' ? a.task.done : jobStatus(a.job) === 'Finished') - Number(b.kind === 'personal' ? b.task.done : jobStatus(b.job) === 'Finished') || b.createdAt - a.createdAt)
  const selectedPersonal = selected?.kind === 'personal' ? personal.find(task => task.id === selected.id) : undefined
  const toggle = async (task: PersonalTask) => {
    if (pending.current) return
    pending.current = true; setBusy(task.id); setError(''); setNotice('')
    try { if (!client.setPersonalTaskDone) throw new Error('Task editing is unavailable in this workspace.'); await client.setPersonalTaskDone(task.id, task.version, !task.done) }
    catch (error) { setError(failureMessage(error)) } finally { pending.current = false; setBusy(null) }
  }
  const loading = state.loading || Boolean(client.createPersonalTask && state.personalTasks === undefined)
  return <section className="dm-tasks" aria-label="Tasks">
    <div className="dm-page-heading dm-task-heading"><div><h2>Tasks</h2><p>A little less to carry.</p></div><button className="dm-task-new" onClick={() => { setAdding(true); setNotice('') }} aria-label="Add a task"><Plus size={22} aria-hidden="true" /></button></div>
    <AssistantWork state={state} runs={state.assistantRuns ?? []} client={client} openJob={openJob}/>{state.learnedWorkflows?.length && client.editLearnedWorkflow && client.approveLearnedWorkflow && client.dismissLearnedWorkflow ? <LearnedWorkflows proposals={state.learnedWorkflows} state={state} onUpdate={client.editLearnedWorkflow} onApprove={client.approveLearnedWorkflow} onDismiss={client.dismissLearnedWorkflow}/> : null}<div className="dm-segmented dm-task-filters" role="group" aria-label="Filter tasks">{filters.map(value => <button key={value.id} aria-pressed={filter === value.id} onClick={() => setFilter(value.id)} title={value.label}>{value.label}</button>)}</div>
    {filter !== 'finished' && <><Routines state={state} client={client} /><EmailTaskReviews suggestions={state.emailTaskSuggestions} children={state.household?.children} onSaveTask={client.saveEmailTask} onDismissTask={client.dismissEmailTask} /></>}
    <PrivateMailFollowups proposals={state.mailProposals ?? []} client={client} filter={filter} search={search} openSource={setSelectedMail} openProposal={openMailProposal} shared={openJob} />
    <PrivateMailDrafts state={state} client={client} filter={filter} search={search} openDraft={openMailDraft} />
    {client.updatePrivateTask && client.setPrivateTaskDone && client.removePrivateTask && <PrivateTasks tasks={privateMatches} limited={state.privateTasksLimited} onUpdate={client.updatePrivateTask} onSetDone={client.setPrivateTaskDone} onRemove={client.removePrivateTask}/>}
    {(rows.length > 0 || (state.privateTasks?.length ?? 0)>0 || (state.mailDrafts?.length ?? 0)>0) && <label className="dm-task-search"><span className="dm-sr-only">Search tasks</span><MagnifyingGlass size={18} aria-hidden="true" /><input className="dm-search" type="search" placeholder="Search tasks" value={search} onChange={event => setSearch(event.target.value)} /></label>}
    {error && <p role="alert" className="dm-error">{error}</p>}{notice && <p role="status" className="dm-notice">{notice}</p>}
    {loading ? <p role="status" className="dm-muted dm-task-loading">Loading your tasks…</p> : visible.length ? <ul className="dm-task-list">{visible.map(row => row.kind === 'personal' ? <li key={`personal:${row.id}`} className={`dm-task-personal${row.task.done ? ' dm-task-done' : ''}`}>
      <label className="dm-task-checkbox"><input type="checkbox" aria-label={`Mark ${row.task.title} ${row.task.done ? 'not done' : 'complete'}`} checked={row.task.done} disabled={busy !== null || !client.setPersonalTaskDone} onChange={() => void toggle(row.task)} /><span aria-hidden="true">{row.task.done && <Check size={15} weight="bold" />}</span></label>
      <button className="dm-task-row" aria-label={`Edit ${row.task.title}`} onClick={() => setSelected({ kind: 'personal', id: row.id })}><span className="dm-task-copy"><span className="dm-task-status">For you{row.task.done ? ' · Done' : ''}{row.task.childId ? ` · ${state.household?.children.find(child => child.id === row.task.childId)?.name ?? 'Child'}` : ''}</span><strong>{row.task.title}</strong>{row.task.dueDate && <span className="dm-task-due">Due {dueDate(row.task.dueDate)}</span>}{row.task.notes && <span className="dm-task-summary">{row.task.notes}</span>}</span><CaretRight className="dm-task-arrow" size={16} aria-hidden="true" /></button>
    </li> : <li key={`assistant:${row.id}`}><button className="dm-task-row dm-task-assistant" onClick={() => openJob(row.id)}><AssistantAvatar className="dm-task-avatar" name={name} avatar={state.preferences?.avatar} size={30} mood={jobAvatarMood(row.job)} /><span className="dm-task-copy"><span className="dm-task-status">{name} · {isScheduled(row.job) ? 'Scheduled' : jobStatus(row.job)}{[...new Set(row.job.actions.flatMap(action => { const child = state.household?.children.find(child => child.id === action.payload.childId); return child ? [child.name] : [] }))].map(child => ` · ${child}`).join('')}</span><strong>{jobTitle(row.job, state.household?.children)}</strong><span className="dm-task-summary">{isScheduled(row.job) ? `Prepare ${scheduleDate(row.job.scheduledFor!, timezone)}` : jobSummary(row.job, state)}</span></span><CaretRight className="dm-task-arrow" size={16} aria-hidden="true" /></button></li>)}</ul> : privateMatches.length > 0 || visibleMailFollowups(state.mailProposals ?? [], filter, search).length > 0 || visiblePrivateMailDrafts(state.mailDrafts ?? [], filter, search).length > 0 ? null : filter !== 'finished' && state.emailTaskSuggestions?.some(suggestion => suggestion.status === 'proposed') ? null : <div className="dm-task-empty" role="status"><h3>{needle ? 'No matching tasks.' : filter === 'you' ? 'Nothing needs you right now.' : filter === 'assistant' ? `Nothing with ${name} yet.` : filter === 'finished' ? 'A place for the things you finish.' : 'Your list has room to breathe.'}</h3>{!needle && <p>{filter === 'all' ? `Keep your own to-dos beside the work ${name} prepares for you.` : filter === 'you' ? 'Your to-dos and requests ready for your review will appear here.' : filter === 'assistant' ? 'School replies, calendar changes, and pickup requests stay together here.' : 'Completed personal tasks and finished requests stay here.'}</p>}{!needle && filter === 'all' && <button onClick={() => setAdding(true)}>Add your first task</button>}</div>}
    {mailMessage && <MessageReview message={mailMessage} state={state} client={client} close={() => setSelectedMail(null)} shared={openJob} />}
    {adding && <NewTask state={state} client={client} close={() => setAdding(false)} compose={compose} added={message => { setNotice(message); setFilter('all'); setSearch('') }} />}
    {selectedPersonal && <PersonalDetails key={selectedPersonal.id} task={selectedPersonal} state={state} client={client} close={() => setSelected(null)} />}
  </section>
}
