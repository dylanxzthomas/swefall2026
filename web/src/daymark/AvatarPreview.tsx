import { useState, useSyncExternalStore } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { avatarMoods, type AvatarMood } from '../../../shared/avatar'
import AssistantAvatar from './AssistantAvatar'
import { avatarExpressions } from './avatarExpressions'

const query = '(prefers-reduced-motion: reduce)'
const subscribeMotion = (changed: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener('change', changed)
  return () => media.removeEventListener('change', changed)
}
const reducedMotion = () => window.matchMedia(query).matches

function Expressions({ name }: { name: string }) {
  const [mood, setMood] = useState<AvatarMood>('idle'), [replay, setReplay] = useState(0)
  const reduced = useSyncExternalStore(subscribeMotion, reducedMotion, () => true)
  return <section className="dm-avatar-preview" aria-label="Character preview">
    <div className="dm-avatar-stage"><AssistantAvatar name={name} mood={mood} size={112} animate replay={replay} /></div>
    <p className="dm-avatar-preview-caption"><strong>{avatarExpressions[mood].label}</strong><span>{avatarExpressions[mood].description}</span></p>
    <button type="button" className="dm-avatar-replay" disabled={reduced} onClick={() => setReplay(value => value + 1)}><ArrowCounterClockwise size={16} aria-hidden="true" />Replay animation</button>
    {reduced && <p className="dm-avatar-motion-note">Motion is off in your device settings.</p>}
    <div className="dm-avatar-expression-grid" role="group" aria-label="Expressions">{avatarMoods.map(value => <button type="button" key={value} aria-pressed={mood === value} onClick={() => { setMood(value); setReplay(count => count + 1) }}><AssistantAvatar name={name} mood={value} size={42} /><span>{avatarExpressions[value].label}</span></button>)}</div>
    <p className="dm-avatar-motion-note">Character preview only. Your requests keep their actual status.</p>
  </section>
}

export default function AvatarPreview({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  return <details className="dm-avatar-preview-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>Expressions &amp; motion</summary>{open && <Expressions name={name} />}</details>
}
