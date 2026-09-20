import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: '.',
  testMatch: ['crm.spec.ts', 'crm-u4.spec.ts', 'crm-u5.spec.ts'],
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  outputDir: '../../work/u3-browser-results',
  reporter: [
    ['./u4-reporter.ts'],
    ['./u5-reporter.ts'],
    ['list'],
    ['json', { outputFile: resolve('work/u3-e2e-results.json') }],
    ['html', { outputFolder: resolve('work/u3-playwright-report'), open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3101',
    browserName: 'chromium',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'npm run dev:crm',
    url: 'http://127.0.0.1:3101/crm/commercial',
    timeout: 120000,
    reuseExistingServer: false,
    env: { RPT_CRM_TEST_CODE: 'u3-synthetic-test-session' },
  },
});
