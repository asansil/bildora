import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

const FAKE_TOOL = resolve('examples/fixtures/fake-tool.mjs');

function electronEnvironment(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

let folder: string;
let dataDir: string;
let open: ElectronApplication[] = [];

async function launchShell(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  return { app, window: await app.firstWindow() };
}

/** Definitions are plain files, so tests can start from what a user would have on disk. */
async function writeTool(id: string, name: string, body: string): Promise<void> {
  const directory = join(dataDir, 'tools', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1
id: ${id}
name: ${name}
version: 1.0.0
level: 1
interpreter: node
${body}`,
  );
}

function fakeTool(id: string, name: string, args: readonly string[]): Promise<void> {
  const list = args.map((argument) => `'${argument}'`).join(', ');
  return writeTool(id, name, `run:\n  program: ${FAKE_TOOL}\n  args: [${list}]\n`);
}

async function writeAutomation(id: string, name: string, steps: string): Promise<string> {
  const file = join(dataDir, 'workspaces', 'default', 'automations', `${id}.yaml`);
  await writeFile(file, `schemaVersion: 1\nid: ${id}\nname: ${name}\nsteps:\n${steps}`);
  return file;
}

function rail(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name, exact: true });
}

function step(window: Page, id: string): Locator {
  return window.locator(`[data-testid="automation-step"][data-step-id="${id}"]`);
}

function editorStep(window: Page, id: string): Locator {
  return window.locator(`[data-testid="step-editor"][data-step-id="${id}"]`);
}

async function openAutomation(window: Page, name: string): Promise<void> {
  await rail(window, 'Automations').click();
  await window.locator('.history-row', { hasText: name }).click();
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-automations-'));
  dataDir = join(folder, 'data');
  const workspace = join(dataDir, 'workspaces', 'default');
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
});

test.afterEach(async () => {
  await Promise.all(open.map((app) => app.close().catch(() => undefined)));
  open = [];
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('builds an automation in the editor and runs it, handing a file between steps', async () => {
  const script = join(folder, 'write.mjs');
  await writeFile(
    script,
    `import { readFileSync, writeFileSync } from 'node:fs';
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const from = process.argv.includes('--from') ? readFileSync(value('--from'), 'utf8') : 'start';
writeFileSync(value('--to'), from + '+more');`,
  );
  await writeTool(
    'writer',
    'Writer',
    `run:
  program: ${script}
parameters:
  - { name: from, type: path, label: From, flag: --from }
  - { name: to, type: path, label: To, flag: --to }
outputs:
  - { name: file, param: to }
`,
  );

  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await expect(window.getByText('No automations in this Workspace yet.')).toBeVisible();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Hand over');

  await window.getByRole('button', { name: 'Run a tool' }).click();
  const first = editorStep(window, 'writer');
  await first.getByLabel('Use a reference').nth(1).selectOption({ label: 'Folder of this run' });
  await first.getByLabel('To', { exact: true }).fill('{{run.folder}}/one.txt');

  await window.getByRole('button', { name: 'Run a tool' }).click();
  const second = editorStep(window, 'writer-2');
  await second.getByLabel('Use a reference').nth(0).selectOption({ label: 'writer: file' });
  await second.getByLabel('To', { exact: true }).fill('{{run.folder}}/two.txt');

  await window.getByRole('button', { name: 'Wait for a person' }).click();
  await window.getByRole('button', { name: 'Move step 3 up' }).click();
  await expect(window.getByTestId('step-editor').nth(1)).toHaveAttribute('data-step-id', 'review');
  await window.getByRole('button', { name: 'Save automation' }).click();

  await expect(window.getByTestId('automation-command')).toHaveText('bildora run hand-over');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  // A tool process can take seconds to start on a busy machine, as in the other run tests.
  const toFinish = { timeout: 15_000 };
  await expect(step(window, 'writer')).toHaveAttribute('data-state', 'completed', toFinish);
  await expect(step(window, 'review')).toContainText('Waiting for you');
  await expect(step(window, 'writer-2')).toHaveAttribute('data-state', 'idle');
  await expect(window.getByTestId('status')).toContainText('1 task');
  await step(window, 'review').getByRole('button', { name: 'Continue' }).click();

  await expect(step(window, 'writer-2')).toHaveAttribute('data-state', 'completed', toFinish);
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'completed',
    toFinish,
  );
  await expect(window.getByTestId('automation-runs')).toContainText('App');
  await expect(window.getByTestId('status')).toHaveText('Ready');

  const runs = join(dataDir, 'automation-runs', 'default', 'hand-over');
  const [runId] = await readdir(runs);
  expect(await readFile(join(runs, runId ?? '', 'two.txt'), 'utf8')).toBe('start+more+more');
  const stored = await readFile(
    join(dataDir, 'workspaces', 'default', 'automations', 'hand-over.yaml'),
    'utf8',
  );
  expect(stored).toContain('{{steps.writer.outputs.file}}');
});

test('a failed step stops the automation and says why', async () => {
  await fakeTool('bad', 'Bad', ['exit', '7']);
  await fakeTool('good', 'Good', ['exit', '0']);
  await writeAutomation(
    'stops',
    'Stops',
    `  - { id: first, type: run, tool: bad }
  - { id: second, type: run, tool: good }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Stops');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(step(window, 'first')).toHaveAttribute('data-state', 'failed');
  await expect(step(window, 'first')).toContainText('The tool exited with code 7');
  await expect(step(window, 'second')).toHaveAttribute('data-state', 'idle');
  await expect(window.getByTestId('automation-runs')).toContainText('first:');

  await rail(window, 'Run history').click();
  await window.locator('.history-row').first().click();
  await expect(window.getByTestId('history-detail')).toContainText('Bad');
});

test('a run that went on past a failed step says so', async () => {
  await fakeTool('bad', 'Bad', ['exit', '7']);
  await writeAutomation(
    'goes-on',
    'Goes on',
    `  - { id: first, type: run, tool: bad, onFailure: continue }
  - { id: pause, type: wait-for-time, seconds: 1 }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Goes on');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(window.locator('.tool-header .state-badge')).toHaveText('Completed, 1 step failed');
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'failed');
  await expect(window.getByTestId('automation-runs')).toContainText('Completed, 1 step failed');
});

test('a step whose tool has gone shows as broken, and nothing changes on its own', async () => {
  const file = await writeAutomation(
    'broken',
    'Broken',
    `  - { id: first, type: run, tool: gone }\n`,
  );
  const before = await readFile(file, 'utf8');

  const { window } = await launchShell();
  await openAutomation(window, 'Broken');

  await expect(window.getByTestId('automation-broken')).toBeVisible();
  await expect(window.getByTestId('step-broken')).toContainText('Tool "gone" is not installed');
  await expect(window.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await window.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(window.getByTestId('step-problem')).toContainText('not installed');
  await window.getByRole('button', { name: 'Cancel' }).click();
  expect(await readFile(file, 'utf8')).toBe(before);
});

test('a damaged file shows as a problem, beside the healthy automations', async () => {
  await writeAutomation('good', 'Healthy', `  - { id: a, type: wait-for-time, seconds: 1 }\n`);
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'automations', 'bad.yaml'),
    'schemaVersion: 1\nid: [',
  );
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await expect(window.locator('.history-row', { hasText: 'Healthy' })).toBeVisible();
  await expect(window.getByTestId('automation-file-problems')).toContainText('bad.yaml');
});

test('opening and closing a category panel leaves the automation in view', async () => {
  await fakeTool('quick', 'Quick', ['exit', '0']);
  await writeAutomation('nightly', 'Nightly', '  - { id: quick, type: run, tool: quick }\n');

  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  await expect(window.getByTestId('automation-detail')).toBeVisible();

  await rail(window, 'Uncategorized').click();
  await expect(window.locator('#tool-panel')).toBeVisible();
  await expect(window.getByTestId('automation-detail')).toBeVisible();

  await rail(window, 'Uncategorized').click();
  await expect(window.locator('#tool-panel')).toBeHidden();
  await expect(window.getByTestId('automation-detail')).toBeVisible();
});

test('a run keeps going across a Workspace switch, and can be stopped', async () => {
  await fakeTool('hang', 'Hang', ['hang']);
  await writeAutomation('long', 'Long', `  - { id: first, type: run, tool: hang }\n`);

  const { window } = await launchShell();
  await openAutomation(window, 'Long');
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'running');

  await window.getByRole('button', { name: /Workspaces/ }).click();
  await window.getByRole('menuitem', { name: 'Create Workspace' }).click();
  await window.getByRole('dialog').getByLabel('Name').fill('Other');
  await window.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(window.getByTestId('status-workspace')).toContainText('Other');
  await expect(window.getByTestId('status')).toContainText('1 task');
  await rail(window, 'Automations').click();
  await expect(window.getByText('No automations in this Workspace yet.')).toBeVisible();

  await window.getByRole('button', { name: /Workspaces/ }).click();
  await window.getByRole('menuitemradio', { name: 'Default' }).click();
  await expect(window.getByTestId('status-workspace')).toContainText('Default');
  await openAutomation(window, 'Long');
  await window.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'cancelled');
  await expect(window.getByTestId('status')).toHaveText('Ready');
});

test('closing asks while an automation only waits, and ends it', async () => {
  await writeAutomation('waits', 'Waits', `  - { id: pause, type: wait-for-time, seconds: 600 }\n`);

  const first = await launchShell();
  await openAutomation(first.window, 'Waits');
  await first.window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(step(first.window, 'pause')).toHaveAttribute('data-state', 'running');
  await expect(first.window.getByTestId('status')).toContainText('1 task');

  // Holds the process after its window has gone, as a slow machine does, and notes any error
  // from then on: Electron shows it in a dialog that stops the app from ever closing.
  const errors = join(folder, 'main-errors.txt');
  await first.app.evaluate(({ app, dialog }, file) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
    process.on('uncaughtException', (error) => {
      process.getBuiltinModule('node:fs').appendFileSync(file, `${error.message}\n`);
    });
    app.once('will-quit', (event) => {
      event.preventDefault();
      setTimeout(() => {
        app.exit(0);
      }, 300);
    });
  }, errors);
  const closed = first.app.waitForEvent('close');
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
  open = [];
  expect(existsSync(errors)).toBe(false);

  const second = await launchShell();
  await openAutomation(second.window, 'Waits');
  await expect(second.window.getByTestId('automation-runs')).toContainText('Cancelled');
});

test('the command palette starts an automation', async () => {
  await writeAutomation(
    'quick',
    'Quick One',
    `  - { id: pause, type: wait-for-time, seconds: 1 }\n`,
  );
  const { window } = await launchShell();
  await expect(window.getByTestId('status')).toHaveText('Ready');
  await window.keyboard.press('Control+K');
  await window.getByRole('combobox', { name: 'Find a tool or action' }).fill('Quick One');
  await window.keyboard.press('Enter');

  await expect(window.getByTestId('automation-detail')).toBeVisible();
  await expect(window.locator('.tool-header .state-badge')).toHaveAttribute(
    'data-state',
    'completed',
  );
});
