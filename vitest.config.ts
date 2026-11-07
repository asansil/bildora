import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'protocol', root: 'packages/protocol', include: ['src/**/*.test.ts'] } },
      {
        test: {
          name: 'core',
          root: 'packages/core',
          include: ['src/**/*.test.ts'],
          // These start real processes, which take far longer when every project runs at once.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'panel-sdk',
          root: 'packages/panel-sdk',
          include: ['src/**/*.test.ts'],
          // Without this, Vitest replaces CSS with nothing, and the token tests need the real file.
          css: true,
        },
      },
      {
        test: {
          name: 'cli',
          root: 'apps/cli',
          include: ['src/**/*.test.ts'],
          // These start real processes too.
          testTimeout: 30_000,
        },
      },
      { test: { name: 'desktop', root: 'apps/desktop', include: ['src/**/*.test.ts'] } },
    ],
  },
});
