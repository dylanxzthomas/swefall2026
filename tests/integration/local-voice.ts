import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Browser, type BrowserServer } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { api, internal } from '../../convex/_generated/api.js'
import type { Id } from '../../convex/_generated/dataModel.js'
import { voiceEvent, voiceModel, type VoiceSession, type VoiceToolResult } from '../../shared/voice.js'
import { waitForVoiceRequest } from '../../web/src/daymark/voiceBrowser.js'
import { closeBounded, VoiceDeadline, within } from './voiceLifecycle.mjs'

// Opt-in actual provider evaluation. The browser creates a disabled, silent
// WebAudio track: getUserMedia is never called and no human microphone is opened.
// Credentials stay in this Node process/backend, never in browser arguments.
const withTools = process.argv.includes('--with-tools'), callLimitMs = 20000
// The local-only impersonation helper exists at runtime but is intentionally
// absent from the public client declarations. It never enters shipped UI code.
type LocalClient = ConvexHttpClient & { setAdminAuth(key: string, identity?: Record<string, string | boolean>): void }
type LocalAdmin = LocalClient & { mutation<Args extends Record<string, any>, Result>(reference: FunctionReference<'mutation', 'internal', Args, Result>, args: Args): Promise<Result> }
const allowedCategories = new Set(['quota', 'rate_limit', 'authentication', 'model_access', 'invalid_configuration', 'provider_unavailable'])
let browser: Browser | undefined, browserServer: BrowserServer | undefined, householdId: Id<'households'> | undefined, session: VoiceSession | undefined
let watchdog: ChildProcess | undefined, watchdogStatus = 'not_started'
let stage = 'configuration', category = 'configuration', httpStatus: number | null = null, providerClosed = false, cleaned = false
let callTimer: ReturnType<typeof setTimeout> | undefined, closing: Promise<void> | undefined
let browserBootTimer: ReturnType<typeof setTimeout> | undefined
const toolAbort = new AbortController(), requestId = `synthetic-voice-${randomUUID()}`
let toolResult: VoiceToolResult | undefined, toolStarted = false
let startedAt = 0, startupMs: number | null = null, toolWaitMs: number | null = null, toolWaitStatus = 'not_started'
let observations: Record<string, unknown> | undefined, checkpoint: Record<string, unknown> | undefined
let client: LocalClient | undefined, admin: LocalAdmin | undefined, read: ((expression: string, timeoutMs?: number) => Promise<any>) | undefined
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const forceBrowserClose = () => {
  const pid = browserServer?.process().pid
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}
async function stopCall() {
  if (closing) return closing
  closing = (async () => {
    toolAbort.abort()
    if (!client || !householdId) return
    const current = session ?? (await within(() => client!.query(api.voice.settings, {}), 2500, 'owner_stop_timeout')).active
    if (current) await within(() => client!.mutation(api.voice.stop, { id: current.id as Id<'voiceSessions'>, version: current.version }), 2500, 'owner_stop_timeout')
  })()
  return closing
}
async function confirmClosed() {
  if (!session || !read) return
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const state = await read(`const row=await ctx.db.get(${JSON.stringify(session.id)});return row?{status:row.status,closed:!row.providerCallId}:null`, Math.min(2000, Math.max(100, deadline - Date.now())))
    if (state?.status === 'stopped' && state.closed) { providerClosed = true; return }
    await wait(250)
  }
}
try {
  const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8')), origin = 'http://127.0.0.1:3210'
  assert.equal(config.ports.cloud, 3210)
  assert.equal(await (await fetch(`${origin}/instance_name`, { signal: AbortSignal.timeout(3000) })).text(), config.deploymentName)
  const environment: NodeJS.ProcessEnv = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DEPLOYMENT: `anonymous:${config.deploymentName}` }
  for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY']) delete environment[name]
  const run = promisify(execFile)
  const cli = async (args: string[], timeoutMs = 5000) => {
    try {
      const result = await run(process.execPath, ['node_modules/convex/bin/main.js', ...args], { env: environment, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
      return result.stdout.trim()
    } catch { throw new Error('Local fixture command failed; private output withheld.') }
  }
  read = async (expression, timeoutMs) => { const value = await cli(['run', '--inline-query', expression], timeoutMs); return value ? JSON.parse(value) : null }
  const names = new Set((await cli(['env', 'list', '--names-only'])).split(/\r?\n/).map(name => name.trim()))
  assert.ok(names.has('OPENAI_API_KEY') && names.has('DAYMARK_VOICE_MODEL'))
  assert.equal(await cli(['env', 'get', 'DAYMARK_VOICE_MODEL']), voiceModel)
  // Cleanup may invoke the existing account-data deletion code, but cannot call
  // Auth0 without either management credential. Never relax this fixture guard.
  assert.ok(!names.has('AUTH0_MANAGEMENT_CLIENT_ID') && !names.has('AUTH0_MANAGEMENT_CLIENT_SECRET'))
  assert.ok(!names.has('DAYMARK_ENVIRONMENT') || await cli(['env', 'get', 'DAYMARK_ENVIRONMENT']) !== 'production')
  const subject = `synthetic-voice-${randomUUID()}`, owner = `https://daymark-test.invalid|${subject}`
  const transport: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname === '/api/action' ? 22000 : 5000) })
  client = new ConvexHttpClient(origin, { logger: false, fetch: transport }) as LocalClient; admin = new ConvexHttpClient(origin, { logger: false, fetch: transport }) as LocalAdmin
  client.setAdminAuth(config.adminKey, { subject, tokenIdentifier: owner, issuer: 'https://daymark-test.invalid', email: `${subject}@example.test`, emailVerified: true })
  admin.setAdminAuth(config.adminKey)
  householdId = await client.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'fictional-child', name: 'Fictional Child' }] })
  const settings = await client.query(api.voice.settings, {})
  assert.equal(settings.configured, true)
  if (withTools) assert.equal(settings.toolsAvailable, true)
  assert.equal((await client.query(api.connections.overview, {})).items.length, 0)
  browserServer = await within(() => chromium.launchServer({ headless: true, timeout: 8000, args: ['--autoplay-policy=no-user-gesture-required'] }), 10000, 'browser_start_timeout')
  browserBootTimer = setTimeout(forceBrowserClose, 10000)
  browser = await within(() => chromium.connect(browserServer!.wsEndpoint(), { timeout: 4000 }), 5000, 'browser_connect_timeout')
  const page = await within(() => browser!.newPage(), 5000, 'browser_page_timeout')
  // tsx preserves function names with this harmless helper inside serialized
  // evaluate callbacks. The empty synthetic page has no application scripts.
  await page.evaluate('globalThis.__name = value => value')
  await page.exposeBinding('captureSyntheticObservations', (_source, value: Record<string, unknown>) => { observations = value })
  await page.exposeBinding('startSyntheticVoice', async (_source, sdp: string) => {
    stage = 'provider_start'; category = 'provider_start_rejected'
    startedAt = Date.now()
    watchdog = fork(new URL('./voice-watchdog.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const armed = new Promise<void>((resolve, reject) => {
      watchdog!.on('message', (message: { status?: string }) => {
        if (['armed', 'stopped', 'stop_failed', 'browser_killed', 'arm_failed'].includes(message.status ?? '')) watchdogStatus = message.status!
        if (message.status === 'armed') resolve()
        if (message.status === 'arm_failed') reject(new Error('Fixture watchdog failed.'))
      })
      watchdog!.once('error', () => reject(new Error('Fixture watchdog failed.')))
    })
    watchdog.send({ type: 'arm', owner, browserPid: browserServer!.process().pid, deadlineAt: startedAt + callLimitMs })
    await within(() => armed, 3000, 'watchdog_arm_timeout')
    callTimer = setTimeout(() => { void stopCall().catch(() => {}) }, callLimitMs)
    try {
      session = await client!.action(api.realtimeVoice.start, { sdp, requestId, consent: true, ...(withTools ? { toolsConsent: true as const } : {}) })
      startupMs = Date.now() - startedAt
      stage = 'voice_exchange'; category = 'transport_unfinished'
      return { sdp: session.sdp, toolsEnabled: session.toolsEnabled === true }
    } catch { return null }
  })
  await page.exposeBinding('prepareSyntheticVoiceTool', async (_source, data: string) => {
    const event = voiceEvent(data)
    if (!withTools || !session?.toolsEnabled || event?.kind !== 'requests' || event.requests.length !== 1 || toolStarted) return null
    const request = event.requests[0]
    // A model cannot broaden this fixture beyond its one fictional request.
    if (!/sunscreen/i.test(request.text) || request.text.length > 3000) return null
    toolStarted = true
    stage = 'private_preparation'; category = 'private_preparation_unfinished'
    const began = Date.now(); toolWaitStatus = 'waiting'
    try {
      toolResult = await waitForVoiceRequest(() => client!.mutation(api.voice.request, { id: session!.id as Id<'voiceSessions'>, version: session!.version, callId: request.callId, text: request.text }), id => client!.query(api.voice.result, { id: session!.id as Id<'voiceSessions'>, version: session!.version, requestId: id as Id<'voiceRequests'> }), toolAbort.signal, callLimitMs)
      toolWaitStatus = toolResult.status
      return { callId: request.callId, result: toolResult }
    } catch { toolWaitStatus = toolAbort.signal.aborted ? 'aborted' : 'request_or_result_rejected'; throw new Error('Synthetic private preparation did not complete.') }
    finally { toolWaitMs = Date.now() - began }
  })
  stage = 'webrtc'; category = 'transport_unfinished'
  clearTimeout(browserBootTimer)
  const observed = await within(() => page.evaluate(async ({ withTools, callLimitMs }) => {
    const surface = window as unknown as {
      startSyntheticVoice(sdp: string): Promise<{ sdp: string; toolsEnabled: boolean } | null>
      prepareSyntheticVoiceTool(data: string): Promise<{ callId: string; result: { status: string; answer?: string; reviewRequired: boolean } } | null>
      captureSyntheticObservations(value: Record<string, unknown>): Promise<void>
    }
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination()
    gain.gain.value = 0; oscillator.connect(gain); gain.connect(destination); oscillator.start()
    const track = destination.stream.getAudioTracks()[0]; track.enabled = false
    const peer = new RTCPeerConnection(), channel = peer.createDataChannel('oai-events'), audio = document.createElement('audio')
    audio.muted = true; audio.autoplay = true; document.body.append(audio)
    let analyser: AnalyserNode | undefined, decodedSignalObserved = false
    const decodedSamples = new Float32Array(2048)
    let captionObserved = false, helloObserved = false, completed = false, audioReceived = false, toolObserved = false, rejection = '', settled = false
    let dataChannelOpened = false, remoteTrackReceived = false, remoteStreamBound = false, audioPlaybackStarted = false, audioPlaybackRejected = false, transcriptDeltaObserved = false, legacyCaptionObserved = false, audioDoneObserved = false
    let sessionCreated = false, sessionUpdated = false, responseCreated = false, responseDone = false, responseStatus = 'none', incompleteReason = 'none'
    let inboundAudioStats = false, audioBytesReceived = false, samplesFieldPresent = false, samplesReceived = false, energyFieldPresent = false, positiveEnergy = false
    let outputTokens: number | null = null, outputAudioTokens: number | null = null, reasoningTokens: number | null = null
    const elapsedAt = performance.now()
    let responseCreatedMs: number | null = null, responseDoneMs: number | null = null, captionMs: number | null = null
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve }), finish = () => { if (!settled) { settled = true; resolveDone() } }
    const classify = (code: unknown) => code === 'insufficient_quota' ? 'quota' : code === 'rate_limit_exceeded' ? 'rate_limit' : code === 'invalid_api_key' ? 'authentication' : code === 'model_not_found' || code === 'permission_denied' ? 'model_access' : 'provider_error'
    const timer = setTimeout(finish, callLimitMs)
    peer.addTrack(track, destination.stream)
    peer.ontrack = event => {
      remoteTrackReceived = true
      const stream = event.streams[0] ?? new MediaStream([event.track])
      remoteStreamBound = true; audio.srcObject = stream
      void audio.play().then(() => { audioPlaybackStarted = true }).catch(() => { audioPlaybackRejected = true })
      // Muted HTML playback can leave RTP's playout-energy statistic at zero.
      // Consume decoded remote speech through an analyser, then silence the
      // output. Samples exist only in this temporary buffer and are never saved.
      const source = context.createMediaStreamSource(stream), silence = context.createGain()
      analyser = context.createAnalyser(); analyser.fftSize = decodedSamples.length
      silence.gain.value = 0; source.connect(analyser); analyser.connect(silence); silence.connect(context.destination)
      void context.resume().catch(() => {})
    }
    channel.onmessage = event => {
      let value: any; try { value = JSON.parse(event.data) } catch { return }
      if (value.type === 'session.created') sessionCreated = true
      if (value.type === 'session.updated') sessionUpdated = true
      if (value.type === 'response.created') { responseCreated = true; responseCreatedMs = Math.round(performance.now() - elapsedAt) }
      if (value.type === 'response.output_audio.done') audioDoneObserved = true
      if (value.type === 'response.output_audio_transcript.delta' || value.type === 'response.audio_transcript.delta') transcriptDeltaObserved = true
      if (value.type === 'response.audio_transcript.done') legacyCaptionObserved = true
      if (value.type === 'error') { rejection = classify(value.error?.code); finish(); return }
      if (value.type === 'response.output_audio_transcript.done' && typeof value.transcript === 'string') { captionMs = Math.round(performance.now() - elapsedAt); captionObserved = value.transcript.trim().length > 0; helloObserved = /^hello[.!]?$/i.test(value.transcript.trim()) }
      if (value.type === 'response.done') {
        responseDone = true; responseDoneMs = Math.round(performance.now() - elapsedAt)
        responseStatus = ['completed', 'incomplete', 'failed', 'cancelled'].includes(value.response?.status) ? value.response.status : 'unknown'
        incompleteReason = ['max_output_tokens', 'content_filter'].includes(value.response?.status_details?.reason) ? value.response.status_details.reason : value.response?.status_details?.reason ? 'other' : 'none'
        const tokenCount = (count: unknown) => typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 128000 ? count : null
        outputTokens = tokenCount(value.response?.usage?.output_tokens); outputAudioTokens = tokenCount(value.response?.usage?.output_token_details?.audio_tokens); reasoningTokens = tokenCount(value.response?.usage?.output_token_details?.reasoning_tokens)
        if (value.response?.status === 'failed') { rejection = classify(value.response.status_details?.error?.code); finish(); return }
        if (value.response?.output?.some((item: any) => item.type === 'function_call')) {
          void surface.prepareSyntheticVoiceTool(event.data).then(output => {
            if (settled || !output || channel.readyState !== 'open') return
            toolObserved = output.result.status === 'complete' && output.result.reviewRequired
            channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: output.callId, output: JSON.stringify(output.result) } }))
            channel.send(JSON.stringify({ type: 'response.create', response: { tool_choice: 'none', max_output_tokens: 128, instructions: 'Summarize the observed preparation in one very short sentence. Do not claim any task was saved or action performed.' } }))
          }).catch(() => { rejection = 'private_preparation_unfinished'; finish() })
        } else completed = value.response?.status === 'completed'
      }
    }
    try {
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer)
      const remote = await surface.startSyntheticVoice(peer.localDescription!.sdp)
      if (!remote) { rejection = 'provider_start_rejected'; finish() }
      else if (!settled) {
        await peer.setRemoteDescription({ type: 'answer', sdp: remote.sdp })
        const send = () => {
          if (settled) return
          dataChannelOpened = true
          channel.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } }, max_output_tokens: 128 } }))
          channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: withTools ? 'Prepare one private task to bring sunscreen for my review. Do not save, share, approve, send or change anything. Use ask_sola.' : 'This is a synthetic connection test. Say only the word Hello.' }] } }))
          channel.send(JSON.stringify({ type: 'response.create', response: { tool_choice: withTools ? { type: 'function', name: 'ask_sola' } : 'none', max_output_tokens: withTools ? 256 : 128, ...(!withTools ? { instructions: 'For this synthetic connection test, say only the single word Hello.' } : {}) } }))
        }
        if (channel.readyState === 'open') send(); else channel.onopen = send
      }
      const samples = setInterval(() => {
        if (analyser) { analyser.getFloatTimeDomainData(decodedSamples); decodedSignalObserved ||= decodedSamples.some(value => Math.abs(value) > 0.00001) }
        void peer.getStats().then(stats => {
          stats.forEach(stat => {
            if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return
            inboundAudioStats = true; audioBytesReceived ||= stat.bytesReceived > 0
            samplesFieldPresent ||= typeof stat.totalSamplesReceived === 'number'; samplesReceived ||= stat.totalSamplesReceived > 0
            energyFieldPresent ||= typeof stat.totalAudioEnergy === 'number'; positiveEnergy ||= stat.totalAudioEnergy > 0
            if (audioBytesReceived && samplesReceived && decodedSignalObserved) audioReceived = true
          })
          if (completed && captionObserved && audioReceived && (!withTools || toolObserved)) finish()
        }).catch(() => {})
      }, 100)
      await done; clearInterval(samples)
      const summary = { captionObserved, helloObserved, completed, audioReceived, decodedSignalObserved, toolObserved, rejection, dataChannelOpened, remoteTrackReceived, remoteStreamBound, audioPlaybackStarted, audioPlaybackRejected, transcriptDeltaObserved, legacyCaptionObserved, audioDoneObserved, sessionCreated, sessionUpdated, responseCreated, responseDone, responseStatus, incompleteReason, inboundAudioStats, audioBytesReceived, samplesFieldPresent, samplesReceived, energyFieldPresent, positiveEnergy, contextRunning: context.state === 'running', peerConnected: peer.connectionState === 'connected', outputTokens, outputAudioTokens, reasoningTokens, responseCreatedMs, responseDoneMs, captionMs, elapsedMs: Math.round(performance.now() - elapsedAt) }
      await Promise.race([surface.captureSyntheticObservations(summary), new Promise(resolve => setTimeout(resolve, 250))])
      return summary
    } finally {
      clearTimeout(timer); channel.onmessage = null; channel.onopen = null; channel.close(); peer.close(); track.stop(); oscillator.stop(); audio.pause(); audio.srcObject = null; await Promise.race([context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))])
    }
  }, { withTools, callLimitMs }), callLimitMs + 4000, 'browser_exchange_timeout')
  observations = observed
  if (observed.rejection) {
    category = allowedCategories.has(observed.rejection) ? observed.rejection : ['provider_start_rejected', 'private_preparation_unfinished', 'provider_error'].includes(observed.rejection) ? observed.rejection : 'transport_unfinished'
    if (category === 'provider_start_rejected') {
      const failed = await read(`return (await ctx.db.query('voiceSessions').withIndex('by_request',q=>q.eq('householdId',${JSON.stringify(householdId)}).eq('createdBy',${JSON.stringify(owner)}).eq('requestId',${JSON.stringify(requestId)})).unique())?.issue ?? ''`)
      const diagnostic = typeof failed === 'string' ? failed.match(/\((quota|rate_limit|authentication|model_access|invalid_configuration|provider_unavailable); HTTP (\d{3})\)/) : null
      if (diagnostic) { category = diagnostic[1]; httpStatus = Number(diagnostic[2]) }
    }
    throw new Error('Synthetic provider evaluation stopped.')
  }
  assert.ok(observed.audioReceived && observed.captionObserved && observed.completed)
  if (withTools) assert.ok(observed.toolObserved && toolResult?.status === 'complete' && toolResult.reviewRequired)
  else assert.equal(observed.helloObserved, true)
  stage = 'provider_close'; category = 'provider_close_unconfirmed'
  await stopCall()
  await confirmClosed()
  assert.equal(providerClosed, true)
  for (const table of ['connections', 'actions', 'approvals', 'attempts', 'mailDrafts', 'planEvents', 'privateTasks', 'personalTasks'] as const) assert.equal(await read(`return (await ctx.db.query(${JSON.stringify(table)}).filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).collect()).length`), 0)
  category = 'passed'
} catch (cause) {
  if (cause instanceof VoiceDeadline) category = cause.category
  process.exitCode = 1
} finally {
  clearTimeout(callTimer); clearTimeout(browserBootTimer); toolAbort.abort()
  try {
    await stopCall()
    if (session && !providerClosed) await confirmClosed()
    if (withTools && toolStarted && householdId && read) checkpoint = await read(`const job=(await ctx.db.query('jobs').withIndex('by_household',q=>q.eq('householdId',${JSON.stringify(householdId)})).collect()).find(j=>!!j.voiceSessionId);const run=job?.assistantRunId?await ctx.db.get(job.assistantRunId):null;return {jobPreparing:job?.preparing??false,jobCancelled:job?.cancelled??false,runPresent:!!run,runStatus:run?.status??'none',step:run?.step??0,attempts:run?.attempts??0,failureCode:['model_request','model_quota','model_unavailable','model_output'].includes(run?.failureCode??'')?run.failureCode:'none'}`)
  } catch { if (category === 'passed') { category = 'provider_close_unconfirmed'; process.exitCode = 1 } }
  await closeBounded(async () => { await browser?.close(); await browserServer?.close() }, forceBrowserClose)
  if (watchdog?.connected) watchdog.send({ type: 'disarm' })
  watchdog?.kill('SIGKILL')
  if (householdId && client && admin && read) {
    try {
      // The guard above proves this path cannot make an Auth0 request. Remove
      // only this randomly named synthetic household through existing cleanup.
      await client.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
      const deletion = await read(`return await ctx.db.query('deletionJobs').filter(q=>q.eq(q.field('householdId'),${JSON.stringify(householdId)})).first()`)
      assert.ok(deletion)
      await admin.mutation(internal.privacy.identityResult, { jobId: deletion._id, status: 'deleted' })
      await admin.mutation(internal.privacy.eraseHousehold, { householdId, jobId: deletion._id })
      cleaned = await read(`return await ctx.db.get(${JSON.stringify(householdId)})`) === null
      assert.equal(cleaned, true)
    } catch { category = 'fixture_cleanup_unfinished'; process.exitCode = 1 }
  }
  console.log(JSON.stringify({ syntheticVoice: true, status: category === 'passed' ? 'passed' : ['quota', 'rate_limit', 'authentication', 'model_access'].includes(category) ? 'blocked' : 'failed', stage, category, httpStatus, providerClosed, cleaned, tools: withTools, startupMs, toolWaitMs, toolWaitStatus, watchdogStatus, observations, checkpoint }))
}
