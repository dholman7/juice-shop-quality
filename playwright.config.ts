/**
 * Two projects: `api` (request-level tests, most of the suite) and `ui` (browser journeys in Chrome).
 * Reporters feed the pipeline: results.json is what triage, the report, and the coverage map read.
 */
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './src/config';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Must stay at or below QA_STAFF_SLOTS (src/staff.ts): each worker needs its own staff accounts.
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
    // Kept only for failures, so a person or the triage agent has evidence without bloating passing runs.
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
