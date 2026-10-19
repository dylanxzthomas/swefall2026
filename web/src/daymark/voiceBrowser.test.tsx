import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { voiceConnection, waitForVoiceRequest } from './voiceBrowser'
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function fixture(ask?: Parameters<typeof voiceConnection>[6]) {
  const track = { stop: vi.fn(), enabled: true, onended: null as (() => void) | null, readyState: 'live' as MediaStreamTrackState }, media = { getTracks: () => [track], getAudioTracks: () => [track] }, channel: any = { close: vi.fn(), onmessage: null, onopen: null, onerror: null, readyState: 'open', send: vi.fn() }
  const peer: any = { addTrack: vi.fn(), createDataChannel: () => channel, createOffer: async () => ({ type: 'offer', sdp }), setLocalDescription: async () => {}, localDescription: { sdp }, setRemoteDescription: vi.fn(async () => {}), iceGatheringState: 'complete', close: vi.fn(), ontrack: null, onconnectionstatechange: null, connectionState: 'connected' }
  const audio: any = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null }, start = vi.fn(async () => ({ id: 'session', version: 1, sdp, model: 'gpt-realtime-2.1', expiresAt: Date.now() + 10000, toolsEnabled: !!ask })), stop = vi.fn(async () => {}), caption = vi.fn(), state = vi.fn(), microphone = vi.fn(async () => media as any)
  const observer = { captions: vi.fn(), activity: vi.fn(), playbackBlocked: vi.fn() }
  const connection = voiceConnection(audio, start, stop, caption, state, { getUserMedia: microphone, peer: () => peer, randomId: () => 'synthetic-request' }, ask, observer)
  return { connection, start, stop, caption, state, peer, channel, audio, track, microphone, observer }
}
it('starts microphone only on demand, connects actual SDP and handles only captions/lifecycle', async () => {
  const f = fixture(); expect(f.microphone).not.toHaveBeenCalled(); await f.connection.start()
  expect(f.start).toHaveBeenCalledWith(sdp, 'synthetic-request')
  expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp })
  f.channel.onmessage({ data: JSON.stringify({ type: 'session.created' }) })
  f.channel.onmessage({ data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'send_email', arguments: '{"approved":true}' }) })
  expect(f.caption).not.toHaveBeenCalled()
  f.channel.onmessage({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Plan dinner' }) })
  expect(f.caption).toHaveBeenCalledWith('you', 'Plan dinner')
  expect(f.state).toHaveBeenLastCalledWith('active')
  await f.connection.stop(); await f.connection.stop()
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalled(); expect(f.peer.close).toHaveBeenCalled(); expect(f.audio.srcObject).toBeNull()
})
it('stops local audio and closes a provider session that returns after the user cancelled', async () => {
  const f = fixture(); let finish!: (value: Awaited<ReturnType<typeof f.start>>) => void
  f.start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.connection.start(); for (let i = 0; i < 6; i++) await Promise.resolve()
  expect(f.start).toHaveBeenCalledOnce(); await f.connection.stop(); expect(f.track.stop).toHaveBeenCalled()
  finish({ id: 'late-session', version: 1, sdp, model: 'gpt-realtime-2.1', expiresAt: Date.now() + 10000, toolsEnabled: false }); await pending
  expect(f.stop).toHaveBeenCalledWith('late-session', 1)
  expect(f.peer.setRemoteDescription).not.toHaveBeenCalled()
})
it('does not create a paid provider call when microphone permission is denied', async () => {
  const f = fixture(); f.microphone.mockRejectedValue(new Error('permission denied')); await f.connection.start()
  expect(f.start).not.toHaveBeenCalled(); expect(f.state).toHaveBeenLastCalledWith('error')
})
it('automatically stops capture and provider work at its bounded expiry', async () => {
  const f = fixture(); await f.connection.start(); await vi.advanceTimersByTimeAsync(10001)
  expect(f.track.stop).toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledWith('session', 1); expect(f.state).toHaveBeenLastCalledWith('stopped')
})
it('mutes and unmutes the actual microphone track while leaving received audio playing',async()=>{
  const f=fixture();await f.connection.start();f.audio.pause.mockClear()
  f.connection.mute(true);expect(f.track.enabled).toBe(false);expect(f.audio.pause).not.toHaveBeenCalled()
  f.connection.mute(false);expect(f.track.enabled).toBe(true)
  expect(f.track.stop).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();expect(f.state).not.toHaveBeenCalledWith('error')
  // Even a platform that emits ended on stop must not recursively close the call.
  f.track.stop.mockImplementation(()=>f.track.onended?.())
  await f.connection.stop();f.connection.mute(true);expect(f.track.enabled).toBe(true);expect(f.track.stop).toHaveBeenCalled()
  expect(f.track.onended).toBeNull();expect(f.stop).toHaveBeenCalledOnce();expect(f.state).not.toHaveBeenCalledWith('error')
})
it('honors a mute selected while the microphone permission prompt is still open',async()=>{
  const f=fixture();let permit!:(media:MediaStream)=>void
  f.microphone.mockImplementation(()=>new Promise(resolve=>{permit=resolve}))
  const connecting=f.connection.start();f.connection.mute(true)
  permit({getTracks:()=>[f.track],getAudioTracks:()=>[f.track]} as unknown as MediaStream);await connecting
  expect(f.track.enabled).toBe(false);await f.connection.stop()
})
it('cleans up on connection failure without showing raw provider errors', async () => {
  const f = fixture(); await f.connection.start(); f.channel.onmessage({ data: JSON.stringify({ type: 'error', error: { message: 'private provider body' } }) })
  await Promise.resolve(); expect(f.track.stop).toHaveBeenCalled(); expect(f.state).toHaveBeenLastCalledWith('error'); expect(f.caption).not.toHaveBeenCalled()
})

