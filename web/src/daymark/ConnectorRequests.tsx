import { useRef, useState } from 'react'
import { connectorRequestSchema } from '../../../shared/connectorRequests'
import type { DaymarkClient, DaymarkState } from './types'
import './connectorRequests.css'

export default function ConnectorRequests({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [service, setService] = useState(''), [outcome, setOutcome] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const pending = useRef(false), requestId = useRef(crypto.randomUUID())
  async function run(operation: () => Promise<unknown>, success: string) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation(); setNotice(success) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'This request could not be saved. Please try again.') }
    finally { pending.current = false; setBusy(false) }
  }
  async function save() {
    const value = connectorRequestSchema.safeParse({ service, outcome })
    if (!value.success) { setError(value.error.issues[0]?.message ?? 'Describe what you need help with.'); return }
    await run(async () => {
      if (!client.createConnectorRequest) throw new Error('Connector requests are not available in this workspace.')
      await client.createConnectorRequest(value.data, requestId.current)
      requestId.current = crypto.randomUUID(); setService(''); setOutcome('')
    }, 'Request saved here. Nothing has been connected or carried out.')
  }
  const requests = (state.connectorRequests ?? []).filter(request => request.status === 'requested')
  return <details className="dm-connector-requests"><summary>Request another connection</summary>
    <p className="dm-muted">Save a request for a service that is not connected yet. This does not connect it or make a booking. {state.storage === 'device' ? 'Your requests stay on this device.' : 'Only you can see these requests.'}</p>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label>Service or app (optional)<input disabled={busy} value={service} maxLength={100} onChange={event => { requestId.current = crypto.randomUUID(); setService(event.target.value) }} placeholder="For example, your activity booking app" /></label>
      <label>What would you like Sola to handle?<textarea disabled={busy} value={outcome} maxLength={2000} rows={3} onChange={event => { requestId.current = crypto.randomUUID(); setOutcome(event.target.value) }} placeholder="Find an available swim lesson and prepare a booking for me to review." /></label>
      <button disabled={busy || !outcome.trim() || !client.createConnectorRequest} type="submit">Save connection request</button>
    </form>
    {!!requests.length && <section className="dm-connector-request-list" aria-label="Saved connection requests">{requests.map(request => <article className="dm-connector-request" key={request.id}>
      <div><h3>{request.service || 'A connection for this task'}</h3><span className="dm-muted">Requested · not connected</span></div>
      <p>{request.outcome}</p>
      <button disabled={busy || !client.dismissConnectorRequest} aria-label={`Dismiss request for ${request.service || 'this task'}`} onClick={() => void run(async () => {
        if (!client.dismissConnectorRequest) throw new Error('Request dismissal is unavailable.')
        await client.dismissConnectorRequest(request.id, request.version)
      }, 'Request dismissed.')}>Dismiss</button>
    </article>)}</section>}
    <p className="dm-muted dm-connector-fallback">Use the service’s own app or website for now.</p>
    {error && <p role="alert" className="dm-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>
}
