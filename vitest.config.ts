import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'protocol', root: 'packages/protocol', include: ['src/**/*.test.ts'] } },
      { test: { name: 'core', root: 'packages/core', include: ['src/**/*.test.ts'] } },
      { test: { name: 'panel-sdk', root: 'packages/panel-sdk', include: ['src/**/*.test.ts'] } },
      { test: { name: 'cli', root: 'apps/cli', include: ['src/**/*.test.ts'] } },
      { test: { name: 'desktop', root: 'apps/desktop', include: ['src/**/*.test.ts'] } },
    ],
  },
});
