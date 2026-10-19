import { test, expect, type Page } from '@playwright/test'

async function openPreview(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Household settings' }).click()
  await page.getByText('Your assistant', { exact: true }).click()
  await page.getByText('Expressions & motion', { exact: true }).click()
  const preview = page.getByRole('region', { name: 'Character preview' })
  await preview.scrollIntoViewIfNeeded()
  return preview
}

test('six expressions replay finite motion without changing saved preferences or tasks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const preview = await openPreview(page)
  for (const [label, mood] of [['Calm', 'idle'], ['Listening', 'listening'], ['Preparing', 'working'], ['Ready for you', 'review'], ['Pleased', 'done'], ['Resting', 'resting']]) {
    await preview.getByRole('button', { name: label, exact: true }).click()
    const avatar = preview.locator('.dm-avatar-stage .dm-avatar')
    await expect(avatar).toHaveAttribute('data-mood', mood)
    await expect(avatar).toHaveAttribute('data-animate', 'true')
    await expect.poll(() => avatar.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const motion = await avatar.locator('img').evaluate(img => { const style = getComputedStyle(img); return { name: style.animationName, seconds: parseFloat(style.animationDuration), iterations: parseFloat(style.animationIterationCount) } })
    expect(motion.name).toMatch(/^sola-/)
    expect(motion.seconds * motion.iterations).toBeLessThanOrEqual(3.2)
    await preview.getByRole('button', { name: 'Replay animation' }).click()
    await expect.poll(() => avatar.locator('img').evaluate(img => img.getAnimations().length)).toBe(1)
    // CSS motion actually changes the rendered character, and settles back to neutral.
    const transform = await avatar.locator('img').evaluate(img => { const animation = img.getAnimations()[0]; animation.pause(); animation.currentTime = 500; return getComputedStyle(img).transform })
    expect(transform).not.toBe('none')
    await avatar.locator('img').evaluate(img => img.getAnimations().forEach(animation => animation.finish()))
    await expect(avatar.locator('img')).toHaveCSS('transform', 'none')
  }
  await expect(page.getByLabel('Assistant name', { exact: true })).toHaveValue('Sola')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.dm-header .dm-avatar')).toHaveAttribute('data-mood', 'idle')
  await page.getByLabel('What can I handle?').focus()
  await expect(page.locator('.dm-header .dm-avatar')).toHaveAttribute('data-mood', 'listening')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.dm-task-row')).toHaveCount(0)
})

test('Reduce Motion changes live and the initial appearance stays still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const preview = await openPreview(page)
  await preview.getByRole('button', { name: 'Pleased', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Replay animation' })).toBeDisabled()
  await expect(preview.locator('.dm-avatar-stage img')).toHaveCSS('animation-name', 'none')
  await expect(preview.getByText('Motion is off in your device settings.')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(preview.getByRole('button', { name: 'Replay animation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Initial', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByLabel('What can I handle?').focus()
  await expect(page.locator('.dm-header .dm-avatar img')).toHaveCount(0)
  await expect(page.locator('.dm-header .dm-avatar')).toHaveAttribute('data-animate', 'false')
})

test('unavailable expressions fall back to the original, then the assistant initial', async ({ page }) => {
  await page.route('**/avatars/sola-*.png', route => route.fulfill({ status: 404, body: '' }))
  const preview = await openPreview(page)
  await preview.getByRole('button', { name: 'Pleased', exact: true }).click()
  await expect(preview.locator('.dm-avatar-stage img')).toHaveAttribute('src', '/avatars/companion.png?v=3')
  await expect(preview.locator('.dm-avatar-stage .dm-avatar')).toHaveAttribute('data-animate', 'false')
  await page.route('**/avatars/companion.png*', route => route.fulfill({ status: 404, body: '' }))
  await page.reload()
  await expect(page.locator('.dm-header .dm-avatar-initial')).toHaveText('S')
})
