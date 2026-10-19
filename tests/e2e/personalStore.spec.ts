import { test, expect } from '@playwright/test'

test('personal tasks persist, reject stale changes, and do not reappear after a delayed create retry', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let store = createDeviceStore(); await store.load()
    await store.client.saveHousehold('America/Los_Angeles', [{ id: 'maya', name: 'Maya' }])
    const input = { title: 'Bring permission slip', notes: 'Signed copy for Maya', childId: 'maya', dueDate: '2026-10-08' }
    const ids = await Promise.all([store.client.createPersonalTask!(input, 'same-create'), store.client.createPersonalTask!(input, 'same-create')])
    const id = ids[0] as string, blocked: string[] = []
    try { await store.client.createPersonalTask!({ ...input, title: 'Changed request' }, 'same-create') } catch { blocked.push('changed retry') }
    try { await store.client.createPersonalTask!({ ...input, childId: 'another-family' }, 'wrong-child') } catch { blocked.push('child') }
    try { await store.client.createPersonalTask!({ ...input, dueDate: '2026-02-31' }, 'bad-date') } catch { blocked.push('date') }
    await store.client.updatePersonalTask!(id, 1, { title: 'Bring signed slip', notes: '' })
    for (const operation of [() => store.client.updatePersonalTask!(id, 1, input), () => store.client.setPersonalTaskDone!(id, 1, true), () => store.client.removePersonalTask!(id, 1)]) {
      try { await operation() } catch { blocked.push('stale') }
    }
    await store.client.setPersonalTaskDone!(id, 2, true)
    store.close(); store = createDeviceStore(); await store.load()
    const persisted = structuredClone(store.getSnapshot().personalTasks)
    await store.client.setPersonalTaskDone!(id, 3, false)
    await store.client.removePersonalTask!(id, 4)
    const delayedRetry = await store.client.createPersonalTask!(input, 'same-create')
    const afterRemove = structuredClone(store.getSnapshot()); store.close()
    return { ids, id, blocked, persisted, delayedRetry, afterRemove }
  })
  expect(result.ids).toEqual([result.id, result.id]); expect(result.blocked).toEqual(['changed retry', 'child', 'date', 'stale', 'stale', 'stale'])
  expect(result.persisted).toHaveLength(1); expect(result.persisted![0]).toMatchObject({ title: 'Bring signed slip', notes: '', done: true, version: 3 })
  expect(result.persisted![0].childId).toBeUndefined(); expect(result.persisted![0].dueDate).toBeUndefined()
  expect(result.delayedRetry).toBe(result.id); expect(result.afterRemove.personalTasks).toEqual([]); expect(result.afterRemove.jobs).toEqual([]); expect(result.afterRemove.plan).toEqual([])
})

test('a due request prepares exactly once after reopening and still requires review', async ({ page }) => {
  const now = new Date('2026-09-30T18:00:00Z')
  await page.clock.install({ time: now }); await page.goto('/')
  const scheduled = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    await store.client.saveHousehold('America/Los_Angeles', [{ id: 'maya', name: 'Maya' }])
    const text = 'Event: Maya trip\nDate: 2026-12-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate', runAt = Date.now() + 60 * 86400000
    const id = await store.client.scheduleRequest!(text, runAt, 'reopen-schedule')
    const duplicate = await store.client.scheduleRequest!(text, runAt, 'reopen-schedule')
    const before = structuredClone(store.getSnapshot().jobs.find(j => j._id === id)); store.close()
    return { id, duplicate, before, text, runAt }
  })
  expect(scheduled.duplicate).toBe(scheduled.id); expect(scheduled.before).toMatchObject({ scheduledFor: scheduled.runAt, actions: [], preparing: false })
  await page.goto('about:blank'); await page.clock.fastForward(60 * 86400000 + 1); await page.goto('/')
  const result = await page.evaluate(async ({ id, text, runAt }) => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const first = createDeviceStore(), second = createDeviceStore()
    await Promise.all([first.load(), second.load()])
    const retried = await first.client.scheduleRequest!(text, runAt, 'reopen-schedule')
    const after = structuredClone(first.getSnapshot()); first.close(); second.close()
    const reopened = createDeviceStore(); await reopened.load(); const next = structuredClone(reopened.getSnapshot().jobs.find(j => j._id === id)); reopened.close()
    return { after, next, retried }
  }, scheduled)
  expect(result.retried).toBe(scheduled.id); expect(result.after.jobs).toHaveLength(1); expect(result.after.jobs[0].scheduledFor).toBeUndefined()
  expect(result.after.jobs[0].actions).toHaveLength(1); expect(result.after.jobs[0].actions[0]).toMatchObject({ status: 'review', receipts: [] })
  expect(result.next?.actions.map(a => a._id)).toEqual(result.after.jobs[0].actions.map(a => a._id)); expect(result.after.plan).toEqual([])
})

