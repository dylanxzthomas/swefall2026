import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalStore, type Persistence } from '../../web/src/mobile/store.js'
import type { Capture, HouseholdItem, HouseholdState } from '../../shared/household.js'
const task = { kind: 'task', title: 'Return form', date: null, time: null, duration: 30, owner: 'parent', person: null, notes: '' }
function memory() { let value: string | null = null; const storage: Persistence = { read: async () => value, write: async v => { value = v } }; return storage }
test('phone writes survive reopening; concurrent additions preserve both items', async () => {
  const storage = memory(), app = createLocalStore(storage)
  await Promise.all([app.request('/items', 'POST', task), app.request('/items', 'POST', { ...task, title: 'Pickup' })])
  const reopened = createLocalStore(storage)
  const data = await reopened.request<HouseholdState>()
  assert.equal(data.items.length, 2)
  const item = data.items[0]
  await reopened.request(`/items/${item.id}`, 'PUT', { ...item, done: true })
  assert.equal((await createLocalStore(storage).request<HouseholdState>()).items[0].done, true)
})
test('approval is atomic and idempotent; invalid assignments cannot alter local data', async () => {
  const app = createLocalStore(memory())
  const capture = await app.request<Capture>('/capture', 'POST', { text: 'Task: Return form' })
  await assert.rejects(app.request(`/captures/${capture.id}/approve`, 'POST', { items: [task, { ...task, owner: 'unknown' }] }))
  assert.equal((await app.request<HouseholdState>()).items.length, 0)
  await app.request(`/captures/${capture.id}/approve`, 'POST', { items: [task] })
  await app.request(`/captures/${capture.id}/approve`, 'POST', { items: [task] })
  assert.equal((await app.request<HouseholdState>()).items.length, 1)
})
test('failed durable write reports failure and queue recovers without corrupting data', async () => {
  let fail = false
  const memoryStore = memory()
  const app = createLocalStore({ read: memoryStore.read, write: async v => { if (fail) throw new Error('Disk full'); await memoryStore.write(v) } })
  const item = await app.request<HouseholdItem>('/items', 'POST', task)
  fail = true
  await assert.rejects(app.request(`/items/${item.id}`, 'PUT', { ...item, done: true }), /Disk full/)
  assert.equal((await app.request<HouseholdState>()).items[0].done, false)
  fail = false
  await app.request(`/items/${item.id}`, 'DELETE')
  assert.equal((await app.request<HouseholdState>()).items.length, 0)
})
