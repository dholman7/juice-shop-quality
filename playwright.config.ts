import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './src/config';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: process.env.CI ? 4 : 6,
  // One retry, so a test that passes on retry is visible as flaky instead of hidden.
  retries: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/results.json' }],
    ['html', { outputFolder: 'reports/playwright', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testMatch: /api\/.*\.spec\.ts/ },
    {
      name: 'ui',
      testMatch: /ui\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
