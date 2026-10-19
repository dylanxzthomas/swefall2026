import { expect, it } from 'vitest'
import { ConvexError } from 'convex/values'
import { connectorErrorMessage } from './connectorErrors.js'
it('preserves intentional recovery guidance when server logs are hidden', () => {
  expect(connectorErrorMessage(new ConvexError('Gmail access changed. Reconnect and review again.'))).toBe('Gmail access changed. Reconnect and review again.')
})
it.each([new Error('synthetic-token https://provider.example.test/ private stack'), { data: 'synthetic-token' }, new ConvexError({ private: 'synthetic-token' }), new ConvexError('x'.repeat(1001))])('does not expose unexpected error details', error => {
  expect(connectorErrorMessage(error)).toBe('This could not finish. Your changes are still here. Try again.')
})
