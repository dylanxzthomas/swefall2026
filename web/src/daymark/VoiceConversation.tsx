import { useEffect, useRef, useState } from 'react'
import { ChatText, Microphone, MicrophoneSlash, PhoneDisconnect, Sparkle, X } from '@phosphor-icons/react'
import { voiceLimits, type VoiceSettings, type AskSolaVoice } from '../../../shared/voice'
import type { VoiceActivity, VoiceCaption } from '../../../shared/voiceTranscript'
import { dictationConstructor, voiceConnection, type Dictation, type StartVoice, type StopVoice } from './voiceBrowser'
import AssistantAvatar from './AssistantAvatar'
import { forgetVoiceConsent, rememberedVoiceConsent, rememberVoiceConsent, voiceConsentKey } from './voiceConsent'
import './voice.css'

export type VoiceCallSnapshot = { id: string; startedAt: number; state: 'connecting' | 'active' | 'stopped' | 'error'; activity: VoiceActivity; view: 'transcript' | 'character'; captions: VoiceCaption[] }
export type { VoiceCaption } from '../../../shared/voiceTranscript'

const callStatus = (call: VoiceCallSnapshot) => {
  if (call.state === 'connecting') return 'Connecting voice…'
  if (call.state === 'error') return 'Voice stopped. You can continue by typing.'
  if (call.state === 'stopped') return 'Voice ended. These captions are temporary.'
  return { listening: 'Microphone is on. Ready when you are.', hearing: 'Listening to you…', thinking: 'Sola is thinking…', speaking: 'Sola is speaking…', working: 'Sola is checking your request…', muted: 'Microphone is muted. You can still hear Sola.' }[call.activity]
}

/** Render in the main chat. This is temporary speech, never an action receipt. */
export function VoiceCallDisplay({ call }: { call: VoiceCallSnapshot }) {
  const active = call.state === 'active', working = active && ['working', 'thinking'].includes(call.activity)
  return <section className="dm-voice-call" aria-label="Voice conversation" data-view={call.view} data-activity={active ? call.activity : 'stopped'}>
    <p className="dm-voice-status" role="status">{callStatus(call)}</p>
    {call.view === 'character' ? <div className="dm-voice-character" aria-label="Sola voice character"><AssistantAvatar name="Sola" size={104} mood={working ? 'working' : active && call.activity === 'hearing' ? 'listening' : 'idle'} /><span className="dm-voice-character-ring" aria-hidden="true" /></div> : <div className="dm-voice-captions" role="log" aria-label="Temporary call captions" aria-live="off">
      {call.captions.map(caption => <div key={caption.id} className={`dm-voice-caption dm-voice-caption-${caption.speaker}`} data-final={caption.final}><span className="dm-voice-speaker">{caption.speaker === 'you' ? 'You' : 'Sola'}</span><p>{caption.text}{!caption.final && <span className="dm-voice-partial"> {active ? '…' : '(partial)'}</span>}</p></div>)}
      {!call.captions.length && <p className="dm-voice-empty">Your conversation will appear here as you speak.</p>}
    </div>}
  </section>
}

