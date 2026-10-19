import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) test(`composer keeps stable one-line geometry and input focus through send in ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: 'What can I handle?', exact: true }), composer = page.locator('.dm-composer'), dock = page.locator('.dm-dock')
  await expect(input).toBeEnabled()
  const before = (await dock.boundingBox())!
  await input.fill('Add milk to my tasks')
  await expect(input).toBeFocused()
  const after = (await dock.boundingBox())!
  expect(Math.abs(before.height - after.height)).toBeLessThan(2)
  expect(await input.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  expect(await composer.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(input).toHaveValue(''); await expect(input).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Saving your request' })).toHaveCount(0)
  await input.fill('One line\nSecond line\nThird line\nFourth line')
  expect((await composer.boundingBox())!.height).toBeGreaterThan(60)
  expect((await composer.boundingBox())!.height).toBeLessThan(150)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `test-results/composer-${colorScheme}.png`, animations: 'disabled' })
})

test('keyboard navigation retains a focus indicator without outlining the composer during pointer typing', async ({ page }) => {
  await page.goto('/')
  const input = page.getByRole('textbox', { name: 'What can I handle?', exact: true }), composer = page.locator('.dm-composer')
  await expect(input).toBeEnabled()
  for (let i = 0; i < 12 && !await input.evaluate(element => element === document.activeElement); i++) await page.keyboard.press('Tab')
  await expect(input).toBeFocused()
  expect(await composer.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
  await input.click()
  expect(await composer.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
})
