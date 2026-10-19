import { expect, it } from 'vitest'
import { checkedMailProposal, validateMailAgentStep, type MailProposalInput } from './mailFollowthrough.js'
const messages = [{ id: 'one', text: 'Return the form by October 12.' }]
const proposal: MailProposalInput = { kind: 'task', messageId: 'one', title: 'Return the form', details: '', dueDate: '2026-10-12', date: '', startTime: '', endTime: '', timezone: '', location: '', question: '', replyBody: '', evidence: [{ messageId: 'one', quote: 'Return the form' }] }
const finish = { tool: 'finish', messageId: '', answer: 'The form needs returning.', evidence: proposal.evidence, proposals: [proposal] }
it('accepts evidence-backed preparation and rejects arbitrary tools, invented sources and embedded approval fields', () => {
  expect(validateMailAgentStep(finish, messages, []).proposals).toHaveLength(1)
  for (const value of [{ ...finish, tool: 'send_email' }, { ...finish, approved: true }, { ...finish, evidence: [{ messageId: 'stranger', quote: 'Return' }] }, { ...finish, proposals: [{ ...proposal, evidence: [{ messageId: 'one', quote: 'A fabricated quote' }] }] }, { ...finish, proposals: [proposal, proposal] }]) expect(() => validateMailAgentStep(value, messages, [])).toThrow()
})
it('requires read steps to be permitted, useful, non-repeated and separate from final preparation', () => {
  const read = { tool: 'read_thread', messageId: 'one', answer: '', evidence: [], proposals: [] }
  expect(validateMailAgentStep(read, messages, []).tool).toBe('read_thread')
  for (const value of [{ ...read, messageId: 'outsider' }, { ...read, answer: 'Completed.' }, { ...read, tool: 'family_context' }]) expect(() => validateMailAgentStep(value, messages, [])).toThrow()
  expect(() => validateMailAgentStep(read, messages, ['read_thread:one'])).toThrow()
})
it('preserves unknown calendar details as a question and rejects malformed dates and times', () => {
  expect(checkedMailProposal({ ...proposal, kind: 'calendar', dueDate: '', date: '2026-10-12', question: 'What time does it finish?' }).endTime).toBe('')
  for (const value of [{ ...proposal, dueDate: '2026-02-30' }, { ...proposal, startTime: '25:00' }, { ...proposal, timezone: 'Imaginary/Zone' }, { ...proposal, kind: 'calendar', question: '' }, { ...proposal, kind: 'reply', replyBody: '' }]) expect(() => checkedMailProposal(value)).toThrow()
})
it('validates model-chosen routine references only for current eligible messages', () => {
  const routine = { id: 'routine-one', version: 2, eligibleMessageIds: ['one'] }
  const p = { ...proposal, routineRefs: [{ id: routine.id, version: 2 }] }
  expect(validateMailAgentStep({ ...finish, proposals: [p] }, messages, [], [routine]).proposals[0].routineRefs).toEqual(p.routineRefs)
  for (const refs of [[{ id: 'outsider', version: 2 }], [{ id: routine.id, version: 1 }], [p.routineRefs[0], p.routineRefs[0]]]) expect(() => validateMailAgentStep({ ...finish, proposals: [{ ...p, routineRefs: refs }] }, messages, [], [routine])).toThrow('routine')
  expect(() => validateMailAgentStep({ ...finish, proposals: [p] }, messages, [], [{ ...routine, eligibleMessageIds: [] }])).toThrow('routine')
  expect(() => validateMailAgentStep({ ...finish, proposals: [p] }, messages, [])).toThrow('routine')
  expect(validateMailAgentStep(finish, messages, [], [routine]).proposals).toHaveLength(1)
})
