// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api } from './_generated/api'
import { googleConnectionConfigured, providerEncryptionConfigured } from './providerConfiguration'
import { seal, unseal } from './googleCrypto'

const modules = import.meta.glob('./**/*.ts')
const key = Buffer.alloc(32, 9).toString('base64')
const ring = JSON.stringify({ test: key })
beforeEach(() => {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', ring); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'test')
  vi.stubEnv('GOOGLE_TOKEN_KEYS', ''); vi.stubEnv('GOOGLE_TOKEN_KEY_ID', '')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-secret')
  vi.stubEnv('CONVEX_SITE_URL', 'https://synthetic.convex.site'); vi.stubEnv('DAYMARK_WEB_URL', 'https://synthetic.example.test')
  vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', 'synthetic@example.test')
})
afterEach(() => vi.unstubAllEnvs())
it('accepts an explicitly selected 32-byte key, including a retained legacy ring', () => {
  expect(googleConnectionConfigured()).toBe(true)
  vi.stubEnv('PROVIDER_TOKEN_KEYS', ''); vi.stubEnv('PROVIDER_TOKEN_KEY_ID', '')
  vi.stubEnv('GOOGLE_TOKEN_KEYS', ring); vi.stubEnv('GOOGLE_TOKEN_KEY_ID', 'test')
  expect(providerEncryptionConfigured()).toBe(true)
  expect(unseal(seal({ value: 'synthetic' }, 'owner'), 'owner')).toEqual({ value: 'synthetic' })
})
it.each(['{broken', 'null', '[]', JSON.stringify({ test: 123 }), JSON.stringify({ test: 'not-base64!' }), JSON.stringify({ test: Buffer.alloc(31).toString('base64') }), JSON.stringify({ other: key })])('fails closed on malformed or unusable key rings', value => {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', value)
  expect(googleConnectionConfigured()).toBe(false)
  expect(() => seal({ value: 'synthetic' }, 'owner')).toThrow('not configured')
})
it('rejects key identifiers that cannot be safely stored in encrypted envelopes', () => {
  vi.stubEnv('PROVIDER_TOKEN_KEY_ID', 'unsafe.id'); vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ 'unsafe.id': key }))
  expect(providerEncryptionConfigured()).toBe(false)
  vi.stubEnv('PROVIDER_TOKEN_KEY_ID', '__proto__'); vi.stubEnv('PROVIDER_TOKEN_KEYS', '{}')
  expect(providerEncryptionConfigured()).toBe(false)
})
it('does not replace an invalid current ring with a different legacy ring', () => {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', '{broken'); vi.stubEnv('GOOGLE_TOKEN_KEYS', ring)
  expect(providerEncryptionConfigured()).toBe(false)
})
it('handles every key length around the encryption requirement consistently', () => {
  for (let length = 0; length <= 64; length++) {
    vi.stubEnv('PROVIDER_TOKEN_KEYS', JSON.stringify({ test: Buffer.alloc(length, 9).toString('base64') }))
    expect(providerEncryptionConfigured()).toBe(length === 32)
  }
})
it('keeps connection buttons unavailable and creates no consent state without encryption', async () => {
  vi.stubEnv('PROVIDER_TOKEN_KEYS', '')
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'synthetic-parent' })
  await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  expect((await parent.query(api.mailbox.settings, {})).configured).toBe(false)
  expect((await parent.query(api.emailWatches.settings, {})).configured).toBe(false)
  expect((await parent.query(api.connections.overview, {})).configured.google).toBe(false)
  await expect(parent.action(api.google.connect, { purpose: 'watch', native: false })).rejects.toThrow('not securely configured')
  expect(await t.run(ctx => ctx.db.query('oauthStates').collect())).toEqual([])
  expect(await t.run(ctx => ctx.db.query('connections').collect())).toEqual([])
})
it('does not start Google consent without a configured dedicated development mailbox', async () => {
  vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS', '')
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'synthetic-parent' })
  await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await expect(parent.action(api.google.connect, { purpose: 'watch', native: false })).rejects.toThrow('dedicated Google test account')
  expect(await t.run(ctx => ctx.db.query('oauthStates').collect())).toEqual([])
})
