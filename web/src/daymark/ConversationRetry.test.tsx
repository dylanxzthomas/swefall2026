import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import ConversationRetry from './ConversationRetry'
import type { Job } from './types'

const job: Job = { _id: 'synthetic', conversation: true, emailPreparationFailed: true, preparing: false, cancelled: false, clarification: 'Preparation stopped.', source: { text: 'Synthetic question', revision: 1 }, actions: [] }
const client = { retryConversation: async () => 2 }
it('offers retry only for a failed conversation with a supported connected client', () => {
  expect(renderToStaticMarkup(<ConversationRetry job={job} client={client} />)).toContain('Try again')
  for (const changes of [{ emailPreparationFailed: undefined }, { preparing: true }, { cancelled: true }, { conversation: false }, { source: null }]) {
    expect(renderToStaticMarkup(<ConversationRetry job={{ ...job, ...changes }} client={client} />)).toBe('')
  }
  expect(renderToStaticMarkup(<ConversationRetry job={job} client={{}} />)).toBe('')
})
