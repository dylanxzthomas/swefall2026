import { expect, test } from '@playwright/test'

// These exercise the real IndexedDB transaction path, independent of the routine form.
test('routine catch-up creates only the latest missed task and concurrent stores never duplicate it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  const saved = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }])
    const definition = { title: 'School bags', outcome: { kind: 'personal_task' as const, task: { title: 'Pack school bags', notes: 'Blue folder', childId: 'maya' }, dueAfterDays: 1 }, schedule: { frequency: 'daily' as const, time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }
    const ids = await Promise.all([store.client.createRoutine!(definition, 'one-routine'), store.client.createRoutine!(definition, 'one-routine')])
    store.close(); return { ids, definition }
  })
  expect(saved.ids[0]).toBe(saved.ids[1])
  await page.goto('about:blank'); await page.clock.fastForward(4 * 86400000 + 2 * 3600000); await page.goto('/')
  const result = await page.evaluate(async id => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const a = createDeviceStore(), b = createDeviceStore(); await Promise.all([a.load(), b.load()])
    await Promise.all([a.runDueRoutines(), b.runDueRoutines()])
    const state = structuredClone(a.getSnapshot()), runs = await a.client.routineOccurrences!(id)
    const task = state.personalTasks![0]; await a.client.setPersonalTaskDone!(task.id, task.version, true)
    const completed = await a.client.routineOccurrences!(id)
    a.close(); b.close(); return { state, runs, completed }
  }, saved.ids[0])
  expect(result.state.personalTasks).toHaveLength(1)
  expect(result.state.personalTasks![0]).toMatchObject({ title: 'Pack school bags', dueDate: '2026-10-06', childId: 'maya', done: false })
  expect(result.runs).toHaveLength(1)
  expect(result.runs[0]).toMatchObject({ localDate: '2026-10-05', scheduledAt: Date.parse('2026-10-05T09:00:00Z'), caughtUpFrom: Date.parse('2026-10-01T09:00:00Z'), status: 'needs_parent' })
  expect(result.completed[0].status).toBe('done_by_parent')
  expect(result.state.routines![0]).toMatchObject({ state: 'active', nextRunAt: Date.parse('2026-10-06T09:00:00Z') })
  expect(result.state.plan).toEqual([]); expect(result.state.jobs).toEqual([])
})

test('pause, stale edits, resume, and changed create retries preserve the confirmed schedule', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  const initial = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); (window as any).routineStore = store
    const definition = { title: 'Pack bags', outcome: { kind: 'personal_task' as const, task: { title: 'Pack bags', notes: '' }, dueAfterDays: 0 }, schedule: { frequency: 'daily' as const, time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }
    const id = await store.client.createRoutine!(definition, 'paused-routine'), blocked: string[] = []
    await store.client.setRoutinePaused!(id, 1, true)
    for (const operation of [() => store.client.updateRoutine!(id, 1, definition), () => store.client.setRoutinePaused!(id, 1, false), () => store.client.removeRoutine!(id, 1), () => store.client.createRoutine!({ ...definition, title: 'Changed' }, 'paused-routine')]) { try { await operation() } catch { blocked.push('rejected') } }
    return { id, definition, blocked }
  })
  expect(initial.blocked).toHaveLength(4)
  await page.clock.fastForward(3 * 86400000 + 2 * 3600000)
  const resumed = await page.evaluate(async id => {
    const store = (window as any).routineStore; await store.runDueRoutines()
    const pausedRuns = await store.client.routineOccurrences(id)
    await store.client.setRoutinePaused(id, 2, false)
    return { pausedRuns, routine: structuredClone(store.getSnapshot().routines[0]) }
  }, initial.id)
  expect(resumed.pausedRuns).toEqual([])
  expect(resumed.routine).toMatchObject({ state: 'active', version: 3, nextRunAt: Date.parse('2026-10-05T09:00:00Z') })
  await page.clock.fastForward(23 * 3600000 + 1)
  await expect.poll(() => page.evaluate(async id => (window as any).routineStore.client.routineOccurrences(id).then((runs: any[]) => runs.length), initial.id)).toBe(1)
  await page.evaluate(() => (window as any).routineStore.close())
})

