import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

// Keep platform-specific native fonts. Baselines were reviewed on macOS/Chromium;
// a different OS/browser needs its own reviewed set, not a permissive pixel threshold.
export default defineConfig(base, {
  testMatch: '*.visual.ts',
  outputDir: 'visual-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'visual-report' }]],
  updateSnapshots: 'none',
  use: { ...base.use, locale: 'en-US', timezoneId: 'America/Los_Angeles' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixels: 40 } },
})
