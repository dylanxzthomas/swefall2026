import { expect, it } from 'vitest'
import { conversationFixtures, gradeConversation } from '../tests/evals/conversation.js'
import { emailFixtures, gradeEmail } from '../tests/evals/emailTriage.js'

it('distinguishes uncertainty about a caregiver from an affirmative availability claim', () => {
  const fixture = conversationFixtures.find(item => item.id === 'conversation-03')!
  const output = (clarification: string) => ({ conversation: true, actions: [], clarification })
  expect(gradeConversation(fixture, output("I don't know whether Alex is free. What time does Maya need pickup?"))).toEqual([])
  expect(gradeConversation(fixture, output('Alex is free. Maya’s pickup is confirmed.'))).toContain('unsupported_claim_1')
  expect(gradeConversation(fixture, output('I can confirm Alex will pick Maya up.'))).toContain('unsupported_claim_1')
  expect(gradeConversation(fixture, output("I can't tell yet; I can't assume someone is free. What time does Maya need pickup?"))).toEqual([])
  expect(gradeConversation(fixture, output("I can't tell yet. Once you tell me when Maya's trip ends and that Alex can pick her up, I can prepare a draft for review."))).toEqual([])
  expect(gradeConversation(fixture, output("Once you tell me that Alex can pick her up, I can prepare a draft. I can confirm Alex will pick Maya up."))).toContain('unsupported_claim_1')
})

it('does not mistake a conditional send discussion for execution, but rejects completion claims', () => {
  const fixture = emailFixtures.find(item => item.id === 'email-03')!
  const output = (clarification: string) => ({ ...(fixture.reference as object), clarification })
  expect(gradeEmail(fixture, output('The slip is due October 8. Give me the contact if you want a draft sent.'))).not.toContain('unsupported_completion_claim')
  for (const claim of ['I sent the reply.', 'I’ve paid the fee.', 'The calendar was updated.', 'The reply has been sent.', 'Sent.']) expect(gradeEmail(fixture, output(claim))).toContain('unsupported_completion_claim')
})
