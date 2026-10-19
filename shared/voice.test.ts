import { expect, it } from 'vitest'
import { validVoiceOffer, voiceCallId, voiceConfiguration, voiceEvent, voiceLimits, voiceModel } from './voice.js'
it('accepts bounded audio SDP but rejects URLs, missing audio, controls and oversized offers', () => {
  expect(validVoiceOffer('v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toBe(true)
  for (const value of ['https://attacker.test/offer', 'v=0\nm=video 9 RTP', 'v=0\nm=audio 9 RTP\u0000', 'v=0\nm=audio ' + 'a'.repeat(voiceLimits.sdpCharacters)]) expect(validVoiceOffer(value)).toBe(false)
})
it('accepts only trusted provider call locations and rejects browser-chosen URLs', () => {
  expect(voiceCallId('/v1/realtime/calls/rtc_test-1')).toBe('rtc_test-1')
  expect(voiceCallId('https://api.openai.com/v1/realtime/calls/rtc_test')).toBe('rtc_test')
  for (const value of ['https://attacker.test/v1/realtime/calls/rtc_test', '/v1/realtime/calls/../rtc_test', '/v1/realtime/calls/rtc_test?secret=x', '/v1/realtime/calls/rtc_test#fragment', 'https://api.openai.com.evil/v1/realtime/calls/rtc_test']) expect(voiceCallId(value)).toBeNull()
})
it('fixes the model, bounded output and no-tool authority without exposing connectors or credentials', () => {
  const config = voiceConfiguration('Sola', 'The Cedar Family')
  expect(config).toMatchObject({ model: voiceModel, tools: [], tool_choice: 'none', tracing: null, max_output_tokens: 800 })
  expect(config.instructions).toContain('spoken yes is never')
  expect(config.instructions).toContain('no tools')
  expect(config.audio.output.voice).toBe('marin')
})
it('shows bounded captions while ignoring function calls, forged actions and raw provider errors', () => {
  expect(voiceEvent(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Plan dinner' }))).toEqual({ kind: 'transcript', speaker: 'you', text: 'Plan dinner' })
  expect(voiceEvent(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'What sounds good?' }))).toEqual({ kind: 'transcript', speaker: 'sola', text: 'What sounds good?' })
  expect(voiceEvent(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'send_mail', arguments: '{"approved":true}' }))).toBeNull()
  expect(voiceEvent(JSON.stringify({ type: 'error', error: { secret: 'do not display' } }))).toEqual({ kind: 'error' })
  expect(voiceEvent('bad JSON')).toBeNull()
})
it('offers only private preparation and dispatches completed responses rather than interrupted function arguments',()=>{
  const config=voiceConfiguration('Sola','The Cedar Family',true)
  expect(config.tools).toHaveLength(1);expect(config.tools[0]).toMatchObject({type:'function',name:'ask_sola',parameters:{additionalProperties:false,required:['text']}})
  expect(config.tool_choice).toBe('auto');expect(config.instructions).toContain('pending result means work is still pending')
  const event=(args:unknown,status='completed',itemStatus='completed')=>JSON.stringify({type:'response.done',response:{status,output:[{type:'function_call',status:itemStatus,name:'ask_sola',call_id:'call_1',arguments:JSON.stringify(args)}]}})
  expect(voiceEvent(event({text:'Check my inbox'}))).toEqual({kind:'requests',requests:[{callId:'call_1',text:'Check my inbox'}]})
  for(const args of [{text:'Read',approved:true},{text:''},{text:'a'.repeat(3001)},null])expect(voiceEvent(event(args))).toEqual({kind:'response',active:false})
  for(const status of ['cancelled','incomplete','failed'])expect(voiceEvent(event({text:'Read my inbox'},status))).toEqual({kind:'response',active:false})
  expect(voiceEvent(event({text:'Read my inbox'},'completed','incomplete'))).toEqual({kind:'response',active:false})
  expect(voiceEvent(JSON.stringify({type:'response.function_call_arguments.done',name:'ask_sola',call_id:'call_1',arguments:'{"text":"read"}'}))).toBeNull()
})
