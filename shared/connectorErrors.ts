import { ConvexError } from 'convex/values'

export function connectorErrorMessage(error: unknown): string {
  // Intentional backend messages remain available even when internal logs are
  // redacted. Never reflect transport/provider errors, URLs or stack traces.
  if (error instanceof ConvexError && typeof error.data === 'string' && error.data.length <= 1000) return error.data
  return 'This could not finish. Your changes are still here. Try again.'
}