test('same-day schedule edits do not repeat an occurrence, and removal does not erase its personal task', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  const initial = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); (window as any).routineStore = store
    const definition = { title: 'Pack bags', outcome: { kind: 'personal_task' as const, task: { title: 'Pack bags', notes: '' }, dueAfterDays: 0 }, schedule: { frequency: 'daily' as const, time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }
    return { id: await store.client.createRoutine!(definition, 'daily'), definition }
  })
  await page.clock.fastForward(3600001)
  await expect.poll(() => page.evaluate(async id => (window as any).routineStore.client.routineOccurrences(id).then((runs: any[]) => runs.length), initial.id)).toBe(1)
  await page.evaluate(async ({ id, definition }) => { const store = (window as any).routineStore; await store.client.updateRoutine(id, 1, { ...definition, schedule: { ...definition.schedule, time: '10:00' } }) }, initial)
  await page.clock.fastForward(3600001)
  const result = await page.evaluate(async ({ id, definition }) => {
    const store = (window as any).routineStore; await store.runDueRoutines()
    const runs = await store.client.routineOccurrences(id)
    await store.client.removeRoutine(id, 2)
    const retry = await store.client.createRoutine(definition, 'daily'), state = structuredClone(store.getSnapshot()); store.close()
    return { runs, retry, state }
  }, initial)
  expect(result.runs).toHaveLength(1); expect(result.retry).toBe(initial.id)
  expect(result.state.routines).toEqual([]); expect(result.state.personalTasks).toHaveLength(1)
})

test('preparation produces reviewable drafts only, and edited routines block old approval and source revisions', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  const id = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); (window as any).routineStore = store
    await store.client.saveHousehold('America/Los_Angeles', [{ id: 'maya', name: 'Maya' }])
    return store.client.createRoutine!({ title: 'Prepare school trip', outcome: { kind: 'prepare_request', instruction: 'Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate' }, schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }, 'draft-routine')
  })
  await page.clock.fastForward(3600001)
  await expect.poll(() => page.evaluate(() => (window as any).routineStore.getSnapshot().jobs.length)).toBe(1)
  const result = await page.evaluate(async id => {
    const store = (window as any).routineStore, before = structuredClone(store.getSnapshot()), job = before.jobs[0], action = job.actions[0], blocked: string[] = []
    await store.client.setRoutinePaused(id, 1, true)
    for (const operation of [() => store.client.approve([{ id: action._id, revision: 1 }]), () => store.client.edit(action._id, 1, action.payload), () => store.client.addDraft(job._id, action.payload), () => store.client.reviseSource(job._id, 1, 'Event: Another trip')]) {
      try { await operation() } catch (error) { blocked.push((error as Error).message) }
    }
    const runs = await store.client.routineOccurrences(id), after = structuredClone(store.getSnapshot()); store.close()
    return { before, after, blocked, runs }
  }, id)
  expect(result.before.jobs[0].actions).toHaveLength(1)
  expect(result.before.jobs[0].actions[0]).toMatchObject({ status: 'review', receipts: [], payload: { timezone: 'UTC' } })
  expect(result.blocked).toHaveLength(4); expect(result.blocked.every((message: string) => message.includes('routine changed or stopped'))).toBe(true)
  expect(result.runs[0].issue).toContain('routine changed or stopped')
  expect(result.after.plan).toEqual([]); expect(result.after.arrangements).toEqual([])
})