type Props = { ownerKey?: string; settings?: VoiceSettings; start?: StartVoice; stop?: StopVoice; ask?: AskSolaVoice; onTranscript(text: string): void; onSignIn?(): Promise<void>; replyToSpeak?: string; open?: boolean; onOpenChange?(open: boolean): void; hideTrigger?: boolean; onCallChange?(call: VoiceCallSnapshot | null): void }
export function VoiceConversation({ ownerKey, settings, start, stop, ask, onTranscript, onSignIn, replyToSpeak = '', open: controlledOpen, onOpenChange, hideTrigger = false, onCallChange }: Props) {
  const [localOpen, setLocalOpen] = useState(false), open = controlledOpen ?? localOpen
  const [consent, setConsent] = useState(false), [dictationConsent, setDictationConsent] = useState(false), [state, setState] = useState<'idle' | VoiceCallSnapshot['state']>('idle'), [listening, setListening] = useState(false), [transcript, setTranscript] = useState(''), [call, setCall] = useState<VoiceCallSnapshot | null>(null), [error, setError] = useState(''), [supported, setSupported] = useState({ dictation: false, realtime: false, speech: false }), [muted, setMuted] = useState(false), [playbackBlocked, setPlaybackBlocked] = useState(false)
  const audio = useRef<HTMLAudioElement>(null), live = useRef<ReturnType<typeof voiceConnection>>(), recognition = useRef<Dictation>(), dictationTimer = useRef<ReturnType<typeof setTimeout>>(), alive = useRef(true), generation = useRef(0), callOwner = useRef(ownerKey)
  const observedSession = useRef<VoiceSettings['active']>(), notify = useRef(onCallChange)
  const [signingIn, setSigningIn] = useState(false)
  const consentKey = ownerKey ? voiceConsentKey(ownerKey, !!(settings?.toolsAvailable && ask)) : ''
  const [consentFor, setConsentFor] = useState(''), [loadedConsentFor, setLoadedConsentFor] = useState('')
  const autoStarted = useRef(false)
  notify.current = onCallChange
  const setOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next) }
  useEffect(() => { setSupported({ dictation: !!dictationConstructor(), realtime: !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined', speech: 'speechSynthesis' in window }) }, [])
  useEffect(() => { notify.current?.(callOwner.current === ownerKey ? call : null) }, [call, ownerKey])
  const stopDictation = () => { clearTimeout(dictationTimer.current); const r = recognition.current; recognition.current = undefined; if (r) { r.onresult = null; r.onerror = null; r.onend = null; r.abort() }; if (alive.current) setListening(false) }
  const stopAll = () => { generation.current++; stopDictation(); const connection = live.current; live.current = undefined; void connection?.stop(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); if (alive.current) { setMuted(false); setState('stopped'); setCall(value => value ? { ...value, state: 'stopped' } : value) } }
  const clearCall = () => { stopAll(); setCall(null); notify.current?.(null); setDictationConsent(false); setTranscript(''); setError(''); setPlaybackBlocked(false) }
  useEffect(() => {
    let current = true
    setConsent(false); setConsentFor(''); setLoadedConsentFor('')
    if (consentKey) void rememberedVoiceConsent(consentKey).then(accepted => {
      if (current) { setConsent(accepted); setConsentFor(consentKey); setLoadedConsentFor(consentKey) }
    })
    return () => { current = false }
  }, [consentKey])
  useEffect(() => {
    alive.current = true
    const hide = () => { if (document.visibilityState === 'hidden') { clearCall(); setOpen(false) } }, leave = () => { clearCall(); setOpen(false) }
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', leave)
    return () => { alive.current = false; stopAll(); notify.current?.(null); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave) }
  }, [ownerKey])
  useEffect(() => { const changed = callOwner.current !== ownerKey; clearCall(); callOwner.current = ownerKey; setState('idle'); if (changed) setOpen(false) }, [ownerKey])
  useEffect(() => { clearCall() }, [settings?.toolsAvailable])
  useEffect(() => { if (!open) clearCall() }, [open])
  useEffect(() => {
    const previous = observedSession.current, current = live.current?.session()
    observedSession.current = settings?.active
    if (current && previous?.id === current.id && previous.version === current.version && (settings?.active?.id !== current.id || settings.active.version !== current.version)) clearCall()
  }, [settings?.active?.id, settings?.active?.version])
  useEffect(() => { if (!ownerKey || settings?.configured === false) clearCall() }, [ownerKey, settings?.configured])
  function dictate() {
    if (!dictationConsent || listening || state === 'active' || state === 'connecting') return
    const Constructor = dictationConstructor(); if (!Constructor) { setError('Dictation is unavailable here. Type a message or use your keyboard’s microphone.'); return }
    stopAll(); setError(''); setTranscript('')
    const r = new Constructor(); recognition.current = r; r.lang = navigator.language || 'en-US'; r.continuous = false; r.interimResults = true
    r.onresult = event => { if (!alive.current || recognition.current !== r) return; const parts = []; for (let i = 0; i < event.results.length; i++) parts.push(event.results[i][0].transcript); setTranscript(parts.join(' ').slice(0, voiceLimits.transcriptCharacters)) }
    r.onerror = () => { stopDictation(); if (alive.current) setError('Dictation could not hear you. Check microphone permission or type your message.') }
    r.onend = () => { if (alive.current) setListening(false); clearTimeout(dictationTimer.current); recognition.current = undefined }
    try { r.start(); setListening(true); dictationTimer.current = setTimeout(stopDictation, 60000) } catch { stopDictation(); setError('Dictation could not start. Type a message or use your keyboard’s microphone.') }
  }
  function talk(acceptedNow = false) {
    if (!open || !ownerKey || !settings?.configured || !(acceptedNow || consent && consentFor === consentKey) || !start || !stop || !audio.current || ['connecting', 'active'].includes(state)) return
    stopAll(); setError(''); setTranscript(''); setMuted(false); setPlaybackBlocked(false)
    const current = ++generation.current, permitted = () => alive.current && generation.current === current
    callOwner.current = ownerKey
    setCall({ id: crypto.randomUUID(), startedAt: Date.now(), state: 'connecting', activity: 'listening', view: 'transcript', captions: [] })
    live.current = voiceConnection(audio.current, start, stop, () => {}, next => {
      if (!permitted()) return
      setState(next); setCall(value => value ? { ...value, state: next } : value)
      if (next === 'stopped' || next === 'error') setMuted(false)
      if (next === 'error') setError('Voice stopped. Check microphone access or continue by typing.')
    }, undefined, ask, {
      captions: captions => { if (permitted()) setCall(value => value ? { ...value, captions } : value) },
      activity: activity => { if (permitted()) setCall(value => value && value.activity !== activity ? { ...value, activity } : value) },
      playbackBlocked: () => { if (permitted()) setPlaybackBlocked(true) },
    })
    void live.current.start()
  }
  useEffect(() => {
    if (!open) { autoStarted.current = false; return }
    if (autoStarted.current || !consentKey || loadedConsentFor !== consentKey || consentFor !== consentKey || !consent || !settings?.configured || !supported.realtime || !start || !stop) return
    autoStarted.current = true
    talk()
  }, [open, consentKey, loadedConsentFor, consentFor, consent, settings?.configured, supported.realtime, start, stop])
  const acceptAndTalk = () => {
    autoStarted.current = true; setConsent(true); setConsentFor(consentKey)
    void rememberVoiceConsent(consentKey).catch(() => { if (alive.current) setError('Voice can work for this call, but this device could not remember your choice.') })
    talk(true)
  }
  function speak() {
    if (!supported.speech || !replyToSpeak.trim()) return
    window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(replyToSpeak.slice(0, 8000)); utterance.lang = navigator.language || 'en-US'; window.speechSynthesis.speak(utterance)
  }
  const active = state === 'connecting' || state === 'active', currentCall = callOwner.current === ownerKey ? call : null
  const viewButton = currentCall && <button type="button" aria-label={currentCall.view === 'character' ? 'Show transcript' : 'Show character'} onClick={() => setCall(value => value ? { ...value, view: value.view === 'transcript' ? 'character' : 'transcript' } : value)}>{currentCall.view === 'character' ? <ChatText size={21} aria-hidden="true" /> : <Sparkle size={21} aria-hidden="true" />}<span>{currentCall.view === 'character' ? 'Transcript' : 'Character'}</span></button>
  return <section className="dm-voice" aria-label="Voice options">
    {!hideTrigger && <button className="dm-voice-trigger" type="button" aria-label="Voice" aria-expanded={open} onClick={() => setOpen(!open)}><Microphone size={20} aria-hidden="true" /></button>}
    {open && <div className="dm-voice-options">
      <div className="dm-voice-heading"><span>{active ? 'Live voice' : 'Voice'}</span><button type="button" aria-label="Close voice" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>
      {currentCall && !onCallChange && <VoiceCallDisplay call={currentCall} />}
      {active ? <div className="dm-voice-controls">
        <button type="button" aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { live.current?.mute(!muted); setMuted(!muted) }}>{muted ? <MicrophoneSlash size={21} aria-hidden="true" /> : <Microphone size={21} aria-hidden="true" />}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
        {viewButton}
        <button className="dm-voice-end" type="button" aria-label="Stop voice" onClick={stopAll}><PhoneDisconnect size={21} aria-hidden="true" /><span>End</span></button>
        {playbackBlocked && <button type="button" onClick={() => { setPlaybackBlocked(false); void live.current?.play() }}>Play voice audio</button>}
      </div> : <>
        {currentCall && <div className="dm-voice-controls dm-voice-ended-controls">{viewButton}</div>}
        {!active && settings?.active && stop && <button type="button" onClick={() => void stop(settings.active!.id, settings.active!.version).catch(() => setError('The earlier session could not be stopped yet. Retry, or wait for its automatic expiry.'))}>Stop earlier voice session</button>}
        {!!ownerKey && settings?.configured && supported.realtime && start && stop ? <>
          {loadedConsentFor !== consentKey ? <p className="dm-muted" role="status">Getting voice ready…</p> : <>
          {!(consent && consentFor === consentKey) && <p className="dm-voice-privacy dm-voice-disclosure">Live voice sends microphone audio to OpenAI. {settings.toolsAvailable && ask ? 'Household requests use Anthropic and stay private for up to 30 days; relevant results go to OpenAI for speech. ' : ''}Sola saves no raw audio. Your choice is remembered on this device; actions still need review.</p>}
          <button className="dm-primary" type="button" disabled={listening} onClick={() => consent && consentFor === consentKey ? talk() : acceptAndTalk()}>{consent && consentFor === consentKey ? 'Try voice again' : 'Start voice'}</button>
          </>}
          <details className="dm-voice-privacy-details"><summary>Voice privacy</summary>
            <p className="dm-voice-privacy">Audio goes to OpenAI; Sola stores no raw audio. Calls end after ten minutes or when you leave. Mute pauses your microphone; End stops capture. Requests already submitted may finish privately.</p>
            {settings.toolsAvailable && ask && <p className="dm-voice-privacy">Household requests use your permitted context and connections, are processed by Anthropic, and are saved as private text for up to 30 days. Relevant results go to OpenAI to speak the answer. General captions are kept only temporarily in this open conversation.</p>}
            <p className="dm-voice-privacy">Providers have their own processing and retention policies. AI speech can make mistakes. Sending or changing anything still needs exact review in the app.</p>
            {consent && consentFor === consentKey && <button type="button" onClick={() => { clearCall(); setConsent(false); autoStarted.current = true; void forgetVoiceConsent(consentKey).catch(() => setError('Your voice choice could not be cleared on this device. Try again.')) }}>Ask before starting voice</button>}
          </details>
        </> : onSignIn ? <>
          <p className="dm-muted">Sign in on this device to use Sola’s live AI voice. Your local work stays on this device.</p>
          <button className="dm-primary" type="button" disabled={signingIn} onClick={() => {
            if (signingIn) return
            setError(''); setSigningIn(true)
            void onSignIn().catch(() => { if (alive.current) setError('Sign-in could not start. Your local work is still here. Try again from Household.') }).finally(() => { if (alive.current) setSigningIn(false) })
          }}>{signingIn ? 'Opening sign-in…' : 'Sign in for live voice'}</button>
        </> : <p className="dm-muted">Live voice needs a signed-in account, a supported microphone connection and the separately configured voice provider.</p>}
        <details className="dm-voice-alternatives"><summary>Dictation and reading aloud</summary>
          <p className="dm-muted">These use device speech tools. Reading a saved reply aloud does not start a live AI conversation.</p>
          {supported.dictation ? <><label className="dm-check"><input type="checkbox" checked={dictationConsent} disabled={listening} onChange={e => setDictationConsent(e.target.checked)} />Allow microphone dictation through this device’s speech service. Its provider may process audio.</label><button type="button" disabled={!dictationConsent} onClick={listening ? stopDictation : dictate}>{listening ? 'Stop dictation' : 'Dictate a message'}</button></> : <p className="dm-muted">Dictation is unavailable in this browser. You can type or use your keyboard’s microphone.</p>}
          {transcript && <><label>Edit before using<textarea value={transcript} maxLength={voiceLimits.transcriptCharacters} rows={3} onChange={e => setTranscript(e.target.value)} /></label><button type="button" disabled={listening || !transcript.trim()} onClick={() => { onTranscript(transcript.trim()); setOpen(false); clearCall() }}>Use in message</button><p className="dm-muted">Moves these words into your composer. It does not send them.</p></>}
          {supported.speech && replyToSpeak.trim() && <div className="dm-actions"><button type="button" disabled={listening} onClick={speak}>Read latest reply aloud</button><button type="button" onClick={() => window.speechSynthesis.cancel()}>Stop reading</button></div>}
        </details>
      </>}
      {error && <p role="alert" className="dm-error">{error}</p>}
    </div>}
    <audio ref={audio} autoPlay aria-label="Sola live voice audio" />
  </section>
}