const toolEvent = (callId = 'call_1', text = 'Check my inbox') => ({ data: JSON.stringify({type:'response.done',response:{status:'completed',output:[{type:'function_call',status:'completed',name:'ask_sola',call_id:callId,arguments:JSON.stringify({text})}]}}) })
it('bridges only observed completed Sola results and coalesces 50 repeated provider events',async()=>{
  let finish!: (result:any)=>void
  const ask=vi.fn((_id:string,_version:number,_callId:string,_text:string,_signal:AbortSignal)=>new Promise<any>(resolve=>{finish=resolve})),f=fixture(ask)
  await f.connection.start()
  for(let i=0;i<50;i++)f.channel.onmessage(toolEvent())
  expect(ask).toHaveBeenCalledOnce();expect(f.channel.send).not.toHaveBeenCalled()
  finish({status:'complete',jobId:'private-job',reviewRequired:true,answer:'I prepared a private draft. Review it in the app.'})
  for(let i=0;i<5;i++)await Promise.resolve()
  expect(f.channel.send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.channel.send.mock.calls[0][0])).toMatchObject({type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_1'}})
  const result=JSON.parse(JSON.parse(f.channel.send.mock.calls[0][0]).item.output)
  expect(result).toMatchObject({status:'complete',reviewRequired:true,answer:'I prepared a private draft. Review it in the app.'})
  expect(JSON.parse(f.channel.send.mock.calls[1][0])).toEqual({type:'response.create',response:{tool_choice:'none'}})
  await f.connection.stop()
})
it('aborts pending request waiting and never speaks a late result after stop or session expiry',async()=>{
  for(const mode of ['stop','expiry']){
    let finish!:(result:any)=>void
    const ask=vi.fn((_id:string,_version:number,_callId:string,_text:string,_signal:AbortSignal)=>new Promise<any>(resolve=>{finish=resolve})),f=fixture(ask)
    await f.connection.start();f.channel.onmessage(toolEvent())
    const signal=ask.mock.calls[0][4] as AbortSignal
    if(mode==='stop')await f.connection.stop();else await vi.advanceTimersByTimeAsync(10001)
    expect(signal.aborted).toBe(true)
    finish({status:'complete',jobId:'late',answer:'Private late answer',reviewRequired:false})
    for(let i=0;i<5;i++)await Promise.resolve()
    expect(f.channel.send).not.toHaveBeenCalled()
  }
})
it('does not grant tools to an audio-only session or dispatch arbitrary writes',async()=>{
  const f=fixture();await f.connection.start();f.channel.onmessage(toolEvent());expect(f.channel.send).not.toHaveBeenCalled();await f.connection.stop()
  const ask=vi.fn(async()=>({status:'complete' as const,jobId:'job',answer:'Current answer',reviewRequired:false})),g=fixture(ask);await g.connection.start()
  g.channel.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'send_email',call_id:'bad',arguments:'{"approved":true}'})})
  expect(ask).not.toHaveBeenCalled();await g.connection.stop()
})
it('polls observed pending preparation without reporting it as completed and cancels promptly',async()=>{
  const control=new AbortController(),submit=vi.fn(async()=>({requestId:'request'})),read=vi.fn(async()=>({status:'pending' as const,jobId:'job',reviewRequired:false}))
  const pending=waitForVoiceRequest(submit,read,control.signal,2000)
  await vi.advanceTimersByTimeAsync(2001)
  expect(await pending).toEqual({status:'pending',jobId:'job',reviewRequired:false});expect(submit).toHaveBeenCalledOnce()
  const stopped=new AbortController(),waiting=waitForVoiceRequest(submit,read,stopped.signal)
  const rejected=expect(waiting).rejects.toThrow('Voice stopped')
  await vi.advanceTimersByTimeAsync(1);stopped.abort();await rejected
})

