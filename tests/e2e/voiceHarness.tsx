import { useRef, useState } from 'react'
import { VoiceCallDisplay, VoiceConversation, type VoiceCallSnapshot } from '../../web/src/daymark/VoiceConversation'
import type { VoiceSettings, VoiceToolResult } from '../../shared/voice'
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
type FixtureChannel = { readyState: string; onmessage: ((event: {data:string}) => void) | null; onerror: null; onopen: null; send(text:string):void; close():void }
let channel: FixtureChannel | undefined, stopTrack = () => {}, finish: ((result:VoiceToolResult)=>void) | undefined, lastMessage: FixtureChannel['onmessage'], emitTrack = () => {}
// Only transport is substituted. Production consent, event parser, call state and dispatcher run unchanged.
export default function VoiceHarness() {
  const [records,setRecords] = useState<string[]>([]), [toolsAvailable,setToolsAvailable] = useState(true), [active,setActive] = useState<VoiceSettings['active']>()
  const [owner,setOwner] = useState('synthetic-parent'), [open,setOpen] = useState(false), [call,setCall] = useState<VoiceCallSnapshot | null>(null), [mounted,setMounted] = useState(true)
  const [signedIn,setSignedIn] = useState(() => !new URLSearchParams(location.search).has('signedout'))
  const rejectSignIn = useRef(false)
  const setup = useRef(false)
  const record = (text:string) => setRecords(rows=>[...rows,text])
  if (!setup.current) {
    setup.current = true
    const track = { enabled: true, stop: () => stopTrack() }, media = { getTracks: () => [track], getAudioTracks: () => [track] }
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{record('microphone requested');return media}}})
    HTMLMediaElement.prototype.play = async () => { record('audio playback resumed') }
    HTMLMediaElement.prototype.pause = () => {}
    window.RTCPeerConnection = class {
      localDescription = {sdp}; iceGatheringState = 'complete'; connectionState = 'connected'; ontrack: ((event:{streams:MediaStream[]})=>void) | null = null; onconnectionstatechange = null
      constructor(){ emitTrack = () => this.ontrack?.({streams:[new MediaStream()]}) }
      addTrack(){}; createOffer(){return Promise.resolve({type:'offer',sdp})}; setLocalDescription(){return Promise.resolve()}; setRemoteDescription(){return Promise.resolve()}; close(){}; addEventListener(){}; removeEventListener(){}
      createDataChannel(){channel={readyState:'open',onmessage:null,onerror:null,onopen:null,send:(text:string)=>record(`provider output ${text}`),close:()=>{}};return channel}
    } as unknown as typeof RTCPeerConnection
  }
  stopTrack = () => record('microphone stopped')
  const emit = (event:unknown) => { lastMessage = channel?.onmessage ?? lastMessage; channel?.onmessage?.({data:JSON.stringify(event)}) }
  const request = () => emit({type:'response.done',response:{status:'completed',output:[{type:'function_call',status:'completed',name:'ask_sola',call_id:'synthetic-call',arguments:JSON.stringify({text:'What needs my attention?'})}]}})
  const partial = () => {
    emit({type:'input_audio_buffer.speech_started'})
    emit({type:'conversation.item.input_audio_transcription.delta',event_id:'input-delta-1',item_id:'input-1',content_index:0,delta:'What is '})
    emit({type:'conversation.item.input_audio_transcription.delta',event_id:'input-delta-2',item_id:'input-1',content_index:0,delta:'next?'})
  }
  const final = () => {
    emit({type:'input_audio_buffer.speech_stopped'})
    const event={type:'conversation.item.input_audio_transcription.completed',event_id:'input-final-1',item_id:'input-1',content_index:0,transcript:'What is next for tomorrow?'}
    emit(event); emit(event)
  }
  return <main className="dm-app">
    <p>Synthetic voice bridge · no microphone, model or provider calls</p>
    <section aria-label="Main conversation">{call && <VoiceCallDisplay call={call}/>}</section>
    <button aria-label="Voice" onClick={()=>setOpen(!open)}>Voice</button>
    {mounted && <VoiceConversation ownerKey={signedIn ? owner : undefined} onSignIn={signedIn ? undefined : async () => { record('sign-in requested'); if (rejectSignIn.current) { rejectSignIn.current = false; throw new Error('private synthetic credential failure') }; setSignedIn(true) }} open={open} onOpenChange={setOpen} hideTrigger onCallChange={setCall} settings={signedIn ? {configured:true,toolsAvailable,active,model:'gpt-realtime-2.1'} : undefined} start={async()=>{
      record('voice started');setActive({id:'synthetic-session',version:1,status:'active',expiresAt:Date.now()+600000})
      setTimeout(()=>emit({type:'session.created'}),10)
      return{id:'synthetic-session',version:1,sdp,model:'gpt-realtime-2.1',toolsEnabled:true,expiresAt:Date.now()+600000}
    }} stop={async()=>{record('provider stopped');setActive(undefined)}} ask={async(_id,_version,_callId,text,signal)=>{
      record(`private request ${text}`);signal.addEventListener('abort',()=>record('request wait cancelled'),{once:true})
      return new Promise(resolve=>{finish=resolve})
    }} onTranscript={()=>record('copied to composer')} />}
    <section aria-label="Synthetic voice controls">
      <button onClick={()=>{rejectSignIn.current = true}}>Reject next sign-in</button>
      <button onClick={request}>Simulate spoken household request</button>
      <button onClick={()=>{for(let i=0;i<50;i++)request()}}>Repeat provider event fifty times</button>
      <button onClick={()=>finish?.({status:'complete',jobId:'synthetic-private-job',answer:'Review the permission form in your private conversation. Nothing was sent.',reviewRequired:true})}>Finish synthetic preparation</button>
      <button onClick={partial}>Simulate partial speech</button>
      <button onClick={final}>Finalize speech twice</button>
      <button onClick={()=>{emit({type:'response.created'});emit({type:'response.output_audio_transcript.delta',event_id:'output-delta-1',item_id:'output-1',content_index:0,delta:'Let me check'});emitTrack();emit({type:'output_audio_buffer.started'})}}>Simulate speaking</button>
      <button onClick={()=>{emit({type:'response.output_audio_transcript.done',event_id:'output-final-1',item_id:'output-1',content_index:0,transcript:'Let me check the family plan.'});emit({type:'response.done',response:{status:'completed',output:[]}});emit({type:'output_audio_buffer.stopped'})}}>Finish speaking</button>
      <button onClick={()=>lastMessage?.({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',event_id:'late-1',item_id:'late-1',transcript:'This late text must never appear.'})})}>Send late caption</button>
      <button onClick={()=>setToolsAvailable(false)}>Revoke voice assistance</button>
      <button onClick={()=>setActive(undefined)}>Stop session from another tab</button>
      <button onClick={()=>setOwner('another-synthetic-parent')}>Change signed-in parent</button>
      <button onClick={()=>setMounted(false)}>Unmount voice controls</button>
    </section>
    <ol aria-label="Synthetic voice observations">{records.map((r,i)=><li key={i}>{r}</li>)}</ol>
  </main>
}
