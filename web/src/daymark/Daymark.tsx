import { reviewStatus, showReviewGuidance } from './reviewStatus'
import PickupEmailReview, { type PickupReviewState } from './PickupEmailReview'
import { ExternalCalendarEvent } from './ExternalCalendarEvent'
import { calendarPlanStatus } from '../../../shared/calendarPlan'
import { VoiceConversation, VoiceCallDisplay, type VoiceCallSnapshot } from './VoiceConversation'
import ConversationMessage from './ConversationMessage'
import { conversationActivity, conversationReply, conversationTargetId, conversationUpdates } from './conversation'
import { useConversationAnnouncements } from './useConversationAnnouncements'
import './conversation.css'
import AssistantWork from './AssistantWork'
import { CalendarFeeds } from './CalendarFeeds'
import WorkingMemorySettings from './WorkingMemorySettings'
import ConnectionSettings, { selectedAccount } from './ConnectionSettings'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Preferences } from '@capacitor/preferences'
import { blockers, localDateTime, dateTimeInstant, type Payload, type CalendarDraft as CalendarPayload } from '../../../shared/daymark'
import type { DaymarkClient, DaymarkState, Job, Deliverable, IncomingPickup } from './types'
import '@fontsource-variable/geist/wght.css'
import './daymark.css'
import './householdSettings.css'
import FamilyMemory from './FamilyMemory'
import { GmailConnection, PrivateMailRun, PrivateMailReplyReview, PrivateMailProposalConversation, privateReplyStatus } from './Mailbox'
import { visibleMailFollowups } from './MailFollowthrough'
import ConnectorRequests from './ConnectorRequests'
import GmailSource from './GmailSource'
import Personalization from './Personalization'
import AssistantAvatar from './AssistantAvatar'
import { headerAvatarMood, jobAvatarMood } from '../../../shared/avatar'
import { assistantName as displayAssistantName, householdLabel } from '../../../shared/persona'
import Tasks from './Tasks'
import { RoutineEditor } from './Routines'
import { routineFromRequest } from '../../../shared/routineIntent'
import { parseMemoryRequest } from '../../../shared/memoryProposals'
import { parseMailboxRequest } from '../../../shared/mailbox'
import { connectorErrorMessage } from '../../../shared/connectorErrors'
import { connectionReturn } from '../../../shared/authentication'
import { MemoryProposalReview } from './MemoryProposals'
import Library from './Library'
import { isConversation } from '../../../shared/assistant'
import { availabilityAt } from '../../../shared/memory'
import { readFiles, saveFiles } from './outbox'
import { native } from './session'
import { App as NativeApp } from '@capacitor/app'
import { NativeIntake, sharedFiles, type SharedNotice } from './nativeIntake'
import { ArrowUp, BookmarkSimple, CalendarBlank, CaretRight, ChatCircle, CheckSquare, ClockCounterClockwise, EnvelopeSimple, GearSix, PencilSimple, Plus, Microphone, SquaresFour, UsersThree } from '@phosphor-icons/react'
import ArtifactPreview, { noticeDate } from './ArtifactPreview'
import ConversationRetry from './ConversationRetry'
import { useConversationScroll } from './useConversationScroll'
import { preserveNativeKeyboardScroll } from './nativeKeyboardScroll'
const draftKey = 'daymark.request-draft.v1'
const title = (a: Deliverable) => a.payload.kind === 'calendar' ? a.payload.title || 'Calendar change' : a.payload.kind === 'email' ? a.payload.subject || 'School email' : 'Pickup request'
function Sheet({ label, close, children }: { label: string; close(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog className="dm-sheet" ref={ref} aria-label={label} onCancel={e => { e.preventDefault(); close() }}><header><h2>{label}</h2><button className="dm-sheet-done" onClick={close} aria-label="Close">Done</button></header>{children}</dialog>
}
function SourceFile({ file, client }: { file: NonNullable<Job['files']>[number]; client: DaymarkClient }) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return <div><button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setUrl(URL.createObjectURL(await client.readFile(file.id))) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>{file.name} · {Math.ceil(file.size / 1024)} KB</button>{error && <p role="alert">{error}</p>}{url && <Sheet label={file.name} close={() => setUrl('')}>{file.mediaType.startsWith('image/') ? <img src={url} alt="Original shared notice" style={{ width: '100%', height: 'auto' }} /> : <iframe src={url} title="Original shared PDF" sandbox="" style={{ width: '100%', height: '75dvh', border: 0 }} />}</Sheet>}</div>
}
function Fields({ p, set, state, files = [] }: { p: Payload; set(p: Payload): void; state: DaymarkState; files?: Job['files'] }) {
  const field = (label: string, key: string, type = 'text') => <label>{label}<input type={type} value={(p as any)[key] ?? ''} onChange={e => set({ ...p, ...(p.kind === 'pickup' && ['date', 'time', 'timezone', 'location'].includes(key) ? { calendarUpdate: undefined } : {}), [key]: e.target.value || (key.endsWith('Time') || key === 'time' ? null : '') })} /></label>
  return <div className="dm-fields"><label>Child<select value={p.childId ?? ''} onChange={e => set({ ...p, childId: e.target.value || null, ...(p.kind === 'pickup' ? { caregiverId: null, calendarUpdate: undefined } : {}) })}><option value="">Choose child</option>{state.household?.children.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    {p.kind === 'calendar' ? <>
      {p.targetId && <label className="dm-check"><input type="checkbox" checked={p.operation === 'delete'} onChange={e => set({ ...p, operation: e.target.checked ? 'delete' : 'save' })} />{state.storage === 'device' ? 'Remove this event from the device plan' : 'Remove this event from the Daymark calendar'}</label>}{field('Event', 'title')}<label>Calendar operation<select value={p.targetId ?? ''} onChange={e => set({ ...p, targetId: e.target.value || null })}><option value="">{state.storage === 'device' ? 'Add to device plan' : 'Add to Daymark calendar'}</option>{state.plan.filter(e => e.payload.kind === 'calendar').map(e => <option key={e._id} value={e._id}>Update: {e.payload.kind === 'calendar' && `${e.payload.title} · ${e.payload.date}`}</option>)}</select></label>
      <label className="dm-check"><input type="checkbox" checked={p.allDay} onChange={e => set({ ...p, allDay: e.target.checked })} />Explicitly an all-day event or date-only deadline</label>
      <div className="dm-pair">{field('Date', 'date', 'date')}{field(p.allDay ? 'Last day' : 'End date', 'endDate', 'date')}</div>
      {!p.allDay && <div className="dm-pair">{field('Start time', 'startTime', 'time')}{field('End time', 'endTime', 'time')}</div>}
      {field('Timezone', 'timezone')}{field('Location', 'location')}<label>Details<textarea value={p.notes} onChange={e => set({ ...p, notes: e.target.value })} /></label>
    </> : p.kind === 'email' ? <>
      <label>Saved school contact<select value="" onChange={e => set({ ...p, to: e.target.value })}><option value="">Choose a confirmed contact</option>{state.facts?.filter(f => f.value.kind === 'contact' && f.value.childId === p.childId).map(f => f.value.kind === 'contact' && <option key={f._id} value={f.value.email}>{f.value.name} · {f.value.email}</option>)}</select></label>{field('To', 'to', 'email')}{field('Subject', 'subject')}<label>Message<textarea rows={7} value={p.body} onChange={e => set({ ...p, body: e.target.value })} /></label>
      <fieldset><legend>Attachments</legend>{files.length ? files.map(f => <label key={f.id} className="dm-check"><input type="checkbox" checked={p.attachments?.some(a => a.id === f.id) ?? false} onChange={e => set({ ...p, attachments: e.target.checked ? [...(p.attachments ?? []), { id: f.id, name: f.name, hash: f.hash }] : p.attachments?.filter(a => a.id !== f.id) })} />{f.name} · {Math.ceil(f.size / 1024)} KB</label>) : <p>No source files available to attach.</p>}</fieldset>
      {p.requirement && <p role="note" className="dm-notice">{p.requirement}</p>}<p className="dm-muted">{state.storage === 'device' ? 'Copy this draft to your mail app. Copying does not send an email.' : `Sent through your selected ${selectedAccount(state, 'email')?.provider === 'microsoft' ? 'Outlook' : 'Gmail'} account. A sent email does not confirm school acceptance.`}</p>
    </> : <>
      <label>Eligible caregiver<select value={p.caregiverId ?? ''} onChange={e => set({ ...p, caregiverId: e.target.value || null, calendarUpdate: undefined })}><option value="">Choose caregiver</option>{state.caregivers.filter(c => p.childId && c.childIds.includes(p.childId)).map(c => <option key={c._id} value={c._id}>{c.name} · {c.email}</option>)}</select></label>
      <div className="dm-pair">{field('Pickup date', 'date', 'date')}{field('Pickup time', 'time', 'time')}</div>{field('Timezone', 'timezone')}{field('Location', 'location')}<label>Reply by<input type="datetime-local" value={localDateTime(p.deadline, p.timezone)} onChange={e => set({ ...p, deadline: dateTimeInstant(e.target.value, p.timezone) })} /></label>
      {p.caregiverId && p.date && p.time && <p className="dm-muted">{(() => { try { const status = availabilityAt((state.facts ?? []).map(f => f.value), p.caregiverId!, p.date, p.time!, p.timezone, state.household?.timezone); return status === 'available' ? 'Availability explicitly confirmed in household settings. Caregiver acceptance is still required.' : status === 'busy' ? 'Saved availability says this caregiver is unavailable. Choose another option.' : 'Availability is unknown; no availability has been inferred from an empty calendar.' } catch { return 'Confirm the pickup time to check saved availability.' } })()}</p>}
      {state.storage !== 'device' && <details><summary>Calendar update after acceptance</summary><p>This exact change will run only after this caregiver accepts. Review the responsibility and time below.</p><label>Calendar change<select value={p.calendarUpdate?.targetId ?? (p.calendarUpdate ? 'new' : '')} onChange={e => {
        const target = state.plan.find(event => event._id === e.target.value)
        const name = state.caregivers.find(c => c._id === p.caregiverId)?.name ?? 'Chosen caregiver'
        if (!e.target.value) set({ ...p, calendarUpdate: undefined })
        else if (target?.payload.kind === 'calendar') set({ ...p, calendarUpdate: { ...target.payload, targetId: target._id, notes: `${target.payload.notes}\nConfirmed pickup: ${name} · ${p.date} ${p.time ?? ''} · ${p.location}`.trim() } })
        else set({ ...p, calendarUpdate: { kind: 'calendar', childId: p.childId, title: `Pickup · ${name}`, date: p.date, endDate: p.date, startTime: p.time, endTime: null, allDay: false, timezone: p.timezone, location: p.location, notes: `Confirmed pickup: ${name}`, evidence: {}, targetId: null } })
      }}><option value="">No calendar change</option><option value="new">Add pickup to Daymark calendar</option>{state.plan.filter(e => e.payload.kind === 'calendar' && e.payload.childId === p.childId).map(e => <option key={e._id} value={e._id}>{e.payload.kind === 'calendar' && `${e.payload.title} · ${e.payload.date}`}</option>)}</select></label>{p.calendarUpdate && <Fields p={p.calendarUpdate} state={state} set={value => { if (value.kind === 'calendar') set({ ...p, calendarUpdate: value }) }} />}</details>}
      <label>Request message<textarea rows={5} value={p.message} onChange={e => set({ ...p, message: e.target.value })} /></label><p className="dm-muted">{state.storage === 'device' ? 'Copy this request to send it yourself. No caregiver has been contacted or confirmed.' : 'One request through the caregiver’s chosen channel. No follow-up unless you choose one below. Acceptance confirms the arrangement, not that pickup happened.'}</p>{state.storage !== 'device' && <><label className="dm-check"><input type="checkbox" checked={p.followUpAt !== undefined} onChange={e => set({ ...p, followUpAt: e.target.checked ? '' : undefined })} />Allow one reminder with the same message</label>{p.followUpAt !== undefined && <label>Send one reminder at<input type="datetime-local" value={localDateTime(p.followUpAt, p.timezone)} onChange={e => set({ ...p, followUpAt: dateTimeInstant(e.target.value, p.timezone) })} /></label>}</>}
    </>}
  </div>
}
function Revision({ action, busy, request, keep }: { action: Deliverable; busy: boolean; request(instruction: string): void; keep(): void }) {
  const [instruction, setInstruction] = useState('')
  if (action.revisionRequest) return <div className="dm-notice"><p role="status">Preparing your change. This draft cannot run until you review and approve it again.</p><button disabled={busy} onClick={keep}>Keep current draft</button></div>
  return <details className="dm-revision"><summary><ChatCircle size={17} aria-hidden="true" />Ask for a change</summary><label>What should change?<textarea rows={2} maxLength={2000} value={instruction} placeholder={action.payload.kind === 'email' ? 'Make it shorter. Don’t include the reason.' : 'Change the date or pickup details…'} onChange={e => setInstruction(e.target.value)} /></label><p className="dm-muted">I’ll revise this draft for you to review. Nothing is sent.</p><button disabled={busy || !instruction.trim()} onClick={() => request(instruction)}>Revise draft</button></details>
}
function Review({ job, state, client, close, openHousehold }: { job: Job; state: DaymarkState; client: DaymarkClient; close(): void; openHousehold(): void }) {
  const reviewClock = useRef({ accumulated: 0, start: performance.now(), active: document.visibilityState === 'visible' })
  const reviewTime = () => reviewClock.current.accumulated + (reviewClock.current.active ? performance.now() - reviewClock.current.start : 0)
  useEffect(() => { const changed = () => { reviewClock.current.accumulated = reviewTime(); reviewClock.current.start = performance.now(); reviewClock.current.active = document.visibilityState === 'visible' }; document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) }, [])

  const editable = job.actions.filter(a => ['review', 'failed', 'queued'].includes(a.status))
  const base = useRef(Object.fromEntries(editable.map(a => [a._id, { revision: a.revision, payload: structuredClone(a.payload) }])))
  const [drafts, setDrafts] = useState<Record<string, Payload>>(Object.fromEntries(editable.map(a => [a._id, structuredClone(a.payload)])))
  const [pickupReviews, setPickupReviews] = useState<Record<string, PickupReviewState>>({})
  const [selected, setSelected] = useState<string[]>(editable.map(a => a._id))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [libraryNotice, setLibraryNotice] = useState(''), [source, setSource] = useState(job.source?.text ?? '')
  // Follow only a requested revision. Unrelated remote changes still require an explicit reload,
  // so another action's unsaved manual edits are never silently replaced.
  const following = useRef(new Map(editable.filter(a => a.revisionRequest).map(a => [a._id, a.revision])))
  useEffect(() => {
    const updates = job.actions.filter(a => following.current.has(a._id) && a.revision >= following.current.get(a._id)!)
    if (!updates.length) return
    for (const a of updates) {
      base.current[a._id] = { revision: a.revision, payload: structuredClone(a.payload) }
      if (!a.revisionRequest) following.current.delete(a._id)
    }
    setDrafts(current => ({ ...current, ...Object.fromEntries(updates.map(a => [a._id, structuredClone(a.payload)])) }))
  }, [job.actions])
  const run = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await fn() } catch (e) { setError(state.storage === 'device' && e instanceof Error ? e.message : connectorErrorMessage(e)) } finally { setBusy(false) } }
  const calendarAccount = selectedAccount(state, 'calendar')
  const nativeDestination = state.storage === 'device' ? state.nativeCalendar?.selectedId ? { calendarId: state.nativeCalendar.selectedId, version: state.nativeCalendar.version } : undefined : calendarAccount?.provider === 'apple' && calendarAccount.calendarId ? { calendarId: calendarAccount.calendarId, version: calendarAccount.version ?? 0 } : undefined
  const selectionStamp = `${state.accounts?.version ?? 0}:${nativeDestination?.calendarId ?? ''}:${nativeDestination?.version ?? 0}`
  const reviewedSelection = useRef(selectionStamp)
  const stale = reviewedSelection.current !== selectionStamp || editable.some(a => base.current[a._id]?.revision !== a.revision)
  const reloadDrafts = () => { reviewedSelection.current = selectionStamp; base.current = Object.fromEntries(editable.map(a => [a._id, { revision: a.revision, payload: structuredClone(a.payload) }])); setDrafts(Object.fromEntries(editable.map(a => [a._id, structuredClone(a.payload)]))); setError('') }
  const save = async () => { if (stale) throw new Error('This review changed. Load the latest version before approving.'); const revised = new Map<string, number>(); for (const a of editable) { if (JSON.stringify(drafts[a._id]) !== JSON.stringify(base.current[a._id].payload)) { await client.edit(a._id, base.current[a._id].revision, drafts[a._id]); base.current[a._id] = { revision: a.revision + 1, payload: structuredClone(drafts[a._id]) }; revised.set(a._id, a.revision + 1) } } return revised }
  const missingConnection = (p: Payload) => {
    if (state.storage === 'device') return null
    const purpose = p.kind === 'email' ? 'gmail' : p.kind === 'calendar' || p.calendarUpdate ? 'calendar' : null
    if (!purpose) return null
    const account = selectedAccount(state, purpose === 'gmail' ? 'email' : 'calendar')
    return !account || !(purpose === 'calendar' ? account.calendar : account.mail) ? purpose : null
  }
  const pickupStamp = (p: Payload) => JSON.stringify([p, state.accounts, state.household?.children, state.caregivers])
  const included = editable.filter(a => selected.includes(a._id)), blocked = included.flatMap(a => {
    const p = drafts[a._id] ?? a.payload, missing = missingConnection(p)
    if (state.storage === 'device' && state.nativeCalendar?.selectedId && included.some(a => a.payload.kind === 'calendar') && included.some(a => a.payload.kind !== 'calendar')) return ['Approve Apple Calendar changes separately from copied messages.']
    if (state.storage === 'device' && p.kind !== 'calendar') return p.kind === 'email' ? (!p.body.trim() ? ['Write the email body before copying.'] : []) : (!p.message.trim() ? ['Write the pickup request before copying.'] : [])
    return [...blockers(p, state.household?.children ?? []), ...(p.kind === 'pickup' && client.reviewPickupEmail && (!pickupReviews[a._id]?.ready || pickupReviews[a._id]?.stamp !== pickupStamp(p)) ? [pickupReviews[a._id]?.error ?? 'Review the caregiver email before approving.'] : []), ...(a.revisionRequest ? ['Wait for the revised draft, or keep the current draft.'] : []), ...(missing ? [`Connect ${missing === 'gmail' ? 'a sending account' : 'a calendar'} before approving.`] : [])]
  })
  const kinds = new Set(included.map(a => a.payload.kind))
  const approveLabel = state.storage === 'device' && state.nativeCalendar?.selectedId && kinds.has('calendar') ? (kinds.size > 1 ? 'Save calendar & copy messages' : 'Update Apple Calendar') : state.storage === 'device' ? (kinds.size > 1 ? 'Save plan & copy messages' : kinds.has('calendar') ? (included.every(a => drafts[a._id].kind === 'calendar' && (drafts[a._id] as CalendarPayload).operation === 'delete') ? 'Remove from device plan' : 'Save to device plan') : kinds.has('email') ? 'Copy email draft' : 'Copy pickup request') : kinds.size > 1 ? 'Approve selected actions' : kinds.has('calendar') ? (included.every(a => drafts[a._id].kind === 'calendar' && (drafts[a._id] as any).operation === 'delete') ? 'Remove calendar event' : 'Update calendar') : kinds.has('email') ? 'Send email' : 'Send pickup request'
  const changed = editable.some(a => JSON.stringify(drafts[a._id]) !== JSON.stringify(base.current[a._id]?.payload))
  const closeReview = () => {
    if (!changed) close()
    else void run(async () => { await save(); close() })
  }
  return <Sheet label="Review request" close={closeReview}>
    {job.source?.email && <GmailSource email={job.source.email} timezone={state.household?.timezone ?? 'UTC'} />}
    {stale && <p className="dm-notice">This review changed. <button onClick={reloadDrafts}>Load latest review</button></p>}
    {job.scheduledFor && !job.cancelled && <section className="dm-scheduled-intro"><AssistantAvatar name={displayAssistantName(state.preferences)} avatar={state.preferences?.avatar} size={52} /><h3>Scheduled with {displayAssistantName(state.preferences)}</h3><p>{new Date(job.scheduledFor).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: state.household?.timezone })} · {state.household?.timezone}</p><p>{state.storage === 'device' ? 'I’ll prepare this when Daymark is open at or after that time.' : 'I’ll prepare this at that time and leave the result here for review.'} Calendar changes and messages still need your approval.</p></section>}
    {job.preparing && <p role="status">Working · your request is saved on the server.</p>}
    {error && <p role="alert" className="dm-error">{error}</p>}
    {job.actions.filter(a => a.status !== 'cancelled').map(a => <section className="dm-artifact" key={a._id}>
      {(a.status !== 'review' || a.revisionRequest || editable.length > 1 || !selected.includes(a._id)) && <div className="dm-artifact-heading"><p className="dm-status">{a.revisionRequest ? 'Revising draft' : a.status === 'queued' && a.provider === 'apple' ? 'Approved · waiting for the connected iPhone' : a.status === 'waiting' && a.payload.kind === 'calendar' ? 'Waiting for caregiver acceptance' : reviewStatus(a)}</p>{(editable.length > 1 || !selected.includes(a._id)) && editable.some(e => e._id === a._id) && <label className="dm-check dm-include"><input type="checkbox" aria-label={`Include ${title(a)} in approval`} checked={selected.includes(a._id)} onChange={e => setSelected(e.target.checked ? [...selected, a._id] : selected.filter(id => id !== a._id))} />Include</label>}</div>}
      <ArtifactPreview payload={editable.some(e => e._id === a._id) ? drafts[a._id] ?? a.payload : a.payload} state={state} />
      {state.storage !== 'device' && client.reviewPickupEmail && drafts[a._id]?.kind === 'pickup' && editable.some(e => e._id === a._id) && <PickupEmailReview id={a._id} revision={a.revision} payload={drafts[a._id] as Extract<Payload, {kind: 'pickup'}>} stamp={pickupStamp(drafts[a._id])} client={client} changed={value => setPickupReviews(current => JSON.stringify(current[a._id]) === JSON.stringify(value) ? current : { ...current, [a._id]: value })} />}
      {a.revisionNote && <p className="dm-muted">{a.revisionNote}</p>}
      {a.error && <p className="dm-notice">{a.error}</p>}{a.status === 'review' && a.payload.kind === 'calendar' && a.payload.targetId && <button disabled={busy || !!a.revisionRequest} onClick={() => void run(() => client.refreshCalendar(a._id))}>{state.storage === 'device' ? 'Refresh current plan details' : 'Refresh current calendar details'}</button>}
      {drafts[a._id] && editable.some(e => e._id === a._id) ? <>
        {a.before?.payload.kind === 'calendar' && <p className="dm-before">Previously: {a.before.payload.title} · {a.before.payload.date} {a.before.payload.startTime ?? 'all day'}–{a.before.payload.endTime ?? ''} · {a.before.payload.location}<br />{a.before.payload.endDate} · {a.before.payload.timezone}<br />{a.before.payload.notes || 'No previous details'}<br />Proposed values below replace these details.</p>}
        <div className="dm-review-tools"><details className="dm-editor"><summary><PencilSimple size={17} aria-hidden="true" />Edit details</summary><fieldset className="dm-editable-fields" disabled={busy || !!a.revisionRequest}><Fields p={drafts[a._id]} state={state} files={job.files} set={p => setDrafts({ ...drafts, [a._id]: p })} /></fieldset></details>
        {state.storage !== 'device' && <Revision action={a} busy={busy || stale} request={instruction => void run(async () => {
          const revised = await save(), revision = revised.get(a._id) ?? a.revision
          following.current.set(a._id, revision + 1)
          try { await client.requestRevision(a._id, revision, instruction) } catch (e) { following.current.delete(a._id); throw e }
        })} keep={() => void run(async () => { following.current.set(a._id, a.revision + 1); await client.cancelRevision(a._id, a.revision) })} />}</div>
        {missingConnection(drafts[a._id]) && <button disabled={busy} onClick={openHousehold}>Choose calendar or email account</button>}
        <p className="dm-destination">{state.storage === 'device' ? a.payload.kind === 'calendar' ? state.nativeCalendar?.selectedId ? `Destination: ${state.nativeCalendar.calendars.find(c => c.id === state.nativeCalendar?.selectedId)?.title ?? 'Apple Calendar'} on this iPhone. Read-back verifies this phone; iCloud sync is separate.` : 'Destination: your device plan. No connected calendar is changed.' : 'Copy the text to send it yourself. Nothing is sent from Daymark.' : a.payload.kind === 'calendar' ? `Destination: ${selectedAccount(state, 'calendar')?.calendarName ?? 'Daymark calendar'} · ${selectedAccount(state, 'calendar')?.email ?? 'Connect a calendar'}${calendarAccount?.provider === 'apple' ? ' · runs when the connected iPhone opens Daymark' : ''}` : a.payload.kind === 'email' ? `From: ${selectedAccount(state, 'email')?.email ?? 'Connect a sending account'}` : `To: ${state.caregivers.find(c => c._id === (drafts[a._id] as any).caregiverId)?.email ?? 'Choose caregiver'}`}</p>
      </> : a.payload.kind === 'email' && <p className="dm-destination">To: {a.payload.to}</p>}
      {a.pickupEmail && <button disabled={busy} onClick={() => void run(() => client.reconcile(a._id))}>Check request email</button>}
      {a.status === 'uncertain' && a.payload.kind === 'calendar' && <button disabled={busy} onClick={() => void run(() => client.reconcile(a._id))}>Check calendar result</button>}
      {a.status === 'saved' && a.payload.kind === 'calendar' && a.payload.operation !== 'delete' && client.exportCalendar && <button disabled={busy} onClick={() => void run(() => client.exportCalendar!(a._id))}>Download calendar file</button>}
      {state.arrangements.filter(r => r.actionId === a._id && r.followUpStatus).map(r => <p key={r.id} className="dm-muted">{r.followUpStatus === 'available_in_app' ? 'The approved reminder is available in the caregiver’s inbox.' : r.followUpStatus === 'accepted' ? 'Reminder email accepted by the provider.' : r.followUpStatus === 'scheduled' ? 'One approved reminder is scheduled.' : r.followUpStatus === 'failed' ? 'The reminder could not be sent. The original pickup request remains visible.' : r.followUpStatus === 'cancelled' ? 'The reminder was cancelled because the request changed.' : 'Reminder delivery is unconfirmed; it will not be sent again automatically.'}</p>)}
      {a.receipts.map(r => <div className="dm-receipt" key={r._id}><strong>{r.outcome === 'saved_on_device' ? 'Saved to your device plan' : r.outcome === 'calendar_deletion_verified' ? 'Calendar removal verified' : r.outcome === 'calendar_read_back_verified' ? 'Verified calendar receipt' : r.outcome === 'apple_calendar_readback' ? `Saved in Apple Calendar on ${state.storage === 'device' ? 'this' : 'the connected'} iPhone` : r.outcome === 'apple_calendar_deleted' ? `Removal verified on ${state.storage === 'device' ? 'this' : 'the connected'} iPhone` : r.outcome === 'microsoft_accepted' ? 'Outlook accepted the email · delivery unverified' : r.outcome === 'gmail_accepted' ? 'Gmail accepted the email' : r.outcome === 'request_available_in_app' ? 'Request available in Daymark · awaiting response' : r.outcome === 'request_email_accepted' ? 'Request email accepted · awaiting response' : 'Caregiver acceptance recorded'}</strong><p>{new Date(r.verifiedAt).toLocaleString()}</p><details><summary>Receipt details</summary>{r.providerId && <p className="dm-id">{r.outcome === 'saved_on_device' ? 'Local record' : 'Provider ID'}: {r.providerId}</p>}{r.requestId && <p className="dm-id">Request reference: {r.requestId}</p>}{r.outcome.startsWith('apple_calendar_') && <p>Read back from {state.storage === 'device' ? 'this' : 'the connected'} iPhone. iCloud sync has not been verified.</p>}{r.outcome === 'microsoft_accepted' && <p>Microsoft accepted the send request. This is not proof of recipient delivery.</p>}{r.url && <a href={r.url} target="_blank" rel="noreferrer">Open calendar event</a>}</details></div>)}
    </section>)}
    {libraryNotice && <p role="status" className="dm-notice">{libraryNotice}</p>}
    {job.clarification && showReviewGuidance(job.actions) && <p className="dm-review-context">{job.clarification}</p>}
    <details className="dm-review-options"><summary>Source & more options</summary>
    {!job.preparing && !job.cancelled && !job.scheduledFor && <details><summary>Add an independent draft</summary><div className="dm-actions">{(['calendar', 'email', 'pickup'] as const).map(kind => <button disabled={busy} key={kind} onClick={() => void run(async () => { await save(); await client.addDraft(job._id, blank(kind, state)) })}>{kind === 'calendar' ? 'Calendar change' : kind === 'email' ? 'School email' : 'Pickup request'}</button>)}</div></details>}
    <section>{job.source?.text ? <><label>Shared notice<textarea rows={6} value={source} onChange={e => setSource(e.target.value)} maxLength={20000} /></label><button disabled={busy || source === job.source.text || job.cancelled} onClick={() => void run(() => client.reviseSource(job._id, job.source!.revision, source))}>Save revised source</button></> : <p>{job.files?.length ? 'Notice shared as a file.' : 'Original source expired after 30 days.'}</p>}{job.files?.map(f => <div className="dm-source-file" key={f.id}><SourceFile file={f} client={client} />{client.keepLibraryFile && <button className="dm-text-button" disabled={busy || state.library?.some(item => item.fileId === f.id)} onClick={() => void run(async () => { await client.keepLibraryFile!(job._id, f.id); setLibraryNotice('File kept in Library. It will stay until you remove it.') })}>{state.library?.some(item => item.fileId === f.id) ? 'Kept in Library' : 'Keep file in Library'}</button>}</div>)}
      {job.actions.some(a => Object.keys(a.payload.evidence).length) && <dl>{job.actions.flatMap(a => Object.entries(a.payload.evidence).map(([field, quote]) => <div key={`${a._id}-${field}`}><dt>{field}</dt><dd>{quote}</dd></div>))}</dl>}
    </section>
    {!job.cancelled && <button className="dm-text-button" disabled={busy} onClick={() => void run(() => client.cancel(job._id))}>Cancel pending work</button>}
    </details>
    {client.saveLibraryArtifact && job.actions.some(a => a.status !== 'cancelled') && <details className="dm-review-options"><summary><BookmarkSimple size={17} aria-hidden="true" />Keep in Library</summary><p className="dm-muted">Keep a shortcut to this work. Its draft or completion status stays visible.</p><div className="dm-actions">{job.actions.filter(a => a.status !== 'cancelled').map(a => <button key={a._id} disabled={busy || state.library?.some(item => item.actionId === a._id)} onClick={() => void run(async () => { await save(); await client.saveLibraryArtifact!(a._id); setLibraryNotice('Saved to Library. No action was approved or sent.') })}>{state.library?.some(item => item.actionId === a._id) ? 'In Library' : `Save ${title(a)} to Library`}</button>)}</div></details>}
    {!!editable.length && <footer className="dm-review-footer">
      {!!blocked.length && <p className="dm-notice">{[...new Set(blocked)].join(' ')}</p>}
      {!state.household?.children.length && <button onClick={openHousehold}>Add a child for this draft</button>}
      {included.some(a => a.payload.kind === 'pickup') && <p className="dm-approval-note">{state.storage === 'device' ? 'Copying does not contact or confirm a caregiver.' : 'The caregiver still needs to accept this request.'}</p>}
      {changed && <button className="dm-save-button" disabled={busy || stale} onClick={() => void run(async () => { await save() })}>Save edits</button>}
      <button className="dm-primary" disabled={busy || stale || !included.length || !!blocked.length} onClick={() => void run(async () => { const revised = await save(); await client.approve(included.map(a => ({ id: a._id, revision: revised.get(a._id) ?? a.revision, ...(state.accounts ? { selectionVersion: state.accounts.version } : {}), ...(nativeDestination && (drafts[a._id]?.kind === 'calendar' || drafts[a._id]?.kind === 'pickup' && (drafts[a._id] as Extract<Payload, {kind: 'pickup'}>).calendarUpdate) ? { nativeCalendar: nativeDestination } : {}), ...(drafts[a._id]?.kind === 'pickup' ? { ...(pickupReviews[a._id]?.hash ? { pickupEmailHash: pickupReviews[a._id].hash } : {}), deliveryChannel: state.caregivers.find(c => c._id === (drafts[a._id] as Extract<Payload, { kind: 'pickup' }>).caregiverId)?.deliveryChannel ?? 'email' } : {}) })), reviewTime()) })}>{busy ? 'Saving…' : approveLabel}</button>
    </footer>}
  </Sheet>
}
function blank(kind: Payload['kind'], state: DaymarkState): Payload {
  const base = { kind, childId: state.household?.children.length === 1 ? state.household.children[0].id : null, evidence: {} }
  if (kind === 'calendar') return { ...base, kind, title: '', date: '', endDate: '', startTime: null, endTime: null, allDay: false, timezone: state.household?.timezone ?? '', location: '', notes: '', targetId: null }
  if (kind === 'email') return { ...base, kind, to: '', subject: '', body: '', requirement: '' }
  return { ...base, kind, caregiverId: null, date: '', time: null, timezone: state.household?.timezone ?? '', location: '', deadline: '', message: '' }
}
function FamilyPlan({ state, open }: { state: DaymarkState; open(actionId: string): void }) {
  const [external,setExternal]=useState<string|null>(null)
  const dates = [...new Set(state.plan.flatMap(e => e.payload.kind === 'calendar' ? [e.payload.date] : []))].sort()
  const pickups = state.arrangements.filter(a => a.status !== 'superseded')
  return <div className="dm-plan"><div className="dm-page-heading"><h2>Family plan</h2><p>{state.storage === 'device' ? state.nativeCalendar?.selectedId ? 'Saved plans and verified calendar changes on this iPhone. Check receipts for their destination.' : 'Your device plan. No connected calendar is changed.' : 'Saved calendar results, current private calendar checks and pickup arrangements.'}</p></div>
    {!!state.calendarAgenda?.events.length && <section aria-label="Private connected calendars"><h3>Your connected calendars</h3><p className="dm-muted">Private to you · {state.calendarAgenda.availabilityKnown ? 'Current selected calendar window' : 'Partial or older coverage; availability needs checking'}</p>{state.calendarAgenda.events.slice(0,100).map(e=><button className="dm-plan-event" key={e.id} onClick={()=>setExternal(e.id)}><span className="dm-plan-time">{e.allDay?'All day':new Date(e.start).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</span><span className="dm-plan-event-copy"><strong>{e.title}</strong><span>{new Date(e.start).toLocaleDateString()} · {e.location}</span></span></button>)}{state.calendarAgenda.events.length>100&&<p>Showing the first 100 events.</p>}</section>}
    {!dates.length && !pickups.length && !state.calendarAgenda?.events.length && <div className="dm-empty"><span className="dm-empty-symbol"><CalendarBlank size={27} aria-hidden="true" /></span><h3>A little room to breathe.</h3><p>Your confirmed plan will appear here.</p></div>}
    {external && <ExternalCalendarEvent eventId={external} onClose={()=>setExternal(null)}/>}
    {dates.map(date => <section className="dm-plan-day" key={date}><h3>{noticeDate(date)}</h3>{state.plan.filter(e => e.payload.kind === 'calendar' && e.payload.date === date).map(e => e.payload.kind === 'calendar' && <button className="dm-plan-event" key={e._id} onClick={() => open(e.actionId)}>
      <span className="dm-plan-time">{e.payload.allDay ? 'All day' : e.payload.startTime || 'Time needed'}</span><span className="dm-plan-event-copy"><strong>{e.payload.title}</strong><span>{[state.household?.children.find(c => c.id === e.payload.childId)?.name, e.payload.location].filter(Boolean).join(' · ')}</span><small>{e.payload.timezone}{state.storage !== 'device' && ` · ${calendarPlanStatus({ ...e, payload: e.payload }, state.calendarAgenda)}`}</small></span><CaretRight size={16} aria-hidden="true" />
    </button>)}</section>)}
    {!!pickups.length && <section className="dm-plan-day"><h3>Pickup responses</h3>{pickups.map(a => <button className="dm-job" key={a.id} onClick={() => open(a.actionId)}><strong>Pickup · {a.caregiver}</strong>{a.payload?.kind === 'pickup' && <span>{state.household?.children.find(c => c.id === a.payload?.childId)?.name} · {noticeDate(a.payload.date)} · {a.payload.time} · {a.payload.location}</span>}<span>{a.status === 'accepted' ? 'Caregiver accepted · pickup not yet verified' : `Coverage unresolved · ${a.status}`}</span></button>)}</section>}
  </div>
}
function PickupReply({ request, current, client, close }: { request: IncomingPickup; current?: IncomingPickup; client: DaymarkClient; close(): void }) {
  const [suggestion, setSuggestion] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('')
  const stale = !current || current.revision !== request.revision
  const respond = async (response: 'accept' | 'decline' | 'suggest') => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await client.respondToPickup(request.id, request.revision, response, response === 'suggest' ? suggestion : '')
      setDone(response === 'accept' ? 'You accepted the pickup.' : response === 'decline' ? 'You declined the pickup.' : 'Your suggested change is waiting for parent approval.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <Sheet label="Pickup request for you" close={close}>
    {done ? <div role="status"><h3>{done}</h3><p>Your response is recorded. Acceptance confirms the arrangement; it does not mean pickup has happened.</p></div> : <>
      <section className="dm-artifact dm-preview"><h3>Pickup for {request.child}</h3><p>{noticeDate(request.date)} · {request.time} ({request.timezone})</p><p>{request.location}</p><div className="dm-letter">{request.message}</div><p className="dm-muted">Reply by {new Date(request.deadline).toLocaleString(undefined, { timeZone: request.timezone })} ({request.timezone})</p>{request.reminder && <p className="dm-notice">One reminder approved by the parent.</p>}</section>
      {error && <p className="dm-error" role="alert">{error}</p>}
      {stale && !busy ? <p className="dm-notice">This request changed, expired, or was already answered. Reopen the current request.</p> : <><details><summary>Suggest a different arrangement</summary><label>Your suggested change<textarea value={suggestion} onChange={e => setSuggestion(e.target.value)} maxLength={2000} /></label><button disabled={busy || !suggestion.trim()} onClick={() => void respond('suggest')}>Send suggestion for review</button></details><p className="dm-muted">This request grants access only to these pickup details.</p><footer className="dm-review-footer"><button disabled={busy} onClick={() => void respond('decline')}>Can’t do it</button><button className="dm-primary" disabled={busy} onClick={() => void respond('accept')}>{busy ? 'Saving response…' : 'Accept pickup'}</button></footer></>}
    </>}
  </Sheet>
}
function Household({ state, client, close }: { state: DaymarkState; client: DaymarkClient; close(): void }) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) }, [])
  const [timezone, setTimezone] = useState(state.household?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [householdName, setHouseholdName] = useState(state.household?.name ?? '')
  const [children, setChildren] = useState(state.household?.children ?? [])
  const [quietStart, setQuietStart] = useState(state.notifications?.quietStart ?? '20:00'), [quietEnd, setQuietEnd] = useState(state.notifications?.quietEnd ?? '07:00')
  const [name, setName] = useState(''), [caregiver, setCaregiver] = useState(''), [email, setEmail] = useState(''), [eligible, setEligible] = useState<string[]>([]), [caregiverId, setCaregiverId] = useState<string | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [deletion, setDeletion] = useState('')
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  const device = state.storage === 'device'
  return <Sheet label="Household" close={close}>
    <div className="dm-household-profile dm-personal-profile"><AssistantAvatar name={displayAssistantName(state.preferences)} avatar={state.preferences?.avatar} size={48} /><div><h3>{householdLabel(state.household)}</h3><p>{displayAssistantName(state.preferences)} · {device ? 'On this device' : 'Connected household'}</p></div></div>
    {error && <p role="alert" className="dm-error">{error}</p>}
    {!state.signedIn && !device ? <p>Sign in to save household details.</p> : <>
      <section className="dm-household-group" aria-labelledby="household-family-heading">
        <h3 id="household-family-heading">You and your family</h3>
        <Personalization state={state} client={client} />
        <details><summary><span>Children and timezone</span><span className="dm-settings-value" aria-hidden="true">{children.length ? `${children.length} ${children.length === 1 ? 'child' : 'children'}` : 'Add family'}</span></summary>
          <label>Household name<input maxLength={80} value={householdName} placeholder="The Cedar household" onChange={e => setHouseholdName(e.target.value)} /></label>
          <label>Household timezone<input value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
          {children.map((c, i) => <label key={c.id}>Child’s first name<input value={c.name} onChange={e => setChildren(children.map((child, n) => n === i ? { ...child, name: e.target.value } : child))} /></label>)}
          <label>Add a child<input value={name} onChange={e => setName(e.target.value)} placeholder="First name" /></label>
          <div className="dm-actions"><button disabled={busy || !name.trim()} onClick={() => { setChildren([...children, { id: crypto.randomUUID(), name: name.trim() }]); setName('') }}>Add child</button>
            <button className="dm-primary" disabled={busy} onClick={() => void run(async () => { await client.saveHousehold(timezone, name.trim() ? [...children, { id: crypto.randomUUID(), name: name.trim() }] : children); if (client.saveHouseholdName && householdName.trim() !== (state.household?.name ?? '')) await client.saveHouseholdName(householdName.trim()); close() })}>Save household</button>
          </div>
        </details>
        {state.household && <><FamilyMemory state={state} client={client} />
          <details><summary><span>Pickup caregivers</span>{!!state.caregivers.length && <span className="dm-settings-value" aria-hidden="true">{state.caregivers.length}</span>}</summary>
            {state.caregivers.map(c => <div className="dm-setting-item" key={c._id}><p>{c.name} · {c.email}</p><button onClick={() => { setCaregiverId(c._id); setCaregiver(c.name); setEmail(c.email); setEligible(c.childIds) }}>Edit caregiver</button></div>)}
            <label>Caregiver name<input value={caregiver} onChange={e => setCaregiver(e.target.value)} /></label><label>Caregiver email<input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <p>I confirm this caregiver is eligible to pick up:</p>{children.map(c => <label key={c.id} className="dm-check"><input type="checkbox" checked={eligible.includes(c.id)} onChange={e => setEligible(e.target.checked ? [...eligible, c.id] : eligible.filter(id => id !== c.id))} />{c.name}</label>)}
            <button disabled={busy || !caregiver || !email || (!caregiverId && !eligible.length)} onClick={() => void run(async () => { if (caregiverId) await client.updateCaregiver(caregiverId, caregiver, email, eligible); else await client.addCaregiver(caregiver, email, eligible); setCaregiverId(null); setCaregiver(''); setEmail(''); setEligible([]) })}>Save eligible caregiver</button>
          </details>
        </>}
      </section>
      {state.household && <>
        <section className="dm-household-group" aria-labelledby="household-connections-heading">
          <h3 id="household-connections-heading">Connections</h3>
          <GmailConnection state={state} client={client} />
          <ConnectionSettings state={state} client={client} busy={busy} run={run} />
          {!device && state.signedIn && client.connectCalendarRead && <details><summary>Calendar reading</summary><CalendarFeeds connections={(state.accounts?.items ?? []).map(c => ({ ...c, version: c.version ?? 0 }))} onConnect={client.connectCalendarRead} selectionVersion={state.accounts?.version} onConnectEditing={client.connectCalendarEditing} /></details>}
          <ConnectorRequests state={state} client={client} />
        </section>
        {!device && <section className="dm-household-group" aria-labelledby="household-preferences-heading">
          <h3 id="household-preferences-heading">Preferences</h3>
          <details><summary>Requests sent to me</summary>
            <p>Pickup requests for {state.pickupDelivery?.email ?? 'your verified sign-in email'}.</p>
            <label>Delivery channel<select aria-label="Pickup request delivery" disabled={busy || !state.pickupDelivery?.verified} value={state.pickupDelivery?.channel ?? 'email'} onChange={e => void run(() => client.savePickupDelivery(e.target.value as 'email' | 'app'))}><option value="email">Private email</option><option value="app">In Daymark</option></select></label>
            <p className="dm-muted">In Daymark: check Assistant for requests; no duplicate email. Changing the channel does not answer existing requests.</p>{!state.pickupDelivery?.verified && <p>Verify your sign-in email before choosing a channel.</p>}
          </details>
          <details><summary>Notifications and quiet hours</summary>
            <p>Optional alerts for review or help. Routine success stays in history.</p>
            <div className="dm-pair"><label>Quiet hours start<input type="time" value={quietStart} onChange={e => setQuietStart(e.target.value)} /></label><label>Quiet hours end<input type="time" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} /></label></div>
            <p className="dm-muted">Uses {state.household.timezone}. Alerts wait until quiet hours end.</p>
            <div className="dm-actions"><button disabled={busy || !native || !state.notifications?.configured} onClick={() => void run(() => client.saveNotifications(true, quietStart, quietEnd))}>{state.notifications?.enabled ? 'Save notification settings' : 'Enable iPhone notifications'}</button>{state.notifications?.enabled && <button disabled={busy} onClick={() => void run(() => client.saveNotifications(false, quietStart, quietEnd))}>Turn off Daymark notifications</button>}</div>{!state.notifications?.configured && <p className="dm-muted">Notification delivery is not connected yet.</p>}
          </details>
          <details><summary>Forward school notices</summary>{state.forwarding?.address ? <><p>Forward from {state.forwarding.sender} to:</p><p className="dm-id">{state.forwarding.address}</p><p>Keep this address private. Received notices appear in Assistant for review.</p></> : <><p>Use the verified email on your sign-in account.</p><button disabled={busy || !state.forwarding?.configured} onClick={() => void run(() => client.enableForwarding())}>Enable private forwarding address</button>{!state.forwarding?.configured && <p className="dm-muted">Forwarding is not connected yet.</p>}</>}{state.forwarding?.notices.map(n => <section key={n.id}><p>{n.title || 'Forwarded notice'} · {n.status}</p>{n.reason && <p>{n.reason}</p>}{n.status === 'failed' && <button disabled={busy} onClick={() => void run(() => client.retryForwarded(n.id))}>Retry notice intake</button>}</section>)}</details>
        </section>}
      </>}
    </>}
    <section className="dm-household-group" aria-labelledby="household-data-heading">
      <h3 id="household-data-heading">Your data</h3>
      {!device && state.workingMemory && client.resetWorkingMemory && <details><summary>Conversation memory</summary><WorkingMemorySettings state={state} client={client} /></details>}
      <details><summary>Data and privacy</summary><div className="dm-settings-privacy">
        {device ? <>
          <h4>On this device</h4><p>Requests, tasks, files, family details and your plan stay in this browser or app. No account is needed; notices are not uploaded to a model. Anyone using this browser profile can open them. Clearing browser storage removes them.</p>
          <h4>Connected actions</h4><p>Approved Apple Calendar events go to the chosen calendar and may sync through its account. A device plan is not a Google Calendar update; copying a message does not send it.</p>
        </> : <>
          <h4>Private and shared</h4><p>Auth0 handles sign-in. Convex stores household records and private files. Shared notices and relevant confirmed family details go to the configured AI provider to prepare work.</p><p>Consented Gmail text, answers and drafts stay private to your account unless you review and share text. Email may be processed by AI; pausing stops future checks. Attachments need separate processing consent; linked pages are not fetched. Selected calendars stay private.</p>
          <h4>Voice</h4><p>With microphone/provider consent, audio goes to OpenAI. Sola stores no raw audio. Spoken household requests you submit stay in private conversation for up to 30 days. Provider retention follows its own policy.</p>
          <h4>Approved actions</h4><p>Calendar changes and emails use your selected accounts. Pickup requests use reviewed Gmail or Resend and reveal only the assigned pickup. Gmail recipients sign in; other email verification codes use Resend. Optional Apple notifications contain no child or school details.</p>
        </>}
        <h4>What expires</h4><p>{device ? 'Original sources and files' : 'Retrieved email, original sources and uploads'} expire after 30 days{device ? ' when Daymark next opens' : ''}. Scheduled request text stays until 30 days after its scheduled time, preparation or cancellation.</p>
        <h4>What stays</h4><p>Personal tasks and files you keep in Library stay until you remove them{device ? '' : ' or delete the household'}.{!device && ' Confirmed plans and receipts stay until household deletion. Preparation time, model usage, review time and corrections are recorded to evaluate the service.'}</p>
        {!device && <><h4>Deleting your account</h4><p>Access stops immediately while household data and the Auth0 identity are removed. Calendar events and sent messages stay with their providers.</p></>}
      </div></details>
      {!device && state.household && <details><summary>Earlier organizer records</summary><p>Import as reference. Originals stay in place; old approvals, sends and calendar writes are never replayed.</p>{native && <button disabled={busy} onClick={() => void run(() => client.importLegacy('phone'))}>Import this phone’s legacy records</button>}<label>Import a SQLite JSON export<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 750000) throw new Error('Export must be under 750 KB.'); await client.importLegacy('sqlite-export', await file.text()) }); e.target.value = '' }} /></label>{state.legacy?.flatMap(record => record.items.map((item, i) => <p key={`${record._id}-${i}`}>{item.title} · {item.date ?? 'No date'} · Legacy reference, external completion unverified</p>))}</details>}
      {state.household && <details className="dm-settings-delete"><summary>{device ? 'Delete saved device data' : 'Delete Daymark account data'}</summary><p>{device ? 'Removes saved requests, files, family details and plan items from this device. Your unsent composer draft and earlier organizer data stay.' : 'Removes household records, sources and saved account credentials. Access stops immediately; your sign-in account is queued for deletion. Sent emails and calendar events remain with their providers.'}</p><label>Type DELETE to confirm<input value={deletion} onChange={e => setDeletion(e.target.value)} /></label><button disabled={busy || deletion !== 'DELETE'} onClick={() => void run(async () => { await client.deleteAccount(); await client.signOut(); close() })}>{device ? 'Delete saved device data' : 'Delete account and household data'}</button></details>}
    </section>
    {device && state.accountAvailable && <button className="dm-household-account" disabled={busy} onClick={() => void run(() => client.signIn())}>Use a connected account</button>}
    {state.signedIn && <button className="dm-text-button dm-household-account" disabled={busy} onClick={() => void run(() => client.signOut())}>Sign out</button>}
  </Sheet>
}
export default function Daymark({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [routineDraft, setRoutineDraft] = useState<(NonNullable<ReturnType<typeof routineFromRequest>> & { text: string }) | null>(null)
  const [routineNotice, setRoutineNotice] = useState('')
  const [memoryReview, setMemoryReview] = useState<string | null>(null)
  const memoryAttempt = useRef<{ text: string; id: string }>()
  const mailboxAttempt = useRef<{ text: string; id: string }>(), mailboxPending = useRef(false)
  const [sentMailbox, setSentMailbox] = useState<string | null>(null)
  const [composerFocused, setComposerFocused] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false), [voiceCall, setVoiceCall] = useState<VoiceCallSnapshot | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ id: string; request: number } | null>(null)
  const conversationWindow = useRef<{ owner: string; first?: string }>({ owner: '' })
  const [mailReview, setMailReview] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<IncomingPickup | null>(null)
  const [tab, setTab] = useState('assistant'), [text, setText] = useState(''), [draftLoaded, setDraftLoaded] = useState(false), [review, setReview] = useState<string | null>(null), [settings, setSettings] = useState(() => state.signedIn && connectionReturn(window.location.search) !== null), [all, setAll] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    if (!state.signedIn || !connectionReturn(window.location.search)) return
    const url = new URL(window.location.href)
    url.searchParams.delete('connection')
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
  }, [state.signedIn])
  useEffect(() => { const open = () => { const id = new URLSearchParams(window.location.hash.slice(1)).get('job'); if (id) setReview(id) }; open(); window.addEventListener('hashchange', open); return () => window.removeEventListener('hashchange', open) }, [])
  const dock = useRef<HTMLDivElement>(null), app = useRef<HTMLDivElement>(null), requestInput = useRef<HTMLTextAreaElement>(null), threadEnd = useRef<HTMLDivElement>(null), voiceEnd = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Tab') app.current?.classList.add('dm-keyboard-navigation') }
    const pointer = () => app.current?.classList.remove('dm-keyboard-navigation')
    document.addEventListener('keydown', keyboard, true); document.addEventListener('pointerdown', pointer, true)
    return () => { document.removeEventListener('keydown', keyboard, true); document.removeEventListener('pointerdown', pointer, true) }
  }, [])
  const [sentJob, setSentJob] = useState<string | null>(null)
  useEffect(() => { if (voiceOpen && tab === 'assistant') threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'instant' }) }, [voiceOpen])
  useEffect(() => { if (sentJob && state.jobs.some(job => job._id === sentJob)) { if (tab === 'assistant') threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'instant' }); setSentJob(null) } }, [state.jobs, sentJob, tab])
  useEffect(() => { if (sentMailbox && state.mailboxRuns?.some(run => run.id === sentMailbox)) { if (tab === 'assistant') threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'instant' }); setSentMailbox(null) } }, [state.mailboxRuns, sentMailbox, tab])
  useLayoutEffect(() => {
    const input = requestInput.current
    if (!input) return
    input.style.height = '44px'
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`
  }, [text, tab])
  useEffect(() => {
    const element = dock.current
    if (!element) return
    const header = app.current?.querySelector<HTMLElement>('.dm-header')
    const measure = () => {
      app.current?.style.setProperty('--dm-dock-height', `${element.getBoundingClientRect().height}px`)
      if (header) app.current?.style.setProperty('--dm-header-height', `${header.getBoundingClientRect().height}px`)
    }
    const keyboard = () => {
      const viewport = window.visualViewport
      const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0
      element.style.bottom = `${inset}px`
      // Modal dialogs share the visible viewport with the composer. Leaving a
      // full-height dialog behind the keyboard makes WKWebView pan its header away.
      app.current?.style.setProperty('--dm-keyboard-inset', `${inset}px`)
      app.current?.style.setProperty('--dm-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    }
    const observer = new ResizeObserver(measure)
    const restoreScroll = native ? preserveNativeKeyboardScroll(window, document) : () => {}
    observer.observe(element); if (header) observer.observe(header); measure(); keyboard()
    window.visualViewport?.addEventListener('resize', keyboard)
    window.visualViewport?.addEventListener('scroll', keyboard)
    return () => { restoreScroll(); observer.disconnect(); window.visualViewport?.removeEventListener('resize', keyboard); window.visualViewport?.removeEventListener('scroll', keyboard) }
  }, [])
  const [shared, setShared] = useState<SharedNotice | null>(null)
  useEffect(() => {
    if (!native) return
    const check = () => NativeIntake.pending().then(r => setShared(r.notices[0] ?? null)).catch(() => setError('Shared intake is unavailable. Check the App Group setup.'))
    void check()
    const listener = NativeApp.addListener('appStateChange', state => { if (state.isActive) void check() })
    return () => { void listener.then(l => l.remove()) }
  }, [])
  const [files, setFiles] = useState<File[]>([]), fileInput = useRef<HTMLInputElement>(null)
  const persist = useRef(Promise.resolve())
  const chooseFiles = async (chosen: File[]) => {
    if (chosen.length > 5 || chosen.reduce((n,f) => n + f.size, 0) > 10 * 1024 * 1024 || chosen.some(f => /\.pdf$/i.test(f.name)) && chosen.length !== 1) { setError('Share up to five images or one PDF, 10 MB total.'); return }
    try { await saveFiles(chosen); setFiles(chosen); setError('') } catch { setError('Could not save the attachment draft on this device.') }
  }
  useEffect(() => { void Promise.allSettled([Preferences.get({ key: draftKey }), readFiles()]).then(([draft, attachments]) => { if (draft.status === 'fulfilled') setText(draft.value.value ?? ''); if (attachments.status === 'fulfilled') setFiles(attachments.value); if (draft.status === 'rejected' || attachments.status === 'rejected') setError('Some local draft storage is unavailable. Keep a copy before signing in.'); setDraftLoaded(true) }); const on = () => setOnline(navigator.onLine); window.addEventListener('online', on); window.addEventListener('offline', on); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) } }, [])
  useEffect(() => { if (!draftLoaded) return; persist.current = persist.current.catch(() => {}).then(() => Preferences.set({ key: draftKey, value: text })).catch(() => setError('This draft could not be saved locally. Keep a copy before signing in.')); }, [text, draftLoaded])
  const importShared = async () => {
    if (!shared) return
    try {
      const last = await Preferences.get({ key: 'daymark.shared-last.v1' })
      if (last.value !== shared.id) {
        const incoming = [...files, ...sharedFiles(shared)], combined = [text, shared.text].filter(Boolean).join('\n')
        if (incoming.length > 5 || incoming.reduce((n,f) => n + f.size, 0) > 10 * 1024 * 1024 || combined.length > 20000 || incoming.some(f => f.type === 'application/pdf') && incoming.length > 1) throw new Error('Send or clear your current draft before adding this shared notice.')
        await persist.current; await saveFiles(incoming); await Preferences.set({ key: draftKey, value: combined }); await Preferences.set({ key: 'daymark.shared-last.v1', value: shared.id }); setFiles(incoming); setText(combined)
      }
      await NativeIntake.acknowledge({ id: shared.id }); setShared(null)
    } catch (e) { setError((e as Error).message) }
  }
  const send = async () => {
    if (busy || (!text.trim() && !files.length)) return
    setError(''); setRoutineNotice('')
    const mailboxRequest = parseMailboxRequest(text)
    if (mailboxRequest) {
      if (mailboxPending.current) return
      if (files.length) { setError('Ask about your Gmail without attachments. Share a notice separately when you want household work.'); return }
      if (!state.signedIn || state.storage === 'device' || !client.requestMailbox) { setError('Connect Gmail in Household settings to ask about your email. Your request is still here.'); return }
      if (!state.mailboxSettings?.connection?.readAllowed || state.mailboxSettings.mailbox?.state !== 'active') { setError('Enable Gmail email help in Household settings first. Your request is still here.'); return }
      if (state.mailboxSettings.mailbox.connectionVersion !== undefined && state.mailboxSettings.mailbox.connectionVersion !== state.mailboxSettings.connection.version) { setError('Review the changed Gmail access in Household settings first. Your request is still here.'); return }
      mailboxPending.current = true; setBusy(true); const submittedText = text
      try {
        if (mailboxAttempt.current?.text !== submittedText) mailboxAttempt.current = { text: submittedText, id: crypto.randomUUID() }
        const id = await client.requestMailbox({ ...mailboxRequest, requestId: mailboxAttempt.current.id, request: submittedText })
        mailboxAttempt.current = undefined; setText(current => current === submittedText ? '' : current); setSentMailbox(id)
      } catch (e) { setError(connectorErrorMessage(e)) } finally { mailboxPending.current = false; setBusy(false) }
      return
    }
    if (!state.signedIn && state.storage !== 'device') { try { await persist.current; await client.signIn() } catch (e) { setError((e as Error).message) } return }
    if (!state.household) { setSettings(true); return }
    const memory = parseMemoryRequest(text)
    if (memory && client.proposeMemory) {
      if (files.length) { setError('Share the notice separately. Memory review currently accepts a short text request.'); return }
      setBusy(true); const submittedText = text
      try {
        if (memoryAttempt.current?.text !== submittedText) memoryAttempt.current = { text: submittedText, id: crypto.randomUUID() }
        const id = await client.proposeMemory({ text: memory.text, requestId: memoryAttempt.current.id })
        memoryAttempt.current = undefined
        setMemoryReview(id); setText(current => current === submittedText ? '' : current)
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
      return
    }
    const routine = routineFromRequest(text, state.household.timezone)
    if (routine && client.createRoutine) {
      if (files.length) { setError('Save the routine without attachments first. Share the notice separately for review.'); return }
      setRoutineDraft({ ...routine, text }); return
    }
    setBusy(true); const submittedText = text
    try { const id = await client.submit(submittedText, files); setText(current => current === submittedText ? '' : current); await saveFiles([]); setFiles([]); setSentJob(id) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const jobs = [...state.jobs].reverse()
  const updates = conversationUpdates(state)
  const receiptAnnouncement = useConversationAnnouncements(updates, state.ownerKey ?? (state.storage === 'device' ? 'device-workspace' : 'signed-out'))
  const sequence = new Map(jobs.map((job, index) => [job._id, index * 2]))
  const tieOrder = (item: { kind: string; id: string; jobId?: string }) => (sequence.get(item.kind === 'outcome' ? item.jobId! : item.id) ?? sequence.size * 2) + (item.kind === 'outcome' ? 1 : 0)
  const retainedMailProposals = state.signedIn && state.storage !== 'device' ? visibleMailFollowups(state.mailProposals ?? []).filter(proposal => !state.mailboxRuns?.some(run => run.id === proposal.runId)) : []
  const conversation = [...updates, ...retainedMailProposals.map(proposal => ({ kind: 'mailProposal' as const, id: `mail-proposal:${proposal.id}`, at: proposal.createdAt, proposal })), ...(state.signedIn && state.storage !== 'device' ? (state.mailDrafts ?? []).map(draft => ({ kind: 'mailDraft' as const, id: `mail-draft:${draft.id}`, at: draft.createdAt, draft })) : []), ...(voiceCall ? [{ kind: 'voice' as const, id: `voice:${voiceCall.id}`, at: voiceCall.startedAt, call: voiceCall }] : []), ...jobs.map(job => ({ kind: 'job' as const, id: job._id, at: job.createdAt ?? 0, job })), ...(state.signedIn && state.storage !== 'device' ? (state.mailboxRuns ?? []).map(run => ({ kind: 'mail' as const, id: run.id, at: run.createdAt, run })) : [])].sort((a, b) => a.at - b.at || tieOrder(a) - tieOrder(b))
  const conversationOwner = state.ownerKey ?? `${state.storage ?? 'connected'}:${state.signedIn}`
  if (conversationWindow.current.owner !== conversationOwner) conversationWindow.current = { owner: conversationOwner }
  if (!conversationWindow.current.first && conversation.length) conversationWindow.current.first = conversation[Math.max(0, conversation.length - 12)].id
  const firstVisible = conversation.findIndex(item => item.id === conversationWindow.current.first)
  const visibleConversation = all ? conversation : conversation.slice(firstVisible >= 0 ? firstVisible : Math.max(0, conversation.length - 12))
  const chatSignal = JSON.stringify(conversation.map(item => item.kind === 'outcome' ? [item.id] : item.kind === 'voice' ? [item.id, item.call.state, item.call.activity, item.call.view, item.call.captions.map(c => [c.id, c.text, c.final])] : item.kind === 'mailProposal' ? [item.id, item.proposal.version, item.proposal.status] : item.kind === 'mailDraft' ? [item.id, item.draft.version, item.draft.status] : item.kind === 'mail' ? [item.id, item.run.status, item.run.answer?.length, item.run.followthrough?.status] : [item.id, item.job.preparing, item.job.clarification, item.job.actions.map(a => [a._id, a.status, a.revision])])) + JSON.stringify((state.mailProposals ?? []).map(p => [p.id, p.version, p.status]))
  const chatScroll = useConversationScroll(chatSignal, tab === 'assistant', threadEnd)
  const assistantName = displayAssistantName(state.preferences)
  const compose = (request?: string) => { setTab('assistant'); if (request) setText(request) }
  const openJob = (id: string) => { setReview(null); setMailReview(null); setTab('assistant'); setAll(true); setFocusTarget(current => ({ id, request: (current?.request ?? 0) + 1 })) }
  const openMailDraft = (id: string) => openJob(`mail-draft:${id}`)
  const openMailProposal = (id: string) => openJob(`mail-proposal:${id}`)
  useEffect(() => {
    if (tab !== 'assistant') { setVoiceOpen(false); setVoiceCall(null); return }
    if (!focusTarget) return
    const frame = requestAnimationFrame(() => { const target = document.getElementById(conversationTargetId(focusTarget.id)); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) })
    return () => cancelAnimationFrame(frame)
  }, [tab, focusTarget])
  useEffect(() => { setReview(null); setMailReview(null); setFocusTarget(null); setVoiceOpen(false); setVoiceCall(null); setAll(false) }, [state.ownerKey, state.storage])
  const currentMailDraft = state.signedIn && state.storage !== 'device' ? state.mailDrafts?.find(draft => draft.id === mailReview) : undefined
  const current = state.jobs.find(j => j._id === review)
  return <div className="dm-app" ref={app}>
    <header className="dm-header"><button className="dm-icon-button" aria-label="History" onClick={() => setTab('history')}><ClockCounterClockwise size={21} aria-hidden="true" /></button><div className="dm-identity dm-identity-personal"><AssistantAvatar name={assistantName} avatar={state.preferences?.avatar} size={38} mood={headerAvatarMood(state.jobs, tab === 'assistant' && composerFocused, busy)} animate /><h1>{assistantName}</h1><p>{householdLabel(state.household)}</p></div><button className="dm-icon-button" aria-label="Household settings" onClick={() => setSettings(true)}><GearSix size={21} aria-hidden="true" /></button></header>
    <main>
      {!state.configured && <p className="dm-notice" role="status">Cloud setup is not connected yet. You can compose a request; it stays on this device.</p>}
      {state.configured && !state.signedIn && state.storage !== 'device' && <div className="dm-signin"><p>Sign in before sharing family information.</p><button disabled={state.loading} onClick={() => void client.signIn().catch(e => setError(e.message))}>Sign in</button></div>}
      {!online && state.storage !== 'device' && <p className="dm-notice">Offline · your request draft is saved on this device. Open Daymark when connected to send it.</p>}
      {shared && <div className="dm-notice"><p>A shared notice is saved on this phone. It has not been uploaded.</p><button onClick={() => void importShared()}>Add shared notice to request</button></div>}
      {error && <p className="dm-error" role="alert">{error}</p>}
      {routineNotice && <p className="dm-notice" role="status">{routineNotice}</p>}
      {tab === 'assistant' ? <section aria-label="Conversation" className="dm-conversation">
        {!!state.incomingPickups?.length && <section aria-label="Pickup requests for you"><div className="dm-section-title"><h2>Pickup requests for you</h2></div>{state.incomingPickups.map(r => <button className="dm-job" key={r.id} onClick={() => setIncoming(r)}><strong>Pickup for {r.child}</strong><span>{noticeDate(r.date)} · {r.time} · {r.location}</span><span>{r.reminder ? 'Reminder · your response is needed' : 'Your response is needed'}</span></button>)}</section>}
        {!conversation.length && !state.incomingPickups?.length && <div className="dm-empty dm-welcome"><p className="dm-welcome-eyebrow">{state.preferences?.parentName ? `Hi, ${state.preferences.parentName}.` : `Hi, I’m ${assistantName}.`}</p><h2>What can I take off your list?</h2><p>A family plan, something to remember,<br />or a note that needs a reply.</p><div className="dm-conversation-starters"><button onClick={() => { compose('What needs my attention?'); requestInput.current?.focus() }}>What needs my attention?</button><button onClick={() => { compose('What can you do?'); requestInput.current?.focus() }}>What can you do?</button></div></div>}
        {visibleConversation.length < conversation.length && !all && <button className="dm-text-button dm-older-messages" onClick={() => setAll(true)}>Show earlier messages</button>}
        <div className="dm-sr-only" aria-label="Request updates" aria-live="polite" aria-atomic="true">{receiptAnnouncement}</div>
        {visibleConversation.map(item => {
          if (item.kind === 'mailProposal') return <article className="dm-thread" key={item.id} aria-label="Retained email follow-up"><time className="dm-chat-time" dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><ConversationMessage name={assistantName} avatar={state.preferences?.avatar}><PrivateMailProposalConversation proposal={item.proposal} state={state} client={client} shared={openJob} /></ConversationMessage></article>
          if (item.kind === 'mailDraft') return <article className="dm-thread" key={item.id} id={conversationTargetId(item.id)} tabIndex={-1} aria-label={`Email reply: ${item.draft.subject}`}><time className="dm-chat-time" dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><ConversationMessage name={assistantName} avatar={state.preferences?.avatar}><p>{privateReplyStatus[item.draft.status]}: {item.draft.subject}</p><button className="dm-conversation-review" onClick={() => setMailReview(item.draft.id)}>{item.draft.status === 'sent' ? 'View sent reply' : 'Review email reply'}<CaretRight size={15} aria-hidden="true" /></button></ConversationMessage></article>
          if (item.kind === 'mail') return <PrivateMailRun key={`mail:${item.id}`} run={item.run} state={state} client={client} shared={id => { openJob(id); setSentJob(id) }} />
          if (item.kind === 'voice') return <article className="dm-thread dm-conversation-voice" id="current-voice-conversation" key={item.id} tabIndex={-1} aria-label="Current voice conversation"><VoiceCallDisplay call={item.call} /><div className="dm-thread-end" ref={voiceEnd} /></article>
          if (item.kind === 'outcome') return <article className="dm-thread" key={item.id} data-conversation-update={item.id}><time className="dm-chat-time" dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><ConversationMessage name={assistantName} avatar={state.preferences?.avatar} outcome><p>{item.text}</p><button className="dm-conversation-review" onClick={() => { openJob(item.jobId) }}>View request<CaretRight size={15} aria-hidden="true" /></button></ConversationMessage></article>
          const job = item.job, activity = conversationActivity(job, state.assistantRuns), reply = conversationReply(job)
          const reviewable = !job.preparing && !isConversation(job)
          const reviewLabel = job.scheduledFor ? 'Review scheduled request' : job.actions.some(a => ['review', 'failed', 'uncertain'].includes(a.status)) ? 'Review request' : 'View request'
          return <article className="dm-thread dm-conversation-work" key={job._id} id={conversationTargetId(job._id)} tabIndex={-1} aria-label={job.source?.text ? `Conversation: ${job.source.text.slice(0, 100)}` : 'Saved request'}>
            {job.createdAt && <time className="dm-chat-time" dateTime={new Date(job.createdAt).toISOString()}>{new Date(job.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>}
            {job.source?.text && <div className="dm-request-context"><p>{job.source.text}</p></div>}
            <ConversationMessage name={assistantName} avatar={state.preferences?.avatar} mood={jobAvatarMood(job)} activity={activity}>
              {reply && <p>{reply}</p>}
              <ConversationRetry job={job} client={client} />
              <AssistantWork state={state} runs={state.assistantRuns ?? []} jobId={job._id} client={client} />
              {reviewable && <button className="dm-conversation-review" onClick={() => setReview(job._id)} aria-label={`${reviewLabel}: ${job.actions.length ? title(job.actions[0]) : 'request'}`}><span>{reviewLabel}</span><CaretRight size={16} aria-hidden="true" /></button>}
            </ConversationMessage>
          </article>
        })}
        <VoiceConversation open={voiceOpen} onOpenChange={setVoiceOpen} hideTrigger onCallChange={setVoiceCall} onSignIn={(state.storage === 'device' ? state.accountAvailable : state.configured && !state.signedIn) ? async () => { await persist.current; await client.signIn() } : undefined} ownerKey={state.ownerKey ?? (state.storage === 'device' ? 'device-workspace' : undefined)} settings={state.voiceSettings} start={client.startVoice} stop={client.stopVoice} ask={client.askSolaVoice} onTranscript={value=>{setText(value);requestInput.current?.focus()}} replyToSpeak={jobs.at(-1)?.clarification ?? ''}/>
        <div className="dm-thread-end" ref={threadEnd} />
      </section> : tab === 'tasks' || tab === 'history' ? <Tasks key={tab} state={state} client={client} openJob={openJob} openMailDraft={openMailDraft} openMailProposal={openMailProposal} compose={compose} initialFilter={tab === 'history' ? 'Finished' : 'All'} /> : tab === 'library' ? <Library state={state} client={client} openJob={openJob} compose={compose} /> : <FamilyPlan state={state} open={actionId => setReview(state.jobs.find(j => j.actions.some(a => a._id === actionId))?._id ?? null)} />}
    </main>
    <div className="dm-dock" ref={dock}>
    {tab === 'assistant' && <>{voiceCall && <button className="dm-text-button dm-current-call" onClick={() => { document.getElementById('current-voice-conversation')?.focus({ preventScroll: true }); voiceEnd.current?.scrollIntoView({ block: 'end', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }}>Return to current call</button>}{chatScroll.unseen && <button className="dm-latest" onClick={chatScroll.jump}>Latest messages ↓</button>}<form className="dm-composer dm-composer-voice" onSubmit={e => { e.preventDefault(); void send() }}><label className="dm-sr-only" htmlFor="request">What can I handle?</label><button type="button" aria-label="Attach a notice" disabled={!draftLoaded || busy} onClick={() => fileInput.current?.click()}><Plus size={23} aria-hidden="true" /></button><textarea ref={requestInput} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)} id="request" disabled={!draftLoaded} placeholder="What can I handle?" maxLength={20000} value={text} onChange={e => setText(e.target.value)} rows={1} onKeyDown={e => { if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey) return; if (e.metaKey || e.ctrlKey || window.innerWidth >= 768 && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} /><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/heic,.heic,.pdf" multiple hidden disabled={busy} onChange={e => { void chooseFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} /><button type="button" aria-label="Talk with Sola" aria-expanded={voiceOpen} aria-pressed={voiceCall?.state === 'active' || voiceCall?.state === 'connecting'} onClick={() => setVoiceOpen(value => !value)}><Microphone size={21} aria-hidden="true" /></button><button className="dm-primary" onPointerDown={e => { if (document.activeElement === requestInput.current) e.preventDefault() }} disabled={busy || (!text.trim() && !files.length) || !state.configured || (!online && state.storage !== 'device') || state.loading} type="submit" aria-label={busy ? 'Sending…' : state.signedIn || state.storage === 'device' ? 'Send' : 'Sign in to send'}><ArrowUp size={20} weight="regular" aria-hidden="true" className={busy ? 'dm-send-pending' : undefined} /></button>{files.length > 0 && <p className="dm-files">{files.map(f => f.name).join(', ')} · Saved locally <button type="button" disabled={busy} onClick={() => void chooseFiles([])}>Remove files</button></p>}</form>{busy && <span className="dm-sr-only" role="status">Saving your request…</span>}</>}
    {state.storage === 'device' && <p className="dm-local-status">On this device · no sign-in needed</p>}
    <nav className="dm-nav" aria-label="Main navigation">{([
      ['assistant', 'Assistant', ChatCircle], ['tasks', 'Tasks', CheckSquare], ['library', 'Library', SquaresFour], ['plan', 'Plan', CalendarBlank],
    ] as const).map(([destination, label, Icon]) => <button key={destination} aria-current={tab === destination || destination === 'tasks' && tab === 'history' ? 'page' : undefined} onClick={() => setTab(destination)}><Icon size={22} weight="regular" aria-hidden="true" /><span>{label}</span></button>)}</nav></div>
    {current && !current.preparing && !isConversation(current) && <Review key={`${current._id}:${current.source?.revision}:${current.preparing}:${current.actions.map(a => a._id).join(',')}`} job={current} state={state} client={client} close={() => setReview(null)} openHousehold={() => setSettings(true)} />}
    {currentMailDraft && <PrivateMailReplyReview draft={currentMailDraft} state={state} client={client} close={() => setMailReview(null)} />}
    {settings && <Household state={state} client={client} close={() => setSettings(false)} />}
    {routineDraft && <RoutineEditor state={state} client={client} initial={routineDraft.definition} note={routineDraft.note} close={() => setRoutineDraft(null)} saved={() => { setText(current => current === routineDraft.text ? '' : current); setRoutineNotice('Routine saved. You can change or pause it in Tasks.'); setTab('tasks') }} />}
    {memoryReview && <Sheet label="Review memory" close={() => setMemoryReview(null)}>{state.memoryProposals?.find(p => p._id === memoryReview) ? <MemoryProposalReview key={memoryReview} proposal={state.memoryProposals.find(p => p._id === memoryReview)!} state={state} client={client} onClose={() => setMemoryReview(null)} /> : <p role="status">This suggestion is no longer pending. You can find confirmed details in Household settings.</p>}</Sheet>}
    {incoming && <PickupReply request={incoming} current={state.incomingPickups?.find(r => r.id === incoming.id)} client={client} close={() => setIncoming(null)} />}
  </div>
}
