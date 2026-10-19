import { expect, test, type Page } from '@playwright/test'
import type { DaymarkState, Job } from '../../web/src/daymark/types'

const pickup = { kind: 'pickup' as const, childId: 'maya', caregiverId: 'alex', date: '2027-05-05', time: '15:00', timezone: 'UTC', location: 'North gate', deadline: '2027-05-05T12:00:00Z', message: 'Can you collect Maya?', evidence: {} }
const fixture = (): DaymarkState => {
  const start = Date.now() - 3600000
  const waiting: Job = { _id: 'pickup-thread', createdAt: start, preparing: false, cancelled: false, clarification: 'I’ve prepared the pickup request. Review the details before sending.', source: { text: 'Ask Alex about Maya’s pickup.', revision: 1 }, actions: [{ _id: 'pickup-action', revision: 1, status: 'waiting', payload: pickup, receipts: [{ _id: 'send-receipt', revision: 1, outcome: 'request_email_accepted', providerId: 'synthetic-mail', verifiedAt: start + 1000 }] }] }
  return { configured: true, signedIn: true, ownerKey: 'synthetic-parent', household: { timezone: 'UTC', children: [{ id: 'maya', name: 'Maya' }] }, jobs: [waiting, ...Array.from({ length: 18 }, (_, i): Job => ({ _id: `turn-${i}`, createdAt: start + 2000 + i * 1000, preparing: false, cancelled: false, conversation: true, source: { text: `Synthetic question ${i}`, revision: 1 }, clarification: `Synthetic answer ${i}. A little more useful context to keep this conversation readable.`, actions: [] }))], plan: [], caregivers: [{ _id: 'alex', name: 'Alex', email: 'synthetic@example.test', childIds: ['maya'] }], arrangements: [], connection: null }
}
async function start(page: Page) {
  await page.addInitScript(value => { if (!sessionStorage.getItem('synthetic-state')) sessionStorage.setItem('synthetic-state', JSON.stringify(value)) }, fixture())
  await page.goto('/e2e.html?scenario=conversation-updates')
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toBeVisible()
}
const deliver = (page: Page) => page.getByRole('button', { name: 'Deliver synthetic caregiver answer' }).evaluate((button: HTMLButtonElement) => button.click())
const updates = (page: Page) => page.locator('[data-conversation-update]')

test('an authoritative caregiver response arrives as one chronological message, dedupes repeated readback and survives reload honestly', async ({ page }) => {
  await start(page)
  await deliver(page)
  await expect(updates(page).filter({ hasText: 'Alex accepted Maya’s pickup.' })).toHaveCount(1)
  await expect(page.getByLabel('Request updates', { exact: true })).toContainText('Alex accepted Maya’s pickup.')
  const message = updates(page).filter({ hasText: 'Alex accepted Maya’s pickup.' })
  const stableId = await message.getAttribute('data-conversation-update'), timestamp = await message.locator('time').getAttribute('datetime')
  await deliver(page)
  await expect(updates(page).filter({ hasText: 'Alex accepted Maya’s pickup.' })).toHaveCount(1)
  expect(await message.getAttribute('data-conversation-update')).toBe(stableId)
  expect(await message.locator('time').getAttribute('datetime')).toBe(timestamp)
  await page.reload()
  await expect(updates(page).filter({ hasText: 'Alex accepted Maya’s pickup.' })).toHaveCount(1)
  await expect(page.getByText('just now', { exact: false })).toHaveCount(0)
  await expect(page.getByLabel('Request updates', { exact: true })).toBeEmpty()
  await expect(page.getByText('Pickup completed', { exact: false })).toHaveCount(0)
})

test('correcting or removing the authorized request withdraws old-revision confirmations and live announcements', async ({ page }) => {
  await start(page); await deliver(page)
  await expect(updates(page).filter({ hasText: 'Alex accepted' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Correct synthetic request' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(updates(page)).toHaveCount(0)
  await expect(page.getByText('Alex accepted Maya’s pickup.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove authorized request' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('#conversation-job-pickup-thread')).toHaveCount(0)
})

for (const colorScheme of ['light', 'dark'] as const) test(`Tasks returns to the relevant main-thread message with draft, focus and explicit review in ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
  await start(page)
  await page.getByLabel('What can I handle?').fill('Keep this unsent follow-up')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('region', { name: 'Tasks', exact: true }).getByRole('button', { name: /Maya pickup/ }).click()
  const target = page.locator('#conversation-job-pickup-thread')
  await expect(target).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('What can I handle?')).toHaveValue('Keep this unsent follow-up')
  await expect(target.getByText('I’ve prepared the pickup request. Review the details before sending.', { exact: true })).toBeVisible()
  await expect(target.locator('.dm-deliverable')).toHaveCount(0)
  await target.getByRole('button', { name: /View request: Pickup request/ }).click()
  await expect(page.getByRole('dialog', { name: 'Review request' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath(`conversation-${colorScheme}.png`), animations: 'disabled' })
})

test('a late caregiver receipt preserves reading position and offers Latest messages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await start(page)
  await page.evaluate(() => window.scrollTo(0, 400)); await page.waitForTimeout(150)
  const position = await page.evaluate(() => window.scrollY)
  await deliver(page)
  await expect(page.getByRole('button', { name: 'Latest messages ↓' })).toBeVisible()
  expect(await page.evaluate(() => window.scrollY)).toBe(position)
  await page.getByRole('button', { name: 'Latest messages ↓' }).click()
  await expect(updates(page).filter({ hasText: 'Alex accepted Maya’s pickup.' })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('conversation-late-update-390.png'), animations: 'disabled' })
})
