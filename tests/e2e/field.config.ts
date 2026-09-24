import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'field.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: '../../work/e2d-test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: '../../work/e2d-e2e-results.json' }],
    ['html', { outputFolder: '../../work/e2d-playwright-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3101',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:crm',
    url: 'http://127.0.0.1:3101/api/field/ready',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { RPT_CRM_TEST_CODE: 'field-e2e-code' },
  },
});
