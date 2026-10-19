// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { seal, unseal } from './googleCrypto'
afterEach(() => vi.unstubAllEnvs())
it('authenticates household binding and supports an old key during rotation', () => {
  const keys = { first: Buffer.alloc(32, 7).toString('base64'), second: Buffer.alloc(32, 8).toString('base64') }
  vi.stubEnv('GOOGLE_TOKEN_KEYS', JSON.stringify(keys)); vi.stubEnv('GOOGLE_TOKEN_KEY_ID', 'first')
  const cipher = seal({ refresh_token: 'synthetic-secret' }, 'household:alice')
  expect(cipher).not.toContain('synthetic-secret')
  expect(unseal(cipher, 'household:alice')).toEqual({ refresh_token: 'synthetic-secret' })
  expect(() => unseal(cipher, 'household:bob')).toThrow()
  vi.stubEnv('GOOGLE_TOKEN_KEY_ID', 'second')
  expect(unseal(cipher, 'household:alice')).toEqual({ refresh_token: 'synthetic-secret' })
  expect(seal({}, 'household:alice')).toMatch(/^second\./)
})
it.each(['short tag', 'short nonce', 'extra fields', 'invalid encoding', 'tampered ciphertext'])('rejects %s without weakening envelope authentication', mutation => {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') })); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'test')
  const parts = seal({ refresh_token: 'synthetic-secret' }, 'household:alice').split('.')
  if (mutation === 'short tag') parts[2] = Buffer.from(parts[2], 'base64url').subarray(0, 4).toString('base64url')
  else if (mutation === 'short nonce') parts[1] = Buffer.from(parts[1], 'base64url').subarray(0, 8).toString('base64url')
  else if (mutation === 'extra fields') parts.push('extra')
  else if (mutation === 'invalid encoding') parts[2] += '!'
  else { const data = Buffer.from(parts[3], 'base64url'); data[0] ^= 1; parts[3] = data.toString('base64url') }
  expect(() => unseal(parts.join('.'), 'household:alice')).toThrow()
})
