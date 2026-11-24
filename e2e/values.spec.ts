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
/** Where screenshots go when a run asks for them, for a person to look at. */
const SHOTS = process.env['BILDORA_SHOTS'];

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

async function shot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * A tool that writes its text to a file, declaring the file as a JSON output too, so a block can
 * hand it values and later blocks can decide on what it wrote.
 */
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
  - { name: width, type: integer, label: Width, flag: --width }
outputs:
  - name: result
    json: '{{params.file}}'
    fields:
      - { name: count, type: integer }
`,
  );
}

function automationFile(id: string): string {
  return join(dataDir, 'workspaces', 'default', 'automations', `${id}.yaml`);
}

async function writeAutomation(id: string, body: string): Promise<void> {
  await writeFile(automationFile(id), `schemaVersion: 2\nid: ${id}\n${body}`);
}

function rail(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name, exact: true });
}

async function openAutomation(window: Page, name: string): Promise<void> {
  const panel = window.getByTestId('automations-panel');
  if (!(await panel.isVisible())) await rail(window, 'Automations').click();
  await panel.getByRole('button', { name, exact: true }).dblclick();
  await expect(window.getByRole('tab', { name, selected: true })).toBeVisible();
  await canvasSettled(window);
}

function block(window: Page, id: string): Locator {
  return window.locator(`.react-flow__node[data-id="${id}"]`);
}

function settings(window: Page): Locator {
  return window.getByTestId('block-settings');
}

function valueField(window: Page, parameter: string): Locator {
  return settings(window).locator(`[data-testid="value-field"][data-parameter="${parameter}"]`);
}

/** Selects a block on the canvas and waits for its settings. */
async function choose(window: Page, id: string): Promise<void> {
  await block(window, id).click();
  await expect(settings(window)).toHaveAttribute('data-block-id', id);
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-values-'));
  dataDir = join(folder, 'data');
  const workspace = join(dataDir, 'workspaces', 'default');
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const PAIR = `name: Pair
blocks:
  - { id: start, type: start }
  - { id: first, type: run, tool: acme.writer, values: { file: 'C:\\out\\a.txt', width: 40 } }
  - { id: second, type: run, tool: acme.writer }
connections:
  - { from: start, to: first }
  - { from: first, to: second }
positions:
  start: { x: 0, y: 0 }
  first: { x: 200, y: -10 }
  second: { x: 200, y: 140 }
