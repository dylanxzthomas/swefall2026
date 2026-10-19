import { expect, it } from 'vitest'
import { needsMailConversation } from './mailConversation.js'

it('uses cached sources for explicit email discussion, regardless of the prior topic', () => {
  for (const text of ['Which email needs a reply?', 'What did the school email say?', 'Could you explain that Gmail summary?']) {
    expect(needsMailConversation(text, false)).toBe(true)
  }
})
it('continues short references only while email is the latest topic', () => {
  for (const text of ['Which one needs a reply?', 'What is the deadline for that one?', 'Could you draft a reply to that?', 'Make it shorter', 'Why?', 'What next?']) {
    expect(needsMailConversation(text, true)).toBe(true)
    expect(needsMailConversation(text, false)).toBe(false)
  }
})
it('keeps unrelated discussion out of mailbox context', () => {
  for (const text of ['What should I order for dinner?', 'Hi Sola', 'What is 10+10?', 'Why do kids dislike broccoli?', 'What should we do this weekend?']) {
    expect(needsMailConversation(text, true)).toBe(false)
  }
})
