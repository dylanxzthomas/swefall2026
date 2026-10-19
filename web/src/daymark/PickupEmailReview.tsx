import { useEffect, useRef, useState } from 'react'
import type { PickupDraft } from '../../../shared/daymark'
import type { PickupEmailReview as Review } from '../../../shared/pickupEmail'
import type { DaymarkClient } from './types'
import { connectorErrorMessage } from '../../../shared/connectorErrors'

export type PickupReviewState = { stamp: string; hash?: string; ready: boolean; error?: string }
export default function PickupEmailReview({ id, revision, payload, stamp, client, changed }: { id: string; revision: number; payload: PickupDraft; stamp: string; client: DaymarkClient; changed(value: PickupReviewState): void }) {
  const refs = useRef({ client, changed }); refs.current = { client, changed }
  const [view, setView] = useState<{ stamp: string; review?: Review; error?: string }>()
  useEffect(() => {
    let active = true
    refs.current.changed({ stamp, ready: false })
    void refs.current.client.reviewPickupEmail?.(id, revision, payload).then(review => {
      if (!active) return
      setView({ stamp, review }); refs.current.changed({ stamp, ready: true, hash: review.hash })
    }).catch(error => {
      if (!active) return
      const message = connectorErrorMessage(error)
      setView({ stamp, error: message }); refs.current.changed({ stamp, ready: false, error: message })
    })
    return () => { active = false }
  }, [id, revision, stamp])
  if (!view || view.stamp !== stamp) return <p className="dm-muted" role="status">Checking how this request will reach the caregiver…</p>
  if (view.error) return <p className="dm-notice" role="alert">{view.error}</p>
  const r = view.review!
  if (r.channel === 'app') return <p className="dm-destination">To: {r.to} · in Daymark. No email will be sent.</p>
  if (r.transport !== 'gmail') return <p className="dm-destination">From: {r.from}<br />To: {r.to} · email verification required.</p>
  return <section aria-label="Caregiver email to approve"><p className="dm-destination">From: {r.from}<br />To: {r.to}</p><strong>{r.subject}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p><p className="dm-muted">The private link opens only this pickup. The caregiver must sign in with the email above before responding.</p>{r.reminder && <details><summary>One reminder · {r.reminder.at}</summary><strong>{r.reminder.subject}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{r.reminder.body}</p></details>}</section>
}