`;

test('typing = links a value, which shows what it resolves to and follows a rename', async () => {
  await writerTool();
  await writeAutomation('pair', PAIR);
  const window = await launchShell();
  await openAutomation(window, 'Pair');

  await choose(window, 'second');
  await settings(window).getByLabel('File', { exact: true }).fill('= first.file');
  const file = valueField(window, 'file');
  await expect(file.getByTestId('expression-shown')).toHaveText('Now: C:\\out\\a.txt');
  // A whole-number field takes an expression too, worked out from other values.
  await settings(window).getByLabel('Width', { exact: true }).fill('= first.width * 2');
  await expect(valueField(window, 'width').getByTestId('expression-shown')).toHaveText('Now: 80');
  await expect(block(window, 'first').getByTestId('block-used-by')).toHaveText('1');
  await shot(window, 'linked-field');

  // Renaming the source keeps the link pointing at it.
  // The panel shows the name as text; its menu opens the Rename dialog, which says why a name
  // cannot be used.
  await choose(window, 'first');
  await settings(window).getByTestId('block-settings-name').click({ button: 'right' });
  await window.locator('.context-menu-root').getByRole('menuitem', { name: 'Rename…' }).click();
  const rename = window.getByTestId('rename-dialog');
  const name = rename.getByLabel('Name in links');
  await expect(name).toBeFocused();
  await name.fill('second');
  await expect(rename).toContainText('Another block, note or group already has this name.');
  await expect(rename.getByRole('button', { name: 'OK' })).toBeDisabled();
  await name.fill('source');
  await name.press('Enter');
  await expect(rename).toHaveCount(0);
  await expect(settings(window)).toHaveAttribute('data-block-id', 'source');
  await expect(settings(window).getByTestId('block-settings-name')).toHaveText('source');
  await choose(window, 'second');
  await expect(settings(window).getByLabel('File', { exact: true })).toHaveValue('source.file');

  // Deleting the source leaves a broken link, which a problem names; undo brings it back.
  await choose(window, 'source');
  await window.keyboard.press('Delete');
  await window.getByRole('tab', { name: 'Problems' }).click();
  await expect(window.getByTestId('automation-problems')).toContainText(
    '"File" follows a block that no longer exists',
  );
  await window.keyboard.press('Control+z');
  await expect(block(window, 'source')).toBeVisible();

  // Unlink keeps the value the link resolved to.
  await choose(window, 'second');
  await valueField(window, 'file').click({ button: 'right', position: { x: 40, y: 8 } });
  await window.locator('.context-menu-root').getByRole('menuitem', { name: 'Unlink' }).click();
  await expect(settings(window).getByLabel('File', { exact: true })).toHaveValue('C:\\out\\a.txt');

  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => readFile(automationFile('pair'), 'utf8'))
    .toContain('expression: source.width * 2');
});

test('a field links from its menu, and from a pick-whip dropped on a block', async () => {
  await writerTool();
  await writeAutomation('pair', PAIR);
  const window = await launchShell();
  await openAutomation(window, 'Pair');

  await choose(window, 'second');
  await valueField(window, 'file').click({ button: 'right', position: { x: 40, y: 8 } });
  const menu = window.locator('.context-menu-root');
  await menu.getByRole('menuitem', { name: 'Link to' }).click();
  await menu.getByRole('menuitem', { name: 'Settings of other blocks' }).click();
  await menu.getByRole('menuitem', { name: 'first' }).click();
  // A whole number does not fit a path, so it is shown but cannot be chosen.
  await expect(menu.getByRole('menuitem', { name: /^Width/ })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'File', exact: true }).click();
  await expect(settings(window).getByLabel('File', { exact: true })).toHaveValue('first.file');

  const whip = valueField(window, 'width').getByRole('button', { name: /Drag onto a block/ });
  const from = await whip.boundingBox();
  const to = await block(window, 'first').boundingBox();
  if (from === null || to === null) throw new Error('Nothing to drag');
  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await window.mouse.down();
  await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await window.mouse.up();
  await window.locator('.context-menu-root').getByRole('menuitem', { name: 'Width' }).click();
  await expect(settings(window).getByLabel('Width', { exact: true })).toHaveValue('first.width');
});

test('Run asks for the inputs, a rule decides on a JSON output, and Data shows each value', async () => {
  await writerTool();
  const target = join(folder, 'counted.json');
  await writeAutomation(
    'counted',
    `name: Counted
blocks:
  - id: start
    type: start
    inputs: [{ name: target, type: path, label: Target, required: true }]
  - id: count
    type: run
    tool: acme.writer
    values: { file: { expression: inputs.target }, text: '{"count": 5}' }
  - id: check
    type: if
    condition:
      match: all
      rules:
        - { field: value, read: { expression: steps.count.outputs.result.count }, operator: greater-than, value: 3 }
  - id: big
    type: run
    tool: acme.writer
    values: { file: { expression: 'join(folder(inputs.target), "big.txt")' }, text: '{"count": 1}' }
  - id: small
    type: run
    tool: acme.writer
    values: { file: { expression: 'join(folder(inputs.target), "small.txt")' }, text: '{"count": 1}' }
connections:
  - { from: start, to: count }
  - { from: count, to: check }
  - { from: check, output: 'true', to: big }
  - { from: check, output: 'false', to: small }
positions:
  start: { x: 0, y: 0 }
  count: { x: 180, y: -10 }
  check: { x: 180, y: 120 }
  big: { x: 420, y: -10 }
  small: { x: 420, y: 140 }
`,
  );
  const window = await launchShell();
  await openAutomation(window, 'Counted');

  await choose(window, 'check');
  await expect(window.getByTestId('condition-sentence')).toHaveText(
    'If count › result › count is greater than 3',
  );

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = window.getByTestId('run-inputs');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Target/).fill(target);
  await shot(window, 'run-inputs');
  await dialog.getByRole('button', { name: 'Run' }).click();

  const toFinish = { timeout: 15_000 };
  await expect(block(window, 'big').getByTestId('canvas-block')).toHaveAttribute(
    'data-state',
    'completed',
    toFinish,
  );
  await expect(block(window, 'small').getByTestId('canvas-block')).toHaveAttribute(
    'data-state',
    'skipped',
  );
  expect(existsSync(join(folder, 'big.txt'))).toBe(true);
  expect(existsSync(join(folder, 'small.txt'))).toBe(false);

  await block(window, 'count').click();
  await window.getByRole('tab', { name: 'Data' }).click();
  const data = window.getByTestId('data-view');
  await expect(data.getByTestId('data-received')).toContainText(target);
  await expect(data.getByTestId('data-received')).toContainText('from = inputs.target');
  await expect(data.getByTestId('data-produced')).toContainText('result.count');
  await expect(data.getByTestId('data-produced')).toContainText('5');
  await shot(window, 'data-view');

  await rail(window, 'Run history').click();
  await window.locator('.history-row').first().click();
  await window.locator('.timeline-row[data-block="count"]').click();
  await expect(window.getByTestId('history-block').getByTestId('data-produced')).toContainText(
    'result.count',
  );
});

test('Ctrl+F finds the blocks that use a value, and the Start block declares inputs', async () => {
  await writerTool();
  await writeAutomation(
    'found',
    `name: Found