test('a native result already dispatched is preserved after its routine is stopped', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const permission = { permission: 'granted' as const, calendars: [{ id: 'synthetic-calendar', title: 'Test calendar', account: 'Fixture' }] }
    const bridge = { available: () => true, connect: async () => permission, status: async () => permission, execute: async (operation: any) => new Promise<any>(resolve => { (window as any).finishRoutineNative = () => resolve({ status: 'verified', eventId: 'synthetic-event', fingerprint: 'synthetic-fingerprint', verifiedAt: Date.now() }); (window as any).dispatchedRoutineNative = operation }), reconcile: async () => { throw new Error('Not used') }, read: async () => { throw new Error('Not used') } }
    const store = createDeviceStore(undefined, bridge); await store.load(); (window as any).routineStore = store
    await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }]); await store.client.selectNativeCalendar!('synthetic-calendar')
    await store.client.createRoutine!({ title: 'School trip', outcome: { kind: 'prepare_request', instruction: 'Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate' }, schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }, 'native-draft')
  })
  await page.clock.fastForward(3600001)
  await expect.poll(() => page.evaluate(() => (window as any).routineStore.getSnapshot().jobs.length)).toBe(1)
  await page.evaluate(() => { const store = (window as any).routineStore, state = store.getSnapshot(), action = state.jobs[0].actions[0]; (window as any).routineApproval = store.client.approve([{ id: action._id, revision: action.revision, nativeCalendar: { calendarId: 'synthetic-calendar', version: state.nativeCalendar.version } }]) })
  await expect.poll(() => page.evaluate(() => !!(window as any).dispatchedRoutineNative)).toBe(true)
  const result = await page.evaluate(async () => {
    const store = (window as any).routineStore, routine = store.getSnapshot().routines[0]
    await store.client.setRoutinePaused(routine.id, routine.version, true)
    ;(window as any).finishRoutineNative(); await (window as any).routineApproval
    const state = structuredClone(store.getSnapshot()), runs = await store.client.routineOccurrences(routine.id); store.close()
    return { state, runs }
  })
  expect(result.state.jobs[0].actions[0]).toMatchObject({ status: 'succeeded', receipts: [{ providerId: 'synthetic-event', outcome: 'apple_calendar_readback' }] })
  expect(result.state.plan).toHaveLength(1); expect(result.runs[0].summary).toContain('iPhone')
})

test('routine validation and device deletion protect household data and erase all schedule contents', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T08:00:00Z') }); await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }])
    const definition = { title: 'Pack bags', outcome: { kind: 'personal_task' as const, task: { title: 'Pack bags', notes: '', childId: 'maya' }, dueAfterDays: 0 }, schedule: { frequency: 'daily' as const, time: '09:00', timezone: 'UTC', startDate: '2026-10-01' } }, blocked: string[] = []
    try { await store.client.createRoutine!({ ...definition, outcome: { ...definition.outcome, task: { ...definition.outcome.task, childId: 'other-household' } } }, 'wrong-child') } catch { blocked.push('child') }
    try { await store.client.createRoutine!({ ...definition, outcome: { kind: 'prepare_request', instruction: 'Hi Sola' } }, 'greeting') } catch { blocked.push('greeting') }
    try { await store.client.createRoutine!({ ...definition, schedule: { ...definition.schedule, endDate: '2026-09-30' } }, 'bad-date') } catch { blocked.push('date') }
    const id = await store.client.createRoutine!(definition, 'child-removed'); await store.client.saveHousehold('UTC', [])
    ;(window as any).routineStore = store
    return { id, blocked }
  })
  expect(result.blocked).toEqual(['child', 'greeting', 'date'])
  await page.clock.fastForward(3600001)
  await expect.poll(() => page.evaluate(() => (window as any).routineStore.getSnapshot().routines[0].state)).toBe('blocked')
  const erased = await page.evaluate(async () => {
    const store = (window as any).routineStore, before = structuredClone(store.getSnapshot()); await store.client.deleteAccount(); store.close()
    const persisted = await new Promise<any>((resolve, reject) => { const request = indexedDB.open('daymark-device-v1'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction('workspace'), get = tx.objectStore('workspace').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close() } })
    return { before, persisted }
  })
  expect(erased.before.personalTasks).toEqual([])
  for (const key of ['routines', 'routineRuns', 'routineRequests', 'routineJobs']) expect(erased.persisted[key]).toBeUndefined()
  expect(erased.persisted.state.routines).toEqual([])
})
