import { describe, expect, it } from 'vitest';
import { shellWebPreferences } from './web-preferences.js';

describe('shellWebPreferences', () => {
  it('keeps the renderer sandboxed and isolated from Node', () => {
    expect(shellWebPreferences('preload.cjs')).toEqual({
      preload: 'preload.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });
});
