type SecureStore = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Auth0 SPA SDK's transaction contains the PKCE verifier. Restore only this client's
// transaction before the SDK starts; never copy sessionStorage or credentials to Preferences.
export function nativeTransaction(clientId: string, secure: SecureStore, session: SessionStore, now = Date.now) {
  const sessionKey = `a0.spajs.txs.${clientId}`, secureKey = `daymark.oauth.transaction.v1.${clientId}`
  const valid = (raw: string) => { try { const t = JSON.parse(raw); return t.response_type === 'code' && typeof t.state === 'string' && t.state.length > 0 && typeof t.code_verifier === 'string' && t.code_verifier.length >= 43 } catch { return false } }
  const clear = async () => { session.removeItem(sessionKey); await secure.remove(secureKey) }
  return {
    clear,
    async save() {
      const transaction = session.getItem(sessionKey)
      if (!transaction || !valid(transaction)) throw new Error('Sign-in could not be saved securely. Please try again.')
      await secure.set(secureKey, JSON.stringify({ transaction, expiresAt: now() + 15 * 60_000 }))
    },
    async restore() {
      const raw = await secure.get(secureKey)
      if (!raw) return
      let saved
      try { saved = JSON.parse(raw) } catch { await clear(); return }
      if (typeof saved.transaction !== 'string' || !valid(saved.transaction) || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= now() || saved.expiresAt > now() + 15 * 60_000) { await clear(); return }
      session.setItem(sessionKey, saved.transaction)
    },
  }
}
