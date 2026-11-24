import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  // On CI a failed test runs once more and, if it then passes, is reported as flaky. Its trace
  // (e2e/fixtures/trace.ts) is kept either way.
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: 'list',
});
