import type { FamilyFact } from '../../../shared/memory'
import type { DaymarkState } from './types'

export function emptyFamilyFact(kind: FamilyFact['kind'], state: DaymarkState): FamilyFact {
  const childId = state.household?.children[0]?.id ?? '', caregiverId = state.caregivers[0]?._id ?? ''
  return kind === 'school' ? { kind, childId, school: '', className: '' } : kind === 'contact' ? { kind, childId, name: '', email: '', role: '' } : kind === 'routine' ? { kind, childId, caregiverId, weekday: 1, time: '', location: '' } : { kind, caregiverId, date: '', start: '', end: '', available: true }
}

export function describeFamilyFact(f: FamilyFact, state: DaymarkState) {
  const child = (id: string) => state.household?.children.find(c => c.id === id)?.name ?? 'Removed child'
  const caregiver = (id: string) => state.caregivers.find(c => c._id === id)?.name ?? 'Removed caregiver'
  return f.kind === 'school' ? [child(f.childId), f.school, f.className].filter(Boolean).join(' · ') : f.kind === 'contact' ? `${child(f.childId)} · ${f.name} · ${f.email}` : f.kind === 'routine' ? `${child(f.childId)} · ${caregiver(f.caregiverId)} · ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][f.weekday]} ${f.time} · ${f.location}` : `${caregiver(f.caregiverId)} · ${f.date} ${f.start}–${f.end} · ${f.available ? 'Available' : 'Unavailable'}`
}

export default function FamilyFactFields({ value, onChange, state, disabled = false }: { value: FamilyFact; onChange(value: FamilyFact): void; state: DaymarkState; disabled?: boolean }) {
  const field = (label: string, key: string, type = 'text') => <label>{label}<input disabled={disabled} type={type} value={String((value as unknown as Record<string, unknown>)[key] ?? '')} onChange={event => onChange({ ...value, [key]: event.target.value })} /></label>
  return <>
    {'childId' in value && <label>Child<select disabled={disabled} value={value.childId} onChange={event => onChange({ ...value, childId: event.target.value })}><option value="">Choose child</option>{state.household?.children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}</select></label>}
    {'childId' in value && !state.household?.children.length && <p className="dm-muted">Add your child in Household before saving this detail.</p>}
    {'caregiverId' in value && <label>Caregiver<select disabled={disabled} value={value.caregiverId} onChange={event => onChange({ ...value, caregiverId: event.target.value })}><option value="">Choose caregiver</option>{state.caregivers.filter(caregiver => !('childId' in value) || caregiver.childIds.includes(value.childId)).map(caregiver => <option key={caregiver._id} value={caregiver._id}>{caregiver.name}</option>)}</select></label>}
    {value.kind === 'school' && <>{field('School', 'school')}{field('Class', 'className')}</>}
    {value.kind === 'contact' && <>{field('Contact name', 'name')}{field('School email', 'email', 'email')}{field('Role', 'role')}</>}
    {value.kind === 'routine' && <><label>Every<select disabled={disabled} value={value.weekday} onChange={event => onChange({ ...value, weekday: Number(event.target.value) })}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, i) => <option key={day} value={i + 1}>{day}</option>)}</select></label>{field('Pickup time', 'time', 'time')}{field('Pickup location', 'location')}<p className="dm-muted">This is a weekly pickup preference, not a confirmed arrangement or permission to send. For one date, save availability instead.</p></>}
    {value.kind === 'availability' && <>{field('Just this date', 'date', 'date')}{field('From', 'start', 'time')}{field('Until', 'end', 'time')}<label>Availability<select disabled={disabled} value={String(value.available)} onChange={event => onChange({ ...value, available: event.target.value === 'true' })}><option value="true">Explicitly available</option><option value="false">Unavailable</option></select></label></>}
    <p className="dm-muted">Times use {state.household?.timezone}.</p>
  </>
}
