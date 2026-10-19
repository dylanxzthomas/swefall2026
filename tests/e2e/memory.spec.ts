import { test, expect } from '@playwright/test'

test('device memory proposals require confirmation, survive reload, and reject stale or resurrected requests', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let store = createDeviceStore(); await store.load()
    await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }])
    const value = { kind: 'school' as const, childId: 'maya', school: 'Oak School', className: 'Room 4' }, request = { requestId: 'same-memory', text: 'Remember Maya goes to Oak School.', value }
    const id = await store.client.proposeMemory!(request), retry = await store.client.proposeMemory!(request)
    const before = structuredClone(store.getSnapshot()), blocked: string[] = []
    try { await store.client.confirmMemory!(id, 2, value) } catch { blocked.push('stale proposal') }
    try { await store.client.proposeMemory!({ ...request, text: 'Remember another school.' }) } catch { blocked.push('changed retry') }
    try { await store.client.confirmMemory!(id, 1, { ...value, childId: 'unknown' }) } catch { blocked.push('unknown child') }
    try { await store.client.confirmMemory!(id, 1, { ...value, send: true } as typeof value) } catch { blocked.push('authority') }
    store.close(); store = createDeviceStore(); await store.load()
    const reopened = structuredClone(store.getSnapshot().memoryProposals)
    const factId = await store.client.confirmMemory!(id, 1, value)
    try { await store.client.confirmMemory!(id, 1, value) } catch { blocked.push('confirmed') }
    const newProposal = await store.client.proposeMemory!({ ...request, requestId: 'new-memory' })
    const identical = await store.client.confirmMemory!(newProposal, 1, value)
    const dismiss = await store.client.proposeMemory!({ requestId: 'dismiss', text: 'Remember Maya is in Room 5.' })
    await store.client.dismissMemory!(dismiss, 1)
    const dismissedRetry = await store.client.proposeMemory!({ requestId: 'dismiss', text: 'Remember Maya is in Room 5.' })
    const after = structuredClone(store.getSnapshot()); store.close()
    return { id, retry, before, reopened, factId, identical, dismiss, dismissedRetry, after, blocked }
  })
  expect(result.retry).toBe(result.id); expect(result.before.facts).toEqual([]); expect(result.before.jobs).toEqual([])
  expect(result.reopened).toMatchObject([{ _id: result.id, text: 'Remember Maya goes to Oak School.' }])
  expect(result.blocked).toEqual(['stale proposal', 'changed retry', 'unknown child', 'authority', 'confirmed'])
  expect(result.factId).toBe(result.identical); expect(result.dismiss).toBe(result.dismissedRetry)
  expect(result.after.memoryProposals).toEqual([]); expect(result.after.facts).toHaveLength(1); expect(result.after.routines).toEqual([]); expect(result.after.plan).toEqual([])
})

test('device memory rejects revised support and stale replacements; expiry and deletion erase raw suggestions', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-05T17:00:00Z') }); await page.goto('/')
  const before = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }])
    const school = { kind: 'school' as const, childId: 'maya', school: 'Oak School', className: 'Room 4' }
    const jobId = await store.client.submit('Event: School trip\nDate: 2026-10-08\nTime: 8:00 AM to 9:00 AM')
    const linked = await store.client.proposeMemory!({ requestId: 'linked', text: 'Remember Maya goes to Oak School.', sourceJobId: jobId, sourceRevision: 1 })
    await store.client.reviseSource(jobId, 1, 'Event: Revised school trip\nDate: 2026-10-08\nTime: 8:00 AM to 9:00 AM')
    const blocked: string[] = []
    try { await store.client.confirmMemory!(linked, 1, school) } catch { blocked.push('source') }
    await store.client.saveFact(school)
    const fact = store.getSnapshot().facts![0]
    const replace = await store.client.proposeMemory!({ requestId: 'replace', text: 'Remember Maya is in Room 5.' })
    await store.client.saveFact({ ...school, className: 'Room 7' }, fact._id, fact.version)
    try { await store.client.confirmMemory!(replace, 1, school, fact._id, fact.version) } catch { blocked.push('replacement') }
    const expires = await store.client.proposeMemory!({ requestId: 'expires', text: 'Remember this private synthetic detail.' })
    store.close(); return { blocked, expires }
  })
  expect(before.blocked).toEqual(['source', 'replacement'])
  await page.goto('about:blank'); await page.clock.setSystemTime(new Date('2026-11-06T17:00:00Z')); await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    const read = () => new Promise<any>((resolve, reject) => { const open = indexedDB.open('daymark-device-v1'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('workspace'), request = tx.objectStore('workspace').get('current'); request.onsuccess = () => resolve(request.result); tx.oncomplete = () => db.close() } })
    const expired = await read(), retry = await store.client.proposeMemory!({ requestId: 'expires', text: 'Remember this private synthetic detail.' })
    const afterRetry = structuredClone(store.getSnapshot())
    await store.client.deleteAccount(); const erased = await read(); store.close()
    return { expired, retry, afterRetry, erased }
  })
  expect(result.retry).toBe(before.expires); expect(result.afterRetry.memoryProposals).toEqual([]); expect(result.afterRetry.facts).toHaveLength(1)
  expect(JSON.stringify(result.expired)).not.toContain('Remember this private synthetic detail')
  expect(result.expired.memorySources).toEqual({}); expect(result.erased.memoryRequests).toBeUndefined(); expect(result.erased.memorySources).toBeUndefined(); expect(result.erased.state.facts).toEqual([])
})

