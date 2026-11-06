import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  timeout: 120_000,
  // The first run after a build is the slowest, at over five seconds to the first output.
  expect: { timeout: 30_000 },
});
