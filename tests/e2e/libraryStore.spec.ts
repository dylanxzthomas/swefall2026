import { test, expect } from '@playwright/test'

test('kept Library media survives original source expiry and is erased with device data', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let store = createDeviceStore()
    await store.load()
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const jobId = await store.client.submit('Synthetic school file', [new File([bytes], 'Synthetic.png', { type: 'image/png' })])
    const fileId = store.getSnapshot().jobs.find(j => j._id === jobId)!.files![0].id
    const id = await store.client.keepLibraryFile!(jobId, fileId) as string
    const duplicate = await store.client.keepLibraryFile!(jobId, fileId)
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('daymark-device-v1')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('workspace', 'readwrite'), table = tx.objectStore('workspace'), get = table.get('current')
        get.onsuccess = () => { const data = get.result; data.expiry[jobId] = Date.now() - 1; data.files[fileId].expiresAt = Date.now() - 1; table.put(data, 'current') }
        tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
      }
    })
    store.close(); store = createDeviceStore(); await store.load()
    const keptBytes = Array.from(new Uint8Array(await (await store.client.readLibraryFile!(id)).arrayBuffer()))
    let expired = false; try { await store.client.readFile(fileId) } catch { expired = true }
    const afterExpiry = structuredClone(store.getSnapshot())
    await store.client.savePreferences!({ parentName: 'Taylor', assistantName: 'Juniper' })
    await store.client.deleteAccount()
    let removed = false; try { await store.client.readLibraryFile!(id) } catch { removed = true }
    const afterDeletion = structuredClone(store.getSnapshot()); store.close()
    return { id, duplicate, expected: Array.from(bytes), keptBytes, expired, afterExpiry, removed, afterDeletion }
  })
  expect(result.duplicate).toBe(result.id); expect(result.keptBytes).toEqual(result.expected); expect(result.expired).toBe(true)
  expect(result.afterExpiry.library).toHaveLength(1); expect(result.afterExpiry.jobs[0].source?.text).toBeUndefined()
  expect(result.removed).toBe(true); expect(result.afterDeletion.library).toEqual([]); expect(result.afterDeletion.jobs).toEqual([])
  expect(result.afterDeletion.preferences).toEqual({ parentName: '', assistantName: 'Sola', avatar: 'robin' })
})

test('removing a kept Library copy preserves the original and rejects disguised SVG media', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const jobId = await store.client.submit('Synthetic school file', [new File([bytes], 'Synthetic.png', { type: 'image/png' })])
    const fileId = store.getSnapshot().jobs.find(j => j._id === jobId)!.files![0].id
    const id = await store.client.keepLibraryFile!(jobId, fileId) as string
    await store.client.removeLibrary!(id, 1)
    const originalBytes = Array.from(new Uint8Array(await (await store.client.readFile(fileId)).arrayBuffer()))
    let blocked = ''; try { await store.client.uploadLibrary!([new File(['<svg><script>never run</script></svg>'], 'pretend.png', { type: 'image/png' })], '') } catch (e) { blocked = (e as Error).message }
    const library = structuredClone(store.getSnapshot().library); store.close()
    return { originalBytes, expected: Array.from(bytes), blocked, library }
  })
  expect(result.originalBytes).toEqual(result.expected); expect(result.blocked).toContain('not a supported image'); expect(result.library).toEqual([])
})

test('new greetings use current personalization and persist as conversations without tasks or receipts', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    let store = createDeviceStore(); await store.load()
    await store.client.savePreferences!({ parentName: 'Taylor', assistantName: 'Juniper' })
    const first = await store.client.submit('Hi')
    await store.client.savePreferences!({ parentName: 'Jamie', assistantName: 'Cedar', avatar: 'robin' })
    const second = await store.client.submit('Hi')
    store.close(); store = createDeviceStore(); await store.load()
    const state = structuredClone(store.getSnapshot()); store.close()
    return { first, second, state }
  })
  expect(result.first).not.toBe(result.second); expect(result.state.jobs).toHaveLength(2)
  expect(result.state.jobs[0]).toMatchObject({ conversation: true, actions: [] }); expect(result.state.jobs[0].clarification).toContain('Jamie')
  expect(result.state.jobs[1].clarification).toContain('Taylor'); expect(result.state.preferences).toEqual({ parentName: 'Jamie', assistantName: 'Cedar', avatar: 'robin' })
  expect(result.state.plan).toEqual([])
})

test('conversation records cannot swallow later operational notices or retain their conversation flag after editing', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const store = createDeviceStore(); await store.load()
    const chatId = await store.client.submit('Hi')
    await store.client.reviseSource(chatId, 1, 'Event: Maya trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
    const revised = structuredClone(store.getSnapshot().jobs.find(j => j._id === chatId))
    const data = await new Promise<any>((resolve, reject) => {
      const open = indexedDB.open('daymark-device-v1'); open.onerror = () => reject(open.error)
      open.onsuccess = () => { const db = open.result, tx = db.transaction('workspace'), query = tx.objectStore('workspace').get('current'); query.onsuccess = () => resolve(query.result); tx.oncomplete = () => db.close() }
    })
    store.close(); return { revised, hashes: data.hashes }
  })
  expect(result.revised?.conversation).toBeUndefined(); expect(result.revised?.actions.length).toBeGreaterThan(0)
  expect(Object.keys(result.hashes)).toHaveLength(1)
})
