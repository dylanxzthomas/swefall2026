import { test, expect } from '@playwright/test'

// These tests exercise the real IndexedDB store with an explicitly injected bridge.
// They make no EventKit call and are not evidence of native or iCloud behavior.
test('Apple approval prevents double writes and rejects changed destinations before dispatch', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let writes = 0
    const info = { permission: 'granted' as const, calendars: [{ id: 'test', title: 'Synthetic calendar', account: 'Synthetic iCloud' }, { id: 'other', title: 'Other', account: 'Synthetic iCloud' }] }
    const calendar = { available: () => true, status: async () => info, connect: async () => info, read: async () => { throw new Error('No target') }, execute: async () => { writes++; return { status: 'verified' as const, eventId: 'synthetic-event', fingerprint: 'v1', verifiedAt: 1000 } }, reconcile: async () => ({ status: 'uncertain' as const }) }
    const store = createDeviceStore(undefined, calendar)
    await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }]); await store.client.connectNativeCalendar!(); await store.client.selectNativeCalendar!('test')
    const id = await store.client.submit('Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
    const action = store.getSnapshot().jobs.find(j => j._id === id)!.actions[0]
    const reviewed = { id: action._id, revision: action.revision, nativeCalendar: { calendarId: 'test', version: store.getSnapshot().nativeCalendar!.version } }
    await store.client.selectNativeCalendar!('other')
    let stale = ''; try { await store.client.approve([reviewed]) } catch (e) { stale = (e as Error).message }
    const blockedWrites = writes
    await store.client.selectNativeCalendar!('test'); reviewed.nativeCalendar.version = store.getSnapshot().nativeCalendar!.version
    await Promise.allSettled([store.client.approve([reviewed]), store.client.approve([reviewed])])
    await store.client.approve([reviewed])
    const saved = structuredClone(store.getSnapshot()); store.close()
    return { stale, blockedWrites, writes, saved }
  })
  expect(result.stale).toContain('selection changed'); expect(result.blockedWrites).toBe(0); expect(result.writes).toBe(1)
  expect(result.saved.plan).toHaveLength(1)
  expect(result.saved.jobs[0].actions[0].receipts).toEqual([expect.objectContaining({ outcome: 'apple_calendar_readback', providerId: 'synthetic-event' })])
})

test('interrupted Apple execution recovers by readback after reload without repeating the write', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let writes = 0, reads = 0
    const info = { permission: 'granted' as const, calendars: [{ id: 'test', title: 'Synthetic', account: 'Synthetic iCloud' }] }
    const calendar = { available: () => true, status: async () => info, connect: async () => info, read: async () => { throw new Error('No target') }, execute: async () => { writes++; throw new Error('Native process interrupted after saving') }, reconcile: async () => { reads++; return { status: 'verified' as const, eventId: 'synthetic-event', fingerprint: 'v1', verifiedAt: 1000 } } }
    let store = createDeviceStore(undefined, calendar)
    await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }]); await store.client.selectNativeCalendar!('test')
    await store.client.submit('Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
    const a = store.getSnapshot().jobs[0].actions[0], approval = { id: a._id, revision: a.revision, nativeCalendar: { calendarId: 'test', version: store.getSnapshot().nativeCalendar!.version } }
    try { await store.client.approve([approval]) } catch {}
    const uncertain = store.getSnapshot().jobs[0].actions[0].status
    try { await store.client.approve([approval]) } catch {}
    store.close(); store = createDeviceStore(undefined, calendar); await store.load()
    const restored = structuredClone(store.getSnapshot()); store.close()
    return { writes, reads, uncertain, restored }
  })
  expect(result.uncertain).toBe('uncertain'); expect(result.writes).toBe(1); expect(result.reads).toBe(1)
  expect(result.restored.jobs[0].actions[0].status).toBe('succeeded'); expect(result.restored.plan).toHaveLength(1)
})

