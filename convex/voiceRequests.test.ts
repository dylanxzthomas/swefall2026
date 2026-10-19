import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { voiceLimits } from '../shared/voice'
import type { Id } from './_generated/dataModel'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('OPENAI_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_VOICE_MODEL', 'gpt-realtime-2.1'); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(toolsConsent = true) {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await t.run(ctx => ctx.db.insert('memberships', {householdId, subject: 'test|other', role: 'adult'}))
  const session = (await owner.mutation(api.voice.reserve, { requestId: 'synthetic-voice', consent: true, ...(toolsConsent ? {toolsConsent:true as const} : {}) }))!
  await t.mutation(internal.voice.started, { id: session.id, version: 1, providerCallId: 'rtc_synthetic' })
  const request = (callId = 'call_1', text = 'Add buy sunscreen to my tasks') => owner.mutation(api.voice.request, {id:session.id, version:1, callId, text})
  const result = (requestId: Id<'voiceRequests'>) => owner.query(api.voice.result,{id:session.id,version:1,requestId})
  const complete = async (jobId: Id<'jobs'>, answer = 'Here is a private task to review.') => {
    const job = (await t.run(ctx=>ctx.db.get(jobId)))!, id = job.assistantRunId!
    await t.mutation(internal.assistantCoordinator.claim,{id,version:1,lease:'synthetic-lease'})
    const step = {tool:'finish',query:'',id:'',from:'',through:'',answer,drafts:[]}
    expect(await t.mutation(internal.assistantCoordinator.advance,{id,version:1,lease:'synthetic-lease',result:JSON.stringify(step)})).toBe(true)
  }
  return {t,owner,other,householdId,session,request,result,complete}
}
it('requires explicit voice-tool consent and does not upgrade an old audio-only session',async()=>{
  const f=await fixture(false)
  expect(f.session.toolsEnabled).toBe(false)
  await expect(f.request()).rejects.toThrow('unavailable')
  expect(await f.t.run(ctx=>ctx.db.query('jobs').collect())).toEqual([])
})
it('rejects a stale session version, expired session, oversized request and revoked voice before creating work',async()=>{
  for(const mode of ['version','expiry','length','provider'] as const){
    const f=await fixture()
    if(mode==='expiry')await f.t.run(ctx=>ctx.db.patch(f.session.id,{expiresAt:now-1}))
    if(mode==='provider')vi.stubEnv('OPENAI_API_KEY','')
    await expect(f.owner.mutation(api.voice.request,{id:f.session.id,version:mode==='version'?2:1,callId:'request',text:mode==='length'?'x'.repeat(3001):'Read my current tasks'})).rejects.toThrow()
    expect(await f.t.run(ctx=>ctx.db.query('jobs').collect())).toEqual([])
    expect(await f.t.run(ctx=>ctx.db.query('voiceRequests').collect())).toEqual([])
    vi.stubEnv('OPENAI_API_KEY','synthetic')
  }
})
it('coalesces 50 duplicate tool deliveries into one private job without invoking the shared literal-task shortcut',async()=>{
  const f=await fixture(), requests=await Promise.all(Array.from({length:50},()=>f.request()))
  expect(new Set(requests.map(r=>r.requestId)).size).toBe(1)
  expect(await f.t.run(ctx=>ctx.db.query('voiceRequests').collect())).toHaveLength(1)
  expect(await f.t.run(ctx=>ctx.db.query('jobs').collect())).toHaveLength(1)
  expect(await f.t.run(ctx=>ctx.db.query('personalTasks').collect())).toEqual([])
  expect(await f.t.run(ctx=>ctx.db.query('privateTasks').collect())).toEqual([])
  const job=await f.t.run(ctx=>ctx.db.get(requests[0].jobId))
  expect(job).toMatchObject({conversation:true,interactive:true,voiceSessionId:f.session.id,preparing:true})
  expect(await f.t.run(ctx=>ctx.db.get(job!.assistantRunId!))).toMatchObject({privateOnly:true})
  expect(await f.result(requests[0].requestId)).toMatchObject({status:'pending'})
  await expect(f.request('call_1','Changed request')).rejects.toThrow('changed')
  await expect(f.request('call_2')).rejects.toThrow('earlier request')
})
it('reads only actual completed answers, remains owner-only in the same household, and rejects late results after stop',async()=>{
  const f=await fixture(), r=await f.request()
  await expect(f.other.query(api.voice.result,{id:f.session.id,version:1,requestId:r.requestId})).rejects.toThrow('unavailable')
  await expect(f.other.mutation(api.voice.request,{id:f.session.id,version:1,callId:'other',text:'Check my inbox'})).rejects.toThrow('unavailable')
  await f.complete(r.jobId,'No email was sent. Review the prepared request in your conversation.')
  expect(await f.result(r.requestId)).toEqual({status:'complete',jobId:r.jobId,reviewRequired:false,answer:'No email was sent. Review the prepared request in your conversation.'})
  await f.owner.mutation(api.voice.stop,{id:f.session.id,version:1})
  await expect(f.result(r.requestId)).rejects.toThrow('unavailable')
  expect(await f.t.run(ctx=>ctx.db.get(r.jobId))).toMatchObject({conversation:true,cancelled:false})
  expect(await f.t.run(ctx=>ctx.db.query('approvals').collect())).toEqual([])
  expect(await f.t.run(ctx=>ctx.db.query('actions').collect())).toEqual([])
})
it('invalidates observed output on source edits, source expiry, membership loss and session expiry',async()=>{
  for(const mode of ['source','sourceExpiry','membership','session'] as const){
    const f=await fixture(),r=await f.request(); await f.complete(r.jobId,'Read this current answer.')
    const j=(await f.t.run(ctx=>ctx.db.get(r.jobId)))!
    if(mode==='source')await f.t.run(ctx=>ctx.db.patch(j.sourceId,{text:'Changed underlying request',revision:2}))
    if(mode==='sourceExpiry')await f.t.run(ctx=>ctx.db.patch(j.sourceId,{expiresAt:now-1}))
    if(mode==='membership')await f.t.run(async ctx=>{const member=await ctx.db.query('memberships').withIndex('by_subject',q=>q.eq('subject','test|parent')).unique(); await ctx.db.delete(member!._id)})
    if(mode==='session')vi.setSystemTime(now+voiceLimits.sessionMs+1)
    if(mode==='source'||mode==='sourceExpiry')expect(await f.result(r.requestId)).toMatchObject({status:'failed'})
    else await expect(f.result(r.requestId)).rejects.toThrow()
    vi.setSystemTime(now)
  }
})
it('bounds unique requests per session and fails closed before any job when main model configuration is removed',async()=>{
  const f=await fixture()
  for(let i=0;i<voiceLimits.requestsPerSession;i++){const r=await f.request(`call_${i}`);await f.complete(r.jobId)}
  await expect(f.request('overflow')).rejects.toThrow('request limit')
  const second=await fixture();vi.stubEnv('ANTHROPIC_API_KEY','')
  await expect(second.request()).rejects.toThrow('unavailable')
  expect(await second.t.run(ctx=>ctx.db.query('jobs').collect())).toEqual([])
})
it('cannot promote a voice request into shared notice preparation through the model tool',async()=>{
  const f=await fixture(),r=await f.request('call_1','Add the school picnic to the family calendar'),j=(await f.t.run(ctx=>ctx.db.get(r.jobId)))!
  await f.t.mutation(internal.assistantCoordinator.claim,{id:j.assistantRunId!,version:1,lease:'lease'})
  const step={tool:'prepare_notice',query:'',id:'',from:'',through:'',answer:'',drafts:[]}
  await expect(f.t.mutation(internal.assistantCoordinator.advance,{id:j.assistantRunId!,version:1,lease:'lease',result:JSON.stringify(step)})).rejects.toThrow('private finish drafts')
  expect(await f.t.run(ctx=>ctx.db.get(r.jobId))).toMatchObject({conversation:true})
  expect(await f.t.run(ctx=>ctx.db.query('actions').collect())).toEqual([])
  expect(await f.t.run(ctx=>ctx.db.get(j.assistantRunId!))).not.toMatchObject({phase:'notice'})
})
it('returns source-backed private review work without saving a task, sharing, or approving provider execution',async()=>{
  const f=await fixture(),r=await f.request('call_1','Prepare a reminder to bring sunscreen'),j=(await f.t.run(ctx=>ctx.db.get(r.jobId)))!
  await f.t.mutation(internal.assistantCoordinator.claim,{id:j.assistantRunId!,version:1,lease:'lease'})
  const step={tool:'finish',query:'',id:'',from:'',through:'',answer:'I prepared a private sunscreen reminder. Review it in the app.',drafts:[{kind:'task',title:'Bring sunscreen',text:'Bring sunscreen.',evidence:[{sourceId:j.sourceId,quote:'bring sunscreen'}]}]}
  await f.t.mutation(internal.assistantCoordinator.advance,{id:j.assistantRunId!,version:1,lease:'lease',result:JSON.stringify(step)})
  expect(await f.result(r.requestId)).toEqual({status:'complete',jobId:r.jobId,reviewRequired:true,answer:step.answer})
  expect(await f.other.query(api.jobs.list,{})).not.toEqual(expect.arrayContaining([expect.objectContaining({_id:r.jobId})]))
  for(const table of ['privateTasks','personalTasks','actions','approvals','attempts','mailDrafts','planEvents'] as const)expect(await f.t.run(ctx=>ctx.db.query(table).collect())).toEqual([])
  expect(await f.t.run(ctx=>ctx.db.get(j.assistantRunId!))).toMatchObject({privateOnly:true,deliverables:[{status:'review',title:'Bring sunscreen'}]})
})
it('expires the request journal and private text after thirty days without retaining raw audio',async()=>{
  const f=await fixture(),r=await f.request(),j=(await f.t.run(ctx=>ctx.db.get(r.jobId)))!
  const journal=(await f.t.run(ctx=>ctx.db.get(r.requestId)))!
  expect(Object.keys(journal).sort()).toEqual(['_creationTime','_id','callId','createdAt','createdBy','expiresAt','householdId','inputHash','jobId','sessionId','sessionVersion'].sort())
  vi.setSystemTime(now+30*86400000+1)
  await f.t.mutation(internal.privacy.expireSources,{})
  expect(await f.t.run(ctx=>ctx.db.get(r.requestId))).toBeNull()
  expect((await f.t.run(ctx=>ctx.db.get(j.sourceId)))?.text).toBeUndefined()
  expect((await f.t.run(ctx=>ctx.db.get(r.jobId)))?.clarification).toContain('expired')
})
it('keeps later text follow-ups private when they inherit a private voice preparation',async()=>{
  const f=await fixture(),first=await f.request('call_1','Help me prepare a dentist appointment calendar entry')
  await f.complete(first.jobId,'I prepared the dentist appointment details privately.')
  vi.setSystemTime(now+100)
  const sourceId=await f.t.run(ctx=>ctx.db.insert('sources',{householdId:f.householdId,text:'Put that appointment on the family calendar.',hash:'synthetic-follow-up',attachmentIds:[],revision:1,expiresAt:now+86400000}))
  const jobId=await f.t.run(ctx=>ctx.db.insert('jobs',{householdId:f.householdId,createdBy:'test|parent',sourceId,interactive:true,conversation:true,preparing:true,cancelled:false,clarification:''}))
  const id=(await f.t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1}))!
  const input=await f.t.mutation(internal.assistantCoordinator.claim,{id,version:1,lease:'follow-up'})
  expect(input?.assistant?.history).toEqual(expect.arrayContaining([expect.objectContaining({response:'I prepared the dentist appointment details privately.'})]))
  expect(input?.canPrepareNotice).toBe(false)
})
