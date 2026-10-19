import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-14T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
async function fixture() {
  const t = convexTest(schema, modules), owner = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' }), other = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' }), outsider = t.withIdentity({ subject: 'outsider', tokenIdentifier: 'test|outsider' })
  workflow.register(t)
  const householdId = await owner.mutation(api.households.save, { timezone: 'UTC', children: [] })
  await t.run(ctx => ctx.db.insert('memberships', { householdId, subject: 'test|other', role: 'adult' }))
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text: 'Raw synthetic private email content never copied into the task.', hash: 'synthetic', revision: 1, expiresAt: now + 30 * 60000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, conversation: true, clarification: 'Synthetic reviewed follow-up.' }))
  const runId = await t.run(ctx => ctx.db.insert('assistantRuns', { householdId, createdBy: 'test|parent', jobId, sourceId, sourceRevision: 1, sourceHash: 'synthetic', version: 1, status: 'complete', step: 1, attempts: 1, used: [], observations: '[]', refs: [], createdAt: now, expiresAt: now + 30 * 60000 }))
  const args = { householdId, subject: 'test|parent', key: `${runId}:0`, title: 'Pack school lunch', text: 'Pack lunch before the school trip.', done: false }
  const keep = () => t.mutation(internal.privateTasks.keep, args)
  return { t, owner, other, outsider, householdId, sourceId, jobId, runId, args, keep }
}
it('keeps only explicitly reviewed minimal task text and survives source/run expiry, removal and revocation', async () => {
  const f = await fixture(), id = await f.keep()
  const connectionId = await f.t.run(ctx => ctx.db.insert('connections', { householdId: f.householdId, subject: 'test|parent', status: 'active', version: 1, scopes: [] }))
  await f.t.run(async ctx => { await ctx.db.patch(connectionId, { status: 'revoked', version: 2 }); await ctx.db.delete(f.sourceId); await ctx.db.delete(f.runId) })
  vi.setSystemTime(now + 40 * 86400000)
  const result = await f.owner.query(api.privateTasks.list, {})
  expect(result.tasks).toEqual([{ id, title: f.args.title, text: f.args.text, done: false, version: 1, createdAt: now, updatedAt: now }])
  expect(result.limited).toBe(false)
  const row = (await f.t.run(ctx => ctx.db.get(id)))!
  for (const field of ['sourceId', 'runId', 'evidence', 'mailContext', 'observations', 'expiresAt', 'rawText']) expect(row).not.toHaveProperty(field)
  expect(JSON.stringify(row)).not.toContain('Raw synthetic private email')
  expect(await f.t.run(ctx => ctx.db.query('personalTasks').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
})
it('enforces private ownership in same and separate households, including authentication and lost access', async () => {
  const f = await fixture(), id = await f.keep()
  for (const client of [f.other, f.outsider]) {
    expect((await client.query(api.privateTasks.list, {})).tasks).toEqual([])
    await expect(client.mutation(api.privateTasks.update, { id, version: 1, title: 'Changed', text: 'Changed.' })).rejects.toThrow('unavailable')
    await expect(client.mutation(api.privateTasks.setDone, { id, version: 1, done: true })).rejects.toThrow('unavailable')
    await expect(client.mutation(api.privateTasks.remove, { id, version: 1 })).rejects.toThrow('unavailable')
  }
  await expect(f.t.query(api.privateTasks.list, {})).rejects.toThrow('Sign in')
  await f.t.run(async ctx => ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique())!._id))
  await expect(f.keep()).rejects.toThrow('access changed')
  await expect(f.owner.mutation(api.privateTasks.remove, { id, version: 1 })).rejects.toThrow('household')
})
it('coalesces fifty reviewed keeps and never overwrites a later private edit with an old retry', async () => {
  const f = await fixture(), ids = await Promise.all(Array.from({ length: 50 }, f.keep))
  expect(new Set(ids).size).toBe(1); const id = ids[0]
  expect(await f.owner.mutation(api.privateTasks.update, { id, version: 1, title: 'Pack two lunches', text: 'Pack both children’s lunches.' })).toBe(2)
  expect(await f.keep()).toBe(id)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks[0]).toMatchObject({ title: 'Pack two lunches', version: 2 })
  await expect(f.t.mutation(internal.privateTasks.keep, { ...f.args, text: 'Different reviewed text.' })).rejects.toThrow('already kept')
})
it('checks exact versions for edit/completion/reopening and preserves parent completion across repeated keeps', async () => {
  const f = await fixture(), id = await f.keep()
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => f.owner.mutation(api.privateTasks.setDone, { id, version: 1, done: true })))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  await f.keep(); expect((await f.owner.query(api.privateTasks.list, {})).tasks[0]).toMatchObject({ done: true, version: 2 })
  await expect(f.owner.mutation(api.privateTasks.update, { id, version: 1, title: 'Old edit', text: 'Old.' })).rejects.toThrow('changed')
  expect(await f.owner.mutation(api.privateTasks.setDone, { id, version: 2, done: false })).toBe(3)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks[0].done).toBe(false)
})
it('erases removed task text, prevents resurrection, and permits full account deletion without a source dependency', async () => {
  const f = await fixture(), id = await f.keep()
  await f.owner.mutation(api.privateTasks.remove, { id, version: 1 })
  expect(await f.keep()).toBe(id)
  expect((await f.owner.query(api.privateTasks.list, {})).tasks).toEqual([])
  expect(await f.t.run(ctx => ctx.db.get(id))).toMatchObject({ title: '', text: '', removed: true, version: 2 })
  await expect(f.owner.mutation(api.privateTasks.update, { id, version: 2, title: 'Revive', text: 'Old text.' })).rejects.toThrow('unavailable')
  await f.t.run(async ctx => { for (const row of await ctx.db.query('privateTasks').withIndex('by_household', q => q.eq('householdId', f.householdId)).collect()) await ctx.db.delete(row._id) })
  expect(await f.t.run(ctx => ctx.db.query('privateTasks').collect())).toEqual([])
})
it('requires valid reviewed text and rejects unsupported provenance fields or invalid review identities', async () => {
  const f = await fixture()
  for (const change of [{ title: '' }, { text: ' ' }, { text: 'x'.repeat(10001) }, { key: 'not-a-reviewed-draft' }]) await expect(f.t.mutation(internal.privateTasks.keep, { ...f.args, ...change })).rejects.toThrow()
  await expect(f.t.mutation(internal.privateTasks.keep, { ...f.args, rawEmail: 'Synthetic raw body' } as any)).rejects.toThrow()
  expect(await f.t.run(ctx => ctx.db.query('privateTasks').collect())).toEqual([])
})
it('keeps a real coordinator review once, independently of its source, and removes the ephemeral task card', async () => {
  const f = await fixture(), text = 'Return the permission form by Friday.'
  const sourceId = await f.t.run(ctx => ctx.db.insert('sources', { householdId:f.householdId,text,hash:'new-turn',revision:1,expiresAt:now+30*60000 }))
  const jobId = await f.t.run(ctx => ctx.db.insert('jobs', {householdId:f.householdId,sourceId,createdBy:'test|parent',interactive:true,preparing:true,cancelled:false,clarification:''}))
  const id=(await f.t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1}))!,lease={id,version:1,lease:'private-keep'}
  await f.t.mutation(internal.assistantCoordinator.claim,lease)
  await f.t.mutation(internal.assistantCoordinator.advance,{...lease,result:JSON.stringify({tool:'finish',query:'',id:'',from:'',through:'',answer:'Here is your private task for review.',drafts:[{kind:'task',title:'Return the permission form',text,evidence:[{sourceId,quote:'Return the permission form'}]}]})})
  const review={id,version:1,index:0,text:'Return only the signed form on Friday.',operation:'keep' as const}
  await expect(f.other.mutation(api.assistantCoordinator.review,review)).rejects.toThrow('unavailable')
  const ids=await Promise.all(Array.from({length:50},()=>f.owner.mutation(api.assistantCoordinator.review,review)))
  expect(new Set(ids).size).toBe(1)
  const saved=(await f.owner.query(api.privateTasks.list,{})).tasks
  expect(saved).toHaveLength(1);expect(saved[0].text).toBe(review.text)
  const run=await f.t.run(ctx=>ctx.db.get(id))
  expect(run!.deliverables![0].privateTaskId).toBe(saved[0].id)
  expect((await f.owner.query(api.assistantCoordinator.list,{})).flatMap(r=>r.drafts).filter(d=>d.kind==='task'&&!d.privateTaskId)).toEqual([])
  vi.setSystemTime(now+31*60000)
  expect((await f.owner.query(api.privateTasks.list,{})).tasks).toHaveLength(1)
  await f.owner.mutation(api.privateTasks.remove,{id:saved[0].id as any,version:1})
  await f.owner.mutation(api.assistantCoordinator.review,review)
  expect((await f.owner.query(api.privateTasks.list,{})).tasks).toEqual([])
})
it('includes private saved tasks only in the owning adult’s conversation and invalidates pending context after edits',async()=>{
  const f=await fixture();const taskId=await f.keep()
  const makeJob=async(subject:string,text:string)=>{const sourceId=await f.t.run(ctx=>ctx.db.insert('sources',{householdId:f.householdId,text,hash:`turn-${subject}`,revision:1,expiresAt:now+86400000}));return f.t.run(ctx=>ctx.db.insert('jobs',{householdId:f.householdId,sourceId,createdBy:subject,interactive:true,preparing:true,cancelled:false,clarification:''}))}
  const jobId=await makeJob('test|parent','What responsibilities should I handle?'),otherJob=await makeJob('test|other','What responsibilities should I handle?')
  expect(JSON.stringify((await f.t.query(internal.jobs.context,{jobId}))!.assistant)).toContain(f.args.title)
  expect(JSON.stringify((await f.t.query(internal.jobs.context,{jobId:otherJob}))!.assistant)).not.toContain(f.args.title)
  const notice=await makeJob('test|parent','Event: Family appointment\nDate: 2026-10-20\nTime: 10 AM to 11 AM')
  const shared=await f.t.query(internal.jobs.context,{jobId:notice})
  expect(JSON.stringify(shared!.assistant)).not.toContain(f.args.title)
  expect(JSON.stringify(shared!.facts)).not.toContain(f.args.title)
  const id=(await f.t.mutation(internal.assistantCoordinator.start,{jobId,sourceRevision:1}))!,lease={id,version:1,lease:'private-context'}
  await f.t.mutation(internal.assistantCoordinator.claim,lease)
  await f.owner.mutation(api.privateTasks.update,{id:taskId,version:1,title:'Updated lunch plan',text:'Updated details.'})
  expect(await f.t.mutation(internal.assistantCoordinator.advance,{...lease,result:JSON.stringify({tool:'finish',query:'',id:'',from:'',through:'',answer:'Old lunch details.',drafts:[]})})).toBe(false)
})
