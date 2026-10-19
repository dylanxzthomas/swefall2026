import { expect, it } from 'vitest'
import { nativeTransaction } from './nativeTransaction.js'

it('restores only the native Auth0 PKCE transaction after termination, then removes it', async () => {
  const keychain = new Map<string, string>(), memory = new Map<string, string>()
  const secure = { get: async (key: string) => keychain.get(key), set: async (key: string, value: string) => { keychain.set(key, value) }, remove: async (key: string) => { keychain.delete(key) } }
  const session = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) }, removeItem: (key: string) => { memory.delete(key) } }
  const transaction = JSON.stringify({ state: 'synthetic-state', code_verifier: 'a'.repeat(43), response_type: 'code' })
  memory.set('a0.spajs.txs.test', transaction); memory.set('unrelated', 'not-copied')
  let now = 1000
  const store = nativeTransaction('test', secure, session, () => now)
  await store.save(); memory.clear(); await store.restore()
  expect(memory.get('a0.spajs.txs.test')).toBe(transaction); expect(memory.has('unrelated')).toBe(false)
  await nativeTransaction('other-client', secure, session, () => now).restore()
  expect(memory.has('a0.spajs.txs.other-client')).toBe(false)
  await store.clear(); expect(keychain.size).toBe(0); expect(memory.size).toBe(0)
  memory.set('a0.spajs.txs.test', transaction); await store.save(); memory.clear(); now += 16 * 60000
  await store.restore(); expect(memory.size).toBe(0); expect(keychain.size).toBe(0)
  await expect(store.save()).rejects.toThrow('securely')
})
