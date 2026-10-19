import { beforeEach, expect, it, vi } from 'vitest'
const memory = new Map<string, string>()
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: memory.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { memory.set(key, value) }),
  remove: vi.fn(async ({ key }: { key: string }) => { memory.delete(key) }),
} }))
import { Preferences } from '@capacitor/preferences'
import { forgetVoiceConsent, rememberedVoiceConsent, rememberVoiceConsent, voiceConsentKey } from './voiceConsent'
beforeEach(() => { memory.clear(); vi.clearAllMocks() })
it('remembers disclosure only for the same adult, backend and processing mode', async () => {
  const key = voiceConsentKey('parent-a', true, 'https://synthetic.convex.cloud')
  expect(await rememberedVoiceConsent(key)).toBe(false)
  await rememberVoiceConsent(key)
  expect(await rememberedVoiceConsent(key)).toBe(true)
  for (const other of [voiceConsentKey('parent-b', true, 'https://synthetic.convex.cloud'), voiceConsentKey('parent-a', false, 'https://synthetic.convex.cloud'), voiceConsentKey('parent-a', true, 'https://different.convex.cloud')]) expect(await rememberedVoiceConsent(other)).toBe(false)
  expect(key).not.toContain('parent-a')
})
it('forgetting clears the choice and a storage read failure never implies consent', async () => {
  const key = voiceConsentKey('parent-a', true)
  await rememberVoiceConsent(key); await forgetVoiceConsent(key)
  expect(await rememberedVoiceConsent(key)).toBe(false)
  vi.mocked(Preferences.get).mockRejectedValueOnce(new Error('synthetic storage failure'))
  expect(await rememberedVoiceConsent(key)).toBe(false)
})
