import { connectorRequestSchema, connectorRequestKey, connectorRequestId, connectorRequestLimit, type ConnectorRequest } from '../../../shared/connectorRequests'
import { defaultPreferences, libraryChangesSchema, preferencesSchema, validateLibraryFiles } from '../../../shared/library'
import { jobStatus, jobSummary, localAssistantReply } from '../../../shared/assistant'
import { Temporal } from '@js-temporal/polyfill'
import { routineDefinitionSchema, nextOccurrence, latestOccurrence, type RoutineDefinition, type Routine, type RoutineRun } from '../../../shared/routines'
import { capabilityReply } from '../../../shared/capabilities'
import { householdAssistantReply, isPreparationRequest } from '../../../shared/householdAssistant'
import { assistantName } from '../../../shared/persona'
import { personalTaskSchema, validateSchedule, type PersonalTaskInput } from '../../../shared/tasks'
import { Capacitor } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { blockers, payloadSchema, payloadHash, sourceHash, validTimezone, calendarTimes, instant, type CalendarDraft } from '../../../shared/daymark'
import { MEMORY_PROPOSAL_TTL, parseMemoryCandidate, parseMemoryRequest } from '../../../shared/memoryProposals'
import { nativeEventPayload, nativeOperation, validateNativeDestination, type NativeEvent, type NativeCalendarOperation, type NativeCalendarResult } from '../../../shared/nativeCalendar'
import { nativeCalendar } from './nativeCalendar'
import { prepareOnDevice } from '../../../shared/devicePreparation'
import type { DaymarkClient, DaymarkState, Deliverable, Job } from './types'

