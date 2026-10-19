import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import { ConvexError } from 'convex/values'
import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import schema from './schema'
import { api, internal } from './_generated/api'
import { coordinatorCorrection } from './assistantCoordinator'
import { extractStructured } from '../server/model'
import { modelFailure } from './coordinatorWorker'
import { event } from '../tests/fixtures/calendar'
vi.mock('../server/model', () => ({ extractStructured: vi.fn() }))
const model = vi.mocked(extractStructured), modules = import.meta.glob('./**/*.ts'), now = Date.parse('2026-10-15T18:00:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); model.mockReset(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
const tool = (tool = 'learn_process', changes: Record<string, unknown> = {}) => ({ tool, query: '', lookbackDays: null, id: '', from: '', through: '', answer: '', drafts: [], ...changes })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  const text = 'Maya goes to Oak School. Every Sunday at 7 PM UTC I pack school bags. Propose a school fact and weekly routine for my review.'
  const sourceId = await t.run(ctx => ctx.db.insert('sources', { householdId, text, hash: 'synthetic', revision: 1, expiresAt: now + 86400000 }))
  const jobId = await t.run(ctx => ctx.db.insert('jobs', { householdId, createdBy: 'test|parent', sourceId, interactive: true, preparing: true, cancelled: false, clarification: '' }))
  const id = (await t.mutation(internal.assistantCoordinator.start, { jobId, sourceRevision: 1 }))!
  const step = (version = 1) => t.action(internal.coordinatorWorker.step, { id, version })
  return { t, parent, householdId, sourceId, jobId, id, step }
}
it('transports fixed argument validation feedback and finishes reviewed learning without publishing the read step', async () => {
  const f = await fixture()
  model.mockResolvedValueOnce(tool('learn_process', { query: 'Save the school and weekly routine', answer: 'I will remember this.' }))
  await f.step()
  let run = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(run).toMatchObject({ status: 'queued', version: 2, step: 0, attempts: 1 })
  expect(JSON.parse(run.observations)[0].result.instruction).toContain('learn_process has no arguments')
  expect(run.learnRequested).toBeUndefined()
  model.mockResolvedValueOnce(tool())
  await f.step(2)
  run = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(run).toMatchObject({ status: 'queued', version: 3, step: 1, attempts: 2, learnRequested: true })
  model.mockResolvedValueOnce(tool('finish', { answer: 'I’ll prepare suggestions for your review. Nothing has been remembered or activated.' }))
  await f.step(3)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'complete', step: 2, attempts: 3 })
  expect((await f.t.run(ctx => ctx.db.query('workflowCurations').collect()))[0]).toMatchObject({ status: 'queued' })
  expect((await f.t.run(ctx => ctx.db.query('memoryFacts').collect())).map(fact => fact.key).sort()).toEqual(['children', 'timezone'])
  for (const table of ['routines', 'mailRoutines', 'approvals', 'actions', 'attempts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('fails once on an unknown backend fault without feeding private error text back to the model', async () => {
  const f = await fixture()
  model.mockImplementationOnce(async () => {
    // The claim was valid. This simulates backend state corruption discovered only at commit.
    await f.t.run(ctx => ctx.db.patch(f.id, { observations: 'unparseable synthetic private detail' }))
    return tool()
  })
  await f.step()
  const run = (await f.t.run(ctx => ctx.db.get(f.id)))!, job = (await f.t.run(ctx => ctx.db.get(f.jobId)))!
  expect(run).toMatchObject({ status: 'failed', attempts: 1, step: 0, failureCode: 'backend_failure' })
  expect(run.issue).not.toContain('synthetic private detail')
  expect(job).toMatchObject({ preparing: false, emailPreparationFailed: true })
  await f.step(); expect(model).toHaveBeenCalledTimes(1)
  expect(await f.t.run(ctx => ctx.db.query('workflowCurations').collect())).toEqual([])
})
it('stops repeated recognized validation after two corrections rather than exhausting eight model calls', async () => {
  const f = await fixture(); model.mockResolvedValue(tool('learn_process', { query: 'unsupported' }))
  await f.step(1); await f.step(2); await f.step(3)
  const run = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(run).toMatchObject({ status: 'failed', attempts: 3, step: 0, failureCode: 'model_output' })
  expect(JSON.parse(run.observations)).toHaveLength(2)
  expect(model).toHaveBeenCalledTimes(3)
  expect(await f.t.run(ctx => ctx.db.query('workflowCurations').collect())).toEqual([])
})
it('backs off a provider rate limit without feeding private error text to the model', async () => {
  const f = await fixture(); model.mockRejectedValueOnce(Object.assign(new Error('synthetic provider detail'), { status: 429 }))
  await f.step()
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'queued', version: 2, transientRetries: 1, notBefore: now + 3000, attempts: 1, step: 0, failureCode: 'model_quota', failureStatus: 429, observations: '[]' })
})
it('accepts only the typed validation payload, never matching arbitrary backend error wording', () => {
  expect(coordinatorCorrection(new ConvexError({ code: 'coordinator_validation', reason: 'arguments', message: 'Use supported arguments.' }))).toBe('arguments')
  for (const error of [new Error('Use exact evidence from supplied sources.'), new ConvexError('private finish arguments'), new ConvexError({ code: 'backend_failure', reason: 'format' }), { data: { code: 'coordinator_validation', reason: 'send' } }]) expect(coordinatorCorrection(error)).toBeNull()
})
it('corrects forbidden notice delegation in a private conversation into reviewed learning without sharing context', async () => {
  const f = await fixture()
  await f.t.run(ctx => ctx.db.patch(f.id, { privateOnly: true }))
  model.mockResolvedValueOnce(tool('prepare_notice'))
  await f.step()
  let run = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(run.phase).toBeUndefined()
  expect(JSON.parse(run.observations)[0].result.reason).toBe('private')
  model.mockResolvedValueOnce(tool('learn_process'))
  await f.step(2)
  model.mockResolvedValueOnce(tool('finish', { answer: 'I’ll prepare suggestions for your review.' }))
  await f.step(3)
  run = (await f.t.run(ctx => ctx.db.get(f.id)))!
  expect(run).toMatchObject({ status: 'complete', attempts: 3, learnRequested: true, privateOnly: true })
  expect((await f.t.run(ctx => ctx.db.get(f.jobId)))?.conversation).toBe(true)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toEqual([])
  expect(await f.t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
  expect((await f.t.run(ctx => ctx.db.query('workflowCurations').collect()))[0]).toMatchObject({ status: 'queued' })
})

it('resumes a transient model failure on the same run without repeating a completed read', async () => {
  const f = await fixture()
  model.mockResolvedValueOnce(tool('family_context'))
  await f.step()
  const saved = (await f.t.run(ctx => ctx.db.get(f.id)))!
  model.mockRejectedValueOnce(Object.assign(new Error('private provider detail'), { status: 503 }))
  await f.step(2)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'queued', version: 3, step: 1, attempts: 2, transientRetries: 1, observations: saved.observations, used: saved.used })
  expect(await f.t.run(ctx => ctx.db.get(f.jobId))).toMatchObject({ preparing: true })
  await f.step(2); await f.step(3)
  expect(model).toHaveBeenCalledTimes(2)
  vi.setSystemTime(now + 3000)
  model.mockResolvedValueOnce(tool('finish', { answer: 'The saved household context is ready.' }))
  // Simultaneous recovery triggers still acquire only one lease.
  await Promise.all(Array.from({ length: 20 }, () => f.step(3)))
  expect(model).toHaveBeenCalledTimes(3)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'complete', version: 3, attempts: 3, step: 2, transientRetries: 1 })
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.failureCode).toBeUndefined()
  for (const table of ['actions', 'approvals', 'attempts', 'receipts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('stops automatic recovery after two retries without resetting the run budget', async () => {
  const f = await fixture(); model.mockRejectedValue(Object.assign(new Error('provider text withheld'), { status: 503 }))
  await f.step(1); vi.setSystemTime(now + 3000); await f.step(2); vi.setSystemTime(now + 15000); await f.step(3)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'failed', version: 3, attempts: 3, step: 0, transientRetries: 2, failureCode: 'model_unavailable' })
  await f.step(3); expect(model).toHaveBeenCalledTimes(3)
  expect(await f.t.run(ctx => ctx.db.get(f.jobId))).toMatchObject({ preparing: false, emailPreparationFailed: true })
})
it.each(['cancelled', 'source', 'membership', 'expired'] as const)('does not recover a transient failure after %s changes', async change => {
  const f = await fixture(); model.mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 })); await f.step()
  await f.t.run(async ctx => {
    if (change === 'cancelled') await ctx.db.patch(f.jobId, { cancelled: true })
    if (change === 'source') await ctx.db.patch(f.sourceId, { revision: 2 })
    if (change === 'expired') await ctx.db.patch(f.sourceId, { expiresAt: now })
    if (change === 'membership') await ctx.db.delete((await ctx.db.query('memberships').withIndex('by_subject', q => q.eq('subject', 'test|parent')).unique())!._id)
  })
  vi.setSystemTime(now + 3000); await f.step(2)
  expect(model).toHaveBeenCalledTimes(1)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'cancelled' })
})
it.each([401, 403, 400, 422])('does not retry provider request rejection %s', async status => {
  const f = await fixture(); model.mockRejectedValueOnce(Object.assign(new Error('private provider detail'), { status })); await f.step()
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'failed', attempts: 1, failureCode: 'model_request', failureStatus: status })
})
it('retries only recognized transport errors and never private error-message matches', () => {
  expect(modelFailure(new APIConnectionError({ message: 'withheld' })).transient).toBe(true)
  expect(modelFailure(new APIConnectionTimeoutError({ message: 'withheld' })).transient).toBe(true)
  for (const error of [Object.assign(new Error('withheld'), { name: 'APIConnectionError' }), new Error('APIConnectionError rate limit temporarily unavailable'), new Error('Model connection is not configured.'), Object.assign(new Error('withheld'), { name: 'APIConnectionError', status: 401 })]) expect(modelFailure(error).transient).toBe(false)
})
it('recovers delegated notice preparation without delegating or creating the draft twice', async () => {
  const f = await fixture()
  model.mockResolvedValueOnce(tool('prepare_notice'))
  await f.step(1)
  model.mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 }))
  await f.t.action(internal.coordinatorWorker.prepareNotice, { id: f.id, version: 2 })
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'queued', phase: 'notice', version: 3, step: 1, attempts: 2, transientRetries: 1 })
  vi.setSystemTime(now + 3000)
  model.mockResolvedValueOnce({ actions: [{ ...event, childId: 'maya' }], clarification: '' })
  await Promise.all(Array.from({ length: 20 }, () => f.t.action(internal.coordinatorWorker.prepareNotice, { id: f.id, version: 3 })))
  expect(model).toHaveBeenCalledTimes(3)
  expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'complete', phase: 'notice', version: 3, step: 1, attempts: 3 })
  expect((await f.t.run(ctx => ctx.db.get(f.id)))?.used).toHaveLength(1)
  expect(await f.t.run(ctx => ctx.db.query('actions').collect())).toHaveLength(1)
  expect((await f.t.run(ctx => ctx.db.query('actions').collect()))[0]).toMatchObject({ jobId: f.jobId, status: 'review', revision: 1 })
  for (const table of ['approvals', 'attempts', 'receipts'] as const) expect(await f.t.run(ctx => ctx.db.query(table).collect())).toEqual([])
})
it('keeps existing attempt and daily-call ceilings when a transient retry is due', async () => {
  for (const budget of ['attempts', 'daily'] as const) {
    const f = await fixture()
    if (budget === 'attempts') await f.t.run(ctx => ctx.db.patch(f.id, { attempts: 7 }))
    model.mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 }))
    await f.step()
    if (budget === 'attempts') expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'failed', attempts: 8 })
    else {
      await f.t.run(async ctx => { const usage = (await ctx.db.query('assistantUsage').collect())[0]; await ctx.db.patch(usage._id, { calls: 120 }) })
      vi.setSystemTime(now + 3000); await f.step(2)
      expect(await f.t.run(ctx => ctx.db.get(f.id))).toMatchObject({ status: 'failed', attempts: 1 })
    }
  }
  expect(model).toHaveBeenCalledTimes(2)
})
