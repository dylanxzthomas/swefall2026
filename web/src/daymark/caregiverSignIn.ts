import { pickupSecret } from '../../../shared/authentication'

export type CaregiverSignInMethod = 'google' | 'email'

/** Only the current private request can survive this sign-in; no caller chooses a redirect or scopes. */
export function caregiverSignInOptions(fragment: string, method: CaregiverSignInMethod) {
  const secret = pickupSecret(fragment)
  if (!secret || !['google', 'email'].includes(method)) throw new Error('Open the current private pickup link before signing in.')
  return {
    appState: { pickupReturn: secret },
    authorizationParams: { prompt: 'login' as const, ...(method === 'google' ? { connection: 'google-oauth2' } : {}) },
  }
}
