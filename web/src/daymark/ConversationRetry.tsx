import { useRef, useState } from 'react'
import { connectorErrorMessage } from '../../../shared/connectorErrors'
import type { DaymarkClient, Job } from './types'

export default function ConversationRetry({ job, client }: { job: Job; client: Pick<DaymarkClient, 'retryConversation'> }) {
  const pending = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (job.assistantRunId || !job.conversation || !job.emailPreparationFailed || job.preparing || job.cancelled || job.actions.length || !job.source || !job.source.text && !job.files?.length || !client.retryConversation) return null
  async function retry() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await client.retryConversation!(job._id, job.source!.revision) }
    catch (cause) { setError(connectorErrorMessage(cause)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div><button className="dm-text-button" disabled={busy} onClick={() => void retry()}>{busy ? 'Retrying…' : 'Try again'}</button>{error && <p className="dm-error" role="alert">{error}</p>}</div>
}
