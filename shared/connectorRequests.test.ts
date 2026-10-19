import { expect, it } from 'vitest'
import { connectorRequestSchema, connectorRequestKey, connectorRequestId } from './connectorRequests.js'

it('accepts a missing service name but requires a concrete bounded request', () => {
  expect(connectorRequestSchema.parse({ service: ' ', outcome: ' Help find a swim lesson. ' })).toEqual({ service: undefined, outcome: 'Help find a swim lesson.' })
  for (const value of [{ outcome: '' }, { outcome: 'x'.repeat(2001) }, { service: 'x'.repeat(101), outcome: 'Book a lesson.' }, { outcome: 'Book a lesson.', approved: true }, { outcome: 'Book a lesson.', status: 'connected' }]) expect(connectorRequestSchema.safeParse(value).success).toBe(false)
  expect(() => connectorRequestId('')).toThrow('valid identifier')
  expect(() => connectorRequestId('a'.repeat(101))).toThrow('valid identifier')
})
it('deduplicates equivalent service and outcome descriptions without changing the displayed request', () => {
  expect(connectorRequestKey({ service: ' Swim School ', outcome: 'Book  a\nlesson' })).toBe(connectorRequestKey({ service: 'swim school', outcome: 'BOOK A LESSON' }))
  expect(connectorRequestKey({ outcome: 'Book a lesson' })).not.toBe(connectorRequestKey({ service: 'School', outcome: 'Book a lesson' }))
})