type FileRecord = { data: Blob; expiresAt: number }
type NativeAttempt = { operation: NativeCalendarOperation; revision: number; sourceRevision: number }
type StoredRoutineRun = Omit<RoutineRun, 'status' | 'summary' | 'issue'> & { routineId: string }
type RoutineOrigin = { id: string; version: number; localDate: string; timezone: string }
type Workspace = { connectorRequests?: (ConnectorRequest & { requestHash: string })[]; connectorRequestKeys?: Record<string, { id: string; hash: string }>; memoryRequests?: Record<string, { id: string; hash: string }>; memorySources?: Record<string, { jobId: string; revision: number }>; routines?: Routine[]; routineRuns?: StoredRoutineRun[]; routineRequests?: Record<string, { id: string; hash: string }>; routineJobs?: Record<string, RoutineOrigin>; state: DaymarkState; hashes: Record<string, string>; files: Record<string, FileRecord>; expiry: Record<string, number>; nativeEvents?: Record<string, NativeEvent>; nativeBefore?: Record<string, NativeEvent>; nativeAttempts?: Record<string, NativeAttempt>; libraryFiles?: Record<string, Blob>; taskRequests?: Record<string, { id: string; hash: string }>; scheduledRequests?: Record<string, { id: string; hash: string }> }
const empty = (): Workspace => ({ state: { storage: 'device', configured: true, signedIn: false, household: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', children: [] }, jobs: [], personalTasks: [], connectorRequests: [], memoryProposals: [], routines: [], routineSettings: { preparationModelConfigured: false, catchUp: 'latest_only', maxSaved: 100 }, plan: [], caregivers: [], arrangements: [], facts: [], library: [], preferences: { ...defaultPreferences }, connection: null }, hashes: {}, files: {}, expiry: {} })
const retention = 30 * 86400_000
function requestKey(requestId: string) { const id = requestId.trim(); if (!id || id.length > 100) throw new Error('This request needs a valid identifier. Please try again.'); return `request:${id}` }
function personalInput(data: Workspace, raw: PersonalTaskInput) { const input = personalTaskSchema.parse(raw); if (input.childId && !data.state.household?.children.some(c => c.id === input.childId)) throw new Error('Choose a child in this household.'); return { ...input, childId: input.childId || undefined } }
function personalTask(data: Workspace, id: string, version: number) { const task = data.state.personalTasks?.find(t => t.id === id); if (!task || task.version !== version) throw new Error('This task changed. Reopen it before making changes.'); return task }
function replyFor(text: string, data: Workspace) {
  const native = data.state.nativeCalendar
  return capabilityReply(text, { mode: 'device', ...(native ? { apple: { available: native.available, permission: native.permission, selected: !!native.selectedId } } : {}) })
    ?? localAssistantReply(text, { storage: 'device', parentName: data.state.preferences?.parentName, assistantName: assistantName(data.state.preferences) })
}
function householdReply(text: string, data: Workspace) {
  return householdAssistantReply(text, { jobs: data.state.jobs, personalTasks: data.state.personalTasks ?? [], plan: data.state.plan, children: data.state.household?.children, timezone: data.state.household?.timezone ?? 'UTC', storage: 'device' })
}
function validateScheduledText(text: string, data: Workspace) { if (replyFor(text, data) || householdReply(text, data) || !isPreparationRequest(text)) throw new Error('Send greetings and questions to your assistant now. Schedule a request to prepare a calendar change, email, or pickup instead.') }
function checkedFact(data: Workspace, raw: unknown) {
  const value = parseMemoryCandidate(raw)
  if ('childId' in value && !data.state.household!.children.some(child => child.id === value.childId)) throw new Error('Choose a confirmed child.')
  if ('caregiverId' in value && !data.state.caregivers.some(caregiver => caregiver._id === value.caregiverId && (!('childId' in value) || caregiver.childIds.includes(value.childId)))) throw new Error('Choose an eligible caregiver.')
  if (value.kind === 'routine' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('Confirm the routine time.')
  if (value.kind === 'availability') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || ![value.start, value.end].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('Confirm the availability date and times.')
    if (instant(value.date, value.end, data.state.household!.timezone).epochMilliseconds <= instant(value.date, value.start, data.state.household!.timezone).epochMilliseconds) throw new Error('Availability must end after it starts.')
  }
  return value
}
function checkedMemorySource(data: Workspace, jobId?: string, revision?: number) {
  if (!jobId) { if (revision !== undefined) throw new Error('Choose the original request.'); return }
  const job = data.state.jobs.find(job => job._id === jobId)
  if (!job || job.cancelled || !job.source?.text || job.source.revision !== revision || !data.expiry[jobId] || data.expiry[jobId] <= Date.now()) throw new Error('The supporting request is unavailable or changed. Make a fresh memory request.')
}
function pendingMemory(data: Workspace, id: string, version: number) {
  const proposal = data.state.memoryProposals?.find(proposal => proposal._id === id)
  if (!proposal || proposal.version !== version || proposal.expiresAt <= Date.now()) throw new Error('This memory suggestion changed or expired. Open its latest version.')
  return proposal
}
function clearMemory(data: Workspace, id: string) {
  data.state.memoryProposals = data.state.memoryProposals?.filter(proposal => proposal._id !== id) ?? []
  delete data.memorySources?.[id]
}
function checkedRoutine(data: Workspace, raw: RoutineDefinition): RoutineDefinition {
  const parsed = routineDefinitionSchema.safeParse(raw)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Confirm the routine details.')
  const definition = parsed.data
  if (definition.outcome.kind === 'personal_task') personalInput(data, definition.outcome.task)
  else validateScheduledText(definition.outcome.instruction, data)
  return definition
}
function currentRoutine(data: Workspace, id: string, version: number) {
  const routine = data.routines?.find(routine => routine.id === id)
  if (!routine || routine.state === 'removed' || routine.version !== version) throw new Error('This routine changed. Reopen it before editing.')
  return routine
}
function routineIssue(data: Workspace, job: Job): string | undefined {
  const origin = data.routineJobs?.[job._id]
  if (!origin) return
  const routine = data.routines?.find(routine => routine.id === origin.id)
  if (!routine || routine.version !== origin.version || !['active', 'finished'].includes(routine.state)) return 'This routine changed or stopped. Start a new request to use these details; earlier results are still saved.'
}
function checkRoutineJob(data: Workspace, job: Job) {
  const issue = routineIssue(data, job)
  if (issue) throw new Error(issue)
}
function saveRoutineVersion(routine: Routine, definition: RoutineDefinition, state: 'active' | 'paused') {
  const next = state === 'active' ? nextOccurrence(definition.schedule, Date.now()) : null
  if (state === 'active' && !next) throw new Error('Choose a schedule with a future occurrence before enabling this routine.')
  Object.assign(routine, { definition, state, version: routine.version + 1, nextRunAt: next?.at, issue: undefined, updatedAt: Date.now() })
  return routine.version
}
function runRoutines(data: Workspace): boolean {
  let changed = false
  const now = Date.now()
  for (const routine of data.routines ?? []) {
    if (routine.state !== 'active' || routine.nextRunAt === undefined || routine.nextRunAt > now) continue
    changed = true
    let definition: RoutineDefinition
    try { definition = checkedRoutine(data, routine.definition!) }
    catch { Object.assign(routine, { state: 'blocked', issue: 'Saved household or routine details changed. Review this routine before resuming.', nextRunAt: undefined, updatedAt: now }); continue }
    const occurrence = latestOccurrence(definition.schedule, now, routine.nextRunAt)
    if (!occurrence) { Object.assign(routine, { state: 'blocked', issue: 'The saved occurrence no longer matches its schedule. Review this routine.', nextRunAt: undefined, updatedAt: now }); continue }
    // A routine has at most one occurrence on its nominal date, even across edits.
    // The record, output, and next run are committed together by the enclosing IDB transaction.
    data.routineRuns ??= []
    if (!data.routineRuns.some(run => run.routineId === routine.id && run.localDate === occurrence.localDate)) {
      const run: StoredRoutineRun = { id: crypto.randomUUID(), routineId: routine.id, version: routine.version, localDate: occurrence.localDate, scheduledAt: occurrence.at, ...(occurrence.at > routine.nextRunAt ? { caughtUpFrom: routine.nextRunAt } : {}), createdAt: now }
      if (definition.outcome.kind === 'personal_task') {
        const task = definition.outcome.task, id = crypto.randomUUID(), dueDate = Temporal.PlainDate.from(occurrence.localDate).add({ days: definition.outcome.dueAfterDays }).toString()
        data.state.personalTasks ??= []
        data.state.personalTasks.unshift({ ...task, id, dueDate, done: false, version: 1, createdAt: now, updatedAt: now })
        run.personalTaskId = id
      } else {
        const id = crypto.randomUUID(), text = definition.outcome.instruction, prepared = drafts(text, data.state, definition.schedule.timezone)
        data.state.jobs.unshift({ _id: id, createdAt: now, preparing: false, cancelled: false, source: { text, revision: 1 }, files: [], ...prepared })
        data.routineJobs ??= {}; data.routineJobs[id] = { id: routine.id, version: routine.version, localDate: occurrence.localDate, timezone: definition.schedule.timezone }
        data.expiry[id] = now + retention; run.jobId = id
      }
      data.routineRuns.push(run)
    }
    const next = nextOccurrence(definition.schedule, now)
    Object.assign(routine, { state: next ? 'active' : 'finished', nextRunAt: next?.at, lastRunAt: occurrence.at, updatedAt: now, issue: undefined })
  }
  return changed
}
function routineHistory(data: Workspace, id: string): RoutineRun[] {
  if (!data.routines?.some(routine => routine.id === id)) throw new Error('This routine is no longer available.')
  return (data.routineRuns ?? []).filter(run => run.routineId === id).sort((a, b) => b.scheduledAt - a.scheduledAt).slice(0, 50).map(run => {
    if (run.personalTaskId) {
      const task = data.state.personalTasks?.find(task => task.id === run.personalTaskId)
      return { ...run, status: !task ? 'removed' : task.done ? 'done_by_parent' : 'needs_parent', summary: !task ? 'The personal task was removed.' : task.done ? 'Marked done by the parent.' : 'Saved to Tasks for the parent to do.' }
    }
    const job = data.state.jobs.find(job => job._id === run.jobId)
    if (!job) return { ...run, status: 'unavailable', summary: 'The request is no longer available.' }
    const issue = routineIssue(data, job), status = job.cancelled ? 'cancelled' : jobStatus(job)
    return { ...run, status: issue && status !== 'Finished' && status !== 'cancelled' ? 'Needs you' : status, summary: jobSummary(job), ...(issue ? { issue } : {}) }
  })
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('daymark-device-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('workspace')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Device storage is unavailable. Your request has not been saved.'))
  })
}
function prune(data: Workspace) {
  for (const proposal of data.state.memoryProposals ?? []) if (proposal.expiresAt <= Date.now()) clearMemory(data, proposal._id)
  for (const [id, expiry] of Object.entries(data.expiry)) if (expiry < Date.now()) {
    const job = data.state.jobs.find(j => j._id === id)
    if (job) { job.source = job.source ? { revision: job.source.revision } : null; if (job.conversation) job.clarification = 'This conversation has expired.'; job.files = []; job.actions.forEach(a => { a.payload.evidence = {} }) }
    delete data.expiry[id]
  }
  for (const [id, file] of Object.entries(data.files)) if (file.expiresAt < Date.now()) delete data.files[id]
}
async function transaction<T>(change: (data: Workspace) => T): Promise<{ result: T; state: DaymarkState }> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite'), store = tx.objectStore('workspace'), request = store.get('current')
    let result: T, data: Workspace, failure: unknown
    request.onsuccess = () => {
      try { data = request.result ?? empty(); prune(data); result = change(data); data.state.routines = (data.routines ?? []).filter(routine => routine.state !== 'removed'); data.state.connectorRequests = (data.connectorRequests ?? []).filter(request => request.status === 'requested').map(({ requestHash, ...request }) => request); store.put(data, 'current') }
      catch (e) { failure = e; tx.abort() }
    }
    tx.oncomplete = () => { db.close(); resolve({ result, state: data.state }) }
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? new Error('Could not save on this device. Your previous work is preserved.')) }
  })
}
const unavailable = async (): Promise<never> => { throw new Error('This service is not connected for device mode. Your draft is saved; nothing has been sent.') }
function action(data: Workspace, id: string, revision?: number) {
  const job = data.state.jobs.find(j => j.actions.some(a => a._id === id)), a = job?.actions.find(a => a._id === id)
  if (!job || !a || job.cancelled) throw new Error('This request is no longer available.')
  if (revision !== undefined && a.revision !== revision) throw new Error('This review changed. Load the latest review before saving.')
  return { job, a }
}
function drafts(text: string, state: DaymarkState, timezone = state.household!.timezone): { actions: Deliverable[]; clarification: string } {
  const prepared = prepareOnDevice(text, { ...state.household!, timezone, caregivers: state.caregivers })
  return { ...prepared, actions: prepared.actions.map(payload => ({ _id: crypto.randomUUID(), revision: 1, payload, status: 'review', receipts: [] })) }
}
function checkTarget(data: Workspace, a: Deliverable) {
  if (a.payload.kind !== 'calendar' || !a.payload.targetId) return
  const targetId = a.payload.targetId, current = data.state.plan.find(p => p._id === targetId)
  if (!current || !a.before || payloadHash(current.payload) !== payloadHash(a.before.payload)) throw new Error('The original plan item changed. Refresh current plan details and review again.')
}
async function fileRecords(files: File[]) {
  if (files.length > 5 || files.reduce((n, f) => n + f.size, 0) > 10 * 1024 * 1024 || files.some(f => /\.pdf$/i.test(f.name)) && files.length !== 1) throw new Error('Share up to five images or one PDF, 10 MB total.')
  return Promise.all(files.map(async f => {
    let mediaType = f.type || (/\.heic$/i.test(f.name) ? 'image/heic' : /\.pdf$/i.test(f.name) ? 'application/pdf' : '')
    if (!['image/jpeg', 'image/png', 'image/heic', 'application/pdf'].includes(mediaType)) throw new Error('Use JPG, PNG, HEIC, or PDF files.')
    const bytes = new Uint8Array(await f.arrayBuffer()), header = new TextDecoder('latin1').decode(bytes.slice(0, 24))
    const detected = header.startsWith('%PDF-') ? 'application/pdf' : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b) ? 'image/png' : header.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(header.slice(8)) ? 'image/heic' : ''
    if (!detected) throw new Error('This file is not a supported image or PDF. SVG and video files are not supported.')
    mediaType = detected
    if (mediaType === 'application/pdf') {
      const { PDFDocument } = await import('pdf-lib')
      try { const pdf = await PDFDocument.load(await f.arrayBuffer()); if (pdf.getPageCount() > 10) throw new Error() } catch { throw new Error('Use an unencrypted PDF with at most ten pages.') }
    }
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('')
    return { id: crypto.randomUUID(), name: f.name.slice(0, 200), size: f.size, mediaType, hash: fingerprint, data: f.slice(0, f.size, mediaType) }
  }))
}
function calendarFile(p: CalendarDraft, id: string) {
  const times = calendarTimes(p), escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r/g, '')
  const stamp = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateLine = (name: string, t: { date?: string; dateTime?: string }) => t.date ? `${name};VALUE=DATE:${stamp(t.date)}` : `${name}:${stamp(t.dateTime!)}`
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Daymark//Device plan//EN', 'BEGIN:VEVENT', `UID:daymark-${id}@device`, `DTSTAMP:${stamp(new Date().toISOString())}`, dateLine('DTSTART', times.start), dateLine('DTEND', times.end), `SUMMARY:${escape(p.title)}`, `LOCATION:${escape(p.location)}`, `DESCRIPTION:${escape(p.notes)}`, 'END:VEVENT', 'END:VCALENDAR']
  return lines.map(line => { let result = '', width = 0; for (const char of line) { const bytes = new TextEncoder().encode(char).length; if (width + bytes > 74) { result += '\r\n '; width = 1 } result += char; width += bytes } return result }).join('\r\n') + '\r\n'
}
export function createDeviceStore(signIn: () => Promise<void> = unavailable, calendar = nativeCalendar) {
  let snapshot = { ...empty().state, loading: true }, load: Promise<void> | undefined
  const subscribers = new Set<() => void>()
  let channel: BroadcastChannel | null = null
  let opened = false, foreground = true, dueTimer: ReturnType<typeof setTimeout> | undefined
  let appListener: ReturnType<typeof NativeApp.addListener> | undefined
  const isActive = () => opened && foreground && document.visibilityState !== 'hidden'
  const scheduleDueCheck = (delay: number): void => { dueTimer = setTimeout(() => { void prepareDue().catch(() => { if (isActive()) scheduleDueCheck(30000) }) }, delay) }
  const armDueTimer = () => {
    if (dueTimer) clearTimeout(dueTimer)
    dueTimer = undefined
    if (!isActive()) return
    const pending = [...snapshot.jobs.filter(job => !job.cancelled && job.scheduledFor !== undefined).map(job => job.scheduledFor!), ...(snapshot.routines ?? []).filter(routine => routine.state === 'active' && routine.nextRunAt !== undefined).map(routine => routine.nextRunAt!)]
    if (!pending.length) return
    const delay = Math.max(250, Math.min(30000, Math.min(...pending) - Date.now()))
    scheduleDueCheck(delay)
  }
  const publish = (state: DaymarkState) => { snapshot = { ...state, personalTasks: state.personalTasks ?? [], connectorRequests: state.connectorRequests ?? [], memoryProposals: state.memoryProposals ?? [], routines: state.routines ?? [], routineSettings: { preparationModelConfigured: false, catchUp: 'latest_only', maxSaved: 100 }, library: state.library ?? [], preferences: { ...defaultPreferences, ...state.preferences, assistantName: assistantName(state.preferences), avatar: state.preferences?.avatar ?? defaultPreferences.avatar }, loading: false }; subscribers.forEach(fn => fn()); armDueTimer() }
  const change = async <T,>(fn: (data: Workspace) => T) => { const saved = await transaction(fn); publish(saved.state); channel?.postMessage('changed'); return saved.result }
  const refresh = async () => { const saved = await transaction(() => undefined); publish(saved.state) }
  const prepareDue = async () => {
    if (!isActive()) return
    // The due check, draft creation, and removal of the schedule share one IDB transaction.
    // Multiple tabs or a suspended/reopened app therefore cannot prepare it twice.
    const saved = await transaction(data => {
      if (!isActive()) return false
      let changed = runRoutines(data)
      for (const job of data.state.jobs) {
        if (job.cancelled || job.scheduledFor === undefined || job.scheduledFor > Date.now()) continue
        delete job.scheduledFor; job.preparing = false; changed = true
        const text = job.source?.text
        if (!text?.trim()) { job.clarification = 'The original scheduled request expired. Share it again to prepare the work.'; continue }
        try {
          const reply = replyFor(text, data), prepared = reply ? { actions: [], clarification: reply } : drafts(text, data.state)
          if (reply) job.conversation = true; else delete job.conversation
          job.actions.push(...prepared.actions); job.clarification = prepared.clarification
        } catch { job.clarification = 'This scheduled request could not be prepared. Open it and correct the source to try again.' }
        data.expiry[job._id] = Date.now() + retention
      }
      return changed
    })
    publish(saved.state)
    if (saved.result) channel?.postMessage('changed')
  }
  const resume = () => { if (isActive()) void prepareDue().catch(() => scheduleDueCheck(30000)); else armDueTimer() }
  const updateCalendarStatus = async (requestAccess = false) => {
    if (!calendar.available()) return
    const permission = await (requestAccess ? calendar.connect() : calendar.status())
    return change(data => {
      const previous = data.state.nativeCalendar
      // A lost or renamed destination invalidates reviews; never silently choose a different calendar.
      const changed = previous && (previous.permission !== permission.permission || JSON.stringify(previous.calendars) !== JSON.stringify(permission.calendars))
      data.state.nativeCalendar = { ...permission, available: true, selectedId: previous?.selectedId, version: (previous?.version ?? 0) + (changed || !previous ? 1 : 0) }
    })
  }
  const completeNative = async (id: string, attempt: NativeAttempt, result: NativeCalendarResult) => change(data => {
    const job = data.state.jobs.find(j => j.actions.some(a => a._id === id)), a = job?.actions.find(a => a._id === id)
    if (!a || a.revision !== attempt.revision || data.nativeAttempts?.[id]?.operation.approvalHash !== attempt.operation.approvalHash) throw new Error('The Apple Calendar result is saved on this iPhone, but the local review changed. Check the calendar before continuing.')
    if (result.status !== 'verified' || !result.verifiedAt || !result.eventId || attempt.operation.operation !== 'delete' && !result.fingerprint) {
      a.status = result.status === 'review' ? 'review' : 'uncertain'; a.error = result.message ?? 'Apple Calendar has not confirmed this change.'
      if (result.status === 'review') { delete data.nativeAttempts![id]; a.revision++ }
      return
    }
    const target = a.payload.kind === 'calendar' ? a.payload.targetId : null
    if (attempt.operation.operation === 'delete') { data.state.plan = data.state.plan.filter(p => p._id !== target); if (target) delete data.nativeEvents?.[target] }
    else {
      const planId = target ?? id
      data.state.plan = data.state.plan.filter(p => p._id !== planId && p.actionId !== id)
      data.state.plan.push({ _id: planId, actionId: id, payload: a.payload })
      data.nativeEvents ??= {}; data.nativeEvents[planId] = { ...attempt.operation, eventId: result.eventId, fingerprint: result.fingerprint! }
    }
    a.status = 'succeeded'; a.error = undefined
    if (!a.receipts.some(r => r.outcome.startsWith('apple_calendar'))) a.receipts.push({ _id: crypto.randomUUID(), providerId: result.eventId, outcome: attempt.operation.operation === 'delete' ? 'apple_calendar_deleted' : 'apple_calendar_readback', verifiedAt: result.verifiedAt })
    delete data.nativeAttempts![id]
  })
  const reconcileNative = async (id: string) => {
    const saved = await transaction(data => data.nativeAttempts?.[id])
    if (!saved.result) throw new Error('There is no pending Apple Calendar operation to check.')
    await completeNative(id, saved.result, await calendar.reconcile(saved.result.operation))
  }
  const approveNative = async (selected: Parameters<DaymarkClient['approve']>[0]) => {
    // Reserve each operation durably before crossing the native bridge. Failure leaves prior successes intact.
    for (const selectedAction of selected) {
      const attempt = await change(data => {
        const { job, a } = action(data, selectedAction.id, selectedAction.revision)
        checkRoutineJob(data, job)
        if (a.status === 'succeeded' || a.status === 'saved') return null
        if (a.status !== 'review' || a.payload.kind !== 'calendar') throw new Error('Review this calendar change separately before saving.')
        validateNativeDestination(data.state.nativeCalendar, selectedAction.nativeCalendar)
        const issues = blockers(a.payload, data.state.household!.children); if (issues.length) throw new Error(issues.join(' '))
        checkTarget(data, a)
        const targetId = a.payload.targetId
        if (data.state.jobs.some(j => j.actions.some(other => other._id !== a._id && ['executing', 'uncertain'].includes(other.status) && other.payload.kind === 'calendar' && other.payload.targetId && other.payload.targetId === targetId))) throw new Error('Another change to this event still needs its result checked.')
        const operation = nativeOperation(a._id, a.revision, job.source?.revision ?? 1, a.payload, selectedAction.nativeCalendar!, data.nativeBefore?.[a._id])
        const attempt = { operation, revision: a.revision, sourceRevision: job.source?.revision ?? 1 }
        data.nativeAttempts ??= {}; data.nativeAttempts[a._id] = attempt; a.status = 'executing'; a.error = undefined
        return attempt
      })
      if (!attempt) continue
      try { await completeNative(selectedAction.id, attempt, await calendar.execute(attempt.operation)) }
      catch (error) { await completeNative(selectedAction.id, attempt, { status: 'uncertain', message: (error as Error).message }); throw error }
    }
  }
  const client: DaymarkClient = {
    createConnectorRequest: (raw, rawId) => change(data => {
      const input = connectorRequestSchema.parse(raw), key = `request:${connectorRequestId(rawId)}`, hash = sourceHash(connectorRequestKey(input)), previous = data.connectorRequestKeys?.[key]
      if (previous) { if (previous.hash !== hash) throw new Error('This identifier was already used for a different connector request.'); return previous.id }
      data.connectorRequests ??= []; data.connectorRequestKeys ??= {}
      const identical = data.connectorRequests.find(request => request.status === 'requested' && request.requestHash === hash)
      let id = identical?.id
      if (!id) {
        if (data.connectorRequests.filter(request => request.status === 'requested').length >= connectorRequestLimit) throw new Error('Dismiss an existing connector request before saving another.')
        id = crypto.randomUUID(); const now = Date.now()
        data.connectorRequests.unshift({ ...input, id, requestHash: hash, status: 'requested', version: 1, createdAt: now, updatedAt: now })
      }
      data.connectorRequestKeys[key] = { id, hash }; return id
    }),
    dismissConnectorRequest: (id, version) => change(data => {
      const request = data.connectorRequests?.find(request => request.id === id)
      if (!request || request.status !== 'requested' || request.version !== version) throw new Error('This connector request changed. Reopen the latest version.')
      Object.assign(request, { status: 'dismissed', service: undefined, outcome: '', version: request.version + 1, updatedAt: Date.now() })
    }),
    signIn, signOut: async () => {},
    savePreferences: value => change(data => { const previous = data.state.preferences; const parsed = preferencesSchema.parse(value); data.state.preferences = { ...parsed, avatar: parsed.avatar ?? previous?.avatar ?? defaultPreferences.avatar } }),
    saveHouseholdName: raw => change(data => { const name = raw.trim(); if (!name || name.length > 80) throw new Error('Give your household a name up to 80 characters.'); data.state.household!.name = name }),
    proposeMemory: input => change(data => {
      const request = parseMemoryRequest(input.text), key = requestKey(input.requestId)
      if (!request) throw new Error('Start with “Remember …” and keep the detail under 2,000 characters.')
      const value = input.value === undefined ? undefined : checkedFact(data, input.value)
      const hash = sourceHash(JSON.stringify({ text: request.text, value: value ?? null, sourceJobId: input.sourceJobId ?? null, sourceRevision: input.sourceRevision ?? null })), previous = data.memoryRequests?.[key]
      if (previous) { if (previous.hash !== hash) throw new Error('This identifier belongs to a different memory request.'); return previous.id }
      checkedMemorySource(data, input.sourceJobId, input.sourceRevision)
      data.state.memoryProposals ??= []; data.memoryRequests ??= {}
      if (data.state.memoryProposals.length >= 100) throw new Error('Review or dismiss your existing memory suggestions first.')
      const id = crypto.randomUUID(), now = Date.now()
      data.state.memoryProposals.unshift({ _id: id, version: 1, text: request.text, ...(value ? { value } : {}), createdAt: now, expiresAt: Math.min(now + MEMORY_PROPOSAL_TTL, input.sourceJobId ? data.expiry[input.sourceJobId] : Infinity) })
      data.memoryRequests[key] = { id, hash }
      if (input.sourceJobId) { data.memorySources ??= {}; data.memorySources[id] = { jobId: input.sourceJobId, revision: input.sourceRevision! } }
      return id
    }),
    confirmMemory: (id, version, raw, replaceFactId, replaceFactVersion) => change(data => {
      pendingMemory(data, id, version)
      const source = data.memorySources?.[id]; checkedMemorySource(data, source?.jobId, source?.revision)
      const value = checkedFact(data, raw), previous = data.state.facts?.find(fact => fact._id === replaceFactId)
      if (replaceFactId && (!previous || !previous.key.startsWith('family:') || previous.version !== replaceFactVersion)) throw new Error('This saved detail changed. Review its latest version before replacing it.')
      if (!replaceFactId && replaceFactVersion !== undefined) throw new Error('Choose the saved detail to replace.')
      const identical = data.state.facts?.find(fact => fact.key.startsWith('family:') && sourceHash(JSON.stringify(fact.value)) === sourceHash(JSON.stringify(value)))
      const factId = previous?._id ?? identical?._id ?? crypto.randomUUID()
      if (previous || !identical) {
        data.state.facts = [...(data.state.facts ?? []).filter(fact => fact._id !== factId), { _id: factId, key: previous?.key ?? `family:${factId}`, value, version: (previous?.version ?? 0) + 1, source: 'Confirmed memory request on this device', updatedAt: Date.now(), scope: value.kind === 'routine' ? 'recurring' : value.kind === 'availability' ? 'one-time' : 'household' }]
      }
      clearMemory(data, id)
      return factId
    }),
    dismissMemory: (id, version) => change(data => { pendingMemory(data, id, version); clearMemory(data, id) }),
    createRoutine: (raw, requestId) => change(data => {
      const definition = checkedRoutine(data, raw), key = requestKey(requestId), hash = sourceHash(JSON.stringify(definition)), previous = data.routineRequests?.[key]
      if (previous) { if (previous.hash !== hash) throw new Error('This request identifier was already used for another routine.'); return previous.id }
      if ((data.routines ?? []).filter(routine => routine.state !== 'removed').length >= 100) throw new Error('This household has 100 saved routines. Remove one before adding another.')
      const next = nextOccurrence(definition.schedule, Date.now())
      if (!next) throw new Error('Choose a schedule with a future occurrence before enabling this routine.')
      const id = crypto.randomUUID(), now = Date.now()
      data.routines ??= []; data.routineRequests ??= {}
      data.routines.unshift({ id, version: 1, state: 'active', definition, nextRunAt: next.at, createdAt: now, updatedAt: now, canEdit: true })
      data.routineRequests[key] = { id, hash }; return id
    }),
    updateRoutine: (id, version, raw) => change(data => { const routine = currentRoutine(data, id, version); return saveRoutineVersion(routine, checkedRoutine(data, raw), routine.state === 'active' ? 'active' : 'paused') }),
    setRoutinePaused: (id, version, paused) => change(data => {
      const routine = currentRoutine(data, id, version)
      if (typeof paused !== 'boolean') throw new Error('Choose whether this routine is paused.')
      const state = paused ? 'paused' : 'active'
      return routine.state === state ? routine.version : saveRoutineVersion(routine, checkedRoutine(data, routine.definition!), state)
    }),
    removeRoutine: (id, version) => change(data => {
      const routine = currentRoutine(data, id, version)
      Object.assign(routine, { state: 'removed', version: routine.version + 1, definition: undefined, nextRunAt: undefined, issue: undefined, updatedAt: Date.now() })
    }),
    routineOccurrences: async id => (await transaction(data => routineHistory(data, id))).result,
    createPersonalTask: (raw, requestId) => change(data => {
      const input = personalInput(data, raw), key = requestKey(requestId), hash = sourceHash(JSON.stringify(input)), previous = data.taskRequests?.[key]
      if (previous) { if (previous.hash !== hash) throw new Error('This request was already used for different task details. Start a new task.'); return previous.id }
      const id = crypto.randomUUID(), now = Date.now()
      data.state.personalTasks ??= []; data.taskRequests ??= {}
      data.state.personalTasks.unshift({ ...input, id, done: false, version: 1, createdAt: now, updatedAt: now }); data.taskRequests[key] = { id, hash }
      return id
    }),
    updatePersonalTask: (id, version, raw) => change(data => { const task = personalTask(data, id, version), input = personalInput(data, raw); Object.assign(task, input, { dueDate: input.dueDate, childId: input.childId, version: task.version + 1, updatedAt: Date.now() }) }),
    setPersonalTaskDone: (id, version, done) => change(data => { const task = personalTask(data, id, version); if (typeof done !== 'boolean') throw new Error('Choose whether this task is done.'); if (task.done !== done) { task.done = done; task.version++; task.updatedAt = Date.now() } }),
    removePersonalTask: (id, version) => change(data => { personalTask(data, id, version); data.state.personalTasks = data.state.personalTasks!.filter(task => task.id !== id) }),
    scheduleRequest: (raw, runAt, requestId) => change(data => {
      const text = raw.trim(), key = requestKey(requestId), hash = sourceHash(JSON.stringify({ text, runAt })), previous = data.scheduledRequests?.[key]
      if (previous) { if (previous.hash !== hash) throw new Error('This request was already used for a different schedule. Start a new request.'); return previous.id }
      validateSchedule(raw, runAt); validateScheduledText(text, data)
      const id = crypto.randomUUID()
      data.state.jobs.unshift({ _id: id, createdAt: Date.now(), scheduledFor: runAt, preparing: false, cancelled: false, actions: [], clarification: 'Scheduled to prepare when Daymark is open after the chosen time. Review is required before any outside action.', source: { text, revision: 1 }, files: [] })
      data.expiry[id] = runAt + retention; data.scheduledRequests ??= {}; data.scheduledRequests[key] = { id, hash }
      return id
    }),
    saveLibraryArtifact: id => change(data => {
      const job = data.state.jobs.find(j => j.actions.some(a => a._id === id)), artifact = job?.actions.find(a => a._id === id)
      if (!job || !artifact) throw new Error('This deliverable is no longer available.')
      data.state.library ??= []
      const existing = data.state.library.find(item => item.actionId === id)
      if (existing) return existing.id
      const p = artifact.payload, itemId = crypto.randomUUID(), title = (p.kind === 'calendar' ? p.title : p.kind === 'email' ? p.subject : 'Pickup request').trim().slice(0, 200) || 'Untitled deliverable'
      data.state.library.unshift({ id: itemId, kind: 'artifact', title, collection: '', ...(p.childId ? { childId: p.childId } : {}), pinned: false, createdAt: Date.now(), version: 1, actionId: id, jobId: job._id })
      return itemId
    }),
    uploadLibrary: async (files, collection, childId) => {
      const accepted = await fileRecords(files)
      validateLibraryFiles(accepted)
      return change(data => {
        const changes = libraryChangesSchema.parse({ title: 'Library upload', collection, childId, pinned: false })
        if (changes.childId && !data.state.household!.children.some(c => c.id === changes.childId)) throw new Error('Choose a child in this household.')
        data.state.library ??= []; data.libraryFiles ??= {}
        for (const f of accepted) { data.libraryFiles[f.id] = f.data; data.state.library.unshift({ id: f.id, kind: 'media', title: f.name || 'Saved file', collection: changes.collection, childId: changes.childId, pinned: false, createdAt: Date.now(), version: 1, mediaType: f.mediaType, size: f.size }) }
      })
    },
    keepLibraryFile: (jobId, fileId) => change(data => {
      const job = data.state.jobs.find(j => j._id === jobId), file = job?.files?.find(f => f.id === fileId), bytes = data.files[fileId]?.data
      if (!job || !file || !bytes) throw new Error('The original file expired or is unavailable.')
      data.state.library ??= []; data.libraryFiles ??= {}
      const previous = data.state.library.find(item => item.fileId === fileId)
      if (previous) return previous.id
      const id = crypto.randomUUID(); data.libraryFiles[id] = bytes.slice(0, bytes.size, file.mediaType)
      data.state.library.unshift({ id, kind: 'media', title: file.name || 'Saved file', collection: '', pinned: false, createdAt: Date.now(), version: 1, jobId, fileId, mediaType: file.mediaType, size: file.size })
      return id
    }),
    updateLibrary: (id, version, raw) => change(data => {
      const item = data.state.library?.find(item => item.id === id), changes = libraryChangesSchema.parse(raw)
      if (!item || item.version !== version) throw new Error('This Library item changed. Reopen it before editing.')
      if (changes.childId && !data.state.household!.children.some(c => c.id === changes.childId)) throw new Error('Choose a child in this household.')
      Object.assign(item, changes, { childId: changes.childId || undefined, version: item.version + 1 })
    }),
    removeLibrary: (id, version) => change(data => {
      const item = data.state.library?.find(item => item.id === id)
      if (!item || item.version !== version) throw new Error('This Library item changed. Reopen it before removing it.')
      data.state.library = data.state.library!.filter(item => item.id !== id); delete data.libraryFiles?.[id]
    }),
    readLibraryFile: async id => { const result = await transaction(data => data.state.library?.some(item => item.id === id && item.kind === 'media') ? data.libraryFiles?.[id] : undefined); if (!result.result) throw new Error('This saved file is unavailable.'); return result.result },
    submit: async (text, files = []) => {
      if ((!text.trim() && !files.length) || text.length > 20000) throw new Error('Share a notice up to 20,000 characters.')
      const accepted = await fileRecords(files)
      return change(data => {
        const household = accepted.length ? null : householdReply(text, data)
        const fallback = !accepted.length && !isPreparationRequest(text) ? 'I can help with saved tasks and household planning here, but open-ended AI conversation isn’t connected yet. Try “What needs my attention?” or “Add buy sunscreen to my tasks,” or share a notice to prepare.' : null
        const existingTask = household?.kind === 'personalTask' ? data.state.personalTasks?.find(task => !task.done && task.title.toLocaleLowerCase() === household.input.title.toLocaleLowerCase() && task.dueDate === household.input.dueDate) : undefined
        const reply = existingTask ? `“${existingTask.title}” is already on your tasks${existingTask.dueDate ? `, due ${existingTask.dueDate}` : ''}.` : household?.text ?? (accepted.length ? null : replyFor(text, data)) ?? fallback
        const fingerprint = sourceHash(text + accepted.map(f => f.hash).join(',')), previous = data.hashes[fingerprint]
        if (!reply && previous && data.state.jobs.some(j => j._id === previous && !j.conversation)) return previous
        const id = crypto.randomUUID(), prepared = reply ? { actions: [], clarification: reply } : drafts(text, data.state), expiresAt = Date.now() + 30 * 86400_000
        // Task creation and its acknowledgment share one transaction. Concurrent requests
        // cannot duplicate an open task; a completed/removed task can be requested again.
        if (household?.kind === 'personalTask' && !existingTask) {
          const input = personalInput(data, household.input), now = Date.now()
          data.state.personalTasks ??= []
          data.state.personalTasks.unshift({ ...input, id: crypto.randomUUID(), done: false, version: 1, createdAt: now, updatedAt: now })
        }
        const metadata = accepted.map(({ data: blob, ...f }) => { data.files[f.id] = { data: blob, expiresAt }; return f })
        const job: Job = { _id: id, createdAt: Date.now(), ...(reply ? { conversation: true } : {}), preparing: false, cancelled: false, ...prepared, clarification: accepted.length ? 'Files saved on this device. Automatic document reading is not connected; use the original file to fill in the draft.' : prepared.clarification, source: { text: text.trim(), revision: 1 }, files: metadata }
        data.state.jobs.unshift(job); if (!reply) data.hashes[fingerprint] = id; data.expiry[id] = expiresAt
        return id
      })
    },
    saveHousehold: (timezone, children) => change(data => {
      if (!validTimezone(timezone) || children.length > 20 || new Set(children.map(c => c.id)).size !== children.length || children.some(c => !c.name.trim() || c.name.length > 80)) throw new Error('Confirm valid children and timezone.')
      data.state.household = { ...data.state.household, timezone, children: children.map(c => ({ ...c, name: c.name.trim() })) }
    }),
    addDraft: (jobId, raw) => change(data => {
      const job = data.state.jobs.find(j => j._id === jobId)
      if (!job || job.cancelled || job.actions.filter(a => a.status !== 'cancelled').length >= 8) throw new Error('This request cannot add another draft.')
      checkRoutineJob(data, job)
      if (job.scheduledFor !== undefined) throw new Error('Wait for scheduled preparation or cancel this request before adding a draft.')
      const payload = payloadSchema.parse(raw)
      if (payload.kind === 'calendar' && payload.targetId) throw new Error('Add the draft first, then choose the plan item in Edit details.')
      delete job.conversation
      job.actions.push({ _id: crypto.randomUUID(), revision: 1, payload, status: 'review', receipts: [] })
    }),
    edit: (id, revision, raw) => change(data => {
      const { job, a } = action(data, id, revision), payload = payloadSchema.parse(raw)
      checkRoutineJob(data, job)
      if (a.status !== 'review' || payload.kind !== a.payload.kind) throw new Error('Reopen the current editable draft.')
      if (payload.kind === 'calendar') {
        const target = data.state.plan.find(p => p._id === payload.targetId)
        if (payload.targetId && !target) throw new Error('The original plan item is no longer available.')
        if (target && (a.payload.kind !== 'calendar' || a.payload.targetId !== payload.targetId || !data.nativeBefore?.[a._id])) { data.nativeBefore ??= {}; if (data.nativeEvents?.[target._id]) data.nativeBefore[a._id] = structuredClone(data.nativeEvents[target._id]); else delete data.nativeBefore[a._id] }
        if (!target) delete data.nativeBefore?.[a._id]
        a.before = target ? a.payload.kind === 'calendar' && a.payload.targetId === payload.targetId && a.before ? a.before : { payload: structuredClone(target.payload) } : undefined
      }
      a.payload = payload; a.revision++; a.error = undefined
    }),
    approve: async selected => {
      if (!selected.length || selected.length > 8 || new Set(selected.map(s => s.id)).size !== selected.length) throw new Error('Choose up to eight different drafts.')
      // Read/validate the whole set before any clipboard side effect.
      const contents = await change(data => selected.flatMap(s => {
        const { job, a } = action(data, s.id, s.revision)
        checkRoutineJob(data, job)
        if (a.status === 'saved' || a.status === 'succeeded') return []
        if (a.status !== 'review') throw new Error('Reopen the latest draft.')
        if (a.payload.kind === 'calendar') { validateNativeDestination(data.state.nativeCalendar, s.nativeCalendar); const issues = blockers(a.payload, data.state.household!.children); if (issues.length) throw new Error(issues.join(' ')); checkTarget(data, a); return [] }
        if (!(a.payload.kind === 'email' ? a.payload.body : a.payload.message).trim()) throw new Error('Write the message before copying.')
        return [a.payload.kind === 'email' ? `To: ${a.payload.to}\nSubject: ${a.payload.subject}\n\n${a.payload.body}` : a.payload.message]
      }))
      if (selected.some(s => s.nativeCalendar)) {
        if (contents.length || selected.some(s => !s.nativeCalendar)) throw new Error('Review Apple Calendar changes separately from copied messages.')
        return approveNative(selected)
      }
      if (contents.length) {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select and copy the text from this draft.')
        await navigator.clipboard.writeText(contents.join('\n\n---\n\n'))
      }
      return change(data => {
        for (const selectedAction of selected) {
          const { job, a } = action(data, selectedAction.id, selectedAction.revision)
          checkRoutineJob(data, job)
          if (a.status === 'saved' || a.status === 'succeeded') continue
          if (a.payload.kind !== 'calendar') { a.revisionNote = a.payload.kind === 'email' ? 'Email text copied. Nothing has been sent. Attach any selected files in your mail app yourself.' : 'Request text copied. No caregiver has been contacted or confirmed.'; continue }
          const issues = blockers(a.payload, data.state.household!.children)
          if (issues.length) throw new Error(issues.join(' '))
          checkTarget(data, a)
          const target = a.payload.targetId
          if (a.payload.operation === 'delete') data.state.plan = data.state.plan.filter(p => p._id !== target)
          else { data.state.plan = data.state.plan.filter(p => p._id !== target && p.actionId !== a._id); data.state.plan.push({ _id: target ?? crypto.randomUUID(), actionId: a._id, payload: a.payload }) }
          a.status = 'saved'; a.receipts.push({ _id: crypto.randomUUID(), providerId: a._id, outcome: 'saved_on_device', verifiedAt: Date.now() })
        }
      })
    },
    reviseSource: (jobId, revision, text) => change(data => {
      const job = data.state.jobs.find(j => j._id === jobId)
      if (!job || job.cancelled || job.source?.revision !== revision || !text.trim() || text.length > 20000) throw new Error('This source changed. Reopen it before editing.')
      checkRoutineJob(data, job)
      if (job.scheduledFor !== undefined) {
        validateScheduledText(text, data)
        job.source = { text: text.trim(), revision: revision + 1 }; data.expiry[jobId] = job.scheduledFor + retention
        return
      }
      if (job.actions.some(a => ['executing', 'uncertain'].includes(a.status))) throw new Error('Check the pending Apple Calendar result before replacing this source.')
      for (const a of job.actions) if (!['saved', 'succeeded'].includes(a.status)) a.status = 'cancelled'
      const prepared = drafts(text, data.state, data.routineJobs?.[jobId]?.timezone)
      delete job.conversation
      job.source = { text, revision: revision + 1 }; job.actions.push(...prepared.actions); job.clarification = prepared.clarification
      data.hashes[sourceHash(text)] = jobId; data.expiry[jobId] = Date.now() + 30 * 86400_000
    }),
    cancel: jobId => change(data => { const job = data.state.jobs.find(j => j._id === jobId); if (job) { if (job.actions.some(a => ['executing', 'uncertain'].includes(a.status))) throw new Error('Check the pending Apple Calendar result before cancelling this request.'); if (job.scheduledFor !== undefined) { delete job.scheduledFor; data.expiry[jobId] = Math.min(data.expiry[jobId] ?? Infinity, Date.now() + retention) }; job.cancelled = true; for (const a of job.actions) if (!['saved', 'succeeded'].includes(a.status)) a.status = 'cancelled' } }),
    saveFact: (raw, id, version) => change(data => {
      const value = checkedFact(data, raw), old = data.state.facts?.find(f => f._id === id)
      if (id && (!old || old.version !== version)) throw new Error('This detail changed. Reopen it before editing.')
      const key = id ?? crypto.randomUUID()
      data.state.facts = [...(data.state.facts ?? []).filter(f => f._id !== id), { _id: key, key: `family:${key}`, value, version: (old?.version ?? 0) + 1, source: 'Confirmed on this device', updatedAt: Date.now(), scope: value.kind === 'routine' ? 'recurring' : value.kind === 'availability' ? 'one-time' : 'household' }]
    }),
    removeFact: (id, version) => change(data => { const old = data.state.facts?.find(f => f._id === id); if (!old || old.version !== version) throw new Error('This detail changed.'); data.state.facts = data.state.facts!.filter(f => f._id !== id) }),
    addCaregiver: (name, email, childIds) => change(data => { validateCaregiver(data, name, email, childIds); data.state.caregivers.push({ _id: crypto.randomUUID(), name: name.trim(), email: email.trim().toLowerCase(), childIds }) }),
    updateCaregiver: (id, name, email, childIds) => change(data => { validateCaregiver(data, name, email, childIds); const c = data.state.caregivers.find(c => c._id === id); if (!c) throw new Error('Caregiver unavailable.'); Object.assign(c, { name: name.trim(), email: email.trim().toLowerCase(), childIds }) }),
    readFile: async id => { const saved = await transaction(data => data.files[id]?.data); if (!saved.result) throw new Error('This local file expired or is unavailable.'); return saved.result },
    deleteAccount: () => change(data => { if (data.state.jobs.some(j => j.actions.some(a => a.status === 'executing'))) throw new Error('Wait for the calendar operation to finish before deleting device data.'); Object.assign(data, empty()); delete data.nativeEvents; delete data.nativeBefore; delete data.nativeAttempts; delete data.libraryFiles; delete data.taskRequests; delete data.scheduledRequests; delete data.routines; delete data.routineRuns; delete data.routineRequests; delete data.routineJobs; delete data.memoryRequests; delete data.memorySources; delete data.connectorRequests; delete data.connectorRequestKeys }),
    refreshCalendar: async id => {
      const saved = await transaction(data => { const { a } = action(data, id); return { revision: a.revision, targetId: a.payload.kind === 'calendar' ? a.payload.targetId : null, native: a.payload.kind === 'calendar' && a.payload.targetId ? data.nativeEvents?.[a.payload.targetId] : undefined } })
      const native = saved.result.native ? await calendar.read({ eventId: saved.result.native.eventId, calendarId: saved.result.native.calendarId }) : undefined
      if (native && (native.eventId !== saved.result.native?.eventId || native.calendarId !== saved.result.native?.calendarId)) throw new Error('The Apple Calendar event identity changed. Check the original event before continuing.')
      return change(data => {
      const { a } = action(data, id, saved.result.revision)
      if (a.payload.kind !== 'calendar' || a.payload.targetId !== saved.result.targetId) throw new Error('This review changed. Refresh the current event again.')
      if (a.status !== 'review' || a.payload.kind !== 'calendar' || !a.payload.targetId) throw new Error('Choose an editable plan change.')
      const targetId = a.payload.targetId, target = data.state.plan.find(p => p._id === targetId)
      if (!target) throw new Error('The original plan item is no longer available.')
      if (native && target.payload.kind === 'calendar') { target.payload = nativeEventPayload(native, target.payload); data.nativeBefore ??= {}; data.nativeBefore[a._id] = native; data.nativeEvents ??= {}; data.nativeEvents[targetId] = native }
      a.before = { payload: structuredClone(target.payload) }; a.revision++
    }) },
    exportCalendar: async id => {
      const saved = await transaction(data => { const { a } = action(data, id); if (a.payload.kind !== 'calendar' || a.payload.operation === 'delete') throw new Error('Choose a calendar addition.'); const issues = blockers(a.payload, data.state.household!.children); if (issues.length) throw new Error(issues.join(' ')); return calendarFile(a.payload, a._id) })
      const url = URL.createObjectURL(new Blob([saved.result], { type: 'text/calendar;charset=utf-8' })), link = document.createElement('a')
      link.href = url; link.download = 'daymark-event.ics'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    connectNativeCalendar: () => updateCalendarStatus(true),
    selectNativeCalendar: async id => {
      await updateCalendarStatus()
      return change(data => {
        const current = data.state.nativeCalendar
        if (!current?.available || id && (current.permission !== 'granted' || !current.calendars.some(c => c.id === id))) throw new Error('Choose an available calendar on this iPhone.')
        if (data.state.jobs.some(j => j.actions.some(a => a.status === 'executing'))) throw new Error('Wait for the current calendar save before changing destinations.')
        current.selectedId = id ?? undefined; current.version++
      })
    },
    requestRevision: unavailable, cancelRevision: unavailable, connect: unavailable, disconnect: unavailable, reconcile: reconcileNative, importLegacy: unavailable, saveNotifications: unavailable, enableForwarding: unavailable, retryForwarded: unavailable, savePickupDelivery: unavailable, respondToPickup: unavailable,
  }
  return { client, runDueRoutines: prepareDue, getSnapshot: () => snapshot, subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn) }, load: () => {
    if (!opened) {
      opened = true; foreground = true
      document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume)
      if (Capacitor.isNativePlatform()) appListener = NativeApp.addListener('appStateChange', state => { foreground = state.isActive; resume() })
    }
    if (!channel && typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel('daymark-device-v1'); channel.addEventListener('message', () => { void refresh().catch(() => {}) }) }
    return load ??= (async () => { await refresh(); await prepareDue(); await updateCalendarStatus(); const pending = await transaction(data => Object.keys(data.nativeAttempts ?? {})); for (const id of pending.result) { try { await reconcileNative(id) } catch { await change(data => { const a = data.state.jobs.flatMap(j => j.actions).find(a => a._id === id); if (a?.status === 'executing') { a.status = 'uncertain'; a.error = 'Open Calendar access, then check this result. Nothing will be replayed automatically.' } }) } } })()
  }, close: () => { opened = false; load = undefined; if (dueTimer) clearTimeout(dueTimer); dueTimer = undefined; document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); void appListener?.then(listener => listener.remove()).catch(() => {}); appListener = undefined; channel?.close(); channel = null } }
}
function validateCaregiver(data: Workspace, name: string, email: string, childIds: string[]) {
  if (!name.trim() || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || childIds.some(id => !data.state.household!.children.some(c => c.id === id))) throw new Error('Confirm the caregiver name, email, and eligible children.')
}