test('a parent asks Sola to remember a detail, reviews it later, confirms it, and dismisses an unsupported preference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/')
  await page.getByRole('button', { name: 'Household settings' }).click()
  await page.getByText('Children and timezone', { exact: true }).click()
  await page.getByLabel('Household timezone', { exact: true }).fill('UTC'); await page.getByLabel('Add a child', { exact: true }).fill('Maya')
  await page.getByRole('button', { name: 'Save household', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Household', exact: true })).toHaveCount(0)
  await page.getByLabel('What can I handle?').fill('Remember Maya goes to Oak School.'); await page.getByRole('button', { name: 'Send', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review memory', exact: true })
  await expect(review).toBeVisible(); await expect(review).toContainText('Not remembered yet')
  await review.getByRole('button', { name: 'Review later' }).click(); await page.reload()
  await page.getByRole('button', { name: 'Household settings' }).click(); await page.getByText('Schools, contacts, and routines', { exact: true }).click()
  await page.getByRole('button', { name: 'Review memory', exact: true }).click()
  const pending = page.getByRole('region', { name: 'Review memory suggestion' })
  await pending.getByLabel('What to remember').selectOption('school'); await pending.getByLabel('School', { exact: true }).fill('Oak School'); await pending.getByLabel('Class', { exact: true }).fill('Room 4')
  await pending.getByRole('button', { name: 'Confirm and remember' }).click()
  await expect(page.getByText('Maya · Oak School · Room 4', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Review memory', exact: true })).toHaveCount(0)
  await page.getByRole('dialog', { name: 'Household', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Household', exact: true })).toHaveCount(0)
  await page.getByLabel('What can I handle?').fill('Remember I like green.'); await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(review).toContainText('General preferences are not supported yet')
  await review.getByRole('button', { name: 'Dismiss suggestion' }).click(); await expect(review).toHaveCount(0)
  const state = await page.evaluate(async () => { const { createDeviceStore } = await import('/src/daymark/deviceStore.ts'); const store = createDeviceStore(); await store.load(); const state = structuredClone(store.getSnapshot()); store.close(); return state })
  expect(state.facts).toHaveLength(1); expect(state.memoryProposals).toEqual([]); expect(state.jobs).toEqual([]); expect(state.plan).toEqual([])
})

test('memory replacement requires a fresh review when another window changes the saved detail', async ({ page }) => {
  await page.goto('/')
  const fact = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load(); await store.client.saveHousehold('UTC', [{ id: 'maya', name: 'Maya' }])
    await store.client.saveFact({ kind: 'school', childId: 'maya', school: 'Oak School', className: 'Room 4' })
    const fact = structuredClone(store.getSnapshot().facts![0]); store.close(); return fact
  })
  await page.reload(); await page.getByLabel('What can I handle?').fill('Remember Maya changed classrooms.'); await page.getByRole('button', { name: 'Send', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review memory', exact: true })
  await review.getByLabel('What to remember').selectOption('school'); await review.getByLabel('School', { exact: true }).fill('Oak School'); await review.getByLabel('Class', { exact: true }).fill('Room 6')
  await review.getByRole('combobox', { name: /^Save as/ }).selectOption(fact._id)
  await page.evaluate(async fact => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const otherWindow = createDeviceStore(); await otherWindow.load(); await otherWindow.client.saveFact({ ...fact.value, className: 'Room 7' }, fact._id, fact.version); otherWindow.close()
  }, fact)
  await expect(review.getByRole('alert')).toContainText('saved detail changed')
  await expect(review.getByRole('button', { name: 'Confirm and remember' })).toBeDisabled()
  await review.getByRole('button', { name: 'Review latest saved detail' }).click()
  await expect(review.getByLabel('Class', { exact: true })).toHaveValue('Room 7')
  await review.getByLabel('Class', { exact: true }).fill('Room 8'); await review.getByRole('button', { name: 'Confirm and remember' }).click(); await expect(review).toHaveCount(0)
  const facts = await page.evaluate(async () => { const { createDeviceStore } = await import('/src/daymark/deviceStore.ts'); const store = createDeviceStore(); await store.load(); const facts = structuredClone(store.getSnapshot().facts); store.close(); return facts })
  expect(facts).toHaveLength(1); expect(facts![0]).toMatchObject({ _id: fact._id, version: 3, value: { className: 'Room 8' } })
})


test('source-linked memory text expires with its older supporting request', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-05T17:00:00Z')); await page.goto('/')
  const jobId = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    const id = await store.client.submit('Event: School trip\nDate: 2026-10-08\nTime: 8:00 AM to 9:00 AM')
    store.close(); return id
  })
  await page.clock.setFixedTime(new Date('2026-10-06T17:00:00Z'))
  const lifetime = await page.evaluate(async jobId => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    const id = await store.client.proposeMemory!({ requestId: 'older-source', text: 'Remember a detail from this source.', sourceJobId: jobId, sourceRevision: 1 })
    const p = store.getSnapshot().memoryProposals!.find(p => p._id === id)!
    store.close(); return p.expiresAt - p.createdAt
  }, jobId)
  expect(lifetime).toBe(29 * 86400_000)
})
