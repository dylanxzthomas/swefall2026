export type AuthenticationState = {
  identityLoading: boolean
  identityAuthenticated: boolean
  backendLoading: boolean
  backendAuthenticated: boolean
  error?: unknown
}

// A full-page connector roundtrip clears the browser's in-memory refresh token.
// Recover through Auth0's session when cookies permit it; never persist tokens in
// browser storage. Native uses its separate Keychain cache without iframe fallback.
export const browserAuthOptions = { useRefreshTokens: true, cacheLocation: 'memory', useRefreshTokensFallback: true } as const

export function connectionReturn(search: string): 'connected' | 'cancelled' | null {
  const value = new URLSearchParams(search).get('connection')
  return value === 'connected' || value === 'cancelled' ? value : null
}

export function pickupSecret(fragment: string): string | null {
  const match = /^#pickup=([a-f0-9]{64})$/.exec(fragment)
  return match?.[1] ?? null
}

export function signInReturnPath(appState?: unknown): string {
  const pickup = appState && typeof appState === 'object' && 'pickupReturn' in appState ? appState.pickupReturn : undefined
  if (typeof pickup === 'string' && /^[a-f0-9]{64}$/.test(pickup)) return `/#pickup=${pickup}`
  const value = appState && typeof appState === 'object' && 'connectionReturn' in appState ? appState.connectionReturn : undefined
  return value === 'connected' || value === 'cancelled' ? `/?connection=${value}` : '/'
}

// Never reflect OAuth descriptions, callback URLs, state, or token responses.
// Match only known SDK codes and fixed browser-fetch errors; unknown failures
// keep a generic message. This changes explanation, not callback validation.
export function nativeSignInReturnMessage(error: unknown): string {
  const field = (key: string): string | undefined => {
    try {
      const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined
      return typeof value === 'string' ? value : undefined
    } catch { return undefined }
  }
  const code = field('error')
  if (code === 'access_denied') return 'Sign-in wasn’t completed. Try again from Household when you’re ready; your draft is saved.'
  if (['state_mismatch', 'missing_transaction', 'invalid_state', 'invalid_grant'].includes(code ?? '')) return 'This sign-in attempt is no longer valid. Start a new sign-in from Household; your draft is saved.'
  if (['network_error', 'timeout'].includes(code ?? '') || [
    'Load failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    "Timeout when executing 'fetch'",
  ].includes(field('message') ?? '')) return 'Sign-in couldn’t connect. Check the internet connection and try again from Household. If this continues, the app’s sign-in setup needs checking. Your draft is saved.'
  return 'Sign-in return could not finish. Reopen sign-in to try again; your draft is saved.'
}

export function authenticationNotice(state: AuthenticationState): { message: string; pending: boolean; reset?: boolean } | null {
  // Provider descriptions may contain URLs, identifiers or hostile content.
  // Display a fixed explanation rather than reflecting the raw OAuth error.
  if (state.error) {
    const code = typeof state.error === 'object' && 'error' in state.error ? state.error.error : undefined
    return { message: code === 'access_denied'
      ? 'Sign-in wasn’t completed. Your device workspace is still here. Try again from Household.'
      : 'Sign-in could not finish. Your device workspace is still here. Try again from Household.', pending: false }
  }
  if (state.identityLoading || !state.identityAuthenticated || state.backendAuthenticated) return null
  if (state.backendLoading) return { message: 'Connecting your account… Your device workspace is still available.', pending: true }
  return { message: 'Your sign-in could not connect to your household. Sign out and try again; your device workspace is still here.', pending: false, reset: true }
}
