import { expect, it } from 'vitest'
import { mailboxFailure, mailboxRetry } from './mailboxFailures.js'

it.each([
  [{ response: { status: 429, data: { secret: 'synthetic-token' } } }, 'rate_limit'],
  [{ response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }, 'rate_limit'],
  [{ response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } }, 'permission'],
  [{ response: { status: 401 } }, 'permission'],
  [{ response: { status: 503 } }, 'provider_unavailable'],
  [{ code: 'ETIMEDOUT' }, 'timeout'],
  [{ code: 'ECONNRESET' }, 'network'],
  [new Error('Gmail returned a different message than requested.'), 'invalid_response'],
  [new Error('The Gmail token account does not match the permitted mailbox.'), 'account_mismatch'],
  [new Error('Mailbox reading stopped.'), 'access_changed'],
  [new Error('synthetic-token private-provider-body https://secret.test/'), 'unknown'],
] as const)('classifies safe failure categories without storing provider details', (error, code) => {
  const result = mailboxFailure(error, 'message')
  expect(result.code).toBe(code)
  expect(JSON.stringify(result)).not.toMatch(/synthetic-token|secret.test|private-provider-body|forbidden|userRateLimitExceeded/)
})
it('requires reconnection for an invalid refresh grant and refuses arbitrary status fields', () => {
  expect(mailboxFailure({ response: { status: 400, data: { error: 'invalid_grant' } } }, 'authorization').code).toBe('permission')
  expect(mailboxFailure({ code: 'synthetic-token' }, 'authorization')).toEqual({ stage: 'authorization', code: 'unknown' })
  expect(mailboxFailure({ status: 9999 }, 'message')).not.toHaveProperty('status')
})
it('backs off bounded read retries and stops after six consecutive failures', () => {
  const failure = { stage: 'message' as const, code: 'provider_unavailable' as const }, now = 1000
  expect(Array.from({ length: 5 }, (_, i) => mailboxRetry(failure, i + 1, now).nextAttemptAt! - now)).toEqual([15, 30, 60, 120, 120].map(m => m * 60_000))
  expect(mailboxRetry(failure, 6, now)).not.toHaveProperty('nextAttemptAt')
  expect(mailboxRetry(failure, 6, now).issue).toContain('Automatic retries stopped')
  expect(mailboxRetry({ stage: 'account', code: 'account_mismatch' }, 1, now)).toMatchObject({ blocked: true })
  expect(mailboxRetry({ stage: 'account', code: 'permission' }, 1, now)).not.toHaveProperty('nextAttemptAt')
})
