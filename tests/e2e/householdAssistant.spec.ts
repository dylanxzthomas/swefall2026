import { expect, test, type Page } from '@playwright/test'

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversation' })
const latest = (page: Page) => conversation(page).locator('.dm-assistant-message').last()
const review = (page: Page) => page.getByRole('dialog', { name: 'Review request' })
async function say(page: Page, text: string) {
  await page.getByLabel('What can I handle?').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('What can I handle?')).toHaveValue('')
}
async function saved(page: Page) {
  return page.evaluate(() => new Promise<any>((resolve, reject) => {
    const open = indexedDB.open('daymark-device-v1')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('workspace'), request = tx.objectStore('workspace').get('current')
      request.onsuccess = () => resolve(request.result)
      tx.oncomplete = () => db.close()
    }
  }))
}

test('chat creates a real personal task, persists it, and answers from its latest completion state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await say(page, 'Add buy sunscreen to my tasks')
  await expect(latest(page)).toContainText('Added “buy sunscreen” to your tasks.')
  await expect(review(page)).toHaveCount(0)
  expect((await saved(page)).state.personalTasks).toEqual([expect.objectContaining({ title: 'buy sunscreen', done: false, version: 1 })])
  await page.reload()
  await expect(conversation(page)).toContainText('Added “buy sunscreen”')
  await say(page, 'What needs my attention?')
  await expect(latest(page)).toContainText('On your list:')
  await expect(latest(page)).toContainText('buy sunscreen')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Mark buy sunscreen complete', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Mark buy sunscreen not done', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  await say(page, 'What needs my attention?')
  await expect(latest(page)).toContainText('Nothing in your saved tasks needs your attention')
  await expect(latest(page)).not.toContainText('buy sunscreen')
  const state = (await saved(page)).state
  expect(state.jobs).toHaveLength(3)
  expect(state.jobs.every((job: any) => job.conversation && !job.actions.length)).toBe(true)
  expect(state.personalTasks[0].done).toBe(true)
})

test('concurrent repeated task requests save one open task with truthful acknowledgments; completed tasks can recur', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createDeviceStore } = await import('/src/daymark/deviceStore.ts')
    const first = createDeviceStore(), second = createDeviceStore()
    await Promise.all([first.load(), second.load()])
    const ids = await Promise.all([first.client.submit('Add pack swimming kit to my tasks'), second.client.submit('Add pack swimming kit to my tasks')])
    first.close(); second.close()
    const reopened = createDeviceStore()
    await reopened.load()
    const retry = await reopened.client.submit('Add pack swimming kit to my tasks'), state = structuredClone(reopened.getSnapshot())
    const task = state.personalTasks![0]
    await reopened.client.setPersonalTaskDone!(task.id, task.version, true)
    await reopened.client.submit('Add pack swimming kit to my tasks')
    const repeated = structuredClone(reopened.getSnapshot())
    reopened.close()
    return { ids, retry, state, repeated }
  })
  expect(new Set([...result.ids, result.retry]).size).toBe(3)
  expect(result.state.personalTasks).toHaveLength(1)
  expect(result.state.jobs).toHaveLength(3)
  expect(result.state.jobs[0]).toMatchObject({ conversation: true, actions: [] })
  expect(result.state.jobs[0].clarification).toContain('already on your tasks')
  expect(result.state.plan).toEqual([])
  expect(result.repeated.personalTasks).toHaveLength(2)
  expect(result.repeated.personalTasks!.filter(task => !task.done)).toHaveLength(1)
  expect(result.repeated.jobs[0].clarification).toContain('Added “pack swimming kit”')
})

test('ordinary chat and capability questions stay conversational while a real notice still opens review', async ({ page, context, baseURL }) => {
  const outside: string[] = []
  context.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) outside.push(request.url()) })
  await page.goto('/')
  await say(page, 'Help me keep the household organized')
  await expect(latest(page)).toContainText('open-ended AI conversation isn’t connected yet')
  await expect(review(page)).toHaveCount(0)
  await say(page, 'Can you read my emails?')
  await expect(latest(page)).toContainText('cannot scan or read your inbox yet')
  await say(page, 'Can you buy things?')
  await expect(review(page)).toHaveCount(0)
  expect((await saved(page)).state.jobs.every((job: any) => job.conversation && !job.actions.length)).toBe(true)
  await say(page, 'Event: Maya’s museum trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
  await page.getByRole('button', { name: /^Review request:/ }).last().click()
  await expect(review(page)).toBeVisible()
  expect((await saved(page)).state.jobs[0].actions[0]).toMatchObject({ status: 'review', payload: { kind: 'calendar', title: 'Maya’s museum trip' }, receipts: [] })
  expect(outside).toEqual([])
})

