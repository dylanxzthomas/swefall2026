import type { GmailSourceInfo } from './types'
import './gmailSource.css'

export default function GmailSource({ email, timezone }: { email: GmailSourceInfo; timezone: string }) {
  const extraction = email.extraction
  return <section className="dm-gmail-source dm-notice" aria-label="Gmail source details">
    <p><strong>{email.subject}</strong><br /><span className="dm-muted">Gmail · {email.sender}</span></p>
    <p className="dm-muted">Received {new Date(email.receivedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone, timeZoneName: 'short' })}</p>
    {(extraction.incomplete || extraction.truncated) && <p>The email text is incomplete. Check the original message for missing details before approving.</p>}
    <details><summary>Source coverage</summary>
      {extraction.issues.map(issue => <p className="dm-muted" key={issue}>{issue}</p>)}
      {extraction.attachments && <p className="dm-muted">Attachments were not read. Share any needed file separately.</p>}
      <p className="dm-muted">Linked pages were not opened. This is prepared work for your review.</p>
    </details>
  </section>
}
