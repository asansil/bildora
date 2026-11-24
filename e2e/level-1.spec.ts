import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApps } from './fixtures/close.js';
import { startTrace, stopTraces } from './fixtures/trace.js';

const MANIFEST = resolve('examples/level-1-file-report/tool.yaml');
const MENU_MANIFEST = resolve('examples/level-1-menu-cli/tool.yaml');
const SECRET = 'e2e-Secret-Value-4711';

function electronEnvironment(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

let folder: string;
let dataDir: string;
let sample: string;
let open: ElectronApplication[] = [];
let problems: string[] = [];

async function launchShell(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  await startTrace(app);
  const window = await app.firstWindow();
  window.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) {
      problems.push(message.text());
    }
  });
  return { app, window };
}

async function stubPicker(app: ElectronApplication, paths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...filePaths] });
  }, paths);
}

async function importSample(app: ElectronApplication, window: Page): Promise<void> {
  await stubPicker(app, [MANIFEST]);
  await window.getByRole('menuitem', { name: 'File' }).click();
  await window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await expect(window.getByTestId('manifest-row')).toContainText('filesystem.read');
  await window.getByRole('button', { name: 'Import 1 tool' }).click();
  await expect(window.getByRole('heading', { name: 'File Report', level: 1 })).toBeVisible();
}

function consoleOf(window: Page) {
  return window.getByTestId('console');
}

async function runSample(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Run', exact: true }).click();
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-level1-'));
  dataDir = join(folder, 'data');
  sample = join(folder, 'notes.txt');
  await writeFile(sample, 'one two three\nfour five\nsix\n');
  problems = [];
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  await rm(folder, { recursive: true, force: true });
});

test('runs a declared tool from its form, and records the run', async () => {
  const { app, window } = await launchShell();
  await importSample(app, window);

  await runSample(window);
  await expect(window.getByText('This field is required.')).toBeVisible();

  await window.getByLabel('File (required)').fill(sample);
  await window.getByLabel('Longest lines').fill('abc');
  await runSample(window);
  await expect(window.getByText('Enter a whole number.')).toBeVisible();

  await window.getByLabel('Longest lines').fill('1');
  await window.getByLabel('Report title').fill('My notes');
  await window.getByLabel('Show each step').check();
  await window.getByLabel('Signing token').fill(SECRET);
  await runSample(window);

  await expect(consoleOf(window)).toContainText('My notes');
  await expect(consoleOf(window)).toContainText('Words: 6');
  await expect(consoleOf(window)).toContainText('Signed with a token');
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'completed',
  );

  await window.getByRole('button', { name: 'History', exact: true }).click();
  await window.locator('.history-row').first().click();
  const detail = window.getByTestId('history-detail');
  await expect(detail).toContainText('File Report');
  await expect(window.getByTestId('history-output')).toContainText('Words: 6');
  await expect(window.getByTestId('history-output')).not.toContainText('bildora-progress');
  await expect(window.getByTestId('history-parameters')).toContainText('notes.txt');
  await expect(window.getByTestId('history-parameters')).toContainText('Secret, not recorded');

  for (const file of await readdir(dataDir)) {
    if (file.startsWith('history.db')) {
      expect(await readFile(join(dataDir, file), 'latin1')).not.toContain(SECRET);
    }
  }
  expect(problems).toEqual([]);
});

test('shows progress, takes typed input and can be stopped', async () => {
  const script = join(folder, 'slow.mjs');
  await writeFile(
    script,
    `console.log('::bildora-progress {"percent":40,"message":"Waiting for you"}');
console.log('READY');
process.stdin.setEncoding('utf8');
process.stdin.once('data', (data) => {
  console.log('TYPED ' + data.trim());
  setInterval(() => undefined, 1000);
});`,
  );
  await writeFile(
    join(folder, 'tool.yaml'),
    `schemaVersion: 1
id: slow
name: Slow
version: 1.0.0
level: 1
interpreter: node
run:
  program: slow.mjs
`,
  );
  const { app, window } = await launchShell();
  await stubPicker(app, [join(folder, 'tool.yaml')]);
  await window.getByRole('menuitem', { name: 'File' }).click();
  await window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await window.getByRole('button', { name: 'Import 1 tool' }).click();

  await runSample(window);
  await expect(consoleOf(window)).toContainText('READY');
  await expect(window.getByTestId('run-progress')).toContainText('Waiting for you');
  await expect(window.getByTestId('status')).toContainText('1 task running');

  await consoleOf(window).click();
  await window.keyboard.type('hello');
  await window.keyboard.press('Enter');
  await expect(consoleOf(window)).toContainText('TYPED hello');

  await window.getByRole('button', { name: 'Stop' }).click();
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'cancelled',
  );
  await expect(window.getByTestId('status')).toHaveText('Ready');
  expect(problems).toEqual([]);
});

