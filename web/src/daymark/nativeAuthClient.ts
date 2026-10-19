import { Auth0Client, type Auth0ClientOptions, type GetTokenSilentlyOptions, type ICache } from '@auth0/auth0-spa-js'

type NativeAuthOptions = Pick<Auth0ClientOptions, 'domain' | 'clientId'> & {
  redirectUri: string
  cache: ICache
}

const errorCode = (error: unknown): string | undefined => {
  try {
    const code = error && typeof error === 'object' ? (error as { error?: unknown }).error : undefined
    return typeof code === 'string' ? code : undefined
  } catch { return undefined }
}

// The SDK's ordinary checkSession skips restoration when its browser cookie is
// absent. Native identity lives in Keychain, so use the documented silent-token
// API directly. The SDK still owns validation, expiry, rotation and locking.
export class NativeAuthClient extends Auth0Client {
  constructor({ domain, clientId, redirectUri, cache }: NativeAuthOptions) {
    super({ domain, clientId, cache, authorizationParams: { redirect_uri: redirectUri }, useRefreshTokens: true, useRefreshTokensFallback: false })
  }

  override async checkSession(options?: GetTokenSilentlyOptions): Promise<void> {
    try {
      await this.getTokenSilently(options)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'missing_refresh_token' || code === 'invalid_grant' || code === 'login_required' || code === 'access_denied') {
        // Clear only this SDK client's session. Do not open a browser, sign out
        // other accounts, or touch the pending PKCE transaction or native journal.
        await this.logout({ openUrl: false })
        if (code === 'missing_refresh_token') return
      }
      // Offline/locked-Keychain errors retain the cache for a later retry and
      // reject initialization, so cached identity is not reported as restored.
      throw error
    }
  }
}
