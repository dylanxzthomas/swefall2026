import { useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { pickupSecret } from '../../../shared/authentication'
import type { CaregiverSignInMethod } from './caregiverSignIn'
import './daymark.css'

type IdentityAccess = { loading: boolean; authenticated: boolean; signIn: (method: CaregiverSignInMethod) => Promise<void> }
export default function CaregiverPage({ identity }: { identity?: IdentityAccess }) {
  const secret = pickupSecret(window.location.hash) ?? ''
  const method = useQuery(api.pickupIdentity.method, secret ? { secret } : 'skip')
  const [session] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''))
  const [verified, setVerified] = useState(false), [sent, setSent] = useState(false), [done, setDone] = useState(''), [error, setError] = useState(''), [code, setCode] = useState(''), [suggestion, setSuggestion] = useState(''), [busy, setBusy] = useState(false)
  const requestCode = useAction(api.pickups.requestCode), verify = useMutation(api.pickups.verify), respond = useMutation(api.pickups.respond), identityRespond = useMutation(api.pickupIdentity.respond)
  const usesIdentity = method?.method === 'identity'
  const codeRequest = useQuery(api.pickups.view, method?.method === 'code' && verified && !done ? { secret, session } : 'skip')
  const identityRequest = useQuery(api.pickupIdentity.view, usesIdentity && identity?.authenticated && !done ? { secret } : 'skip')
  const request = usesIdentity ? identityRequest : codeRequest
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch { setError('This request could not be opened or answered. Check your verified caregiver account, or ask the parent for a current request.') } finally { setBusy(false) } }
  const unavailable = <p>This request changed, expired, or was already answered. Ask the parent for a current request.</p>
  return <div className="dm-app"><header className="dm-header"><h1>Sola</h1><span>Private pickup request</span></header><main>
    {error && <p role="alert" className="dm-error">{error}</p>}
    {done ? <><h2>{done}</h2><p>Your response is recorded. A caregiver’s acceptance does not mean pickup has happened.</p></> : !secret || method === null ? unavailable : method === undefined ? <p role="status">Opening private request…</p> : usesIdentity && !identity ? <p>Secure caregiver sign-in is not configured. Ask the parent to contact you directly.</p> : usesIdentity && identity?.loading ? <p role="status">Verifying sign-in…</p> : usesIdentity && !identity?.authenticated ? <>
      <h2>Open your pickup request</h2><p>You don’t need a Sola household or to install the app. Sign-in creates or uses a secure identity to open only this private request.</p><p>Choose the Google account with the caregiver email invited by the parent, or use email to sign in or create an account.</p>
      <div className="dm-actions"><button className="dm-primary" disabled={busy} onClick={() => void run(async () => { await identity!.signIn('google') })}>Continue with Google</button><button disabled={busy} onClick={() => void run(async () => { await identity!.signIn('email') })}>Use email</button></div>
    </> : !usesIdentity && !verified ? <>
      <h2>Verify your email</h2><p>We’ll send a code to the caregiver email chosen by the parent. It opens only this request.</p>
      <button disabled={busy} onClick={() => void run(async () => { await requestCode({ secret }); setSent(true) })}>Send verification code</button>
      {sent && <><label>Email code<input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label><button className="dm-primary" disabled={busy || code.length !== 6} onClick={() => void run(async () => { if (await verify({ secret, session, code })) setVerified(true); else setError('Code is invalid, expired, or locked after repeated attempts.') })}>View request</button></>}
    </> : request ? <>
      <h2>Pickup for {request.child}</h2><p>{request.date} · {request.time} ({request.timezone})</p><p>{request.location}</p><p>{request.message}</p><p>Response deadline: {request.deadline}</p>
      <label>Suggested change<textarea value={suggestion} onChange={e => setSuggestion(e.target.value)} maxLength={2000} /></label>
      <div className="dm-actions">{(['accept', 'decline', 'suggest'] as const).map(response => <button className={response === 'accept' ? 'dm-primary' : ''} disabled={busy || response === 'suggest' && !suggestion.trim()} key={response} onClick={() => void run(async () => { const args = { secret, response, suggestion: response === 'suggest' ? suggestion : '' }; if (usesIdentity) await identityRespond(args); else await respond({ ...args, session }); setDone(response === 'accept' ? 'You accepted the pickup' : response === 'decline' ? 'You declined the pickup' : 'Change sent to the parent for review') })}>{response === 'accept' ? 'Accept pickup' : response === 'decline' ? 'Can’t do it' : 'Suggest a change'}</button>)}</div>
    </> : request === undefined ? <p role="status">Opening verified request…</p> : <>{usesIdentity && identity ? <><p>This account can’t open the request, or the request is no longer available. Ask the parent for a current request if needed.</p><p>Choose the caregiver email invited by the parent. You don’t need a Sola household or to install the app.</p><div className="dm-actions"><button className="dm-primary" disabled={busy} onClick={() => void run(async () => { await identity.signIn('google') })}>Continue with Google</button><button disabled={busy} onClick={() => void run(async () => { await identity.signIn('email') })}>Use another account</button></div></> : unavailable}</>}
  </main></div>
}
