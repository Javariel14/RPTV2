import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'crm.spec.ts',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  outputDir: '../../work/u3-browser-results',
  reporter: [
    ['list'],
    ['json', { outputFile: 'work/u3-e2e-results.json' }],
    ['html', { outputFolder: 'work/u3-playwright-report', open: 'never' }],
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
