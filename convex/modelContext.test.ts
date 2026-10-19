import { expect, it } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api } from './_generated/api'
import { modelContextLimits, modelHouseholdContext } from './modelContext'
import { event } from '../tests/fixtures/calendar'

const modules = import.meta.glob('./**/*.ts')
async function fixture() {
  const t = convexTest(schema, modules), parent = t.withIdentity({ subject: 'parent', tokenIdentifier: 'test|parent' })
  const householdId = await parent.mutation(api.households.save, { timezone: 'UTC', children: [] })
  const actionId = await t.run(async ctx => {
    const sourceId = await ctx.db.insert('sources', { householdId, text: 'Synthetic notice', revision: 1, hash: 'synthetic', expiresAt: Date.now() + 86400_000 })
    const jobId = await ctx.db.insert('jobs', { householdId, sourceId, createdBy: 'test|parent', preparing: false, cancelled: false, clarification: '' })
    return ctx.db.insert('actions', { householdId, jobId, sourceRevision: 1, revision: 1, payload: event, status: 'review' })
  })
  return { t, parent, householdId, actionId }
}
it('bounds large household context, excludes unconfirmed facts and other adults’ events, and reports partial coverage', async () => {
  const f = await fixture()
  await f.t.run(async ctx => {
    for (let i = 0; i < 90; i++) {
      await ctx.db.insert('memoryFacts', { householdId: f.householdId, key: `fact-${i}`, value: { kind: 'school', school: `School ${i}` }, source: 'confirmed', scope: 'household', confirmed: true, updatedAt: i, version: 1 })
      await ctx.db.insert('caregivers', { householdId: f.householdId, name: `Caregiver ${i}`, email: `caregiver-${i}@example.test`, childIds: [] })
      await ctx.db.insert('planEvents', { householdId: f.householdId, owner: 'test|parent', actionId: f.actionId, eventId: `parent-${i}`, calendarId: 'synthetic', etag: 'synthetic', payload: event })
      await ctx.db.insert('planEvents', { householdId: f.householdId, owner: 'test|other', actionId: f.actionId, eventId: `other-${i}`, calendarId: 'synthetic', etag: 'synthetic', payload: { ...event, title: 'Other adult event' } })
    }
    await ctx.db.insert('memoryFacts', { householdId: f.householdId, key: 'unconfirmed', value: { private: 'Unconfirmed suggestion' }, source: 'model', scope: 'household', confirmed: false, updatedAt: Date.now() + 1000, version: 1 })
  })
  const context = await f.t.run(ctx => modelHouseholdContext(ctx, f.householdId, 'test|parent'))
  expect(context.facts).toHaveLength(modelContextLimits.facts)
  expect(context.caregivers).toHaveLength(modelContextLimits.caregivers)
  expect(context.plan).toHaveLength(modelContextLimits.events)
  expect(context.modelCoverage).toMatchObject({ limited: true, limits: { facts: true, caregivers: true, events: true } })
  expect(context.facts.every(f => f.confirmed)).toBe(true)
  expect(context.plan.every(p => p.owner === 'test|parent')).toBe(true)
  expect(JSON.stringify(context)).not.toMatch(/Other adult event|Unconfirmed suggestion/)
})
it('keeps an explicitly revised old event within the bounded list and refuses another adult’s target', async () => {
  const f = await fixture()
  const targets = await f.t.run(async ctx => {
    const create = (owner: string, eventId: string) => ctx.db.insert('planEvents', { householdId: f.householdId, owner, actionId: f.actionId, eventId, calendarId: 'synthetic', etag: 'synthetic', payload: event })
    const old = await create('test|parent', 'old-target'), other = await create('test|other', 'other-target')
    for (let i = 0; i < 50; i++) await create('test|parent', `recent-${i}`)
    return { old, other }
  })
  const context = await f.t.run(ctx => modelHouseholdContext(ctx, f.householdId, 'test|parent', targets.old))
  expect(context.plan).toHaveLength(modelContextLimits.events)
  expect(context.plan.some(p => p._id === targets.old)).toBe(true)
  const forbidden = await f.t.run(ctx => modelHouseholdContext(ctx, f.householdId, 'test|parent', targets.other))
  expect(forbidden.plan.some(p => p._id === targets.other)).toBe(false)
  const malformed = await f.t.run(ctx => modelHouseholdContext(ctx, f.householdId, 'test|parent', 'not-an-id'))
  expect(malformed.plan).toHaveLength(modelContextLimits.events)
})
it('does not describe a small saved plan as full external calendar coverage', async () => {
  const f = await fixture(), context = await f.t.run(ctx => modelHouseholdContext(ctx, f.householdId, 'test|parent'))
  expect(context.modelCoverage.limited).toBe(false)
  expect(context.modelCoverage.description).toContain('no full external calendar')
})
