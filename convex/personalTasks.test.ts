import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convexTest } from 'convex-test'
import schema from './schema'
import { api, internal } from './_generated/api'
const modules = import.meta.glob('./**/*.ts')
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
async function fixture() {
  const t = convexTest(schema, modules), alice = t.withIdentity({ subject: 'alice', tokenIdentifier: 'test|alice' }), bob = t.withIdentity({ subject: 'bob', tokenIdentifier: 'test|bob' })
  const householdId = await alice.mutation(api.households.save, { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] })
  await bob.mutation(api.households.save, { timezone: 'UTC', children: [] })
  return { t, alice, bob, householdId }
}
const input = { requestId: 'synthetic-request', title: 'Pack the library books', notes: 'In the blue bag', childId: 'maya', dueDate: '2026-10-08' }

it('creates one household-scoped personal task for retries without any assistant execution', async () => {
  const f = await fixture(), id = await f.alice.mutation(api.personalTasks.create, input)
  expect(await f.alice.mutation(api.personalTasks.create, input)).toBe(id)
  await expect(f.alice.mutation(api.personalTasks.create, { ...input, title: 'Changed request' })).rejects.toThrow('different task')
  expect(await f.alice.query(api.personalTasks.list, {})).toEqual([{ id, title: input.title, notes: input.notes, childId: 'maya', dueDate: input.dueDate, done: false, version: 1, createdAt: Date.now(), updatedAt: Date.now() }])
  expect(await f.bob.query(api.personalTasks.list, {})).toEqual([])
  await expect(f.t.query(api.personalTasks.list, {})).rejects.toThrow('Sign in')
  await expect(f.bob.mutation(api.personalTasks.setDone, { id, version: 1, done: true })).rejects.toThrow('unavailable')
  await expect(f.bob.mutation(api.personalTasks.update, { id, version: 1, changes: { title: input.title, notes: input.notes } })).rejects.toThrow('unavailable')
  await expect(f.bob.mutation(api.personalTasks.remove, { id, version: 1 })).rejects.toThrow('unavailable')
  expect(await f.t.run(async ctx => ({ jobs: await ctx.db.query('jobs').collect(), actions: await ctx.db.query('actions').collect(), scheduled: await ctx.db.system.query('_scheduled_functions').collect() }))).toEqual({ jobs: [], actions: [], scheduled: [] })
})

it('rejects stale edits/completion/removal, supports reopening, and clears optional fields explicitly', async () => {
  const f = await fixture(), id = await f.alice.mutation(api.personalTasks.create, input)
  await f.alice.mutation(api.personalTasks.setDone, { id, version: 1, done: true })
  for (const operation of [() => f.alice.mutation(api.personalTasks.setDone, { id, version: 1, done: false }), () => f.alice.mutation(api.personalTasks.update, { id, version: 1, changes: { title: input.title, notes: '' } }), () => f.alice.mutation(api.personalTasks.remove, { id, version: 1 })]) await expect(operation()).rejects.toThrow('changed')
  await f.alice.mutation(api.personalTasks.setDone, { id, version: 2, done: false })
  await f.alice.mutation(api.personalTasks.update, { id, version: 3, changes: { title: '  Library books  ', notes: '' } })
  const task = (await f.alice.query(api.personalTasks.list, {}))[0]
  expect(task).toMatchObject({ title: 'Library books', done: false, version: 4 })
  expect(task.dueDate).toBeUndefined(); expect(task.childId).toBeUndefined()
  await f.alice.mutation(api.personalTasks.remove, { id, version: 4 })
  expect(await f.alice.query(api.personalTasks.list, {})).toEqual([])
  expect(await f.alice.mutation(api.personalTasks.create, input)).toBe(id)
  expect(await f.alice.query(api.personalTasks.list, {})).toEqual([])
  await expect(f.alice.mutation(api.personalTasks.setDone, { id, version: 5, done: true })).rejects.toThrow('unavailable')
  const tombstone = await f.t.run(ctx => ctx.db.get(id))
  expect(tombstone).toMatchObject({ removed: true, title: '', notes: '' })
  expect(tombstone?.childId).toBeUndefined(); expect(tombstone?.dueDate).toBeUndefined()
})

it('validates dates, titles, children, and request identity before saving', async () => {
  const f = await fixture()
  for (const changes of [{ title: ' ' }, { title: 'x'.repeat(201) }, { dueDate: '2026-02-30' }, { childId: 'outside-household' }, { requestId: '' }]) await expect(f.alice.mutation(api.personalTasks.create, { ...input, ...changes })).rejects.toThrow()
  expect(await f.alice.query(api.personalTasks.list, {})).toEqual([])
  const id = await f.alice.mutation(api.personalTasks.create, input)
  await expect(f.alice.mutation(api.personalTasks.update, { id, version: 1, changes: { title: input.title, notes: '', childId: 'outside-household' } })).rejects.toThrow('Choose a child')
})

it('keeps household names separate from family settings and removes personal tasks on household deletion', async () => {
  const f = await fixture(), id = await f.alice.mutation(api.personalTasks.create, input)
  const other = await f.bob.mutation(api.personalTasks.create, { requestId: input.requestId, title: 'Another household’s task', notes: '' })
  await f.alice.mutation(api.households.saveName, { name: '  Maple household  ' })
  await f.alice.mutation(api.households.save, { timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  expect(await f.alice.query(api.households.current, {})).toMatchObject({ name: 'Maple household', timezone: 'America/Los_Angeles', children: [{ id: 'maya', name: 'Maya' }] })
  expect((await f.bob.query(api.households.current, {}))?.name).toBeUndefined()
  await expect(f.alice.mutation(api.households.saveName, { name: ' ' })).rejects.toThrow()
  await expect(f.alice.mutation(api.households.saveName, { name: 'x'.repeat(81) })).rejects.toThrow()
  await f.alice.mutation(api.privacy.deleteAccount, { confirmation: 'DELETE' })
  await expect(f.alice.query(api.personalTasks.list, {})).rejects.toThrow('unavailable')
  await expect(f.alice.mutation(api.personalTasks.setDone, { id, version: 1, done: true })).rejects.toThrow('unavailable')
  const deletion = (await f.t.run(ctx => ctx.db.query('deletionJobs').collect()))[0]
  await f.t.mutation(internal.privacy.eraseHousehold, { householdId: f.householdId, jobId: deletion._id })
  expect(await f.t.run(ctx => ctx.db.get(id))).toBeNull()
  expect((await f.bob.query(api.personalTasks.list, {}))[0].id).toBe(other)
})
