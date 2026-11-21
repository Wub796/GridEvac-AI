import { defineConfig } from '@playwright/test';

/**
 * The deployed-site smoke test talks to production, so this config has no
 * webServer: nothing is built or started locally. The board's own suite lives
 * in playwright.config.ts and ignores this spec.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'deployed.smoke.spec.ts',
  timeout: 90_000,
  retries: 1, // a deployment can still be promoting on the first run
  use: {
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
  },
});
