import { useState } from 'react'
import { ConvexError } from 'convex/values'
import Daymark from '../../web/src/daymark/Daymark'
import type { DaymarkClient, DaymarkState } from '../../web/src/daymark/types'
import type { LearnedProposal } from '../../shared/learnedWorkflows'
import type { RoutineDefinition } from '../../shared/routines'
import type { FamilyFact } from '../../shared/memory'
import type { PrivateMailMessage } from '../../shared/mailbox'
import { mailRoutineDefinitionSchema, type MailRoutineDefinition } from '../../shared/mailRoutines'
import { sourceHash, type CalendarDraft } from '../../shared/daymark'
import type { Id } from '../../convex/_generated/dataModel'
const now = Date.now(), expiresAt = now + 30 * 86400_000
const message: PrivateMailMessage = { id: 'synthetic-builds-message', version: 1, sender: 'school@example.test', subject: 'Synthetic museum attachment', receivedAt: now - 1000, text: 'Return the permission form by October 16. Private office note: ask separately about tuition.', extraction: { format: 'plain', incomplete: true, truncated: false, attachments: true, issues: ['The original attachment has not been read.'] }, expiresAt, dismissed: false }
const proposals: LearnedProposal[] = [
  { _id: 'synthetic-school-fact', version: 1, kind: 'fact', title: 'Maya’s school detail', reason: 'An explicit parent statement to review.', quote: 'Maya goes to Oak School.', value: { kind: 'school', childId: 'maya', school: 'Oak School', className: '' }, createdAt: now, expiresAt },
  { _id: 'synthetic-packing-routine', version: 1, kind: 'routine', title: 'Weekly school bags', reason: 'An explicit weekly process to review.', quote: 'Every Sunday at 7 PM, pack school bags.', value: { title: 'School bag packing', outcome: { kind: 'personal_task', task: { title: 'Pack school bags', notes: 'Check lunch boxes.', childId: 'maya' }, dueAfterDays: 0 }, schedule: { frequency: 'weekly', weekdays: [7], time: '19:00', timezone: 'UTC', startDate: '2026-10-18' } }, createdAt: now, expiresAt },
]
const initial: DaymarkState = { configured: true, signedIn: true, ownerKey: 'synthetic-adult', voiceSettings: { configured: false }, household: { name: 'The Synthetic Family', timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] }, preferences: { assistantName: 'Sola', parentName: 'Elaine' }, jobs: [{ _id: 'synthetic-builds-job', createdAt: now - 100, preparing: false, conversation: true, cancelled: false, clarification: 'I’ve prepared private work for your review. Nothing has been sent or changed.', source: { text: 'Help me organize the museum trip.', revision: 1 }, actions: [] }], assistantRuns: [{ id: 'synthetic-coordinator', jobId: 'synthetic-builds-job', version: 1, status: 'complete', stale: false, retryable: false, drafts: [{ kind: 'task', title: 'Return the permission form', text: 'Return Maya’s signed museum form by October 16.', evidence: [{ sourceId: message.id, quote: 'Return the permission form by October 16.' }], status: 'review' }, { kind: 'calendar', title: 'Review the museum plan', text: 'Maya’s museum trip October 20 at 09:30–14:30 UTC. Private office note: tuition is separate.', evidence: [{ sourceId: message.id, quote: 'Return the permission form by October 16.' }], status: 'review' }] }], learnedWorkflows: proposals, personalTasks: [], privateTasks: [], routines: [], facts: [], plan: [], caregivers: [], arrangements: [], connection: null, mailboxSettings: { configured: true, modelConfigured: true, connection: { id: 'synthetic-google', version: 1, email: 'parent@example.test', status: 'active', readAllowed: true, composeAllowed: false }, mailbox: { id: 'synthetic-box', version: 1, connectionVersion: 1, state: 'active', lookbackDays: 30 } }, mailboxRuns: [{ id: 'synthetic-mail-run', version: 1, request: 'Check my email', kind: 'check', status: 'complete', scanned: 1, from: now - 86400_000, through: now, scope: 'inbox', hasMore: false, createdAt: now, answer: 'A synthetic message has an attachment available for private review.', messages: [message] }], mailboxMessages: [message], mailAttachments: [], calendarAgenda: { events: [{ id: 'synthetic-private-event', title: 'Synthetic piano lesson', start: now + 86400_000, end: now + 90000_000, allDay: false, location: 'Music room', provider: 'google' }], coverage: [{ feedId: 'synthetic-feed', complete: false, fresh: true, from: now - 86400_000, through: now + 7 * 86400_000, issue: 'Synthetic partial selection.' }], availabilityKnown: false, truncated: false } }
initial.assistantRuns![0].drafts.push({ kind: 'email', title: 'Reply about the museum trip', text: 'Thank you. Maya can attend.', evidence: [{ sourceId: message.id, quote: 'Return the permission form by October 16.' }], status: 'review', replySource: { messageId: message.id, version: 1, to: 'school@example.test', subject: 'Re: Synthetic museum attachment', accountEmail: 'parent@example.test' } })
initial.mailDrafts = []
function startingState(scenario: string) {
  const s = structuredClone(initial)
  if (scenario.startsWith('assistant-builds-calendar-')) {
    const original = calendarOriginal()
    s.plan = [{ _id: 'synthetic-saved-plan', actionId: 'synthetic-saved-action', owner: 'synthetic-adult', provider: 'google', connectionId: 'synthetic-calendar-account', connectionVersion: 1, calendarId: 'family', eventId: 'provider-piano', etag: 'saved-etag', payload: original }]
    s.calendarAgenda = { owner: scenario.endsWith('-other') ? 'synthetic-other' : 'synthetic-adult', from: Date.parse('2026-10-19T00:00Z'), through: Date.parse('2026-10-22T00:00Z'), truncated: false, availabilityKnown: !scenario.endsWith('-partial'), events: scenario.endsWith('-missing') || scenario.endsWith('-other') ? [] : [{ id: 'synthetic-private-event', title: scenario.endsWith('-changed') ? 'Private changed piano lesson' : original.title, start: Date.parse('2026-10-20T16:00Z'), end: Date.parse('2026-10-20T17:00Z'), allDay: false, location: 'Private music room', provider: 'google', providerId: 'provider-piano', calendarId: 'family', connectionId: 'synthetic-calendar-account', connectionVersion: 1, etag: scenario.endsWith('-changed') ? 'changed-etag' : 'saved-etag' }], coverage: scenario.endsWith('-other') ? [] : [{ feedId: 'synthetic-feed', provider: 'google', connectionId: 'synthetic-calendar-account', connectionVersion: 1, calendars: ['family'], from: Date.parse('2026-10-19T00:00Z'), through: Date.parse('2026-10-22T00:00Z'), fresh: true, complete: !scenario.endsWith('-partial') }] }
    if (scenario.includes('-handoff')) s.assistantRuns![0].drafts = [{ kind: 'calendar', title: 'Move the existing piano lesson', text: 'Move this lesson one hour later. Keep the original event.', status: 'review', evidence: [{ sourceId: 'synthetic-private-event', quote: 'Synthetic piano lesson' }], calendarReviewRequired: true, ...(scenario.endsWith('-ambiguous') ? {} : { calendarSource: { eventId: 'synthetic-private-event', title: original.title, provider: 'google' } }) }]
  }
  if (scenario === 'assistant-builds-private-reply') s.mailboxSettings!.connection!.composeAllowed = true
  if (scenario === 'assistant-builds-email-generic') delete s.assistantRuns![0].drafts[2].replySource
  if (scenario.startsWith('assistant-builds-mail-routines')) {
    s.assistantRuns = []; s.jobs = []; s.mailRoutines = []
    s.learnedWorkflows = [{ _id: 'synthetic-learned-mail-routine', kind: 'mail_routine', version: 1, title: 'School form emails', reason: 'The parent explicitly asked to repeat this preparation.', quote: 'Whenever school emails about a form, prepare the deadline and a reply.', value: { title: 'School forms', condition: 'asks for a school permission form', instruction: 'Pull out the deadline and prepare a reply for my review.' }, createdAt: now, expiresAt }]
    if (scenario.endsWith('disconnected')) s.mailboxSettings = { configured: true, modelConfigured: true, connection: null, mailbox: null }
  }
  return s
}
function calendarOriginal(): CalendarDraft { return { kind: 'calendar', title: 'Synthetic piano lesson', childId: 'maya', date: '2026-10-20', endDate: '2026-10-20', startTime: '16:00', endTime: '17:00', allDay: false, timezone: 'UTC', location: 'Shared original room', notes: 'Original reviewed details', targetId: null, evidence: {} } }
export default function AssistantBuildsHarness({ scenario }: { scenario: string }) {
  const storageKey = `assistant-builds-state:${scenario}`, [state, setState] = useState<DaymarkState>(() => JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? startingState(scenario))
  const update = (fn: (state: DaymarkState) => DaymarkState) => setState(previous => { const next = fn(previous); sessionStorage.setItem(storageKey, JSON.stringify(next)); return next })
  const record = (action: string, data?: unknown) => sessionStorage.setItem('assistant-builds-actions', JSON.stringify([...JSON.parse(sessionStorage.getItem('assistant-builds-actions') ?? '[]'), { action, data }]))
  const noop = async () => {}
  const client: DaymarkClient = {
    inspectCalendarEvent: async (eventId, origin) => { record('calendar-inspect', { eventId, origin }); return { eventId: eventId as Id<'calendarFeedEvents'>, feedVersion: 1, connectionVersion: 1, selectionVersion: 1, etag: 'saved-etag', original: calendarOriginal(), originalHash: sourceHash(JSON.stringify(calendarOriginal())), provider: 'google', ...(origin ? { origin } : {}) } },
    prepareCalendarEventChange: async (preview, proposed) => {
      const run = state.assistantRuns!.find(r => r.id === preview.origin?.id)
      if (preview.origin && (!run || run.stale || run.version !== preview.origin.version)) throw new ConvexError('The assistant preparation or calendar source changed. Ask Sola for a fresh review.')
      record('calendar-prepare', { preview, proposed })
      update(s => ({ ...s, jobs: [...s.jobs, { _id: 'synthetic-targeted-calendar-job', preparing: false, cancelled: false, clarification: 'Review this exact existing calendar event. Nothing has been changed.', source: { revision: 1, text: JSON.stringify({ original: preview.original, proposed }) }, actions: [{ _id: 'synthetic-targeted-calendar-action', revision: 1, payload: { ...proposed, targetId: 'synthetic-existing-target' }, status: 'review', receipts: [] }] }] }))
      return 'synthetic-targeted-calendar-job'
    },
    ...(scenario.startsWith('assistant-builds-mail-routines') ? {
      createRoutine: async () => 'synthetic-scheduled-not-created',
      createMailRoutine: async (definition: MailRoutineDefinition, requestId: string) => {
        const clean = mailRoutineDefinitionSchema.parse(definition)
        if (scenario.endsWith('save-error')) throw new ConvexError('This routine could not be saved. Your edits are still here.')
        const id = `synthetic-mail-${requestId}`
        record('mail-routine-create', { definition: clean, requestId })
        update(s => ({ ...s, mailRoutines: [...s.mailRoutines ?? [], { id, version: 1, state: 'paused', definition: clean, createdAt: now, updatedAt: now }] }))
        return id
      },
      updateMailRoutine: async (id: string, version: number, definition: MailRoutineDefinition) => {
        const row = state.mailRoutines!.find(row => row.id === id)
        if (!row || row.version !== version) throw new ConvexError('This routine changed elsewhere.')
        record('mail-routine-update', { id, version, definition })
        update(s => ({ ...s, mailRoutines: s.mailRoutines!.map(row => row.id === id ? { ...row, definition: mailRoutineDefinitionSchema.parse(definition), version: version + 1, updatedAt: Date.now() } : row) }))
        return version + 1
      },
      setMailRoutinePaused: async (id: string, version: number, paused: boolean) => {
        const row = state.mailRoutines!.find(row => row.id === id)
        if (!row || row.version !== version) throw new ConvexError('This routine changed elsewhere.')
        if (!paused && !state.mailboxSettings?.connection?.readAllowed) throw new ConvexError('Connect your Gmail first.')
        if (!paused && scenario.endsWith('activation-error')) throw new ConvexError('Your Gmail access changed. Review the connection before activating.')
        record('mail-routine-pause', { id, version, paused })
        update(s => ({ ...s, mailRoutines: s.mailRoutines!.map(row => row.id === id ? { ...row, state: paused ? 'paused' : 'active', issue: undefined, version: version + 1, updatedAt: Date.now(), ...(!paused ? { activatedAt: Date.now() } : {}) } : row) }))
        return version + 1
      },
      removeMailRoutine: async (id: string, version: number) => {
        if (state.mailRoutines!.find(row => row.id === id)?.version !== version) throw new ConvexError('This routine changed elsewhere.')
        record('mail-routine-remove', { id, version }); update(s => ({ ...s, mailRoutines: s.mailRoutines!.filter(row => row.id !== id) }))
      },
      mailRoutineHistory: async () => [
        { id: 'synthetic-prepared', routineVersion: 1, createdAt: now, status: 'prepared' as const, summary: 'A synthetic permission-form reply is ready for review.' },
        { id: 'synthetic-superseded', routineVersion: 1, createdAt: now - 1000, status: 'superseded' as const, summary: 'This preparation is no longer current.' },
        { id: 'synthetic-expired', routineVersion: 1, createdAt: now - 2000, status: 'expired' as const, summary: 'The original private email expired.' },
      ],
    } : {}),
    signIn: noop, signOut: noop, saveHousehold: noop, addDraft: noop, edit: noop, reviseSource: noop, cancel: noop, reconcile: noop, deleteAccount: noop, refreshCalendar: noop, importLegacy: noop, saveNotifications: noop, enableForwarding: noop, retryForwarded: noop, saveFact: noop, removeFact: noop, updateCaregiver: noop, savePickupDelivery: noop, respondToPickup: noop, addCaregiver: noop, connect: noop, disconnect: noop, readFile: async () => new Blob(), requestRevision: async () => 1, cancelRevision: noop,
    submit: async text => { record('synthetic-submit', { text }); return 'synthetic-builds-job' },
    approve: async () => { record('forbidden-provider-approval'); throw new Error('This fixture never approves or writes to a provider.') },
    retryAssistant: async (id, version) => { record('retry-assistant', { id, version }) },
    reviewAssistantDraft: async (id, version, index, text, operation, consent) => {
      const run = state.assistantRuns!.find(r => r.id === id)!
      const existingDraft=run.drafts[index]
      if(operation==='keep' && existingDraft.privateTaskId){if(existingDraft.text!==text.trim())throw new ConvexError('Edit the saved private task instead.');return existingDraft.privateTaskId}
      if (scenario === 'assistant-builds-share-error' && operation === 'share') throw new ConvexError('The supporting email changed. Your reviewed text is still here; prepare it again.')
      if (run.version !== version || run.stale) throw new ConvexError('The supporting context changed. Prepare this again.')
      if (operation === 'reply') {
        if (!existingDraft.replySource || !text.trim() || text.trim().length > 4000) throw new ConvexError('Review one current private email and a reply under 4,000 characters.')
        const privateMailDraftId = existingDraft.privateMailDraftId ?? 'synthetic-coordinator-private-reply'
        if (existingDraft.privateMailDraftId) { if (existingDraft.text !== text.trim()) throw new ConvexError('Edit the saved private reply instead.'); return privateMailDraftId }
        record('assistant-reply', { id, version, index, text, consent })
        update(s => ({ ...s, assistantRuns: s.assistantRuns!.map(r => r.id === id ? { ...r, version: version + 1, drafts: r.drafts.map((d, i) => i === index ? { ...d, text, status: 'kept', privateMailDraftId } : d) } : r), mailDrafts: [...(s.mailDrafts ?? []), { id: privateMailDraftId, messageId: message.id, connectionId: 'synthetic-google', connectionVersion: 1, version: 1, to: existingDraft.replySource!.to, subject: existingDraft.replySource!.subject, body: text.trim(), status: 'review', accountEmail: 'parent@example.test', createdAt: now }] }))
        return privateMailDraftId
      }
      if (operation === 'share' && !consent) throw new ConvexError('Review exact sharing first.')
      record(`assistant-${operation}`, { id, version, index, text, consent })
      const privateTaskId=existingDraft.kind==='task' && ['keep','done'].includes(operation)?`synthetic-private-task-${index}`:undefined
      update(s => ({ ...s, assistantRuns: s.assistantRuns!.map(r => r.id === id ? { ...r, version: version + 1, drafts: r.drafts.map((d, i) => i === index ? { ...d, text, status: operation === 'done' ? 'done' : operation === 'dismiss' ? 'dismissed' : 'kept', ...(operation === 'share' ? { sharedJobId: 'synthetic-shared-preparation' } : {}), ...(privateTaskId?{privateTaskId}:{}) } : d) } : r), ...(privateTaskId?{privateTasks:[...(s.privateTasks??[]),{id:privateTaskId,title:existingDraft.title,text:text.trim(),done:operation==='done',version:1,createdAt:now,updatedAt:now}]}:{}), ...(operation === 'share' ? { jobs: [...s.jobs, { _id: 'synthetic-shared-preparation', createdAt: Date.now(), preparing: true, cancelled: false, clarification: '', source: { text, revision: 1 }, actions: [] }] } : {}) }))
      return operation === 'share' ? 'synthetic-shared-preparation' : privateTaskId
    },
    editMailDraft: async (id, version, input) => { const draft = state.mailDrafts?.find(d => d.id === id); if (!draft || draft.version !== version) throw new ConvexError('The private reply changed.'); record('private-reply-edit', { id, version, input }); update(s => ({ ...s, mailDrafts: s.mailDrafts?.map(d => d.id === id ? { ...d, ...input, version: version + 1 } : d) })); return version + 1 },
    approveMailDraft: async () => { record('forbidden-gmail-approval'); throw new Error('This fixture never writes to Gmail.') },
    approveMailSend: async () => { record('forbidden-gmail-send'); throw new Error('This fixture never sends email.') },
    updatePrivateTask: async(id,version,input)=>{const task=state.privateTasks?.find(t=>t.id===id);if(!task || task.version!==version)throw new ConvexError('This private task changed.');record('private-task-edit',{id,version,input});update(s=>({...s,privateTasks:s.privateTasks!.map(t=>t.id===id?{...t,...input,version:version+1,updatedAt:Date.now()}:t)}));return version+1},
    setPrivateTaskDone: async(id,version,done)=>{const task=state.privateTasks?.find(t=>t.id===id);if(!task || task.version!==version)throw new ConvexError('This private task changed.');record('private-task-done',{id,version,done});update(s=>({...s,privateTasks:s.privateTasks!.map(t=>t.id===id?{...t,done,version:version+1,updatedAt:Date.now()}:t)}));return version+1},
    removePrivateTask: async(id,version)=>{const task=state.privateTasks?.find(t=>t.id===id);if(!task || task.version!==version)throw new ConvexError('This private task changed.');record('private-task-remove',{id,version});update(s=>({...s,privateTasks:s.privateTasks!.filter(t=>t.id!==id)}))},
    editLearnedWorkflow: async (id, version, value) => { const p = state.learnedWorkflows!.find(p => p._id === id)!; if (p.version !== version) throw new ConvexError('This suggestion changed.'); record('learning-edit', { id, version, value }); update(s => ({ ...s, learnedWorkflows: s.learnedWorkflows!.map(p => p._id === id ? { ...p, value, version: version + 1 } as LearnedProposal : p) })); return version + 1 },
    approveLearnedWorkflow: async (id, version, value, shareConfirmed) => {
      const p = state.learnedWorkflows!.find(p => p._id === id)!; if (p.version !== version || p.kind !== 'mail_routine' && !shareConfirmed) throw new ConvexError('Review and confirm this exact suggestion.')
      record('learning-approve', { id, version, value, shareConfirmed, ...(p.kind !== 'fact' ? { savedState: 'paused' } : {}) })
      update(s => ({ ...s, learnedWorkflows: s.learnedWorkflows!.filter(p => p._id !== id), ...(p.kind === 'fact' ? { facts: [...s.facts!, { _id: 'synthetic-reviewed-fact', key: 'family:synthetic', value: value as FamilyFact, version: 1, source: 'Synthetic reviewed suggestion', updatedAt: now, scope: 'household' }] } : p.kind === 'mail_routine' ? { mailRoutines: [...s.mailRoutines ?? [], { id: 'synthetic-learned-mail', version: 1, state: 'paused', definition: value as MailRoutineDefinition, createdAt: now, updatedAt: now }] } : { routines: [...s.routines!, { id: 'synthetic-paused-routine', version: 1, state: 'paused', definition: value as RoutineDefinition, createdAt: now, updatedAt: now, canEdit: true }] }) }))
    },
    dismissLearnedWorkflow: async (id, version) => { record('learning-dismiss', { id, version }); update(s => ({ ...s, learnedWorkflows: s.learnedWorkflows!.filter(p => p._id !== id) })) },
    discoverMailAttachments: async (messageId, version) => { record('attachment-discover', { messageId, version }); update(s => ({ ...s, mailAttachments: [{ id: 'synthetic-attachment', messageId, descriptorHash: 'synthetic-descriptor', version: 1, filename: 'Synthetic permission.pdf', mimeType: 'application/pdf', size: 1024, status: 'available', expiresAt, updatedAt: now, retryable: false }] })); return { incomplete: false, count: 1 } },
    readMailAttachment: async (id, version, descriptorHash) => { record('attachment-read', { id, version, descriptorHash }); update(s => ({ ...s, mailAttachments: s.mailAttachments!.map(a => a.id === id ? { ...a, version: version + 1, status: 'running' } : a) })); setTimeout(() => update(s => ({ ...s, mailAttachments: s.mailAttachments!.map(a => a.id === id ? { ...a, version: version + 2, status: 'complete', text: 'Return the synthetic form by October 16.', summary: 'The synthetic form has an October 16 deadline.', extractionMethod: 'model', incomplete: true, issues: ['Machine transcription; verify dates, names and numbers against the original.'] } : a) })), 300); return version + 1 },
  }
  return <><p className="dm-mailbox-fixture-banner">Synthetic assistant builds preview · no provider, model, microphone or account calls</p><div aria-label="Synthetic test controls">{scenario.startsWith('assistant-builds-mail-routines') && <><button onClick={() => update(s => ({ ...s, mailRoutines: s.mailRoutines?.map(row => ({ ...row, version: row.version + 1, state: 'paused', updatedAt: Date.now() })) }))}>Simulate changed email routine</button><button onClick={() => update(s => ({ ...s, mailRoutines: s.mailRoutines?.map(row => ({ ...row, issue: 'Your Gmail access changed. Resume with the current connection.' })) }))}>Simulate changed Gmail access</button><button onClick={() => update(s => ({ ...s, mailRoutines: [] }))}>Simulate removed email routine</button></>}<button onClick={() => update(s => ({ ...s, assistantRuns: s.assistantRuns!.map(r => ({ ...r, version: r.version + 1, stale: true })) }))}>Simulate changed assistant context</button><button onClick={() => update(s=>({...s,assistantRuns:s.assistantRuns!.map(r=>({...r,stale:true})),jobs:s.jobs.map(j=>({...j,source:null}))}))}>Simulate expired assistant source</button><button onClick={() => update(s=>({...s,privateTasks:s.privateTasks?.map(t=>({...t,version:t.version+1}))}))}>Simulate changed saved private task</button><button onClick={()=>{const r=state.assistantRuns![0],d=r.drafts[0];void client.reviewAssistantDraft!(r.id,1,0,d.text,'keep',false)}}>Replay original private task keep</button><button onClick={() => update(s => ({ ...s, learnedWorkflows: s.learnedWorkflows!.map(p => ({ ...p, version: p.version + 1 })) }))}>Simulate changed learning suggestion</button></div><Daymark state={state} client={client} /></>
}
