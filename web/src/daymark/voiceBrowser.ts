import { voiceEvent, voiceLimits, type VoiceSession, type AskSolaVoice, type VoiceToolResult } from '../../../shared/voice'
import { voiceActivity, voiceTranscript, type VoiceActivity, type VoiceCaption } from '../../../shared/voiceTranscript'
export type StartVoice = (sdp: string, requestId: string) => Promise<VoiceSession>
export type StopVoice = (id: string, version: number) => Promise<unknown>
type Dependencies = { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>; peer(): RTCPeerConnection; randomId(): string }
export type VoiceObserver = { captions?(rows: VoiceCaption[]): void; activity?(activity: VoiceActivity): void; playbackBlocked?(): void }
/** Only ask_sola can request private preparation. Provider events cannot approve actions. */
export function voiceConnection(audio: HTMLAudioElement, startSession: StartVoice, stopSession: StopVoice, onCaption: (speaker: 'you' | 'sola', text: string) => void, onState: (state: 'connecting' | 'active' | 'stopped' | 'error') => void, deps: Dependencies = { getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints), peer: () => new RTCPeerConnection(), randomId: () => crypto.randomUUID() }, askSola?: AskSolaVoice, observer: VoiceObserver = {}) {
  let stopped = false, starting = false, peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined, media: MediaStream | undefined, session: VoiceSession | undefined, timer: ReturnType<typeof setTimeout> | undefined, closing: Promise<unknown> | undefined
  const toolsAbort = new AbortController(), calls = new Set<string>()
  const captions = voiceTranscript()
  let responding = false, responseWaiting = false, microphoneMuted = false, input = false, playback = false, audioPlaying = false, working = 0
  const activity = () => { if (!stopped) observer.activity?.(voiceActivity({ input, playback, audioPlaying, responding, working, muted: microphoneMuted })) }
  const play = async () => { if (stopped) return; try { await audio.play(); if (!stopped) { audioPlaying = true; activity() } } catch { if (!stopped) { audioPlaying = false; activity(); observer.playbackBlocked?.() } } }
  const resume = () => { if (stopped || responding || !responseWaiting || channel?.readyState !== 'open') return; responseWaiting = false; responding = true; try { channel.send(JSON.stringify({type:'response.create',response:{tool_choice:'none'}})); activity() } catch { void stop(); onState('error') } }
  const dispatch = async (callId: string, text: string) => {
    if (stopped || !session?.toolsEnabled || !askSola || calls.has(callId) || calls.size >= 50) return
    calls.add(callId)
    working++; activity()
    let result: VoiceToolResult
    if (calls.size > voiceLimits.requestsPerSession) result = {status: 'failed', jobId: '', reviewRequired: false, answer: 'This call reached its request limit. Continue by typing.'}
    else try { result = await askSola(session.id, session.version, callId, text, toolsAbort.signal) } catch { result = {status: 'failed', jobId: '', reviewRequired: false, answer: 'This request could not be checked. Nothing was approved or sent. Review your private conversation before retrying.'} }
    working--; activity()
    if (stopped || toolsAbort.signal.aborted || channel?.readyState !== 'open') return
    try { channel.send(JSON.stringify({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: callId, output: JSON.stringify(result)}}))
    responseWaiting = true; resume() } catch { void stop(); onState('error') }
  }
  const cleanup = () => {
    toolsAbort.abort()
    clearTimeout(timer)
    if (channel) { channel.onmessage = null; channel.onopen = null; channel.onerror = null; channel.close() }
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close() }
    // Remove our handlers before stopping tracks so cleanup cannot reenter itself.
    media?.getAudioTracks().forEach(track => { track.onended = null })
    media?.getTracks().forEach(t => t.stop()); audio.pause(); audio.srcObject = null
  }
  const stop = async () => {
    const wasStopped = stopped; stopped = true; cleanup()
    if (!wasStopped) onState('stopped')
    if (session && !closing) closing = stopSession(session.id, session.version).catch(() => { /* Local microphone is stopped; the backend expiry also closes the call. */ })
    await closing
  }
  const start = async () => {
    if (starting || stopped) return
    starting = true; onState('connecting')
    try {
      media = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (stopped) { media.getTracks().forEach(t => t.stop()); return }
      const microphoneTracks = media.getAudioTracks()
      const ended = () => { if (!stopped) { void stop(); onState('error') } }
      microphoneTracks.forEach(track => { track.enabled = !microphoneMuted; track.onended = ended })
      // Permission/device loss can happen while the permission promise resolves.
      if (microphoneTracks.some(track => track.readyState === 'ended')) { ended(); return }
      peer = deps.peer(); for (const track of media.getAudioTracks()) peer.addTrack(track, media)
      peer.ontrack = event => { if (!stopped && event.streams[0]) { audio.srcObject = event.streams[0]; void play() } }
      peer.onconnectionstatechange = () => { if (!stopped && peer && ['failed', 'disconnected', 'closed'].includes(peer.connectionState)) { void stop(); onState('error') } }
      channel = peer.createDataChannel('oai-events')
      channel.onmessage = event => {
        if (stopped) return
        const parsed = voiceEvent(event.data)
        if (parsed?.kind === 'transcript') {
          const rows = captions.update(parsed)
          if (rows) { observer.captions?.(rows); if (parsed.final !== false) onCaption(parsed.speaker, parsed.text) }
        } else if (parsed?.kind === 'requests') {
          responding = false; for (const request of parsed.requests) void dispatch(request.callId, request.text); resume()
        } else if (parsed?.kind === 'response') { responding = parsed.active; resume() }
        else if (parsed?.kind === 'input') input = parsed.active
        else if (parsed?.kind === 'playback') playback = parsed.active
        else if (parsed?.kind === 'ready') onState('active')
        else if (parsed?.kind === 'error') { void stop(); onState('error') }
        activity()
      }
      channel.onerror = () => { if (!stopped) { void stop(); onState('error') } }
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer)
      if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
        const end = () => { clearTimeout(timeout); peer?.removeEventListener('icegatheringstatechange', check); resolve() }, check = () => { if (peer?.iceGatheringState === 'complete') end() }, timeout = setTimeout(end, 2000)
        peer!.addEventListener('icegatheringstatechange', check)
      })
      if (stopped) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('No audio offer.')
      session = await startSession(sdp, deps.randomId())
      if (stopped) { await stop(); return }
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp })
      const remaining = Math.min(voiceLimits.sessionMs, session.expiresAt - Date.now())
      if (remaining <= 0) { await stop(); return }
      timer = setTimeout(() => void stop(), remaining)
    } catch {
      if (!stopped) { await stop(); onState('error') }
    }
  }
  const mute = (muted: boolean) => { if (!stopped) { microphoneMuted = muted; if (muted) input = false; media?.getAudioTracks().forEach(track => { track.enabled = !muted }); activity() } }
  return { start, stop, mute, play, session: () => session && { id: session.id, version: session.version } }
}
export type DictationResult = { results: { length: number; [index: number]: { 0: { transcript: string }; isFinal: boolean } } }
export type Dictation = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: DictationResult) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start(): void; stop(): void; abort(): void }
export function dictationConstructor(): (new () => Dictation) | undefined {
  const surface = window as unknown as { SpeechRecognition?: new () => Dictation; webkitSpeechRecognition?: new () => Dictation }
  return surface.SpeechRecognition ?? surface.webkitSpeechRecognition
}

/** Client polling stops on leave/expiry. A timeout reports the observed pending state. */
export async function waitForVoiceRequest(submit: () => Promise<{requestId: string}>, read: (requestId: string) => Promise<VoiceToolResult>, signal: AbortSignal, waitMs: number = voiceLimits.toolWaitMs): Promise<VoiceToolResult> {
  const check = () => { if (signal.aborted) throw new DOMException('Voice stopped', 'AbortError') }
  const observed = <T,>(work: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Voice stopped', 'AbortError'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { check(); return work() }).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
  check(); const request = await observed(submit); check()
  const deadline = Date.now() + waitMs
  for (;;) {
    check(); const result = await observed(() => read(request.requestId)); check()
    if (result.status !== 'pending' || Date.now() >= deadline) return result
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Voice stopped', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.min(1000, Math.max(0, deadline - Date.now())))
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }
}
