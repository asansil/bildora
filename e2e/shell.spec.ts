import { resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/** VS Code leaks ELECTRON_RUN_AS_NODE to child processes, which stops Electron opening a window. */
function electronEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
    ),
  );
}

test('the built shell opens a sandboxed window', async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment(),
  });
  try {
    const window = await app.firstWindow();

    await expect(window).toHaveTitle('Bildora');
    await expect(window.getByRole('heading', { name: 'Bildora' })).toBeVisible();
    await expect(window.getByTestId('platform')).toHaveText(process.platform);
    expect(await window.evaluate(() => typeof Reflect.get(globalThis, 'require'))).toBe(
      'undefined',
    );
  } finally {
    await app.close();
  }
});
