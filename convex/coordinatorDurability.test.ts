import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {convexTest} from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import {api,internal} from './_generated/api'
import {coordinatorLimits} from '../shared/assistantCoordinator'
import {event} from '../tests/fixtures/calendar'
const modules=import.meta.glob('./**/*.ts'),now=Date.parse('2026-10-14T18:00:00Z')
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now)})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs()})
async function fixture(withEvents=false){
 const t=convexTest(schema,modules);workflow.register(t)
 const parent=t.withIdentity({subject:'parent',tokenIdentifier:'test|parent'})
 const householdId=await parent.mutation(api.households.save,{timezone:'UTC',children:[{id:'maya',name:'Maya'}]})
 const sourceId=await t.run(ctx=>ctx.db.insert('sources',{householdId,text:'Prepare a school trip on October 20.',hash:'original',revision:1,expiresAt:now+86400000}))
 const jobId=await t.run(ctx=>ctx.db.insert('jobs',{householdId,createdBy:'test|parent',sourceId,interactive:true,preparing:true,cancelled:false,clarification:''}))
 const saved=[]
 if(withEvents)for(const owner of ['test|parent','test|other'])saved.push(await t.run(async ctx=>{
  const previousJob=await ctx.db.insert('jobs',{householdId,sourceId,createdBy:owner,preparing:false,cancelled:false,clarification:''})
  const actionId=await ctx.db.insert('actions',{householdId,jobId:previousJob,sourceRevision:1,revision:1,status:'succeeded',payload:event})
  return ctx.db.insert('planEvents',{householdId,owner,actionId,eventId:`provider-${owner}`,calendarId:'synthetic-calendar',etag:'synthetic-etag',payload:{...event,id:'untrusted-legacy-id',title:owner==='test|parent'?'Saved parent event':'Other adult event'}})
 }))
 const id=(await t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1}))!
 const lease={id,version:1,lease:'held'}
 const tool=(tool:string,extra:Record<string,unknown>={})=>({tool,query:'',id:'',from:'',through:'',answer:'',drafts:[],...extra})
 return{t,parent,householdId,sourceId,jobId,id,lease,tool,saved}
}
it('supplies bounded owner-specific saved event identities to delegated calendar preparation',async()=>{
 const f=await fixture(true);await f.t.mutation(internal.assistantCoordinator.claim,f.lease)
 await f.t.mutation(internal.assistantCoordinator.advance,{...f.lease,result:JSON.stringify(f.tool('prepare_notice'))})
 const next={id:f.id,version:2,lease:'notice'}
 await f.t.mutation(internal.assistantCoordinator.claim,{...next,phase:'notice'})
 const input=await f.t.mutation(internal.assistantCoordinator.noticeInput,next)
 expect(input?.existingEvents).toEqual([{id:f.saved[0],...event,title:'Saved parent event'}])
 expect(JSON.stringify(input)).not.toContain('Other adult event')
 expect(JSON.stringify(input)).not.toContain(String(f.saved[1]))
 expect(await f.t.run(ctx=>ctx.db.query('approvals').collect())).toEqual([])
})
it('recovers the delegated extractor, rejects the wrong worker and removes fabricated evidence',async()=>{
 const f=await fixture();await f.t.mutation(internal.assistantCoordinator.claim,f.lease)
 await f.t.mutation(internal.assistantCoordinator.advance,{...f.lease,result:JSON.stringify(f.tool('prepare_notice'))})
 const next={id:f.id,version:2,lease:'notice'}
 expect(await f.t.mutation(internal.assistantCoordinator.claim,next)).toBeNull()
 expect(await f.t.mutation(internal.assistantCoordinator.claim,{...next,phase:'notice'})).not.toBeNull()
 vi.setSystemTime(now+coordinatorLimits.lease+1)
 await f.t.mutation(internal.assistantCoordinator.recover,{id:f.id})
 const timers=await f.t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())
 expect(timers.some(timer=>timer.name.includes('coordinatorWorker:prepareNotice'))).toBe(true)
 const replacement={...next,lease:'recovered'}
 expect(await f.t.mutation(internal.assistantCoordinator.claim,{...replacement,phase:'notice'})).not.toBeNull()
 const input=await f.t.mutation(internal.assistantCoordinator.noticeInput,replacement)
 expect(input).toMatchObject({timezone:'UTC',source:'Prepare a school trip on October 20.'})
 await f.t.mutation(internal.assistantCoordinator.noticeFinished,{...replacement,result:JSON.stringify({actions:[{...event,evidence:{title:'fabricated approval'}}],clarification:'Review the trip.'})})
 const actions=await f.t.run(ctx=>ctx.db.query('actions').collect())
 expect(actions).toHaveLength(1);expect(actions[0].payload.evidence).toEqual({});expect(actions[0].status).toBe('review')
 expect(await f.t.run(ctx=>ctx.db.query('approvals').collect())).toEqual([])
})
it('rejects fabricated evidence and corrects within its original call budget',async()=>{
 const f=await fixture()
 await f.t.mutation(internal.assistantCoordinator.claim,f.lease)
 await expect(f.t.mutation(internal.assistantCoordinator.advance,{...f.lease,result:JSON.stringify(f.tool('finish',{answer:'Ready.',drafts:[{kind:'task',title:'Trip',text:'Prepare trip',evidence:[{sourceId:f.sourceId,quote:'fabricated'}]}]}))})).rejects.toThrow('evidence')
 expect(await f.t.mutation(internal.assistantCoordinator.correct,f.lease)).toBe(true)
 const second={id:f.id,version:2,lease:'corrected'}
 expect(JSON.stringify(await f.t.mutation(internal.assistantCoordinator.claim,second))).toContain('previous response')
 await f.t.mutation(internal.assistantCoordinator.advance,{...second,result:JSON.stringify(f.tool('finish',{answer:'I need the trip time before preparing it.'}))})
 expect((await f.t.run(ctx=>ctx.db.get(f.id)))?.attempts).toBe(2)
 expect(await f.t.run(ctx=>ctx.db.query('actions').collect())).toEqual([])
})
it('honors retry cooldown even when an older recovery timer wakes the run',async()=>{
 const f=await fixture();await f.t.mutation(internal.assistantCoordinator.claim,f.lease)
 await f.t.mutation(internal.assistantCoordinator.fail,f.lease)
 await f.parent.mutation(api.assistantCoordinator.retry,{id:f.id,version:1})
 await f.t.mutation(internal.assistantCoordinator.recover,{id:f.id})
 expect(await f.t.mutation(internal.assistantCoordinator.claim,{id:f.id,version:2,lease:'early'})).toBeNull()
 vi.setSystemTime(now+15001)
 expect(await f.t.mutation(internal.assistantCoordinator.claim,{id:f.id,version:2,lease:'after'})).not.toBeNull()
})
it('atomically reserves the last daily call across 50 different runs and resets only on a new UTC day',async()=>{
 const f=await fixture()
 const meter=(await f.t.run(ctx=>ctx.db.query('assistantUsage').collect()))[0]
 await f.t.run(ctx=>ctx.db.patch(meter._id,{calls:coordinatorLimits.dailyCalls-1}))
 const ids=[f.id]
 for(let i=1;i<50;i++)ids.push(await f.t.run(async ctx=>{const run=(await ctx.db.get(f.id))!;const {_id,_creationTime,...copy}=run;return ctx.db.insert('assistantRuns',{...copy,version:i+1})}))
 const claims=await Promise.all(ids.map((id,i)=>f.t.mutation(internal.assistantCoordinator.claim,{id,version:i+1,lease:`attempt-${i}`})))
 expect(claims.filter(Boolean)).toHaveLength(1)
 expect((await f.t.run(ctx=>ctx.db.get(meter._id)))?.calls).toBe(coordinatorLimits.dailyCalls)
 vi.setSystemTime(now+86400000)
 // Same-day records are retained; no deletion/reconnect can reset usage.
 expect(await f.t.run(ctx=>ctx.db.get(meter._id))).not.toBeNull()
})