blocks:
  - { id: start, type: start }
  - { id: first, type: run, tool: acme.writer, values: { file: 'C:\\a.txt' } }
  - { id: second, type: run, tool: acme.writer, values: { file: { expression: first.file } } }
  - { id: third, type: run, tool: acme.writer, values: { file: 'C:\\c.txt' } }
connections:
  - { from: start, to: first }
  - { from: first, to: second }
  - { from: second, to: third }
positions:
  start: { x: 0, y: 0 }
  first: { x: 180, y: -120 }
  second: { x: 180, y: 0 }
  third: { x: 180, y: 120 }
`,
  );
  const window = await launchShell();
  await openAutomation(window, 'Found');
  await choose(window, 'third');

  await window.getByTestId('canvas').press('Control+f');
  const find = window.getByTestId('canvas-find');
  await expect(find.getByRole('textbox')).toBeFocused();
  await find.getByRole('textbox').fill('first.file');
  await expect(find.getByTestId('canvas-find-count')).toHaveText('1 of 1');
  await expect(window.locator('.react-flow__node.is-match')).toHaveCount(1);
  await expect(block(window, 'second')).toHaveClass(/is-match/);
  await expect(block(window, 'third')).toHaveClass(/is-dimmed/);
  await shot(window, 'canvas-find');
  await find.getByRole('textbox').press('Escape');
  await expect(find).toBeHidden();
  await expect(window.locator('.react-flow__node.is-dimmed')).toHaveCount(0);

  // The "used by" mark finds the blocks that follow a block's values.
  await block(window, 'first').getByTestId('block-used-by').click();
  await expect(find.getByRole('textbox')).toHaveValue('first.');
  await expect(find.getByTestId('canvas-find-count')).toHaveText('1 of 1');
  await find.getByRole('textbox').press('Escape');

  await choose(window, 'start');
  await settings(window).getByRole('button', { name: 'Add input' }).click();
  const input = settings(window).getByTestId('start-input');
  await input.getByLabel('Name', { exact: true }).fill('size');
  await input.getByLabel('Kind of value').selectOption({ label: 'Whole number' });
  await input.getByLabel('Default').fill('12');
  await choose(window, 'third');
  await settings(window).getByLabel('Width', { exact: true }).fill('= inputs.size + 1');
  await expect(valueField(window, 'width').getByTestId('expression-shown')).toHaveText('Now: 13');
});

test('Enter hands the keyboard back, F2 renames, Replace starts a block afresh, and the find stays', async () => {
  await writerTool();
  await writeAutomation('pair', PAIR);
  const window = await launchShell();
  await openAutomation(window, 'Pair');
  const canvas = window.getByTestId('canvas');

  // Enter applies a field of the panel and gives focus back to the canvas.
  await choose(window, 'second');
  await settings(window)
    .getByLabel('Text', { exact: true })
    .fill('= steps.first.outputs.result.count');
  await settings(window).getByLabel('Text', { exact: true }).press('Escape');
  await settings(window).getByLabel('Text', { exact: true }).press('Enter');
  await expect(canvas).toBeFocused();
  // Reading a block's results counts as using its values, as the find does.
  await expect(block(window, 'first').getByTestId('block-used-by')).toHaveText('1');

  // The suggestions open below the field, never over it.
  const file = settings(window).getByLabel('File', { exact: true });
  await file.fill('= f');
  // Typing opens the suggestions, as it would for a person.
  const expression = settings(window).getByRole('combobox', { name: 'File', exact: true });
  await expression.pressSequentially('i');
  const list = settings(window).getByRole('listbox');
  await expect(list).toBeVisible();
  const fieldBox = await expression.boundingBox();
  const listBox = await list.boundingBox();
  if (fieldBox === null || listBox === null) throw new Error('Nothing shown');
  expect(listBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
  await expression.press('Escape');
  await expression.fill('');

  // F2 opens the Rename dialog with the name selected; Escape leaves the name as it was.
  await choose(window, 'second');
  await canvas.press('F2');
  const rename = window.getByTestId('rename-dialog');
  await expect(rename.getByLabel('Name in links')).toBeFocused();
  await expect(rename.getByLabel('Name in links')).toHaveValue('second');
  await window.keyboard.press('Escape');
  await expect(rename).toHaveCount(0);
  await expect(settings(window)).toHaveAttribute('data-block-id', 'second');
  await expect(settings(window).getByLabel('Tool')).toHaveCount(0);

  // The pick-whip lights up a block only when one of its values fits the field.
  const whip = valueField(window, 'width').getByRole('button', { name: /Drag onto a block/ });
  const from = await whip.boundingBox();
  const first = await block(window, 'first').boundingBox();
  const start = await block(window, 'start').boundingBox();
  if (from === null || first === null || start === null) throw new Error('Nothing to drag');
  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await window.mouse.down();
  await window.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 8 });
  await expect(block(window, 'first')).toHaveClass(/is-whip-target/);
  await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2, { steps: 8 });
  await expect(block(window, 'start')).not.toHaveClass(/is-whip-target/);
  await expect(block(window, 'first')).not.toHaveClass(/is-whip-target/);
  await window.keyboard.press('Escape');
  await window.mouse.up();
  await expect(window.locator('.is-whip-target')).toHaveCount(0);

  // Replace puts a new block in place: a new name, no values, the same connections.
  await block(window, 'first').click({ button: 'right' });
  await window.locator('.context-menu-root').getByRole('menuitem', { name: 'Replace…' }).click();
  await window.getByTestId('add-choices').getByRole('button', { name: 'Writer' }).click();
  await expect(block(window, 'Writer1')).toBeVisible();
  await expect(block(window, 'first')).toHaveCount(0);
  await expect(settings(window)).toHaveAttribute('data-block-id', 'Writer1');
  await expect(settings(window).getByLabel('File', { exact: true })).toHaveValue('');
  await window.getByRole('tab', { name: /Problems/ }).click();
  // What read the old block's results still names it, as a problem.
  await expect(window.getByTestId('automation-problems')).toContainText('first');
  await canvas.press('Control+z');
  await expect(block(window, 'first')).toBeVisible();
  await expect(block(window, 'Writer1')).toHaveCount(0);

  // The find stays open when focus moves on, and Escape closes it from the panel too.
  await choose(window, 'second');
  await canvas.press('Control+f');
  const find = window.getByTestId('canvas-find');
  await find.getByRole('textbox').fill('first.');
  await expect(find.getByTestId('canvas-find-count')).toHaveText('1 of 1');
  await settings(window).getByLabel('Width', { exact: true }).click();
  await expect(find).toBeVisible();
  await settings(window).getByLabel('Width', { exact: true }).press('Escape');
  await expect(find).toBeHidden();
});

test('a new automation asks for its inputs on its first Run, and a block is named FileCheck-style', async () => {
  await writerTool();
  const window = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Asks');

  await window.getByTestId('block-library').getByRole('button', { name: 'Writer' }).click();
  await expect(settings(window)).toHaveAttribute('data-block-id', 'Writer1');
  await expect(block(window, 'Writer1')).toContainText('Writer1');
  await expect(block(window, 'Writer1')).toContainText('Writer');
  await settings(window).getByLabel('File', { exact: true }).fill('= inputs.target');

  await choose(window, 'start');
  await settings(window).getByRole('button', { name: 'Add input' }).click();
  const input = settings(window).getByTestId('start-input');
  await input.getByLabel('Name', { exact: true }).fill('target');
  await input.getByLabel('Kind of value').selectOption({ label: 'File or folder' });
  await input.getByLabel('Must be given').check();

  await window.getByRole('button', { name: 'Save and run', exact: true }).click();
  await expect(window.getByRole('tab', { name: 'Asks', selected: true })).toBeVisible();
  const dialog = window.getByTestId('run-inputs');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(window.getByTestId('run-refused')).toHaveCount(0);
});