test('reminders save dated tasks without promising alerts and timed requests do not create fake schedules', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-09T02:00:00Z'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Household settings' }).click()
  await page.getByText('Children and timezone', { exact: true }).click()
  await page.getByLabel('Household timezone', { exact: true }).fill('America/Los_Angeles')
  await page.getByRole('button', { name: 'Save household', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Household', exact: true })).toHaveCount(0)
  await say(page, 'Remind me to pack lunches tomorrow')
  await expect(latest(page)).toContainText('due 2026-10-09')
  await expect(latest(page)).toContainText('not a reminder alert')
  await say(page, 'Remind me to leave at 3 PM')
  await expect(latest(page)).toContainText('can’t set timed or recurring reminder alerts')
  const state = (await saved(page)).state
  expect(state.personalTasks).toHaveLength(1)
  expect(state.personalTasks[0]).toMatchObject({ title: 'pack lunches', dueDate: '2026-10-09' })
  expect(state.jobs.every((job: any) => job.conversation && !job.scheduledFor && !job.actions.length)).toBe(true)
})

test('calendar answers use saved events and household time; new status answers do not reuse the old review state', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-09T02:00:00Z'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Household settings' }).click()
  await page.getByText('Children and timezone', { exact: true }).click()
  await page.getByLabel('Household timezone', { exact: true }).fill('America/Los_Angeles')
  await page.getByLabel('Add a child', { exact: true }).fill('Maya')
  await page.getByRole('button', { name: 'Save household', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Household', exact: true })).toHaveCount(0)
  await say(page, 'Event: Maya’s museum trip\nDate: 2026-10-08\nTime: 8:30 AM to 2:30 PM\nLocation: North gate')
  await page.getByRole('button', { name: /^Review request:/ }).last().click()
  await expect(review(page)).toBeVisible()
  await review(page).getByRole('button', { name: 'Close', exact: true }).click()
  await say(page, 'What needs my attention?')
  await expect(latest(page)).toContainText('Calendar change ready for review')
  await say(page, 'What is on my calendar today?')
  await expect(latest(page)).toContainText('no events saved here for today (2026-10-08)')
  await conversation(page).getByRole('button', { name: /Maya’s museum trip/ }).click()
  await review(page).getByRole('button', { name: 'Save to device plan', exact: true }).click()
  await expect(review(page)).toContainText('Saved to your device plan')
  await review(page).getByRole('button', { name: 'Close', exact: true }).click()
  await say(page, 'What is on my calendar today?')
  await expect(latest(page)).toContainText('Maya’s museum trip — 8:30 AM')
  await expect(latest(page)).toContainText('isn’t a full sync')
  await say(page, 'What needs my attention?')
  await expect(latest(page)).toContainText('Nothing in your saved tasks needs your attention')
  await say(page, 'What are you handling?')
  await expect(latest(page)).toContainText('not handling any saved requests')
  expect((await saved(page)).state.plan).toHaveLength(1)
})

test('expired conversations lose source and reply text while confirmed personal tasks remain', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Add return library books to my tasks')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('daymark-device-v1')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('workspace', 'readwrite'), store = tx.objectStore('workspace'), request = store.get('current')
      request.onsuccess = () => {
        const data = request.result, job = data.state.jobs[0]
        job.source.text = 'SYNTHETIC EXPIRED SOURCE'; job.clarification = 'SYNTHETIC EXPIRED REPLY'
        data.expiry[job._id] = Date.now() - 1; store.put(data, 'current')
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
  await page.reload()
  await expect(conversation(page)).toContainText('This conversation has expired.')
  await expect(conversation(page)).not.toContainText('SYNTHETIC EXPIRED')
  await say(page, 'What needs my attention?')
  await expect(latest(page)).toContainText('return library books')
  const state = (await saved(page)).state
  expect(state.personalTasks).toHaveLength(1)
  expect(state.jobs[1].source.text).toBeUndefined()
})
