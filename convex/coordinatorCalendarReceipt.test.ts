import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { validAssistantRun } from './assistantCoordinator'
import { jobStatus, jobSummary, type Task } from '../shared/assistant'
import { event, notice } from '../tests/fixtures/calendar'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T08:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DAYMARK_ENVIRONMENT', 'development'); vi.stubEnv('DAYMARK_TEST_EMAIL_RECIPIENTS', 'school@example.test') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture(operation: 'create' | 'update' | 'delete' = 'create') {
 const t=convexTest(schema,modules); workflow.register(t)
 const owner=t.withIdentity({subject:'parent',tokenIdentifier:'test|parent'})
 const householdId=await owner.mutation(api.households.save,{timezone:'America/Los_Angeles',children:[{id:'maya',name:'Maya'}]})
 const sourceId=await t.run(ctx=>ctx.db.insert('sources',{householdId,text:notice,hash:'parent-notice',revision:1,expiresAt:now+86400000}))
 const jobId=await t.run(ctx=>ctx.db.insert('jobs',{householdId,sourceId,createdBy:'test|parent',interactive:true,preparing:true,cancelled:false,clarification:''}))
 const connectionId=await t.run(ctx=>ctx.db.insert('connections',{householdId,subject:'test|parent',provider:'google',status:'active',version:1,cipher:'synthetic-unused',email:'parent@example.test',calendarId:'synthetic-calendar',scopes:['https://www.googleapis.com/auth/calendar.app.created','https://www.googleapis.com/auth/gmail.send']}))
 let targetId: string | null = null
 if(operation!=='create'){
  targetId=await t.run(async ctx=>{
   const originalJob=await ctx.db.insert('jobs',{householdId,sourceId,createdBy:'test|parent',preparing:false,cancelled:false,clarification:''})
   const originalAction=await ctx.db.insert('actions',{householdId,jobId:originalJob,sourceRevision:1,revision:1,status:'succeeded',payload:{...event,title:'Previous trip'}})
   return ctx.db.insert('planEvents',{householdId,owner:'test|parent',actionId:originalAction,connectionId,provider:'google',eventId:'synthetic-calendar-event',calendarId:'synthetic-calendar',etag:'old-etag',payload:{...event,title:'Previous trip'}})
  })
 }
 const calendarPayload={...event,operation:operation==='delete'?'delete' as const:'save' as const,targetId}
 const id=(await t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1}))!
 await t.mutation(internal.assistantCoordinator.claim,{id,version:1,lease:'select'})
 await t.mutation(internal.assistantCoordinator.advance,{id,version:1,lease:'select',result:JSON.stringify({tool:'prepare_notice',query:'',id:'',from:'',through:'',answer:'',drafts:[]})})
 await t.mutation(internal.assistantCoordinator.claim,{id,version:2,lease:'notice',phase:'notice'})
 const clarification='Please confirm the bus stop with the school before sending the RSVP.'
 await t.mutation(internal.assistantCoordinator.noticeFinished,{id,version:2,lease:'notice',result:JSON.stringify({actions:[calendarPayload,{kind:'email',childId:'maya',to:'school@example.test',subject:'Trip RSVP',body:'Maya will attend.',requirement:'',evidence:{}}],clarification})})
 const actions=await t.run(ctx=>ctx.db.query('actions').withIndex('by_job',q=>q.eq('jobId',jobId)).collect())
 const calendar=actions.find(a=>a.payload.kind==='calendar')!,email=actions.find(a=>a.payload.kind==='email')!
 await owner.mutation(api.jobs.approve,{actions:[{id:calendar._id,revision:1}]})
 const approved=(await t.run(ctx=>ctx.db.get(calendar._id)))!
 const claim=(await t.mutation(internal.execution.claim,{actionId:calendar._id,approvalId:approved.approvalId!}))!
 expect(await t.mutation(internal.execution.dispatch,{attemptId:claim.attemptId})).toBe(true)
 const valid=()=>t.run(ctx=>validAssistantRun(ctx,{householdId,createdBy:'test|parent',assistantRunId:id}))
 const finish=()=>t.mutation(internal.execution.finish,{attemptId:claim.attemptId,status:'succeeded',providerId:'synthetic-calendar-event',etag:'synthetic-etag'})
 return {t,owner,householdId,sourceId,jobId,connectionId,id,calendar,email,claim,clarification,valid,finish}
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function receipt(f: Fixture, path: 'finish' | 'reconcile') {
 if(path==='finish')await f.finish()
 else{await f.t.mutation(internal.execution.finish,{attemptId:f.claim.attemptId,status:'uncertain',error:'Synthetic lost response'});await f.t.mutation(internal.execution.reconciled,{actionId:f.calendar._id,providerId:'synthetic-calendar-event',etag:'synthetic-etag'})}
}
it.each([
 ['finish','create'],['finish','update'],['finish','delete'],
 ['reconcile','create'],['reconcile','update'],['reconcile','delete'],
] as const)('preserves useful notice clarification after its own verified %s %s while receipts and independent work remain authoritative',async(path,operation)=>{
 const f=await fixture(operation),before=(await f.owner.query(api.jobs.list,{})).find(j=>j._id===f.jobId)!,runBefore=(await f.t.run(ctx=>ctx.db.get(f.id)))!
 expect(before.clarification).toBe(f.clarification);expect(await f.valid()).toBe(true)
 await receipt(f,path)
 const shown=(await f.owner.query(api.jobs.list,{})).find(j=>j._id===f.jobId)!,runAfter=(await f.t.run(ctx=>ctx.db.get(f.id)))!
 expect(await f.valid()).toBe(true);expect(shown.clarification).toBe(f.clarification)
 expect(runAfter.refs.filter(r=>r.kind!=='family')).toEqual(runBefore.refs.filter(r=>r.kind!=='family'))
 expect(runAfter.refs.filter(r=>r.kind==='family')).not.toEqual(runBefore.refs.filter(r=>r.kind==='family'))
 expect(runAfter.contextBindings).toEqual(runBefore.contextBindings);expect(runAfter.version).toBe(runBefore.version)
 expect(jobSummary(shown as Task)).toBe(operation==='delete'?'Calendar removal verified; email ready for review':'Calendar updated; email ready for review')
 expect(jobStatus(shown as Task)).toBe('Needs you')
 expect(shown.actions.find(a=>a._id===f.calendar._id)!.receipts).toHaveLength(1)
 expect(await f.t.run(ctx=>ctx.db.query('planEvents').collect())).toHaveLength(operation==='delete'?0:1)
 await f.owner.mutation(api.jobs.approve,{actions:[{id:f.email._id,revision:1}]})
 const approved=(await f.t.run(ctx=>ctx.db.get(f.email._id)))!,emailClaim=(await f.t.mutation(internal.execution.claim,{actionId:f.email._id,approvalId:approved.approvalId!}))!
 expect(await f.t.mutation(internal.execution.dispatch,{attemptId:emailClaim.attemptId})).toBe(true)
 await f.t.mutation(internal.execution.finish,{attemptId:emailClaim.attemptId,status:'succeeded',providerId:'synthetic-accepted-email'})
 const finished=(await f.owner.query(api.jobs.list,{})).find(j=>j._id===f.jobId)!
 expect(jobStatus(finished as Task)).toBe('Finished')
 expect(jobSummary(finished as Task)).toBe(operation==='delete'?'Calendar removal verified · Email accepted · delivery unverified':'Calendar updated · Email accepted · delivery unverified')
 expect(finished.clarification).toBe(f.clarification)
})
it.each(['family','source','source-expiry','source-deleted','membership','household'] as const)('records authoritative returned receipts after an external %s change without refreshing stale context',async change=>{
 for(const path of ['finish','reconcile'] as const){
  const f=await fixture(),before=(await f.t.run(ctx=>ctx.db.get(f.id)))!
  if(change==='family')await f.owner.mutation(api.households.save,{timezone:'UTC',children:[{id:'maya',name:'Maya'}]})
  if(change==='source')await f.t.run(ctx=>ctx.db.patch(f.sourceId,{revision:2,text:'Parent corrected the notice.'}))
  if(change==='source-expiry')await f.t.run(ctx=>ctx.db.patch(f.sourceId,{expiresAt:now}))
  if(change==='source-deleted')await f.t.run(ctx=>ctx.db.delete(f.sourceId))
  if(change==='membership')await f.t.run(async ctx=>{const member=await ctx.db.query('memberships').withIndex('by_subject',q=>q.eq('subject','test|parent')).unique();await ctx.db.delete(member!._id)})
  if(change==='household')await f.t.run(ctx=>ctx.db.patch(f.householdId,{deleted:true}))
  expect(await f.valid()).toBe(false)
  await receipt(f,path)
  expect((await f.t.run(ctx=>ctx.db.get(f.calendar._id)))!.status).toBe('succeeded')
  expect(await f.t.run(ctx=>ctx.db.query('receipts').collect())).toHaveLength(1)
  expect(await f.t.run(ctx=>ctx.db.query('planEvents').collect())).toHaveLength(1)
  expect(await f.valid()).toBe(false)
  const after=(await f.t.run(ctx=>ctx.db.get(f.id)))!
  expect(after.refs).toEqual(before.refs);expect(after.contextBindings).toEqual(before.contextBindings)
 }
})
it('retains verified provider evidence after post-dispatch account revocation without enabling another action',async()=>{
 for(const path of ['finish','reconcile'] as const){
  const f=await fixture()
  await f.t.run(ctx=>ctx.db.patch(f.connectionId,{status:'revoked',version:2}))
  await receipt(f,path)
  expect((await f.t.run(ctx=>ctx.db.get(f.calendar._id)))!.status).toBe('succeeded')
  expect(await f.t.run(ctx=>ctx.db.query('receipts').collect())).toHaveLength(1)
  await expect(f.owner.mutation(api.jobs.approve,{actions:[{id:f.email._id,revision:1}]})).rejects.toThrow('Connect')
 }
})
it.each(['finish','reconcile'] as const)('never refreshes context on a duplicate %s receipt after a later external change',async path=>{
 const f=await fixture();await receipt(f,path)
 const before=(await f.t.run(ctx=>ctx.db.get(f.id)))!
 await f.owner.mutation(api.households.save,{timezone:'UTC',children:[{id:'maya',name:'Maya'}]})
 expect(await f.valid()).toBe(false)
 await receipt(f,path)
 expect(await f.valid()).toBe(false)
 expect((await f.t.run(ctx=>ctx.db.get(f.id)))!.refs).toEqual(before.refs)
 expect(await f.t.run(ctx=>ctx.db.query('receipts').collect())).toHaveLength(1)
})
it('leaves context fingerprints unchanged when no calendar effect was verified',async()=>{
 for(const status of ['failed','uncertain'] as const){
  const f=await fixture(),before=(await f.t.run(ctx=>ctx.db.get(f.id)))!
  await f.t.mutation(internal.execution.finish,{attemptId:f.claim.attemptId,status,error:'Synthetic response without verified evidence'})
  expect(await f.valid()).toBe(true)
  expect((await f.t.run(ctx=>ctx.db.get(f.id)))!.refs).toEqual(before.refs)
  expect(await f.t.run(ctx=>ctx.db.query('planEvents').collect())).toEqual([])
  expect(await f.t.run(ctx=>ctx.db.query('receipts').collect())).toEqual([])
 }
})
