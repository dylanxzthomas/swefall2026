import React, { useState, useEffect, useRef } from 'react'
import { ConvexError } from 'convex/values'
import { createRoot } from 'react-dom/client'
import Daymark from '../../web/src/daymark/Daymark'
import EmailWatchHarness from './emailWatchHarness'
import MailboxHarness from './mailboxHarness'
import AssistantBuildsHarness from './assistantBuildsHarness'
import VoiceHarness from './voiceHarness'
import type { DaymarkState, DaymarkClient } from '../../web/src/daymark/types'
import { pickupEmailProof } from '../../shared/pickupEmail'
import { event, notice } from '../fixtures/calendar'
if (import.meta.env.MODE !== 'test') throw new Error('Synthetic harness is only available in test mode.')
const scenario = new URLSearchParams(window.location.search).get('scenario')
const email = { kind: 'email' as const, childId: 'maya', to: 'teacher@example.test', subject: 'Maya’s field trip', body: 'Please find the notice attached.', requirement: '', evidence: {} }
const pickup = { kind: 'pickup' as const, childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you collect Maya?', evidence: {} }
const initial: DaymarkState = { configured: true, signedIn: true, household: { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] }, jobs: [], plan: [], caregivers: [{ _id: 'alex', name: 'Alex', email: 'alex@example.test', childIds: ['maya'] }], arrangements: [], connection: { status: 'active', calendarId: 'synthetic-calendar', email: 'parent@example.test', scopes: ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/gmail.send'] } }
const accounts: NonNullable<DaymarkState['accounts']> = { items: [
  { id: 'google-account', provider: 'google', status: 'active', scopes: ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/gmail.send'], calendarId: 'google-calendar', calendarName: 'Daymark family', email: 'parent@google.example.test', calendar: true, mail: true },
  { id: 'microsoft-account', provider: 'microsoft', status: 'active', scopes: ['Calendars.ReadWrite', 'Mail.Send'], calendarId: 'outlook-calendar', calendarName: 'Family calendar', email: 'parent@outlook.example.test', calendar: true, mail: true },
], calendarId: 'microsoft-account', emailId: scenario === 'accounts-email' ? 'microsoft-account' : 'google-account', version: 3, configured: { google: true, microsoft: true } }
const accountInitial = scenario === 'accounts-unconfigured' ? { ...initial, connection: null, accounts: { items: [], version: 0, configured: { google: false, microsoft: false } } } : { ...initial, accounts }
const pickupGmail = scenario?.startsWith('pickup-gmail') ?? false
const pickupGmailInitial: DaymarkState = { ...initial, accounts: { ...accounts, emailId: 'google-account', items: accounts.items.map(a => a.provider === 'google' ? { ...a, scopes: [...a.scopes, 'https://www.googleapis.com/auth/gmail.readonly'] } : a) } }
const emailTaskInitial: DaymarkState = { ...initial, personalTasks: [], emailTaskSuggestions: [{ id: 'email-suggestion', jobId: 'email-job', sourceRevision: 1, version: 1, status: 'proposed', input: { title: 'Return Maya’s form', notes: 'Sign the form before the trip.', dueDate: '2026-10-20', childId: 'maya' }, evidence: ['Please return Maya’s signed form by October 20.'], canSave: true }] }
function Harness() {
  const [state, setState] = useState<DaymarkState>(() => JSON.parse(sessionStorage.getItem('synthetic-state') ?? 'null') ?? (pickupGmail ? pickupGmailInitial : scenario === 'email-followup-tasks' ? emailTaskInitial : scenario?.startsWith('accounts') ? accountInitial : scenario?.startsWith('inbox') ? { ...initial, pickupDelivery: { verified: true, email: 'alex@example.test', channel: 'app' }, incomingPickups: [{ id: 'incoming', revision: 1, child: 'Maya', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', message: 'Can you collect Maya after school?', deadline: '2027-05-05T12:00:00Z', reminder: false }] } : scenario === 'pickup-app' ? { ...initial, caregivers: initial.caregivers.map(c => ({ ...c, deliveryChannel: 'app' })) } : initial))
  const previewBlocked = useRef(scenario === 'pickup-gmail-loading'), previewWaiters = useRef<(() => void)[]>([])
  const update = (fn: (s: DaymarkState) => DaymarkState) => setState(s => { const next = fn(s); sessionStorage.setItem('synthetic-state', JSON.stringify(next)); return next })
  useEffect(() => {
    if (scenario !== 'accounts-race' || !state.jobs.length || state.accounts?.version !== 3) return
    // Simulate a second signed-in device changing the destination during review.
    const timer = setTimeout(() => update(s => ({ ...s, accounts: { ...s.accounts!, calendarId: 'google-account', version: 4 } })), 800)
    return () => clearTimeout(timer)
  }, [state.jobs.length, state.accounts?.version])
  // Explicit fixture behavior for UI races, never an actual model or provider call.
  useEffect(() => {
    if (scenario === 'revision-pending') return
    const pending = state.jobs.flatMap(j => j.actions).filter(a => a.revisionRequest)
    if (!pending.length) return
    const timer = setTimeout(() => update(s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, actions: j.actions.map(a => pending.some(p => p._id === a._id && p.revision === a.revision) && a.revisionRequest ? { ...a, revision: a.revision + 1, revisionRequest: undefined, revisionNote: 'Draft revised. Review the changes before approving.', payload: a.payload.kind === 'email' ? { ...a.payload, body: 'Maya will attend Friday.' } : a.payload } : a) })) })), 600)
    return () => clearTimeout(timer)
  }, [state.jobs])
  const client: DaymarkClient = {
    ...(pickupGmail ? { reviewPickupEmail: async (id: string, revision: number, payload: Parameters<typeof pickupEmailProof>[0]) => {
      if (previewBlocked.current) await new Promise<void>(resolve => previewWaiters.current.push(resolve))
      if (scenario === 'pickup-gmail-error') throw new ConvexError('Caregiver sending account is unavailable. Reconnect and review this request again.')
      const sender = state.accounts?.items.find(a => a.id === state.accounts?.emailId)
      const recipient = state.caregivers.find(c => c._id === payload.caregiverId)
      if (!sender?.email || !recipient) throw new ConvexError('Choose the current sender and caregiver.')
      const proof = pickupEmailProof(payload, 'Maya', 'https://response.example.test', sender.email, recipient.email)
      const previews = JSON.parse(sessionStorage.getItem('synthetic-pickup-previews') ?? '[]')
      sessionStorage.setItem('synthetic-pickup-previews', JSON.stringify([...previews, { id, revision, payload, proof, selectionVersion: state.accounts!.version }]))
      return { channel: 'email' as const, transport: 'gmail' as const, from: proof.accountEmail, to: proof.to, subject: proof.subject, body: proof.body, reminder: proof.reminder, hash: proof.hash }
    } } : {}),
    saveEmailTask: async (id, version, sourceRevision, input) => {
      const proposal = state.emailTaskSuggestions?.find(s => s.id === id)
      if (!proposal || proposal.version !== version || proposal.sourceRevision !== sourceRevision || !proposal.canSave) throw new Error('This suggestion changed.')
      update(s => ({ ...s, emailTaskSuggestions: s.emailTaskSuggestions?.map(t => t.id === id ? { ...t, input, version: version + 1, status: 'saved', canSave: false } : t), personalTasks: [...(s.personalTasks ?? []), { id: 'saved-email-task', ...input, done: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() }] }))
    },
    dismissEmailTask: async id => { update(s => ({ ...s, emailTaskSuggestions: s.emailTaskSuggestions?.map(t => t.id === id ? { ...t, status: 'dismissed', canSave: false, version: t.version + 1 } : t) })) },
    chooseAccount: async (purpose, id, version) => {
      if (!state.accounts || state.accounts.version !== version) throw new Error('Account choices changed. Reopen settings.')
      update(s => ({ ...s, accounts: { ...s.accounts!, [purpose === 'calendar' ? 'calendarId' : 'emailId']: id, version: version + 1 } }))
    },
    savePickupDelivery: async channel => { update(s => ({ ...s, pickupDelivery: { verified: true, email: 'alex@example.test', channel } })) },
    respondToPickup: async (id, revision, response, suggestion) => {
      if (scenario === 'inbox-error') throw new Error('This overlaps another confirmed pickup. Suggest a change so the parent can resolve it.')
      update(s => ({ ...s, incomingPickups: s.incomingPickups?.filter(r => r.id !== id) }))
    },
    requestRevision: async (id, revision, instruction) => {
      if (scenario === 'revision-error') throw new ConvexError('Automatic revisions are not connected. You can still edit this draft directly. Nothing was sent.')
      update(s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, actions: j.actions.map(a => a._id === id && a.revision === revision ? { ...a, revision: revision + 1, revisionRequest: { instruction, startedAt: Date.now() } } : a) })) }))
      return revision + 1
    },
    cancelRevision: async (id, revision) => { update(s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, actions: j.actions.map(a => a._id === id && a.revision === revision ? { ...a, revision: revision + 1, revisionRequest: undefined, revisionNote: 'Kept the previous draft. Review it before approving.' } : a) })) })) },
    readFile: async () => new Blob(['Synthetic test file']), saveNotifications: async () => {}, enableForwarding: async () => {}, retryForwarded: async () => {}, saveFact: async (value, id, version) => { update(s => ({ ...s, facts: [...(s.facts ?? []).filter(f => f._id !== id), { _id: id ?? 'fact', key: 'family:synthetic', value, version: (version ?? 0) + 1, source: 'Synthetic adult confirmation', updatedAt: Date.now(), scope: value.kind === 'availability' ? 'one-time' : 'household' }] })) }, removeFact: async id => { update(s => ({ ...s, facts: s.facts?.filter(f => f._id !== id) })) }, updateCaregiver: async () => {}, importLegacy: async () => {}, deleteAccount: async () => {}, refreshCalendar: async () => {}, signIn: async () => {}, signOut: async () => {}, saveHousehold: async () => {}, connect: async () => {}, disconnect: async () => {}, addCaregiver: async () => {},
    submit: async text => { update(s => s.jobs.some(j => j.source?.text === text) ? s : { ...s, jobs: [...s.jobs, { _id: 'job', preparing: false, cancelled: false, clarification: '', source: { text, revision: 1, ...(scenario?.startsWith('gmail-source') ? { email: { sender: 'school@example.test', subject: 'Synthetic field trip notice', receivedAt: Date.parse('2026-10-05T12:00:00Z'), extraction: { format: scenario === 'gmail-source-incomplete' ? 'snippet' as const : 'html' as const, truncated: scenario === 'gmail-source-incomplete', incomplete: scenario === 'gmail-source-incomplete', attachments: true, issues: scenario === 'gmail-source-incomplete' ? ['Only the email preview was available.'] : [] } } } : {}) }, files: scenario === 'email' ? [{ id: 'file', name: 'Synthetic notice.pdf', hash: 'synthetic', size: 1024, mediaType: 'application/pdf' }] : [], actions: [{ _id: 'action', revision: 1, payload: scenario === 'email' || scenario?.startsWith('revision') || scenario === 'partial-review' || scenario === 'accounts-email' || scenario === 'accounts-mixed' ? email : scenario?.startsWith('pickup') ? pickup : event, status: 'review', receipts: [] }, ...(scenario === 'revision-group' || scenario === 'partial-review' || scenario === 'accounts-mixed' ? [{ _id: 'calendar-action', revision: 1, payload: scenario === 'partial-review' ? { ...event, endTime: null } : event, status: 'review' as const, receipts: [] }] : [])] }] }); return 'job' },
    edit: async (id, revision, payload) => { if (pickupGmail) sessionStorage.setItem('synthetic-pickup-edit', JSON.stringify({ id, revision: revision + 1, payload })); update(s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, actions: j.actions.map(a => a._id === id ? { ...a, payload, revision: revision + 1 } : a) })) })) },
    approve: async actions => {
      if (scenario === 'approval-error') throw new ConvexError('Google is disconnected. Nothing was written.')
      if (scenario === 'approval-internal-error') throw new Error('PRIVATE_INTERNAL_SENTINEL provider-token https://provider.example.test/')
      if (state.accounts && actions.some(a => a.selectionVersion !== state.accounts!.version)) throw new Error('The calendar or email account changed. Reopen the review before approving.')
      if (pickupGmail) {
        const previews = JSON.parse(sessionStorage.getItem('synthetic-pickup-previews') ?? '[]')
        for (const approved of actions) {
          const edited = JSON.parse(sessionStorage.getItem('synthetic-pickup-edit') ?? 'null')
          const action = edited?.id === approved.id ? edited : state.jobs.flatMap(j => j.actions).find(a => a._id === approved.id)
          const preview = previews.findLast((p: any) => p.id === approved.id && p.proof.hash === approved.pickupEmailHash)
          if (!action || !preview || JSON.stringify(action.payload) !== JSON.stringify(preview.payload) || approved.selectionVersion !== preview.selectionVersion) throw new ConvexError('The exact caregiver email changed. Review it again.')
        }
      }
      sessionStorage.setItem('synthetic-approvals', JSON.stringify(actions))
      update(s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, actions: j.actions.map(a => {
        if (!actions.some(x => x.id === a._id)) return a
        const outlook = a.payload.kind === 'email' && s.accounts?.emailId === 'microsoft-account'
        return { ...a, status: a.payload.kind === 'pickup' ? 'waiting' : 'succeeded', receipts: [{ _id: 'receipt', ...(outlook ? { requestId: 'SYNTHETIC-ONLY-graph-request' } : { providerId: 'SYNTHETIC-ONLY-no-provider-write' }), outcome: outlook ? 'microsoft_accepted' : a.payload.kind === 'email' ? 'gmail_accepted' : a.payload.kind === 'pickup' ? (scenario === 'pickup-app' ? 'request_available_in_app' : 'request_email_accepted') : 'calendar_read_back_verified', verifiedAt: Date.now() }] }
      }) })), plan: [{ _id: 'plan', actionId: 'action', payload: s.jobs[0].actions[0].payload }] }))
    },
    addDraft: async () => {}, reviseSource: async () => {}, cancel: async id => { update(s => ({ ...s, jobs: s.jobs.map(j => j._id === id ? { ...j, cancelled: true } : j) })) }, reconcile: async () => {},
  }
  return <><div style={{ background: '#ffe5b1', color: '#252923', padding: 8, textAlign: 'center', fontSize: 13 }}>Synthetic UI test · no sign-in or provider calls</div>{scenario === 'pickup-gmail-loading' && <button onClick={() => { previewBlocked.current = false; previewWaiters.current.splice(0).forEach(resolve => resolve()) }}>Finish synthetic email preview</button>}{scenario === 'pickup-gmail-race' && <button onClick={() => update(s => ({ ...s, accounts: { ...s.accounts!, version: s.accounts!.version + 1, items: s.accounts!.items.map(a => a.id === s.accounts!.emailId ? { ...a, email: 'changed-parent@google.example.test' } : a) } }))}>Simulate changed pickup sender</button>}{scenario === 'conversation-updates' && <><button onClick={() => update(s => ({ ...s, jobs: s.jobs.map(j => j._id === 'pickup-thread' ? { ...j, actions: j.actions.map(a => ({ ...a, status: 'succeeded' as const, receipts: [...a.receipts, { _id: crypto.randomUUID(), revision: a.revision, outcome: 'caregiver_accepted_not_pickup_completed', providerId: 'synthetic-request', verifiedAt: Date.now() }] })) } : j) }))}>Deliver synthetic caregiver answer</button><button onClick={() => update(s => ({ ...s, jobs: s.jobs.map(j => j._id === 'pickup-thread' ? { ...j, actions: j.actions.map(a => ({ ...a, revision: a.revision + 1, status: 'review' as const })) } : j) }))}>Correct synthetic request</button><button onClick={() => update(s => ({ ...s, jobs: s.jobs.filter(j => j._id !== 'pickup-thread') }))}>Remove authorized request</button></>}<Daymark state={state} client={client} /></>
}
createRoot(document.getElementById('root')!).render(scenario === 'voice-bridge' ? <VoiceHarness /> : scenario?.startsWith('assistant-builds') ? <AssistantBuildsHarness scenario={scenario} /> : scenario?.startsWith('mailbox-') ? <MailboxHarness scenario={scenario} /> : scenario?.startsWith('email-watch') ? <EmailWatchHarness scenario={scenario} /> : <Harness />)
