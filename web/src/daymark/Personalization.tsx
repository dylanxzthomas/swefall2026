import { useState } from 'react'
import { UserCircle } from '@phosphor-icons/react'
import type { DaymarkClient, DaymarkState } from './types'
import { assistantName as displayName, type AssistantAvatar as AvatarChoice } from '../../../shared/persona'
import AssistantAvatar from './AssistantAvatar'
import AvatarPreview from './AvatarPreview'

export default function Personalization({ state, client }: { state: DaymarkState; client: DaymarkClient }) {
  const [parentName, setParentName] = useState(state.preferences?.parentName ?? '')
  const [assistantName, setAssistantName] = useState(displayName(state.preferences))
  const [avatar, setAvatar] = useState<AvatarChoice>(state.preferences?.avatar ?? 'robin')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const save = async () => {
    if (!client.savePreferences || busy) return
    setBusy(true); setMessage(''); setError('')
    try { await client.savePreferences({ parentName: parentName.trim(), assistantName: assistantName.trim(), avatar }); setMessage('Saved. Make yourself at home.') }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <details className="dm-setting-start dm-setting-end">
    <summary><UserCircle size={20} aria-hidden="true" />Your assistant</summary>
    <label>Your name<input autoComplete="given-name" maxLength={60} value={parentName} placeholder="What should I call you?" disabled={busy} onChange={e => { setParentName(e.target.value); setMessage('') }} /></label>
    <label>Assistant name<input maxLength={40} value={assistantName} disabled={busy} onChange={e => { setAssistantName(e.target.value); setMessage('') }} /></label>
    <fieldset className="dm-avatar-options" disabled={busy}><legend>Assistant appearance</legend><div>{(['robin', 'initial'] as const).map(value => <button type="button" key={value} aria-pressed={avatar === value} onClick={() => { setAvatar(value); setMessage('') }}><AssistantAvatar name={assistantName} avatar={value} size={36} /><span>{value === 'robin' ? 'Character' : 'Initial'}</span></button>)}</div></fieldset>
    <button disabled={busy || !client.savePreferences || !assistantName.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save preferences'}</button>
    {message && <p role="status" className="dm-muted">{message}</p>}
    {error && <p role="alert" className="dm-error">{error}</p>}
    {!client.savePreferences && <p className="dm-muted">Personalization is unavailable in this preview.</p>}
    {avatar === 'robin' && <AvatarPreview name={assistantName || displayName()} />}
  </details>
}
