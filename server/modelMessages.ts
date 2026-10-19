import type Anthropic from '@anthropic-ai/sdk'
import { isConversation, jobSummary, jobTitle, type Task } from '../shared/assistant.js'

export type ConversationExchange = { request: string; response: string; sourceOnly?: true }
export const conversationHistoryLimit = 12
export const conversationHistoryCharacterLimit = 18_000
// Keep a parent's still-permitted words without carrying an answer derived from
// changed work, forgotten working context or a revoked connector into a new turn.
export const unavailableConversationResponse = 'The earlier answer is no longer current. Use the parent’s original message for topic continuity, and check current records before describing work or taking action.'

/** One representation for retrieval AND provenance matching, including prepared work. */
export function recordedConversationResponse(job: Task): string {
  if (isConversation(job)) return job.clarification
  // Preserve the assistant's question/introduction as well as the authoritative
  // current status. A status label alone loses the details a correction refers to.
  const clarification = job.clarification.trim().slice(0, 1500)
  const saved = `Saved work: ${jobTitle({ ...job, source: null })} — ${jobSummary(job)}`
  return [clarification, saved].filter(Boolean).join('\n\n')
}

/** Preserve complete recent exchanges; never keep an answer without its question. */
export function boundedConversationHistory(history: readonly ConversationExchange[]) {
  const selected: ConversationExchange[] = []
  let characters = 0
  for (const turn of history.slice(-conversationHistoryLimit).reverse()) {
    const request = turn.request.slice(0, 3000), response = turn.response.slice(0, 2000)
    if (!request.trim() || !response.trim()) continue
    if (characters + request.length + response.length > conversationHistoryCharacterLimit) break
    selected.push({ request, response, ...(turn.sourceOnly ? { sourceOnly: true as const } : {}) }); characters += request.length + response.length
  }
  return selected.reverse()
}

/** Called only with history retrieved by the server for the signed-in adult. */
export function modelMessages(input: unknown, attachments: Anthropic.ContentBlockParam[], history?: readonly ConversationExchange[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
  if (history) {
    for (const turn of boundedConversationHistory(history)) {
      messages.push({ role: 'user', content: turn.request })
      messages.push({ role: 'assistant', content: turn.response })
    }
    // Avoid presenting the same exchange as both transcript and reference JSON.
    if (input && typeof input === 'object' && 'assistant' in input && input.assistant && typeof input.assistant === 'object') {
      const { history: _history, ...assistant } = input.assistant as Record<string, unknown>
      input = { ...input, assistant }
    }
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }, ...attachments] })
  return messages
}
