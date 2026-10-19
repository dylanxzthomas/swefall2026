import { expect, test } from '@playwright/test'
import { notice } from '../fixtures/calendar'

for (const incomplete of [false, true]) test(`Gmail review shows source coverage ${incomplete ? 'with missing text' : 'from HTML text'}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`/e2e.html?scenario=gmail-source${incomplete ? '-incomplete' : ''}`)
  await page.getByLabel('What can I handle?').fill(notice)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review request' }), source = review.getByRole('region', { name: 'Gmail source details' })
  await expect(review).toHaveCount(0)
  await page.getByRole('button', { name: /^Review request:/ }).click()
  await expect(source).toContainText('Synthetic field trip notice')
  await expect(source).toContainText('school@example.test')
  await expect(source).toContainText('PDT')
  await source.getByText('Source coverage', { exact: true }).click()
  await expect(source).toContainText('Attachments were not read')
  await expect(source).toContainText('Linked pages were not opened')
  await expect(source).toContainText('prepared work for your review')
  if (incomplete) {
    await expect(source).toContainText('Check the original message for missing details before approving')
    await expect(source).toContainText('Only the email preview was available')
  } else await expect(source).not.toContainText('email text is incomplete')
  expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => sessionStorage.getItem('synthetic-approvals'))).toBeNull()
  await page.screenshot({ path: test.info().outputPath(`gmail-source-${incomplete ? 'incomplete' : 'html'}-dark.png`), animations: 'disabled' })
})