it('stops waiting immediately even when a request or result transport never resolves',async()=>{
  for(const mode of ['submit','result']){
    const controller=new AbortController(),never=()=>new Promise<any>(()=>{}),submit=mode==='submit'?never:async()=>({requestId:'request'}),read=mode==='result'?never:async()=>({status:'pending' as const,jobId:'job',reviewRequired:false})
    const waiting=waitForVoiceRequest(submit,read,controller.signal),rejected=expect(waiting).rejects.toThrow('Voice stopped')
    for(let i=0;i<5;i++)await Promise.resolve()
    controller.abort();await rejected
  }
})

it('stops polling after access is revoked and never treats the last pending result as completed',async()=>{
  const controller=new AbortController(),submit=vi.fn(async()=>({requestId:'request'})),read=vi.fn().mockResolvedValueOnce({status:'pending',jobId:'job',reviewRequired:false}).mockRejectedValue(new Error('This private voice request is unavailable.'))
  const waiting=waitForVoiceRequest(submit,read,controller.signal),rejected=expect(waiting).rejects.toThrow('unavailable')
  await vi.advanceTimersByTimeAsync(1000);await rejected
  await vi.advanceTimersByTimeAsync(5000)
  expect(read).toHaveBeenCalledTimes(2)
})

it('queues spoken tool results until an overlapping model response finishes',async()=>{
  let finish!:(result:any)=>void
  const ask=vi.fn((_id:string,_version:number,_callId:string,_text:string,_signal:AbortSignal)=>new Promise<any>(resolve=>{finish=resolve})),f=fixture(ask)
  await f.connection.start();f.channel.onmessage(toolEvent())
  f.channel.onmessage({data:JSON.stringify({type:'response.created',response:{id:'overlap'}})})
  finish({status:'complete',jobId:'job',answer:'Observed answer',reviewRequired:false})
  for(let i=0;i<5;i++)await Promise.resolve()
  expect(f.channel.send).toHaveBeenCalledTimes(1)
  f.channel.onmessage({data:JSON.stringify({type:'response.done',response:{status:'completed',output:[]}})})
  expect(f.channel.send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.channel.send.mock.calls[1][0])).toEqual({type:'response.create',response:{tool_choice:'none'}})
  await f.connection.stop()
})

it('streams caption deltas into one row, deduplicates finals and ignores queued messages after stop', async () => {
  const f = fixture(); await f.connection.start()
  const emit = (type: string, data: Record<string, unknown>) => f.channel.onmessage({ data: JSON.stringify({ type, item_id: 'utterance', content_index: 0, ...data }) })
  emit('conversation.item.input_audio_transcription.delta', { event_id: 'e1', delta: 'Please ' })
  emit('conversation.item.input_audio_transcription.delta', { event_id: 'e2', delta: 'help' })
  expect(f.caption).not.toHaveBeenCalled()
  expect(f.observer.captions).toHaveBeenLastCalledWith([expect.objectContaining({ text: 'Please help', final: false })])
  emit('conversation.item.input_audio_transcription.completed', { event_id: 'e3', transcript: 'Please help.' })
  emit('conversation.item.input_audio_transcription.completed', { event_id: 'e4', transcript: 'Please help.' })
  expect(f.caption).toHaveBeenCalledExactlyOnceWith('you', 'Please help.')
  const late = f.channel.onmessage; await f.connection.stop(); f.observer.captions.mockClear(); f.observer.activity.mockClear()
  late({ data: JSON.stringify({ type: 'response.output_audio_transcript.delta', item_id: 'late', delta: 'Private late answer' }) })
  expect(f.observer.captions).not.toHaveBeenCalled(); expect(f.observer.activity).not.toHaveBeenCalled()
})

