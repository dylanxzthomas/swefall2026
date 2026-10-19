import { CalendarBlank, Clock, EnvelopeSimple, MapPin, Paperclip, UsersThree } from '@phosphor-icons/react'
import type { Payload } from '../../../shared/daymark'
import type { DaymarkState } from './types'

export function noticeDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date needed'
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isNaN(date.getTime()) ? 'Date needed' : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
function clock(value: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return 'Time needed'
  const [hour, minute] = value.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}
function deadline(value: string, timezone: string) {
  try { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { timeZone: timezone }) : 'Time needed' }
  catch { return 'Confirm the timezone' }
}
export const artifactKind = (p: Payload) => p.kind === 'email' ? 'Email draft' : p.kind === 'pickup' ? 'Pickup request' : p.operation === 'delete' ? 'Remove event' : p.targetId ? 'Calendar change' : 'New calendar event'

/** Shows the exact proposed content; fields are a separate, optional editing surface. */
export default function ArtifactPreview({ payload: p, state, compact = false }: { payload: Payload; state: DaymarkState; compact?: boolean }) {
  const child = state.household?.children.find(c => c.id === p.childId)?.name ?? 'Choose a child'
  const caregiver = p.kind === 'pickup' ? state.caregivers.find(c => c._id === p.caregiverId) : null
  const Icon = p.kind === 'calendar' ? CalendarBlank : p.kind === 'email' ? EnvelopeSimple : UsersThree
  return <div className={`dm-preview${compact ? ' dm-preview-compact' : ''}`}>
    <div className="dm-preview-kind"><Icon size={17} aria-hidden="true" /><span>{artifactKind(p)}</span><span className="dm-child-tag">{child}</span></div>
    <h3>{p.kind === 'calendar' ? p.title || 'Untitled event' : p.kind === 'email' ? p.subject || 'School email' : `Pickup${caregiver ? ` with ${caregiver.name}` : ' request'}`}</h3>
    {p.kind === 'email' ? <>
      <p className="dm-email-to"><span>To</span> {p.to || 'Choose a recipient'}</p>
      <div className="dm-letter">{p.body || 'Your reply will appear here.'}</div>
      {!!p.attachments?.length && <div className="dm-attachment-list">{p.attachments.map(f => <span key={f.id}><Paperclip size={15} aria-hidden="true" />{f.name}</span>)}</div>}
      {!compact && p.requirement && <p className="dm-notice">{p.requirement}</p>}
    </> : <>
      <div className="dm-event-line"><CalendarBlank size={18} aria-hidden="true" /><span>{noticeDate(p.date)}{p.kind === 'calendar' && p.endDate !== p.date ? ` – ${noticeDate(p.endDate)}` : ''}</span></div>
      <div className="dm-event-line"><Clock size={18} aria-hidden="true" /><span>{p.kind === 'calendar' ? p.allDay ? 'All day' : `${clock(p.startTime)} – ${clock(p.endTime)}` : clock(p.time)}<small>{p.timezone || 'Timezone needed'}</small></span></div>
      <div className="dm-event-line"><MapPin size={18} aria-hidden="true" /><span>{p.location || 'Location not specified'}</span></div>
      {p.kind === 'calendar' ? !compact && p.notes && <details className="dm-event-notes"><summary>Event notes</summary><p>{p.notes}</p></details> : <>
        {!compact && <><p className="dm-email-to"><span>To</span> {caregiver?.email || 'Choose an eligible caregiver'}</p><p className="dm-muted">{state.storage === 'device' ? 'Copy the request and send it yourself' : caregiver?.deliveryChannel === 'app' ? 'In Daymark · chosen by caregiver' : 'Private email with a response link'}</p><div className="dm-letter">{p.message || 'Your pickup request will appear here.'}</div>
          <p className="dm-terms">Reply by {deadline(p.deadline, p.timezone)} · {p.timezone}</p>
          <p className="dm-terms">{p.followUpAt !== undefined ? `One reminder: ${deadline(p.followUpAt, p.timezone)}` : 'No automatic follow-up.'}</p>
          {p.calendarUpdate && <div className="dm-conditional"><p>After {caregiver?.name ?? 'the caregiver'} accepts</p><ArtifactPreview payload={p.calendarUpdate} state={state} /></div>}
        </>}
      </>}
    </>}
  </div>
}
