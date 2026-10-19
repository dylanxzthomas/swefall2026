export const mailboxFailureStages = ['authorization', 'account', 'listing', 'history', 'message', 'persistence'] as const
export const mailboxFailureCodes = ['permission', 'rate_limit', 'timeout', 'network', 'provider_unavailable', 'invalid_response', 'account_mismatch', 'access_changed', 'connection_busy', 'unknown'] as const
export type MailboxFailure = { stage: typeof mailboxFailureStages[number]; code: typeof mailboxFailureCodes[number]; status?: number }

/** Only allowlisted categories and HTTP status cross the storage/client boundary. */
export function mailboxFailure(error: unknown, stage: MailboxFailure['stage']): MailboxFailure {
  const e = error as { code?: unknown; status?: unknown; message?: unknown; response?: { status?: unknown; data?: { error?: unknown } } } | null
  const rawStatus = e?.response?.status ?? e?.status ?? e?.code
  const numeric = typeof rawStatus === 'number' ? rawStatus : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined
  const status = numeric !== undefined && Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : undefined
  const data = e?.response?.data?.error
  const reasons = data && typeof data === 'object' && 'errors' in data && Array.isArray(data.errors) ? data.errors.map(item => item && typeof item === 'object' && 'reason' in item ? item.reason : null) : []
  let code: MailboxFailure['code'] = 'unknown'
  if (status === 429 || status === 403 && reasons.length > 0 && reasons.every(r => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].includes(String(r)))) code = 'rate_limit'
  else if (status === 401 || status === 403 || stage === 'authorization' && status === 400 && data === 'invalid_grant') code = 'permission'
  else if (status === 408 || ['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(e?.code))) code = 'timeout'
  else if (status !== undefined && status >= 500) code = 'provider_unavailable'
  else if (['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String(e?.code))) code = 'network'
  else if (e instanceof Error && e.message === 'The Gmail token account does not match the permitted mailbox.') code = 'account_mismatch'
  else if (e instanceof Error && e.message === 'Mailbox reading stopped.') code = 'access_changed'
  else if (e instanceof Error && /^Gmail (?:returned|exceeded)/.test(e.message)) code = 'invalid_response'
  return { stage, code, ...(status !== undefined ? { status } : {}) }
}

export function mailboxRetry(failure: MailboxFailure, consecutiveFailures: number, now: number) {
  const blocked = ['permission', 'account_mismatch', 'access_changed'].includes(failure.code)
  const exhausted = consecutiveFailures >= 6
  const minutes = Math.min(120, 15 * 2 ** Math.max(0, Math.min(4, consecutiveFailures - 1)))
  const cause: Record<MailboxFailure['code'], string> = {
    permission: 'Gmail reading access needs reconnection.',
    rate_limit: 'Gmail is temporarily limiting requests.',
    timeout: 'Gmail did not respond in time.',
    network: 'The connection to Gmail was interrupted.',
    provider_unavailable: 'Gmail is temporarily unavailable.',
    invalid_response: 'Gmail returned a result that could not be safely accepted.',
    account_mismatch: 'The Gmail account did not match this private connection.',
    access_changed: 'Private mailbox access changed.',
    connection_busy: 'Another operation is using this Gmail connection.',
    unknown: 'The mailbox check stopped before completion.',
  }
  return {
    blocked,
    ...(blocked || exhausted ? {} : { nextAttemptAt: now + minutes * 60_000 }),
    issue: `${cause[failure.code]} ${blocked ? 'Reconnect and explicitly resume before checking again.' : exhausted ? 'Automatic retries stopped after repeated failures. Review this check and continue when ready.' : `This check retries in about ${minutes} minutes.`} Saved pages stay private; no completed check was recorded.`,
  }
}
