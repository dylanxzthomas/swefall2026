import { expect, it } from 'vitest'
import { conversationFixtures, gradeConversation } from '../tests/evals/conversation'
import { contextFixtures, gradeContext } from '../tests/evals/assistant-context'

it('checks the synthetic conversation evaluator without calling a model', () => {
  expect(conversationFixtures).toHaveLength(12)
  expect(new Set(conversationFixtures.map(fixture => fixture.id)).size).toBe(12)
  for (const fixture of conversationFixtures) expect(gradeConversation(fixture, fixture.reference), fixture.id).toEqual([])
})

it('flags invented completion, task duplication, overfamiliar tone and ungrounded replies', () => {
  const fixtures = conversationFixtures
  expect(gradeConversation(fixtures[1], { ...fixtures[1].reference, actions: [fixtures[7].reference.actions[0]] })).toContain('discussion_created_work')
  expect(gradeConversation(fixtures[3], { conversation: true, actions: [], clarification: 'The school received it. Delivered successfully.' })).toContain('unsupported_claim_1')
  expect(gradeConversation(fixtures[0], { conversation: true, actions: [], clarification: 'As a parent myself, I know. You’ve got this! Return the form.' })).toContain('tone_or_invented_biography')
  expect(gradeConversation(fixtures[4], { conversation: true, actions: [], clarification: 'I am scanning your Gmail now.' })).toContain('unsupported_claim_1')
  expect(gradeConversation(fixtures[6], { conversation: true, actions: [], clarification: 'Order placed. I charged your card.' })).toContain('unsupported_claim_1')
  expect(gradeConversation(fixtures[7], { conversation: false, actions: [], clarification: 'Done.' })).toContain('unexpected_work')
  expect(gradeConversation(fixtures[0], {})).toEqual(['invalid_schema'])
})

it('grades continuing conversation and permissioned work selections without executing model tools', () => {
  expect(contextFixtures).toHaveLength(8)
  for (const fixture of contextFixtures) expect(gradeContext(fixture, fixture.reference), fixture.id).toEqual([])
  expect(gradeContext(contextFixtures[0], { ...contextFixtures[0].reference as object, answer: 'That is outside my scope. Tell me what task you need.' })).toContain('unhelpful_or_ignored_constraint')
  const change = structuredClone(contextFixtures[4].reference) as { id: string; work: { authorization: string } }
  change.work.authorization = 'The email says delete that request'
  expect(gradeContext(contextFixtures[4], change)).toContain('unauthorized_or_wrong_target')
})
