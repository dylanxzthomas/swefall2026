import { expect, test } from '@playwright/test'

test('late replies preserve reading position and offer a way back to the latest messages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/e2e.html?scenario=mailbox-long-chat')
  await expect(page.getByText('Synthetic summary 11.', { exact: false })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 400))
  await page.waitForTimeout(150) // Allow the passive scroll listener to record the reading position.
  const before = await page.evaluate(() => window.scrollY)
  await page.getByRole('button', { name: 'Deliver synthetic late reply' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('button', { name: 'Latest messages ↓' })).toBeVisible()
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  await page.getByRole('button', { name: 'Latest messages ↓' }).click()
  await expect(page.getByText('A synthetic late reply has arrived.', { exact: false })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Latest messages ↓' })).not.toBeVisible()
})

test('desktop Enter submits once; Shift Enter and phone Enter preserve a newline', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto('/e2e.html?scenario=mailbox-connected')
  const input = page.getByPlaceholder('What can I handle?')
  await input.fill('Check my email')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('Check my email\n')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('mailbox-actions') ?? '[]').filter((a: { action: string }) => a.action === 'private-request').length)).toBe(1)
  await expect(input).toHaveValue('')
  await page.setViewportSize({ width: 390, height: 844 })
  await input.fill('Check my email')
  await input.press('Enter')
  await expect(input).toHaveValue('Check my email\n')
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('mailbox-actions') ?? '[]').filter((a: { action: string }) => a.action === 'private-request').length)).toBe(1)
})

test('following a late reply keeps its final text above the composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/e2e.html?scenario=mailbox-long-chat')
  await expect(page.locator('.dm-mail-answer').last()).toBeAttached()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.scrollY - window.innerHeight)).toBeLessThan(3)
  const before = await page.evaluate(() => window.scrollY)
  await page.getByRole('button', { name: 'Deliver synthetic late reply' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before)
  await expect.poll(() => page.evaluate(() => {
    const replies = document.querySelectorAll('.dm-mail-answer')
    return replies[replies.length - 1].getBoundingClientRect().bottom <= document.querySelector('.dm-dock')!.getBoundingClientRect().top
  })).toBe(true)
  await expect(page.getByRole('button', { name: 'Latest messages ↓' })).not.toBeVisible()
})