test('open-app schedules use revised text, cancellation blocks preparation, and conversational scheduling is rejected', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T18:00:00Z') }); await page.goto('/')
  const ids = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); (window as any).scheduleStore = store
    const text = 'Event: Original trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM', runAt = Date.now() + 10000
    const id = await store.client.scheduleRequest!(text, runAt, 'editable'), cancelled = await store.client.scheduleRequest!(text, runAt, 'cancelled')
    await store.client.reviseSource(id, 1, text.replace('Original trip', 'Revised trip'))
    const blocked: string[] = []
    try { await store.client.reviseSource(id, 1, text) } catch { blocked.push('stale source') }
    try { await store.client.reviseSource(id, 2, 'Hello') } catch { blocked.push('greeting edit') }
    try { await store.client.addDraft(id, {} as never) } catch { blocked.push('early draft') }
    try { await store.client.scheduleRequest!('Who are you?', runAt, 'greeting') } catch { blocked.push('greeting') }
    try { await store.client.scheduleRequest!(text, runAt + 1, 'editable') } catch { blocked.push('changed retry') }
    await store.client.cancel(cancelled)
    return { id, cancelled, blocked, before: structuredClone(store.getSnapshot().jobs) }
  })
  expect(ids.blocked).toEqual(['stale source', 'greeting edit', 'early draft', 'greeting', 'changed retry'])
  expect(ids.before.every(j => j.actions.length === 0)).toBe(true)
  await page.clock.fastForward(11000)
  await expect.poll(() => page.evaluate(id => (window as any).scheduleStore.getSnapshot().jobs.find((j: any) => j._id === id).actions.length, ids.id)).toBe(1)
  const result = await page.evaluate(() => { const store = (window as any).scheduleStore, state = structuredClone(store.getSnapshot()); store.close(); return state })
  const prepared = result.jobs.find((j: any) => j._id === ids.id), cancelled = result.jobs.find((j: any) => j._id === ids.cancelled)
  expect(prepared.source.revision).toBe(2); expect(prepared.actions[0].payload.title).toBe('Revised trip'); expect(prepared.actions[0].status).toBe('review')
  expect(cancelled).toMatchObject({ cancelled: true, actions: [] }); expect(cancelled.scheduledFor).toBeUndefined(); expect(result.plan).toEqual([])
})

test('future instructions survive ordinary source retention and deletion erases schedules, tasks, and personalization', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    await store.client.saveHouseholdName!('The Rivera family')
    await store.client.saveHousehold('America/New_York', [{ id: 'maya', name: 'Maya' }])
    await store.client.savePreferences!({ parentName: 'Taylor', assistantName: 'Cedar', avatar: 'initial' })
    await store.client.savePreferences!({ parentName: 'Jamie', assistantName: 'Cedar' })
    const task = await store.client.createPersonalTask!({ title: 'Pack lunch', notes: '' }, 'private-task')
    const runAt = Date.now() + 60 * 86400000, id = await store.client.scheduleRequest!('Prepare an email reply to the school', runAt, 'private-schedule')
    const before = structuredClone(store.getSnapshot())
    const read = () => new Promise<any>((resolve, reject) => { const request = indexedDB.open('daymark-device-v1'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction('workspace'), get = tx.objectStore('workspace').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close() } })
    const scheduledExpiry = (await read()).expiry[id]
    await store.client.cancel(id)
    const cancelledExpiry = (await read()).expiry[id], cancelledAt = Date.now()
    await store.client.deleteAccount()
    const after = structuredClone(store.getSnapshot()), persisted = await read(); store.close()
    return { task, before, runAt, scheduledExpiry, cancelledExpiry, cancelledAt, after, persisted }
  })
  expect(result.before.household).toMatchObject({ name: 'The Rivera family', timezone: 'America/New_York' })
  expect(result.before.preferences).toEqual({ parentName: 'Jamie', assistantName: 'Cedar', avatar: 'initial' })
  expect(result.scheduledExpiry).toBe(result.runAt + 30 * 86400000); expect(result.cancelledExpiry).toBeLessThanOrEqual(result.cancelledAt + 30 * 86400000)
  expect(result.after.personalTasks).toEqual([]); expect(result.after.jobs).toEqual([]); expect(result.after.household?.name).toBeUndefined()
  expect(result.after.preferences).toEqual({ parentName: '', assistantName: 'Sola', avatar: 'robin' })
  expect(result.persisted.taskRequests).toBeUndefined(); expect(result.persisted.scheduledRequests).toBeUndefined(); expect(result.persisted.expiry).toEqual({})
})

test('background work waits for foreground and a cancelled due request stays cancelled', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T18:00:00Z') }); await page.goto('/')
  const ids = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); (window as any).scheduleStore = store
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))
    const text = 'Event: School conference\nDate: 2026-10-08\nTime: 8:30 AM to 9:30 AM', runAt = Date.now() + 1000
    const id = await store.client.scheduleRequest!(text, runAt, 'foreground'), cancelled = await store.client.scheduleRequest!(text, runAt, 'cancel-in-background')
    return { id, cancelled }
  })
  await page.clock.fastForward(2000)
  const pending = await page.evaluate(async id => {
    const store = (window as any).scheduleStore
    await store.client.cancel(id)
    return structuredClone(store.getSnapshot().jobs)
  }, ids.cancelled)
  expect(pending.every((job: any) => job.actions.length === 0)).toBe(true)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect.poll(() => page.evaluate(id => (window as any).scheduleStore.getSnapshot().jobs.find((job: any) => job._id === id).actions.length, ids.id)).toBe(1)
  const cancelled = await page.evaluate(id => { const store = (window as any).scheduleStore, job = structuredClone(store.getSnapshot().jobs.find((j: any) => j._id === id)); store.close(); return job }, ids.cancelled)
  expect(cancelled).toMatchObject({ cancelled: true, actions: [] }); expect(cancelled.scheduledFor).toBeUndefined()
})
