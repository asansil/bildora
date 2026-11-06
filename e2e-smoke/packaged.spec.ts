import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const UNPACKED = resolve('apps/desktop/release/win-unpacked');
const SAMPLE = resolve('examples/level-1-file-report');
const SECRET = 'smoke-Secret-Value-4711';

/** What a user's machine has: no development variables, and the tool's runtime on `PATH`. */
function userEnvironment(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      !entry[0].startsWith('ELECTRON_') &&
      !entry[0].startsWith('BILDORA_') &&
      entry[1] !== undefined,
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

async function launch(
  folder: string,
  dataDir: string,
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    executablePath: join(folder, 'app', 'Bildora.exe'),
    args: [],
    env: userEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  return { app, window: await app.firstWindow() };
}

test.skip(process.platform !== 'win32', 'Packages exist for Windows only so far');

test('the packaged app, moved away from the repository, runs a level 1 tool', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bildora smoke ñ-'));
  const dataDir = join(folder, 'data');
  const toolFolder = join(folder, 'sample tool');
  const input = join(folder, 'notes.txt');
  await cp(UNPACKED, join(folder, 'app'), { recursive: true });
  await cp(SAMPLE, toolFolder, { recursive: true });
  await writeFile(input, 'one two three\n');

  const { app, window } = await launch(folder, dataDir);
  try {
    await expect(window.getByTestId('status')).toHaveText('Ready');
    await expect(window.locator('.status-end')).toContainText('alpha');

    await app.evaluate(
      ({ dialog }, manifest) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [manifest] });
      },
      join(toolFolder, 'tool.yaml'),
    );
    await window.getByRole('menuitem', { name: 'File' }).click();
    await window.getByRole('menuitem', { name: 'Add a tool…' }).click();
    await window.getByRole('button', { name: 'Import 1 tool' }).click();

    await window.getByLabel('File (required)').fill(input);
    await window.getByLabel('Signing token').fill(SECRET);
    await window.getByRole('button', { name: 'Save as…' }).click();
    await window.getByRole('dialog').getByLabel('Name').fill('Smoke');
    await window.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(window.getByLabel('Profile')).toHaveValue('smoke');

    await window.getByRole('button', { name: 'Run', exact: true }).click();
    const console_ = window.getByTestId('console');
    await expect(console_).toContainText('Words: 3');
    await expect(console_).toContainText('Signed with a token');

    await window.getByRole('button', { name: 'History', exact: true }).click();
    await window.locator('.history-row').first().click();
    await expect(window.getByTestId('history-output')).toContainText('Words: 3');

    for (const file of await readdir(dataDir)) {
      if (file.startsWith('history.db')) {
        expect(await readFile(join(dataDir, file), 'latin1')).not.toContain(SECRET);
      }
    }

    // Leaves nothing in the credential store.
    await window.getByRole('menuitem', { name: 'Tools' }).click();
    await window.getByRole('menuitem', { name: 'Find a tool or action…' }).click();
    await window.getByRole('combobox', { name: 'Find a tool or action' }).fill('File Report');
    await window.keyboard.press('Enter');
    await window.getByRole('button', { name: 'Remove' }).click();
    await window.getByRole('dialog').getByRole('button', { name: 'Remove tool' }).click();
  } finally {
    await app.close().catch(() => undefined);
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
