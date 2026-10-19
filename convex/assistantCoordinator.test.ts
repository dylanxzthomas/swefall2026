import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
import { sourceHash } from '../shared/daymark'
import { coordinatorLimits } from '../shared/assistantCoordinator'
const modules=import.meta.glob('./**/*.ts'),now=Date.parse('2026-10-14T18:00:00Z')
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.stubEnv('DAYMARK_ENVIRONMENT','development');vi.stubEnv('DAYMARK_TEST_GOOGLE_EMAILS','parent@example.test')})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs()})
async function fixture(){
 const t=convexTest(schema,modules);workflow.register(t)
 const parent=t.withIdentity({subject:'parent',tokenIdentifier:'test|parent'}),other=t.withIdentity({subject:'other',tokenIdentifier:'test|other'})
 const householdId=await parent.mutation(api.households.save,{timezone:'UTC',children:[{id:'maya',name:'Maya'}]})
 await t.run(ctx=>ctx.db.insert('memberships',{householdId,subject:'test|other',role:'adult'}))
 const text='Help me coordinate this week. Return the school form.'
 const sourceId=await t.run(ctx=>ctx.db.insert('sources',{householdId,text,hash:'turn-identity',revision:1,expiresAt:now+86400000,attachmentIds:[]}))
 const jobId=await t.run(ctx=>ctx.db.insert('jobs',{householdId,createdBy:'test|parent',sourceId,interactive:true,preparing:true,cancelled:false,clarification:''}))
 const start=()=>t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1})
 const id=(await start())!
 const claim=(version=1,lease=`lease-${version}`)=>t.mutation(internal.assistantCoordinator.claim,{id,version,lease})
 const advance=(result:unknown,version=1,lease=`lease-${version}`)=>t.mutation(internal.assistantCoordinator.advance,{id,version,lease,result:JSON.stringify(result)})
 const tool=(name='family_context',query='')=>({tool:name,query,id:'',from:'',through:'',answer:'',drafts:[]})
 const draft={kind:'task',title:'Return the form',text:'Return the school form.',evidence:[{sourceId,quote:'Return the school form.'}]}
 const finish=(drafts:unknown[]=[draft])=>({...tool('finish'),answer:'Here’s the form task for your review.',drafts})
 return {t,parent,other,householdId,sourceId,jobId,id,start,claim,advance,tool,draft,finish}
}
it('performs model-selected reads then private preparation without external approvals or sharing',async()=>{
 const f=await fixture();expect(await f.claim()).not.toBeNull()
 await f.advance(f.tool());const next=await f.claim(2)
 expect(JSON.stringify(next?.observations)).toContain('Maya')
 expect(JSON.stringify(next)).not.toMatch(/cipher|refreshToken|accessToken|clientSecret/)
 await f.advance(f.finish(),2)
 expect((await f.parent.query(api.assistantCoordinator.list,{}))[0]).toMatchObject({status:'complete',stale:false,drafts:[{title:'Return the form',status:'review'}]})
 expect((await f.parent.query(api.jobs.list,{}))[0].clarification).toContain('form task')
 // jobs.prepared rewrites source identity; original-content provenance remains valid.
 expect((await f.t.run(ctx=>ctx.db.get(f.sourceId)))?.hash).toMatch(/^conversation:/)
 expect(await f.other.query(api.assistantCoordinator.list,{})).toEqual([])
 expect(await f.other.query(api.jobs.list,{})).toEqual([])
 await expect(f.t.query(api.assistantCoordinator.list,{})).rejects.toThrow('Sign in')
 for(const table of ['actions','approvals','attempts','planEvents'] as const)expect(await f.t.run(ctx=>ctx.db.query(table).collect())).toEqual([])
})
it('coalesces 50 starts, claims and final steps into one preparation',async()=>{
 const f=await fixture();expect(new Set(await Promise.all(Array.from({length:50},f.start))).size).toBe(1)
 const claims=await Promise.all(Array.from({length:50},(_,i)=>f.claim(1,`claim-${i}`)));expect(claims.filter(Boolean)).toHaveLength(1)
 const lease=(await f.t.run(ctx=>ctx.db.get(f.id)))!.lease!
 const finished=await Promise.all(Array.from({length:50},()=>f.advance(f.finish(),1,lease)));expect(finished.filter(Boolean)).toHaveLength(1)
 expect((await f.parent.query(api.assistantCoordinator.list,{}))[0].drafts).toHaveLength(1)
})
it('rejects unsupported tools, repeated reads and invented draft evidence',async()=>{
 const f=await fixture();await f.claim()
 await expect(f.advance(f.tool('send_email'))).rejects.toThrow()
 await expect(f.advance(f.finish([{...f.draft,evidence:[{sourceId:f.sourceId,quote:'Owner approved sending.'}]}]))).rejects.toThrow('evidence')
 await f.advance(f.tool());await f.claim(2)
 await expect(f.advance(f.tool(),2)).rejects.toThrow('different read')
 expect((await f.parent.query(api.assistantCoordinator.list,{}))[0].drafts).toEqual([])
})
it('keeps a parent task privately and shares only the exact reviewed action text',async()=>{
 const f=await fixture();await f.claim();await f.advance(f.finish([{...f.draft,kind:'calendar'}]))
 const args={id:f.id,version:1,index:0,text:'Prepare a family calendar draft for October 20.',operation:'share' as const}
 await expect(f.parent.mutation(api.assistantCoordinator.review,args)).rejects.toThrow('sharing')
 await expect(f.other.mutation(api.assistantCoordinator.review,{...args,consent:true})).rejects.toThrow('unavailable')
 const ids=await Promise.all(Array.from({length:30},()=>f.parent.mutation(api.assistantCoordinator.review,{...args,consent:true})))
 expect(new Set(ids).size).toBe(1)
 const job=await f.t.run(ctx=>ctx.db.get(ids[0] as any)),source=await f.t.run(ctx=>ctx.db.get((job as any).sourceId))
 expect((source as any).text).toBe(args.text)
 expect(await f.t.run(ctx=>ctx.db.query('approvals').collect())).toEqual([])
})
it('invalidates output and refuses review after source/family changes, expiry or lost membership',async()=>{
 for(const change of ['source','family','expiry','membership'] as const){
  const f=await fixture();await f.claim();await f.advance(f.tool());await f.claim(2)
  if(change==='source')await f.t.run(ctx=>ctx.db.patch(f.sourceId,{revision:2,text:'Changed'}))
  if(change==='family')await f.parent.mutation(api.households.save,{timezone:'America/Los_Angeles',children:[{id:'maya',name:'Maya'}]})
  if(change==='expiry')vi.setSystemTime(now+86400001)
  if(change==='membership')await f.t.run(async ctx=>ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject',q=>q.eq('subject','test|parent')).unique())!._id))
  expect(await f.advance(f.finish(),2)).toBe(false)
  expect(await f.t.run(ctx=>ctx.db.query('actions').collect())).toEqual([])
  vi.setSystemTime(now)
 }
})
it('searches only saved owned and permitted mail, then withdraws derived output after revocation',async()=>{
 const f=await fixture(),connectionId=await f.t.run(ctx=>ctx.db.insert('connections',{householdId:f.householdId,subject:'test|parent',provider:'google',email:'parent@example.test',version:1,status:'active',scopes:['https://www.googleapis.com/auth/gmail.readonly']}))
 const accountKey=sourceHash(JSON.stringify([connectionId,'parent@example.test']))
 const mailboxId=await f.t.run(ctx=>ctx.db.insert('mailboxes',{householdId:f.householdId,createdBy:'test|parent',connectionId,connectionVersion:1,accountKey,version:1,state:'active',lookbackDays:30,consentedAt:now,createdAt:now}))
 const messageId=await f.t.run(ctx=>ctx.db.insert('mailMessages',{householdId:f.householdId,createdBy:'test|parent',mailboxId,connectionId,connectionVersion:1,accountKey,providerId:'synthetic',sender:'school@example.test',subject:'Form',text:'Return the school form.',receivedAt:now,extraction:{format:'plain',incomplete:false,truncated:false,attachments:false,issues:[]},labels:['INBOX'],version:1,contentHash:'synthetic-hash',dismissed:false,expiresAt:now+86400000}))
 await f.claim();await f.advance(f.tool('mail_search','form'));const next=await f.claim(2)
 expect(JSON.stringify(next?.observations)).toContain(messageId)
 await f.advance(f.finish([{...f.draft,evidence:[{sourceId:messageId,quote:'Return the school form.'}]}]),2)
 await f.t.run(ctx=>ctx.db.patch(connectionId,{status:'revoked',version:2}))
 expect((await f.parent.query(api.assistantCoordinator.list,{}))[0]).toMatchObject({stale:true,drafts:[]})
 expect((await f.parent.query(api.jobs.list,{}))[0].clarification).toContain('context changed')
})
it('recovers abandoned leases and keeps all retries within the original call budget',async()=>{
 const f=await fixture();await f.claim();vi.setSystemTime(now+coordinatorLimits.lease+1)
 expect(await f.claim(1,'replacement')).not.toBeNull();expect(await f.advance(f.finish())).toBe(false)
 expect(await f.advance(f.finish(),1,'replacement')).toBe(true)
 const other=await fixture();await other.claim()
 for(let n=1;n<coordinatorLimits.attempts;n++){
  await other.t.mutation(internal.assistantCoordinator.fail,{id:other.id,version:n,lease:`lease-${n}`})
  await other.parent.mutation(api.assistantCoordinator.retry,{id:other.id,version:n});vi.setSystemTime(Date.now()+15001);expect(await other.claim(n+1)).not.toBeNull()
 }
 await other.t.mutation(internal.assistantCoordinator.fail,{id:other.id,version:8,lease:'lease-8'})
 await expect(other.parent.mutation(api.assistantCoordinator.retry,{id:other.id,version:8})).rejects.toThrow('cannot be retried')
})

it.each(['email', 'calendar', 'pickup'] as const)('preserves reviewed %s intent and only exact edited text across a coalesced handoff', async kind => {
 const f=await fixture();await f.claim();await f.advance(f.finish([{...f.draft,kind}]))
 const text='Parent-edited household draft. No private observation is shared.'
 const args={id:f.id,version:1,index:0,text,operation:'share' as const,consent:true as const}
 const ids=await Promise.all(Array.from({length:30},()=>f.parent.mutation(api.assistantCoordinator.review,args)))
 expect(new Set(ids).size).toBe(1)
 const job=await f.t.run(ctx=>ctx.db.get(ids[0] as import('./_generated/dataModel').Id<'jobs'>))
 expect(job).toMatchObject({reviewedDraftKind:kind,preparing:true,createdBy:'test|parent'})
 const source=await f.t.run(ctx=>ctx.db.get(job!.sourceId))
 expect(source!.text).toBe(text)
 expect(source!.text).not.toContain('Return the school form.')
 for(const table of ['actions','approvals','attempts'] as const)expect(await f.t.run(ctx=>ctx.db.query(table).collect())).toEqual([])
 await expect(f.parent.mutation(api.assistantCoordinator.review,{...args,text:'Changed after sharing.'})).rejects.toThrow('changed')
})