test('an Apple update refreshes the actual before image and requires review after external changes', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let writes = 0
    const info = { permission: 'granted' as const, calendars: [{ id: 'test', title: 'Synthetic', account: 'Synthetic iCloud' }] }
    const calendar = { available: () => true, status: async () => info, connect: async () => info, read: async () => ({ eventId: 'synthetic-event', calendarId: 'test', fingerprint: 'external-change', title: 'Maya trip changed at school', location: 'West gate', notes: '', start: Date.parse('2026-10-08T08:30:00Z'), end: Date.parse('2026-10-08T14:30:00Z'), allDay: false, timezone: 'UTC' }), execute: async (operation: { expectedFingerprint?: string }) => { writes++; if (writes > 1 && operation.expectedFingerprint !== 'external-change') return { status: 'review' as const, message: 'Original event changed' }; return { status: 'verified' as const, eventId: 'synthetic-event', fingerprint: 'v1', verifiedAt: 1000 } }, reconcile: async () => ({ status: 'uncertain' as const }) }
    const store = createDeviceStore(undefined, calendar)
    await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }]); await store.client.selectNativeCalendar!('test')
    const jobId = await store.client.submit('Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
    const original = store.getSnapshot().jobs[0].actions[0]
    const destination = { calendarId: 'test', version: store.getSnapshot().nativeCalendar!.version }
    await store.client.approve([{ id: original._id, revision: original.revision, nativeCalendar: destination }])
    await store.client.addDraft(jobId, { ...original.payload, location: 'South gate' })
    let edited = store.getSnapshot().jobs[0].actions[1]
    await store.client.edit(edited._id, edited.revision, { ...edited.payload, targetId: store.getSnapshot().plan[0]._id })
    edited = store.getSnapshot().jobs[0].actions[1]
    await store.client.approve([{ id: edited._id, revision: edited.revision, nativeCalendar: destination }])
    const blocked = structuredClone(store.getSnapshot().jobs[0].actions[1])
    await store.client.refreshCalendar(edited._id)
    const refreshed = structuredClone(store.getSnapshot().jobs[0].actions[1])
    await store.client.approve([{ id: refreshed._id, revision: refreshed.revision, nativeCalendar: destination }])
    const final = structuredClone(store.getSnapshot()); store.close()
    return { blocked, refreshed, final, writes }
  })
  expect(result.blocked.status).toBe('review'); expect(result.blocked.receipts).toHaveLength(0)
  expect(result.refreshed.before?.payload).toEqual(expect.objectContaining({ title: 'Maya trip changed at school', location: 'West gate' }))
  expect(result.final.plan).toHaveLength(1); expect(result.final.plan[0].payload).toEqual(expect.objectContaining({ location: 'South gate' }))
  expect(result.writes).toBe(3)
})

test('a pending native refresh cannot replace a newly selected event with its old target', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    type Operation = import('../../shared/nativeCalendar').NativeCalendarOperation
    type NativeEvent = import('../../shared/nativeCalendar').NativeEvent
    let writes = 0, readStarted!: () => void, resolveRead!: (event: NativeEvent) => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const delayedRead = new Promise<NativeEvent>(resolve => { resolveRead = resolve })
    const operations: Operation[] = []
    const info = { permission: 'granted' as const, calendars: [{ id: 'test', title: 'Synthetic', account: 'Synthetic iCloud' }] }
    const calendar = {
      available: () => true, status: async () => info, connect: async () => info,
      read: async () => { readStarted(); return delayedRead },
      execute: async (operation: Operation) => { operations.push(structuredClone(operation)); writes++; return { status: 'verified' as const, eventId: operation.eventId ?? `synthetic-event-${writes}`, fingerprint: `version-${writes}`, verifiedAt: 1000 } },
      reconcile: async () => ({ status: 'uncertain' as const }),
    }
    const store = createDeviceStore(undefined, calendar)
    await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }]); await store.client.selectNativeCalendar!('test')
    const jobId = await store.client.submit('Event: Maya first trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
    const first = store.getSnapshot().jobs.find(job => job._id === jobId)!.actions[0]
    const destination = { calendarId: 'test', version: store.getSnapshot().nativeCalendar!.version }
    await store.client.approve([{ id: first._id, revision: first.revision, nativeCalendar: destination }])
    await store.client.addDraft(jobId, { ...first.payload, title: 'Maya second trip', location: 'East gate' })
    const second = store.getSnapshot().jobs.find(job => job._id === jobId)!.actions[1]
    await store.client.approve([{ id: second._id, revision: second.revision, nativeCalendar: destination }])
    const [targetA, targetB] = structuredClone(store.getSnapshot().plan)
    await store.client.addDraft(jobId, { ...first.payload, title: 'Reviewed correction', location: 'South gate' })
    const draft = () => store.getSnapshot().jobs.find(job => job._id === jobId)!.actions[2]
    await store.client.edit(draft()._id, draft().revision, { ...draft().payload, targetId: targetA._id })
    const refresh = store.client.refreshCalendar(draft()._id).then(() => '', error => (error as Error).message)
    await started
    await store.client.edit(draft()._id, draft().revision, { ...draft().payload, targetId: targetB._id })
    resolveRead({ ...operations[0], title: 'Old target changed externally', eventId: 'synthetic-event-1', fingerprint: 'external-version' })
    const error = await refresh
    const beforeApproval = structuredClone(store.getSnapshot())
    await store.client.approve([{ id: draft()._id, revision: draft().revision, nativeCalendar: destination }])
    const saved = structuredClone(store.getSnapshot()); store.close()
    return { error, beforeApproval, saved, operations, targetA, targetB }
  })
  expect(result.error).toContain('changed')
  expect(result.beforeApproval.plan).toEqual([result.targetA, result.targetB])
  expect(result.beforeApproval.jobs[0].actions[2].before?.payload).toEqual(result.targetB.payload)
  expect(result.operations[2]).toMatchObject({ eventId: 'synthetic-event-2', expectedFingerprint: 'version-2' })
  expect(result.saved.plan.find(item => item._id === result.targetA._id)).toEqual(result.targetA)
  expect(result.saved.plan.find(item => item._id === result.targetB._id)?.payload).toEqual(expect.objectContaining({ title: 'Reviewed correction', location: 'South gate' }))
})
