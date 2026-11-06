import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * The development server injects styles and scripts inline and talks over a WebSocket, which the
 * production policy rightly forbids. This changes the page only when served, never when built.
 */
function developmentContentSecurityPolicy(): Plugin {
  return {
    name: 'bildora-development-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self'", "connect-src 'self' ws:"),
  };
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rolldownOptions: {
        output: {
          // A sandboxed preload cannot load ES modules.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), developmentContentSecurityPolicy()],
  },
});
