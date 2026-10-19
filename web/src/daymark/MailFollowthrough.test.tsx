import { expect, it } from 'vitest'
import { visibleMailFollowups } from './MailFollowthrough'
import type { PrivateMailProposal } from '../../../shared/mailFollowthrough'

const proposal: PrivateMailProposal = { id: 'proposal-one', runId: 'run-one', version: 1, createdAt: Date.now(), expiresAt: Date.now() + 86400_000, kind: 'task', messageId: 'message-one', title: 'Return the form', details: 'Bring the signed form.', dueDate: '2026-10-15', date: '', startTime: '', endTime: '', timezone: '', location: '', question: '', replyBody: '', evidence: [{ messageId: 'message-one', quote: 'Return the form.' }], status: 'review', stale: false }

it('hides a saved task proposal from every email list so Tasks owns its current state', () => {
  for (const status of ['kept', 'done'] as const) for (const filter of ['all', 'you', 'assistant', 'finished'] as const) {
    expect(visibleMailFollowups([{ ...proposal, status, privateTaskId: 'task-one' }], filter, 'form')).toEqual([])
  }
})

it('keeps unretained and legacy task proposals available for their existing review filters', () => {
  expect(visibleMailFollowups([proposal], 'you')).toEqual([proposal])
  expect(visibleMailFollowups([{ ...proposal, status: 'kept' }], 'you')).toHaveLength(1)
  expect(visibleMailFollowups([{ ...proposal, status: 'done' }], 'finished')).toHaveLength(1)
})