test('keeps values in a profile and secrets out of it', async () => {
  const { app, window } = await launchShell();
  await importSample(app, window);

  await window.getByLabel('Report title').fill('Saved title');
  await window.getByLabel('Signing token').fill(SECRET);
  await window.getByRole('button', { name: 'Save as…' }).click();
  await window.getByRole('dialog').getByLabel('Name').fill('Nightly');
  await window.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(window.getByLabel('Profile')).toHaveValue('nightly');

  const file = join(
    dataDir,
    'workspaces',
    'default',
    'tools',
    'bildora.sample.file-report',
    'profiles',
    'nightly.yaml',
  );
  const text = await readFile(file, 'utf8');
  expect(text).toContain('Saved title');
  expect(text).not.toContain(SECRET);

  await window.getByLabel('Profile').selectOption('');
  await expect(window.getByLabel('Report title')).toHaveValue('');
  await window.getByLabel('Profile').selectOption('nightly');
  await expect(window.getByLabel('Report title')).toHaveValue('Saved title');
  await expect(window.getByLabel('Signing token')).toHaveValue('');
  await expect(window.getByLabel('Signing token')).toHaveAttribute(
    'placeholder',
    'Saved in the credential store',
  );

  await window.getByLabel('File (required)').fill(sample);
  await runSample(window);
  await expect(consoleOf(window)).toContainText('Signed with a token');

  await window.getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('dialog').getByRole('button', { name: 'Remove tool' }).click();
  await expect(window.getByRole('heading', { name: 'File Report', level: 1 })).toBeHidden();

  // Removing the tool took the secret with it, and left the run as evidence.
  await window.getByRole('button', { name: 'Run history' }).click();
  await expect(window.locator('.history-row')).toHaveCount(1);
  expect(problems).toEqual([]);
});

test('refuses a manifest it cannot use, and says why', async () => {
  const manifest = join(folder, 'tool.yaml');
  await writeFile(manifest, 'schemaVersion: 99\nid: future\n');
  const { app, window } = await launchShell();
  await stubPicker(app, [manifest]);

  await window.getByRole('menuitem', { name: 'File' }).click();
  await window.getByRole('menuitem', { name: 'Add a tool…' }).click();

  await expect(window.getByTestId('refused-manifest')).toContainText('Update Bildora');
  await expect(window.getByRole('button', { name: 'Import 0 tools' })).toBeDisabled();
});

test('ends a console run on close and records it as cancelled', async () => {
  const script = join(folder, 'hang.mjs');
  await writeFile(script, `console.log('READY');\nsetInterval(() => undefined, 1000);`);
  await writeFile(
    join(folder, 'tool.yaml'),
    `schemaVersion: 1
id: hang
name: Hang
version: 1.0.0
level: 1
interpreter: node
run:
  program: hang.mjs
`,
  );
  const first = await launchShell();
  await stubPicker(first.app, [join(folder, 'tool.yaml')]);
  await first.window.getByRole('menuitem', { name: 'File' }).click();
  await first.window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await first.window.getByRole('button', { name: 'Import 1 tool' }).click();
  await runSample(first.window);
  await expect(consoleOf(first.window)).toContainText('READY');

  await first.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  });
  const closed = first.app.waitForEvent('close');
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
  open = [];

  const second = await launchShell();
  await second.window.getByRole('button', { name: 'Run history' }).click();
  await second.window.locator('.history-row').first().click();
  await expect(second.window.getByTestId('history-detail')).toContainText('Cancelled');
});

test('answers a console menu by hand or with the script, and remembers the choice', async () => {
  const first = await launchShell();
  await stubPicker(first.app, [MENU_MANIFEST]);
  await first.window.getByRole('menuitem', { name: 'File' }).click();
  await first.window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await first.window.getByRole('button', { name: 'Import 1 tool' }).click();
  const window = first.window;
  await expect(window.getByRole('heading', { name: 'Greeting Writer', level: 1 })).toBeVisible();

  const choice = window.getByLabel('Answer with the script');
  await expect(choice).not.toBeChecked();
  await expect(window.getByLabel('Name (required)')).toHaveCount(0);
  await expect(window.getByLabel('Capitals')).toBeVisible();

  await runSample(window);
  await expect(consoleOf(window)).toContainText('Format [csv/json]:');
  await consoleOf(window).click();
  await window.keyboard.type('csv');
  await window.keyboard.press('Enter');
  await expect(consoleOf(window)).toContainText('Your name:');
  await window.keyboard.type('Bob');
  await window.keyboard.press('Enter');
  await expect(consoleOf(window)).toContainText('Continue? [y/n]');
  await window.keyboard.type('y');
  await window.keyboard.press('Enter');
  await expect(consoleOf(window)).toContainText('Hello, Bob');
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'completed',
  );

  await choice.check();
  await runSample(window);
  await expect(window.getByText('This field is required.')).toBeVisible();
  await window.getByLabel('Name (required)').fill('Ada');
  await window.getByLabel('Format').selectOption('json');
  await runSample(window);
  await expect(consoleOf(window)).toContainText('"greeting": "Hello, Ada"');
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'completed',
  );

  await first.app.close();
  open = [];
  const second = await launchShell();
  await expect(
    second.window.getByRole('heading', { name: 'Greeting Writer', level: 1 }),
  ).toBeVisible();
  await expect(second.window.getByLabel('Answer with the script')).toBeChecked();
  await expect(second.window.getByLabel('Name (required)')).toBeVisible();
  expect(problems).toEqual([]);
});
