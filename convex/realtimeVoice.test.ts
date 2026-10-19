// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { closeVoiceCall, createVoiceCall, VoiceProviderError } from './realtimeVoice'
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', key = 'synthetic-test-key', safety = 'a'.repeat(64)
it('creates a real unified WebRTC request with server-only credentials, fixed configuration and trusted call identity', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(sdp, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_fixture' } }))
  const result = await createVoiceCall(key, sdp, { assistantName: 'Sola', householdName: 'Synthetic Family' }, safety, transport)
  expect(result).toEqual({ sdp, callId: 'rtc_fixture' })
  const [url, request] = transport.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/realtime/calls')
  expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'OpenAI-Safety-Identifier': safety } })
  const form = request!.body as FormData
  expect(form.get('sdp')).toBe(sdp)
  expect(JSON.parse(form.get('session') as string)).toMatchObject({ model: 'gpt-realtime-2.1', tools: [], tool_choice: 'none', max_output_tokens: 800, tracing: null })
  expect(JSON.stringify(result)).not.toContain(key)
})
it('rejects bad SDP and transport failures without forwarding provider error content', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider detail', { status: 403 }))
  await expect(createVoiceCall(key, 'https://evil.test/SDP', { assistantName: 'Sola', householdName: 'Family' }, safety, transport)).rejects.toThrow('Invalid voice configuration')
  expect(transport).not.toHaveBeenCalled()
  await expect(createVoiceCall(key, sdp, { assistantName: 'Sola', householdName: 'Family' }, safety, transport)).rejects.toThrow('Voice provider connection failed')
})
it('hangs up a created provider call if the SDP answer is malformed', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('malformed answer', { status: 201, headers: { Location: '/v1/realtime/calls/rtc_fixture' } })).mockResolvedValueOnce(new Response(null, { status: 200 }))
  await expect(createVoiceCall(key, sdp, { assistantName: 'Sola', householdName: 'Family' }, safety, transport)).rejects.toThrow('connection failed')
  expect(transport.mock.calls[1][0]).toBe('https://api.openai.com/v1/realtime/calls/rtc_fixture/hangup')
})
it('cannot hang up an arbitrary URL and treats an already gone call as closed', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
  expect(await closeVoiceCall(key, 'https://evil.test/a', transport)).toBe(false)
  expect(transport).not.toHaveBeenCalled()
  expect(await closeVoiceCall(key, 'rtc_fixture', transport)).toBe(true)
  expect(transport).toHaveBeenCalledOnce()
  transport.mockRejectedValue(new Error('Do not show me'))
  expect(await closeVoiceCall(key, 'rtc_fixture', transport)).toBe(false)
})
it('advertises only ask_sola when the backend reservation explicitly enables private assistance',async()=>{
  const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(sdp,{status:201,headers:{Location:'/v1/realtime/calls/rtc_fixture'}}))
  await createVoiceCall(key,sdp,{assistantName:'Sola',householdName:'Family',toolsEnabled:true},safety,transport)
  const session=JSON.parse((transport.mock.calls[0][1]!.body as FormData).get('session') as string)
  expect(session.tools).toHaveLength(1);expect(session.tools[0].name).toBe('ask_sola');expect(session.tool_choice).toBe('auto')
  expect(JSON.stringify(session)).not.toContain(key)
})
it('retains only a fixed status/category for quota, model access and malformed provider rejection bodies',async()=>{
  for(const [status,body,category] of [[429,JSON.stringify({error:{code:'insufficient_quota',message:'private body'}}),'quota'],[403,'private model access response','model_access'],[400,'malformed private response','invalid_configuration']] as const){
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{status}))
    try {await createVoiceCall(key,sdp,{assistantName:'Sola',householdName:'Family'},safety,transport);throw new Error('Expected provider rejection.')}
    catch(cause){expect(cause).toBeInstanceOf(VoiceProviderError);expect(cause).toMatchObject({status,category});expect(String(cause)).not.toContain('private');expect(JSON.stringify(cause)).not.toContain('private')}
  }
})