it('shows speaking only after actual output-buffer activity and successful playback, then clears on interruption', async () => {
  const f = fixture(); await f.connection.start()
  const emit = (type: string) => f.channel.onmessage({ data: JSON.stringify({ type }) })
  emit('response.created'); expect(f.observer.activity).toHaveBeenLastCalledWith('thinking')
  emit('output_audio_buffer.started'); expect(f.observer.activity).toHaveBeenLastCalledWith('thinking')
  f.audio.play.mockRejectedValueOnce(new Error('Autoplay blocked')); f.peer.ontrack({ streams: [{}] }); await Promise.resolve(); await Promise.resolve()
  expect(f.observer.playbackBlocked).toHaveBeenCalledOnce(); expect(f.observer.activity).not.toHaveBeenCalledWith('speaking')
  await f.connection.play(); expect(f.observer.activity).toHaveBeenLastCalledWith('speaking')
  f.channel.onmessage({ data: JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [] } }) })
  expect(f.observer.activity).toHaveBeenLastCalledWith('speaking')
  emit('output_audio_buffer.cleared'); emit('input_audio_buffer.speech_started'); expect(f.observer.activity).toHaveBeenLastCalledWith('hearing')
  f.connection.mute(true); expect(f.observer.activity).toHaveBeenLastCalledWith('muted')
  await f.connection.stop()
})

it('ends the call immediately on microphone loss, aborts private waits and suppresses queued events',async()=>{
  let finish!:(result:any)=>void
  const ask=vi.fn((_id:string,_version:number,_callId:string,_text:string,_signal:AbortSignal)=>new Promise<any>(resolve=>{finish=resolve})),f=fixture(ask)
  await f.connection.start();f.channel.onmessage({data:JSON.stringify({type:'session.created'})});f.channel.onmessage(toolEvent())
  const signal=ask.mock.calls[0][4],ended=f.track.onended!,message=f.channel.onmessage
  f.track.readyState='ended';ended()
  expect(f.track.onended).toBeNull();expect(f.track.stop).toHaveBeenCalledOnce();expect(f.stop).toHaveBeenCalledExactlyOnceWith('session',1)
  expect(f.peer.close).toHaveBeenCalledOnce();expect(f.audio.pause).toHaveBeenCalled();expect(f.audio.srcObject).toBeNull();expect(signal.aborted).toBe(true)
  expect(f.state).toHaveBeenLastCalledWith('error')
  const states=f.state.mock.calls.length;f.observer.captions.mockClear();f.observer.activity.mockClear()
  ended();message({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'Late speech'})})
  finish({status:'complete',jobId:'late',reviewRequired:true,answer:'Late private result'})
  for(let i=0;i<5;i++)await Promise.resolve()
  await vi.advanceTimersByTimeAsync(10001)
  expect(f.state).toHaveBeenCalledTimes(states);expect(f.stop).toHaveBeenCalledOnce();expect(f.track.stop).toHaveBeenCalledOnce()
  expect(f.channel.send).not.toHaveBeenCalled();expect(f.observer.captions).not.toHaveBeenCalled();expect(f.observer.activity).not.toHaveBeenCalled()
})

it('closes a provider call returned after microphone access ends during setup without reconnecting',async()=>{
  const f=fixture();let finish!:(value:Awaited<ReturnType<typeof f.start>>)=>void
  f.start.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const pending=f.connection.start();for(let i=0;i<6;i++)await Promise.resolve()
  expect(f.start).toHaveBeenCalledOnce();f.track.onended!()
  expect(f.state).toHaveBeenLastCalledWith('error');expect(f.track.onended).toBeNull()
  finish({id:'late-after-revoke',version:2,sdp,model:'gpt-realtime-2.1',expiresAt:Date.now()+10000,toolsEnabled:false});await pending
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('late-after-revoke',2);expect(f.peer.setRemoteDescription).not.toHaveBeenCalled()
  expect(f.state).toHaveBeenLastCalledWith('error')
})

it('does not create a provider session when permission returns an already-ended microphone',async()=>{
  const f=fixture();f.track.readyState='ended';await f.connection.start()
  expect(f.start).not.toHaveBeenCalled();expect(f.peer.addTrack).not.toHaveBeenCalled();expect(f.track.stop).toHaveBeenCalledOnce()
  expect(f.track.onended).toBeNull();expect(f.state).toHaveBeenLastCalledWith('error')
})
