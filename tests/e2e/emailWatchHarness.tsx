import React, { useState } from 'react'
import EmailWatches from '../../web/src/daymark/EmailWatches'
import type { EmailWatchSettings, EmailWatchSummary } from '../../shared/emailWatches'
import type { EmailCheck } from '../../shared/emailTriage'
import type { EmailTaskSuggestion } from '../../shared/emailTasks'
import '../../web/src/daymark/daymark.css'
const fixtureSettings: EmailWatchSettings = { configured: true, modelConfigured: true, connection: { id: 'synthetic-google', email: 'parent@example.test', version: 1, readAllowed: true }, intervalMinutes: 15, firstLookbackHours: 24, maxBatch: 5 }
export default function EmailWatchHarness({ scenario }: { scenario: string }) {
  const followups = scenario.startsWith('email-watch-followups')
  const [watches, setWatches] = useState<EmailWatchSummary[]>([])
  const [checks, setChecks] = useState<EmailCheck[]>(followups ? [{ jobId: 'synthetic-followup', sourceRevision: 1, sender: 'school@example.test', subject: 'Field trip reminder', receivedAt: Date.parse('2026-10-06T15:00:00Z'), status: 'review', reason: 'The school needs the signed form before the trip.', evidence: ['Please return the signed form by October 10.'], canReview: false, handlingVersion: 1, canHandle: scenario !== 'email-watch-followups-unavailable', canRetry: true, related: [{ jobId: 'synthetic-earlier', subject: 'Field trip details', receivedAt: Date.parse('2026-10-04T15:00:00Z') }, { jobId: 'synthetic-correction', subject: 'Re: Field trip details — return time', receivedAt: Date.parse('2026-10-05T15:00:00Z') }] }] : scenario.startsWith('email-watch-triage') ? [{ jobId: 'synthetic-message', sourceRevision: 1, sender: 'school@example.test', subject: 'October highlights', receivedAt: Date.parse('2026-10-05T12:00:00Z'), status: 'quiet', reason: 'A recap with no requested follow-up.', evidence: ['There is nothing to sign or return.'], canReview: scenario !== 'email-watch-triage-paused' }] : [])
  const [suggestions, setSuggestions] = useState<EmailTaskSuggestion[]>(followups ? [{ id: 'synthetic-suggestion', jobId: 'synthetic-followup', sourceRevision: 1, version: 1, status: 'proposed', input: { title: 'Return field-trip form', notes: 'The form needs a parent signature.', dueDate: '2026-10-10', childId: 'maya' }, evidence: ['Please return the signed form by October 10.'], issue: 'Check the due date before saving.', canSave: scenario !== 'email-watch-followups-unavailable' }] : [])
  const settings = scenario === 'email-watch-unconfigured' ? { ...fixtureSettings, configured: false, modelConfigured: false, connection: null } : fixtureSettings
  const log = (action: string) => sessionStorage.setItem('watch-actions', JSON.stringify([...JSON.parse(sessionStorage.getItem('watch-actions') ?? '[]'), action]))
  const checked = (id: string, version: number) => { const record = watches.find(w => w.id === id); if (!record || record.version !== version || scenario === 'email-watch-stale') throw new Error('This watch changed. Reopen its latest settings.'); return record }
  return <main className="dm-app" style={{ minHeight: '100vh' }}><p>Synthetic email watch controls · no provider calls</p>{scenario === 'email-watch-followups-changed' && <button onClick={() => setSuggestions(current => current.map(s => ({ ...s, version: s.version + 1, input: { ...s.input, title: 'Review corrected field-trip form' } })))}>Simulate newer suggestion</button>}<dialog open className="dm-sheet" aria-label="Household" style={{ position: 'relative', maxHeight: 'none', margin: '0 auto' }}><header><h2>Household</h2></header><EmailWatches settings={settings} watches={watches} checks={checks} suggestions={suggestions} children={[{ id: 'maya', name: 'Maya' }, { id: 'lucy', name: 'Lucy' }]}
    onSaveTask={async (id, version, sourceRevision, input) => {
      const suggestion = suggestions.find(s => s.id === id)
      if (scenario === 'email-watch-followups-stale' || !suggestion || suggestion.version !== version || suggestion.sourceRevision !== sourceRevision) throw new Error('The original email changed. Your edits are still here; review the latest source before saving.')
      log('save-task')
      await new Promise(resolve => setTimeout(resolve, 600))
      const saved = JSON.parse(sessionStorage.getItem('saved-email-tasks') ?? '[]')
      sessionStorage.setItem('saved-email-tasks', JSON.stringify([...saved, { ...input, done: false }]))
      setSuggestions(current => current.map(s => s.id === id ? { ...s, input, version: s.version + 1, status: 'saved', personalTaskId: 'synthetic-personal-task', canSave: false } : s))
    }}
    onDismissTask={async (id, version, sourceRevision) => {
      const suggestion = suggestions.find(s => s.id === id)
      if (!suggestion || suggestion.version !== version || suggestion.sourceRevision !== sourceRevision) throw new Error('This suggestion changed. Review the latest source.')
      log('dismiss-task'); setSuggestions(current => current.map(s => s.id === id ? { ...s, version: s.version + 1, status: 'dismissed', canSave: false } : s))
    }}
    onHandleMessage={async (jobId, sourceRevision, handlingVersion, operation, until) => {
      const check = checks.find(c => c.jobId === jobId)
      if (!check || check.sourceRevision !== sourceRevision || check.handlingVersion !== handlingVersion || !check.canHandle || scenario === 'email-watch-followups-stale') throw new Error('This email changed. Review the latest message before setting it aside.')
      log(operation)
      setChecks(current => current.map(c => c.jobId === jobId ? { ...c, handlingVersion: handlingVersion + 1, status: operation === 'restore' ? 'review' : operation === 'dismiss' ? 'dismissed' : 'snoozed', snoozedUntil: operation === 'snooze' ? until : undefined } : c))
      setSuggestions(current => current.map(s => s.jobId === jobId ? { ...s, canSave: operation === 'restore' && s.status === 'proposed' } : s))
    }}
    onRetryMessage={async (jobId, sourceRevision) => {
      const check = checks.find(c => c.jobId === jobId)
      if (!check || check.sourceRevision !== sourceRevision || scenario === 'email-watch-followups-stale') throw new Error('This source changed. Share the email again.')
      log('retry-message'); setChecks(current => current.map(c => c.jobId === jobId ? { ...c, status: 'preparing', canRetry: false, canHandle: false } : c))
    }}
    onReviewMessage={async () => {
      if (scenario === 'email-watch-triage-stale') throw new Error('The original email changed or expired. Share it again.')
      log('review-message'); setChecks(current => current.map(check => ({ ...check, status: 'preparing', canReview: false })))
    }}
    onConnect={async () => { log('connect') }}
    onCreate={async (definition, requestId, connectionId) => {
      log(`create:${requestId}:${connectionId}`)
      if (scenario === 'email-watch-slow') await new Promise(resolve => setTimeout(resolve, 750))
      setWatches([{ ...definition, id: 'synthetic-watch', version: 1, state: 'active', checking: false, consentedAt: Date.now() }])
    }}
    onUpdate={async (id, version, definition) => { checked(id, version); log('update'); setWatches(watches.map(w => w.id === id ? { ...w, ...definition, version: version + 1, state: 'paused' } : w)) }}
    onPause={async (id, version, paused) => { checked(id, version); log(paused ? 'pause' : 'resume'); setWatches(watches.map(w => w.id === id ? { ...w, version: version + 1, state: paused ? 'paused' : 'active' } : w)) }}
    onRemove={async (id, version) => { checked(id, version); log('remove'); setWatches(watches.filter(w => w.id !== id)) }}
    onCheck={async (id, version) => { checked(id, version); log('check'); setWatches(watches.map(w => w.id === id ? { ...w, checking: true } : w)) }}
  /></dialog></main>
}
