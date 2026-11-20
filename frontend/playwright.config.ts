import { defineConfig } from '@playwright/test';

/**
 * The board's guarantees are layout guarantees: no sideways scroll, a drawer
 * that opens to a usable height, a water staff that drags. They are cheap to
 * check in a real browser and were all broken at least once during the
 * redesign, so they run here instead of in a screenshot script.
 *
 * Locally this uses the installed Chrome; CI installs Playwright's Chromium.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start -- --port 3210',
    url: 'http://127.0.0.1:3210',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
