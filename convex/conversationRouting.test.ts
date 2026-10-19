import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import workflow from '@convex-dev/workflow/test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic'); vi.stubEnv('DAYMARK_MODEL', 'synthetic') })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function fixture() {
  const t = convexTest(schema, modules); workflow.register(t)
  const owner = t.withIdentity({ subject: 'owner', tokenIdentifier: 'test|owner' })
  await owner.mutation(api.households.save, { timezone: 'UTC', children: [] })
  return { t, owner }
}
it.each(['What needs my attention?', 'What are you working on?', 'What is on my calendar today?'])('uses connected reasoning rather than an incomplete canned summary for %s', async text => {
  const { t, owner } = await fixture(), id = await owner.mutation(api.jobs.submit, { text })
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ interactive: true, preparing: true, clarification: '' })
  expect(await t.run(ctx => ctx.db.query('approvals').collect())).toEqual([])
})
it('retains atomic task acknowledgments as private follow-up context without another model call', async () => {
  const { t, owner } = await fixture(), request = 'Add pack swim bag to my tasks'
  const first = await owner.mutation(api.jobs.submit, { text: request })
  expect(await t.run(ctx => ctx.db.get(first))).toMatchObject({ interactive: true, preparing: false, conversation: true })
  expect(await t.run(ctx => ctx.db.query('personalTasks').collect())).toHaveLength(1)
  vi.setSystemTime(Date.now() + 1000)
  const next = await owner.mutation(api.jobs.submit, { text: 'Rename that task to Pack sports bag.' })
  const context = await t.query(internal.jobs.context, { jobId: next })
  expect(context!.assistant!.history).toEqual(expect.arrayContaining([expect.objectContaining({ request, response: expect.stringContaining('pack swim bag') })]))
  const outsider = t.withIdentity({ subject: 'other', tokenIdentifier: 'test|other' })
  await outsider.mutation(api.households.save, { timezone: 'UTC', children: [] })
  expect(await outsider.query(api.jobs.list, {})).toEqual([])
})
it('keeps the truthful saved-record fallback available when no model is configured', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  const { t, owner } = await fixture(), id = await owner.mutation(api.jobs.submit, { text: 'What needs my attention?' })
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ preparing: false, conversation: true })
  expect((await owner.query(api.jobs.list, {}))[0].clarification).toContain('saved tasks')
})
