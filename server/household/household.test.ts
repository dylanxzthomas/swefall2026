import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HouseholdStore } from './store.js'
import { attention, itemSchema, planText, type ItemInput } from '../../shared/household.js'
import { guidedItems } from './http.js'
const item: ItemInput = { kind: 'event', title: 'School pickup', date: '2026-09-22', time: '15:00', duration: 30, owner: 'parent', person: null, notes: '' }

test('review approval is atomic, idempotent, and persists across restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wren-home-'))
  const file = path.join(dir, 'test.sqlite')
  let store = new HouseholdStore(file)
  try {
    const capture = store.capture('Pickup at 3', [item], [], 'guided')
    assert.equal(store.read().items.length, 0)
    assert.throws(() => store.approve(capture.id, [item, { ...item, owner: 'unknown' }]))
    assert.equal(store.read().items.length, 0)
    store.approve(capture.id, [item]); store.approve(capture.id, [item])
    assert.equal(store.read().items.length, 1)
    store.close(); store = new HouseholdStore(file)
    assert.equal(store.read().items[0].sourceId, capture.id)
    assert.equal(store.read().captures[0].status, 'approved')
  } finally { store.close(); rmSync(dir, { recursive: true }) }
})

test('overlaps honor ownership, duration, completion, and next-seven-day scope', () => {
  const store = new HouseholdStore(':memory:')
  try {
    const a = store.add(item)
    const b = store.add({ ...item, title: 'Work call', time: '15:15' })
    assert.equal(attention(store.read(), '2026-09-22').filter(a => a.kind === 'conflict').length, 1)
    store.update(b.id, { ...b, time: '15:30' }, false)
    assert.equal(attention(store.read(), '2026-09-22').filter(a => a.kind === 'conflict').length, 0)
    store.update(b.id, { ...b, time: '15:15' }, true)
    assert.equal(attention(store.read(), '2026-09-22').length, 0)
    store.update(a.id, a, false)
    assert.equal(attention(store.read(), '2026-09-23')[0].kind, 'overdue')
    assert.ok(planText(store.read(), '2026-09-22').includes('School pickup'))
  } finally { store.close() }
})

test('removing adult clears assignments and schema rejects impossible dates', () => {
  const store = new HouseholdStore(':memory:')
  try {
    store.add(item)
    store.saveProfile({ name: 'Home', members: [{ id: 'other', name: 'Alex', role: 'adult' }], notes: '' })
    assert.equal(store.read().items[0].owner, null)
    assert.equal(attention(store.read(), '2026-09-22')[0].kind, 'unassigned')
    assert.equal(itemSchema.safeParse({ ...item, date: '2026-02-30' }).success, false)
    assert.equal(itemSchema.safeParse({ ...item, date: null }).success, false)
    assert.throws(() => store.saveProfile({ name: 'Home', members: [{ id: 'child', name: 'Sam', role: 'child' }], notes: '' }))
  } finally { store.close() }
})

test('guided intake preserves source wording and does not invent schedule facts', () => {
  const draft = guidedItems('Event: Soccer tomorrow at 4\nBuy: Milk\nSign school form')
  assert.deepEqual(draft.map(i => i.kind), ['event', 'shopping', 'task'])
  assert.equal(draft[0].title, 'Soccer tomorrow at 4')
  assert.equal(draft[0].date, null)
  assert.equal(draft[0].owner, null)
})
