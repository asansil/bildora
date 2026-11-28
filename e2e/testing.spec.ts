import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { canvasSettled } from './fixtures/canvas.js';
import { closeApps } from './fixtures/close.js';
import { startTrace, stopTraces } from './fixtures/trace.js';

const FAKE_TOOL = resolve('examples/fixtures/fake-tool.mjs');
const TO_FINISH = { timeout: 15_000 };

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

async function launchShell(): Promise<Page> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  await startTrace(app);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1400, height: 900 });
  return window;
}

/** A tool that writes its text to a file, and hands the file on to the blocks after it. */
async function writerTool(): Promise<void> {
  const directory = join(dataDir, 'tools', 'acme.writer');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1
id: acme.writer
name: Writer
version: 1.0.0
level: 1
interpreter: node
run:
  program: ${FAKE_TOOL}
  args: [write]
parameters:
  - { name: file, type: path, label: File, required: true }
  - { name: text, type: string, label: Text }
outputs:
  - { name: written, param: file }
`,
  );
}

/** start → first → second → third, each writing the path the block before it wrote. */
async function writeChain(): Promise<void> {
  const file = (name: string): string => JSON.stringify(join(folder, `${name}.txt`));
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'automations', 'chain.yaml'),
    `schemaVersion: 2
id: chain
name: Chain
blocks:
  - { id: start, type: start }
  - { id: first, type: run, tool: acme.writer, values: { file: ${file('first')}, text: one } }
  - id: second
    type: run
    tool: acme.writer
    values: { file: ${file('second')}, text: { expression: 'steps.first.outputs.written' } }
  - id: third
    type: run
    tool: acme.writer
    values: { file: ${file('third')}, text: { expression: 'steps.second.outputs.written' } }
connections:
  - { from: start, to: first }
  - { from: first, to: second }
  - { from: second, to: third }
positions:
  start: { x: 0, y: 0 }
  first: { x: 200, y: 0 }
  second: { x: 400, y: 0 }
  third: { x: 600, y: 0 }
`,
  );
}

async function openAutomation(window: Page, name: string): Promise<void> {
  await window
    .getByRole('navigation')
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await window
    .getByTestId('automations-panel')
    .getByRole('button', { name, exact: true })
    .dblclick();
  await expect(window.getByRole('tab', { name, selected: true })).toBeVisible();
  await canvasSettled(window);
}

function block(window: Page, id: string): Locator {
  return window.locator(`.react-flow__node[data-id="${id}"]`).getByTestId('canvas-block');
}

/** Chooses an item of a block's menu. */
async function fromMenu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`.react-flow__node[data-id="${id}"]`).click({ button: 'right' });
  await window.getByRole('menuitem', { name: item }).click();
}

/** Runs the automation on view, and waits for its last block. */
async function runAll(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(block(window, 'third')).toHaveAttribute('data-state', 'completed', TO_FINISH);
}

/** Goes back from the run view to editing. */
async function backToEditing(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Back to editing' }).click();
  await expect(block(window, 'first')).not.toHaveAttribute('data-state');
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-testing-'));
  dataDir = join(folder, 'data');
  const workspace = join(dataDir, 'workspaces', 'default');
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
  await writerTool();
  await writeChain();
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('runs from a block onward, keeping what the blocks before it left', async () => {
  const window = await launchShell();
  await openAutomation(window, 'Chain');

  // With no run yet, there is nothing to reuse.
  await fromMenu(window, 'second', 'Run from here…');
  await expect(window.getByTestId('test-blocked')).toContainText('Run the automation once first');
  await window.getByRole('button', { name: 'Close', exact: true }).click();

  await runAll(window);
  await backToEditing(window);
  await rm(join(folder, 'first.txt'));
  await rm(join(folder, 'third.txt'));

  await fromMenu(window, 'second', 'Run from here…');
  const dialog = window.getByTestId('test-dialog');
  await expect(dialog).toContainText('Real tools will run');
  await dialog.getByRole('button', { name: 'Run from here' }).click();

  await expect(block(window, 'third')).toHaveAttribute('data-state', 'completed', TO_FINISH);
  await expect(block(window, 'first')).toHaveClass(/is-reused/);
  await expect(block(window, 'second')).not.toHaveClass(/is-reused/);
  // The first block did not run again, and the second still read what it left.
  expect(existsSync(join(folder, 'first.txt'))).toBe(false);
  expect(await readFile(join(folder, 'third.txt'), 'utf8')).toBe(join(folder, 'second.txt'));
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await expect(window.getByTestId('automation-runs')).toContainText('Run from second');
});

test('tests one block with a typed value, and stops warning when asked', async () => {
  const window = await launchShell();
  await openAutomation(window, 'Chain');
  await runAll(window);
  await backToEditing(window);

  await fromMenu(window, 'third', 'Test block…');
  const dialog = window.getByTestId('test-dialog');
  await expect(dialog.getByLabel(/^Text/)).toHaveValue(join(folder, 'second.txt'));
  await dialog.getByLabel(/^Text/).fill('typed');
  await dialog.getByLabel("Don't warn me again").check();
  await dialog.getByRole('button', { name: 'Test block' }).click();

  await expect(block(window, 'third')).toHaveAttribute('data-state', 'completed', TO_FINISH);
  await expect(block(window, 'second')).toHaveClass(/is-reused/);
  await expect.poll(() => readFile(join(folder, 'third.txt'), 'utf8'), TO_FINISH).toBe('typed');

  // With the warning off and no fields to fill, Run from here starts at once.
  await backToEditing(window);
  await fromMenu(window, 'third', 'Run from here…');
  await expect(window.getByTestId('test-dialog')).toBeHidden();
  await expect
    .poll(() => readFile(join(folder, 'third.txt'), 'utf8'), TO_FINISH)
    .toBe(join(folder, 'second.txt'));
});
