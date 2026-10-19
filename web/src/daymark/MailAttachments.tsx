import { useRef, useState } from 'react'
import type { PrivateMailAttachment } from '../../../shared/mailAttachments'
import { connectorErrorMessage } from '../../../shared/connectorErrors'

export function MailAttachments({ messageId, messageVersion, attachments, discover, read }: {
  messageId: string; messageVersion: number; attachments: PrivateMailAttachment[]
  discover?(messageId: string, version: number): Promise<{ incomplete: boolean; count: number }>
  read?(id: string, version: number, descriptorHash: string): Promise<number>
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [discovered, setDiscovered] = useState(false), [incomplete, setIncomplete] = useState(false), pending = useRef(false)
  const rows = attachments.filter(a => a.messageId === messageId && a.expiresAt > Date.now())
  async function run(key: string, work: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true; setBusy(key); setError('')
    try { await work() } catch (e) { setError(connectorErrorMessage(e)) }
    finally { pending.current = false; setBusy('') }
  }
  return <section className="dm-mail-attachments" aria-label="Private email attachments">
    <h3>Attachments</h3>
    {!rows.length && !discovered && <button disabled={!!busy || !discover} onClick={() => void run('discover', async () => { const result = await discover!(messageId, messageVersion); setDiscovered(true); setIncomplete(result.incomplete) })}>{busy === 'discover' ? 'Checking files…' : 'Show attachments'}</button>}
    {discovered && !rows.length && !busy && <p className="dm-muted">No named attachments were available in this message.</p>}
    {incomplete && <p className="dm-mail-issue">Only the first 12 supported MIME file entries can be shown. Other content was not read.</p>}
    {rows.some(r => ['available', 'failed'].includes(r.status)) && <p className="dm-muted">Choose a file to read privately. PDFs and images are sent to the configured AI provider for transcription. Extracted text stays private and expires with this email; the original file is not saved. Nothing is shared or sent.</p>}
    {rows.map(row => <article key={row.id}>
      <p><strong>{row.filename}</strong> <span className="dm-muted">{Math.max(1, Math.ceil(row.size / 1024))} KB</span></p>
      {row.status === 'complete' ? <>
        <p className="dm-muted">{row.extractionMethod === 'model' ? 'AI transcription — check dates, names and numbers against the original.' : 'UTF-8 text read privately.'}</p>
        {row.summary && <p>{row.summary}</p>}
        {row.issues?.map((issue, i) => <p className="dm-mail-issue" key={i}>{issue}</p>)}
        {row.incomplete && !row.issues?.length && <p className="dm-mail-issue">Some attachment content may be missing. Check the original before acting.</p>}
        <details><summary>Read extracted text</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.text}</p></details>
      </> : ['queued', 'running'].includes(row.status) ? <p role="status">{row.status === 'queued' ? 'Waiting to read privately…' : 'Reading privately…'}</p> : <>
        {row.issue && <p className="dm-mail-issue">{row.issue}</p>}
        {(row.status === 'available' || row.retryable) && <button disabled={!!busy || !read} onClick={() => void run(row.id, () => read!(row.id, row.version, row.descriptorHash))}>{busy === row.id ? 'Starting…' : row.retryable ? 'Retry private reading' : 'Read privately'}</button>}
      </>}
    </article>)}
    {error && <p role="alert" className="dm-error">{error}</p>}
  </section>
}
