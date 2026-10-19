import { expect, test, type Page } from '@playwright/test'

async function openRequests(page: Page) {
  await page.getByRole('button', { name: 'Household settings', exact: true }).click()
  await page.getByText('Request another connection', { exact: true }).click()
  return page.getByRole('dialog', { name: 'Household', exact: true })
}
async function data(page: Page) {
  return page.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('daymark-device-v1')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { const db = request.result, tx = db.transaction('workspace'), row = tx.objectStore('workspace').get('current'); row.onsuccess = () => resolve(row.result); tx.oncomplete = () => db.close() }
  }))
}
test('saves a connection request from Household, persists it and clearly leaves the actual task undone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  let sheet = await openRequests(page)
  await expect(sheet.getByRole('button', { name: 'Save connection request', exact: true })).toBeDisabled()
  await sheet.getByLabel('Service or app (optional)').fill('Synthetic swim school')
  await sheet.getByLabel('What would you like Sola to handle?').fill('Find a Saturday swim lesson and prepare a booking for me to review.')
  expect((await data(page)).state.connectorRequests ?? []).toHaveLength(0)
  await sheet.getByRole('button', { name: 'Save connection request', exact: true }).click()
  await expect(sheet.getByRole('status')).toContainText('Nothing has been connected or carried out')
  await expect(sheet.getByText('Requested · not connected', { exact: true })).toBeVisible()
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('connector-request-dark.png') })
  const saved = await data(page)
  expect(saved.state.connectorRequests).toHaveLength(1)
  expect(saved.state.connectorRequests[0]).toMatchObject({ service: 'Synthetic swim school', status: 'requested', version: 1 })
  expect(saved.state.jobs).toEqual([]); expect(saved.state.plan).toEqual([]); expect(saved.state.connection).toBeNull()
  await page.reload(); sheet = await openRequests(page)
  await expect(sheet.getByRole('heading', { name: 'Synthetic swim school', exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'Dismiss request for Synthetic swim school', exact: true }).click()
  await expect(sheet.getByRole('heading', { name: 'Synthetic swim school', exact: true })).toHaveCount(0)
  await page.reload(); sheet = await openRequests(page)
  await expect(sheet.getByRole('heading', { name: 'Synthetic swim school', exact: true })).toHaveCount(0)
})

test('real device storage deduplicates concurrent requests, rejects retry collisions and stale dismissals, and erases private markers', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let store = createDeviceStore(); await store.load()
    const input = { service: 'Synthetic lessons', outcome: 'Find a Saturday lesson.' }
    const ids = await Promise.all([store.client.createConnectorRequest!(input, 'request-a'), store.client.createConnectorRequest!(input, 'request-b'), store.client.createConnectorRequest!(input, 'request-a')])
    const blocked: string[] = []
    try { await store.client.createConnectorRequest!({ ...input, outcome: 'Something else' }, 'request-b') } catch { blocked.push('alias collision') }
    try { await store.client.createConnectorRequest!({ ...input, approved: true } as any, 'invalid') } catch { blocked.push('hidden permission') }
    try { await store.client.dismissConnectorRequest!(ids[0], 0) } catch { blocked.push('stale') }
    store.close(); store = createDeviceStore(); await store.load()
    const persisted = structuredClone(store.getSnapshot().connectorRequests)
    await store.client.dismissConnectorRequest!(ids[0], 1)
    const retry = await store.client.createConnectorRequest!(input, 'request-b')
    const dismissed = structuredClone(store.getSnapshot().connectorRequests)
    const fresh = await store.client.createConnectorRequest!(input, 'fresh')
    const beforeDelete = structuredClone(store.getSnapshot())
    await store.client.deleteAccount(); store.close()
    const reloaded = createDeviceStore(); await reloaded.load(); const afterDelete = structuredClone(reloaded.getSnapshot()); reloaded.close()
    return { ids, blocked, persisted, retry, dismissed, fresh, beforeDelete, afterDelete }
  })
  expect(new Set(result.ids).size).toBe(1); expect(result.blocked).toEqual(['alias collision', 'hidden permission', 'stale'])
  expect(result.persisted).toHaveLength(1); expect(result.retry).toBe(result.ids[0]); expect(result.dismissed).toEqual([]); expect(result.fresh).not.toBe(result.ids[0])
  expect(result.beforeDelete.jobs).toEqual([]); expect(result.beforeDelete.plan).toEqual([]); expect(result.beforeDelete.connection).toBeNull()
  expect(result.afterDelete.connectorRequests).toEqual([])
  const stored = await data(page)
  expect(stored.connectorRequests).toBeUndefined(); expect(stored.connectorRequestKeys).toBeUndefined()
})

test('an unsupported chat request does not silently install or queue a connector', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('What can I handle?', { exact: true }).fill('Book a Saturday swimming lesson through Synthetic Lessons.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('What can I handle?', { exact: true })).toHaveValue('')
  const saved = await data(page)
  expect(saved.state.connectorRequests ?? []).toEqual([])
  expect(saved.state.jobs.flatMap((job: any) => job.actions)).toEqual([])
  expect(saved.state.connection).toBeNull()
})
