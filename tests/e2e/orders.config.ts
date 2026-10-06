import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'orders.spec.ts',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  outputDir: '../../work/orders-browser-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3101',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:crm',
    url: 'http://127.0.0.1:3101/orders',
    timeout: 180000,
    reuseExistingServer: false,
    env: { RPT_CRM_TEST_CODE: 'orders-e2e' },
  },
});
