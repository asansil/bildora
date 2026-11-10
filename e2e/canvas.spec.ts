import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

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

async function launchShell(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1400, height: 900 });
  return { app, window };
}

async function shot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function fakeTool(id: string, name: string, args: readonly string[]): Promise<void> {
  const directory = join(dataDir, 'tools', id);
  await mkdir(directory, { recursive: true });
  const list = args.map((argument) => `'${argument}'`).join(', ');
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1\nid: ${id}\nname: ${name}\nversion: 1.0.0\nlevel: 1\ninterpreter: node\nrun:\n  program: ${FAKE_TOOL}\n  args: [${list}]\n`,
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

function automationsPanel(window: Page): Locator {
  return window.getByTestId('automations-panel');
}

async function openAutomation(window: Page, name: string): Promise<void> {
  if (!(await automationsPanel(window).isVisible())) {
    await rail(window, 'Automations').click();
  }
  await automationsPanel(window).getByRole('button', { name, exact: true }).dblclick();
  await expect(window.getByRole('tab', { name, selected: true })).toBeVisible();
}

/** Drags with the mouse, in steps, as a person would. */
async function drag(window: Page, target: Locator, by: { x: number; y: number }): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('Nothing to drag');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + by.x / 2, y + by.y / 2, { steps: 5 });
  await window.mouse.move(x + by.x, y + by.y, { steps: 5 });
  await window.mouse.up();
}

function block(window: Page, id: string): Locator {
  return window.locator(`.react-flow__node[data-id="${id}"]`);
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-canvas-'));
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

const BRANCHED = `name: Branched
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - id: check
    type: if
    condition:
      match: all
      rules: [{ block: extract, field: exit-code, operator: equals, value: 0 }]
  - { id: report, type: run, tool: acme.report }
  - { id: notify, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
  - { from: extract, to: check }
  - { from: check, output: 'true', to: report }
  - { from: check, output: 'false', to: notify }
  - { from: extract, output: error, to: notify }
`;

test('a file with no positions opens laid out, and saving keeps the positions', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('branched', BRANCHED);
  const { window } = await launchShell();
  await openAutomation(window, 'Branched');

  await expect(window.getByTestId('canvas-block')).toHaveCount(5);
  await expect(block(window, 'check')).toContainText('If the exit code of Extract is 0');
  const start = await block(window, 'start').boundingBox();
  const extract = await block(window, 'extract').boundingBox();
  expect(extract?.x).toBeGreaterThan((start?.x ?? 0) + (start?.width ?? 0));
  await shot(window, 'branched');

  // Laying out is not an edit, so there is nothing to save until a block moves.
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await window.getByRole('button', { name: 'Tidy up' }).click();
  await drag(window, block(window, 'extract'), { x: 0, y: 120 });
  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const text = await readFile(automationFile('branched'), 'utf8');
  expect(text).toContain('positions:');
  expect(text).toMatch(/report:\s*\n\s+x:/);
});

test('a decision is built with the mouse, and the run shows the path it took', async () => {
  test.setTimeout(90_000);
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Decide');
  const library = window.getByTestId('block-library');
  const settings = window.getByTestId('block-settings');

  await library.getByRole('button', { name: 'Extract' }).click();
  await library.getByRole('button', { name: 'If', exact: true }).click();
  await expect(settings).toHaveAttribute('data-block-id', 'decide');
  await settings.getByLabel('Read').selectOption({ label: 'Its exit code' });
  await settings.getByLabel('With').fill('0');
  await expect(settings.getByTestId('condition-sentence')).toHaveText(
    'If the exit code of Extract is 0',
  );
  // The If's first free output is True; with True taken, the next block goes on False.
  await library.getByRole('button', { name: 'Report' }).click();
  await block(window, 'decide').click();
  await library.getByRole('button', { name: 'Report' }).click();
  await expect(window.locator('.react-flow__edge')).toHaveCount(4);

  // While a connection is drawn, Start is never a target, and blocks ahead of it are.
  const handle = block(window, 'report-2').locator('[data-output="next"]');
  const box = await handle.boundingBox();
  if (box === null) throw new Error('No handle');
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.move(box.x + 60, box.y + 60, { steps: 4 });
  await expect(block(window, 'start')).not.toHaveClass(/is-target/);
  await expect(block(window, 'extract')).not.toHaveClass(/is-target/);
  await shot(window, 'connecting');
  await window.mouse.up();

  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('tab', { name: 'Decide', selected: true })).toBeVisible();
  await shot(window, 'decision');
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const state = (id: string) => block(window, id).getByTestId('canvas-block');
  await expect(state('report')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(state('report-2')).toHaveAttribute('data-state', 'skipped');
  await expect(window.locator('.react-flow__edge.edge--taken')).toHaveCount(3);
  await shot(window, 'run-view');

  await window.getByRole('button', { name: 'Back to editing' }).click();
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await window.getByTestId('automation-runs').getByRole('button').first().click();
  await expect(state('report-2')).toHaveAttribute('data-state', 'skipped');
  await expect(window.getByRole('button', { name: 'Back to editing' })).toBeVisible();
});

test('notes and groups are kept in the file, and a group moves its blocks', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('branched', BRANCHED);
  const { window } = await launchShell();
  await openAutomation(window, 'Branched');

  await window.getByTestId('block-library').getByRole('button', { name: 'Note' }).click();
  await window.getByTestId('note-settings').getByLabel('Text').fill('Runs every night');
  await expect(window.getByTestId('canvas-note')).toHaveText('Runs every night');

  await block(window, 'start').click();
  await block(window, 'extract').click({ modifiers: ['Control'] });
  await expect(window.getByTestId('selection-settings')).toContainText('2 blocks selected');
  await window.keyboard.press('Control+g');
  const settings = window.getByTestId('group-settings');
  await settings.getByLabel('Name').fill('Prepare');
  await expect(window.getByTestId('canvas-group')).toContainText('Prepare');

  const before = await block(window, 'extract').boundingBox();
  await drag(window, window.locator('.frame-header'), { x: 0, y: 80 });
  const after = await block(window, 'extract').boundingBox();
  expect(Math.round((after?.y ?? 0) - (before?.y ?? 0))).toBeGreaterThan(40);
  await shot(window, 'notes-groups');

  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const text = await readFile(automationFile('branched'), 'utf8');
  expect(text).toContain('Runs every night');
  expect(text).toMatch(/groups:\s*\n\s+- id: group\s*\n\s+name: Prepare/);
});

test('undo and redo step through edits, and typing a name undoes as one', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).pressSequentially('Night');
  const library = window.getByTestId('block-library');
  await library.getByRole('button', { name: 'Extract' }).click();
  await library.getByRole('button', { name: 'Wait for time' }).click();
  await expect(window.getByTestId('canvas-block')).toHaveCount(3);

  // Focus on the canvas rather than a field, where Ctrl+Z belongs to the text.
  await window.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await window.keyboard.press('Control+z');
  await expect(window.getByTestId('canvas-block')).toHaveCount(2);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(window.getByTestId('canvas-block')).toHaveCount(1);
  await window.keyboard.press('Control+y');
  await expect(window.getByTestId('canvas-block')).toHaveCount(2);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(window.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(window.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await window.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(window.getByLabel('Name', { exact: true })).toHaveValue('Night');
});

test('a flow is built from the keyboard alone, with one Tab stop for the canvas', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Keys');
  const canvas = window.getByTestId('canvas');
  const announcer = window.getByTestId('announcer');
  await canvas.focus();

  /** Adds a block after the focused one, through the A dialog and its search box. */
  async function addWithKeys(label: string): Promise<void> {
    await window.keyboard.press('a');
    await window.keyboard.type(label);
    await window.keyboard.press('Tab');
    await window.keyboard.press('Enter');
    await expect(canvas).toBeFocused();
  }

  await window.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-focused', 'start');
  await addWithKeys('Extract');
  await expect(canvas).toHaveAttribute('data-focused', 'extract');
  await expect(announcer).toHaveText('Added after Start');
  await addWithKeys('If');
  await addWithKeys('Report');
  await window.keyboard.press('ArrowLeft');
  await expect(canvas).toHaveAttribute('data-focused', 'decide');
  await addWithKeys('Wait for time');
  await expect(canvas).toHaveAttribute('data-focused', 'pause');

  // C connects the wait's Next output to Report, chosen from the blocks that can follow.
  await window.keyboard.press('c');
  await window.keyboard.type('Report');
  await window.keyboard.press('Tab');
  await window.keyboard.press('Enter');
  await expect(announcer).toHaveText('Connected Wait 60 seconds, Next, to Report');
  await expect(window.locator('.react-flow__edge')).toHaveCount(5);
  const focusedBlock = window.locator(
    `[id="${(await canvas.getAttribute('aria-activedescendant')) ?? ''}"]`,
  );
  await expect(focusedBlock).toHaveAttribute(
    'aria-label',
    /Wait 60 seconds, Wait for time\. Next goes to Report/,
  );

  // Delete keeps focus on the canvas, on a neighbouring block.
  await window.keyboard.press('Delete');
  await expect(window.getByTestId('canvas-block')).toHaveCount(4);
  await expect(canvas).toBeFocused();
  await expect(canvas).not.toHaveAttribute('data-focused', 'pause');
  await expect(announcer).toHaveText('Deleted Wait 60 seconds');

  // Tab leaves the canvas at once: no block or connection is a stop of its own.
  await window.keyboard.press('Tab');
  await expect(canvas).not.toBeFocused();
  await expect(window.locator('.react-flow__node:focus, .react-flow__edge:focus')).toHaveCount(0);
  await expect(window.locator(':focus')).toHaveCount(1);

  // The blocks list reads the same structure, and choosing a block focuses it on the canvas.
  await window.getByRole('tab', { name: 'Blocks list' }).click();
  const outline = window.getByTestId('outline');
  await expect(outline).toContainText('True goes to Report');
  await outline.getByRole('button', { name: /^Extract/ }).click();
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveAttribute('data-focused', 'extract');
});

/** An exit code rule for a Switch case, in the file's own shape. */
function exitCodeIs(code: number): string {
  return `{ match: all, rules: [{ block: extract, field: exit-code, operator: equals, value: ${String(code)} }] }`;
}

const FORKED = `name: Forked
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - id: route
    type: switch
    cases:
      - { id: busy, condition: ${exitCodeIs(3)} }
      - { id: ok, condition: ${exitCodeIs(0)} }
  - { id: fork, type: parallel }
  - { id: left, type: run, tool: acme.report }
  - { id: right, type: run, tool: acme.report }
  - { id: meet, type: join, parallel: fork }
  - { id: other, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
  - { from: extract, to: route }
  - { from: route, output: busy, to: other }
  - { from: route, output: ok, to: fork }
  - { from: route, output: default, to: other }
  - { from: fork, to: left }
  - { from: fork, to: right }
  - { from: left, to: meet }
  - { from: right, to: meet }
`;

test('a Switch takes the case that holds, and parallel branches meet at the Join', async () => {
  test.setTimeout(90_000);
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('forked', FORKED);
  const { window } = await launchShell();
  await openAutomation(window, 'Forked');
  const settings = window.getByTestId('block-settings');

  // Each case is an output of its own, and Default comes after them.
  const outputs = block(window, 'route').locator('[data-output]');
  await expect(outputs).toHaveCount(3);
  await block(window, 'route').click();
  await settings.getByRole('button', { name: 'Add a case' }).click();
  await expect(settings.getByTestId('switch-case')).toHaveCount(3);
  await expect(outputs).toHaveCount(4);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(outputs).toHaveCount(3);

  await block(window, 'meet').click();
  await settings.getByLabel('If a branch fails').selectOption({
    label: 'Let the other branches finish',
  });
  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await readFile(automationFile('forked'), 'utf8')).toContain('onBranchFailure: let-finish');
  await shot(window, 'switch-parallel');

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const state = (id: string) => block(window, id).getByTestId('canvas-block');
  await expect(state('meet')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(state('left')).toHaveAttribute('data-state', 'completed');
  await expect(state('right')).toHaveAttribute('data-state', 'completed');
  await expect(state('other')).toHaveAttribute('data-state', 'skipped');
  await shot(window, 'switch-parallel-run');
});

test('a Parallel comes with its Join, and branches are led to it from the keyboard', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Both');
  const library = window.getByTestId('block-library');

  await library.getByRole('button', { name: 'Parallel', exact: true }).click();
  await expect(window.getByTestId('canvas-block')).toHaveCount(3);
  await expect(block(window, 'join')).toBeVisible();
  // With the Parallel selected, each tool added becomes a branch of its own.
  await library.getByRole('button', { name: 'Extract' }).click();
  await block(window, 'parallel').click();
  await library.getByRole('button', { name: 'Report' }).click();
  await expect(window.locator('.react-flow__edge')).toHaveCount(3);

  const canvas = window.getByTestId('canvas');
  const outline = window.getByTestId('outline');
  await window.getByRole('tab', { name: 'Blocks list' }).click();
  for (const [id, name] of [
    ['extract', 'Extract'],
    ['report', 'Report'],
  ] as const) {
    await outline.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(canvas).toBeFocused();
    await expect(canvas).toHaveAttribute('data-focused', id);
    // A tool has two outputs, so C asks which first: Next comes first.
    await window.keyboard.press('c');
    await expect(window.getByTestId('connect-outputs')).toBeVisible();
    await window.keyboard.press('Enter');
    await window.keyboard.type('Join');
    await window.keyboard.press('Tab');
    await window.keyboard.press('Enter');
    await expect(canvas).toBeFocused();
  }
  await expect(window.locator('.react-flow__edge')).toHaveCount(5);
  await window.getByRole('tab', { name: /^Problems/ }).click();
  await expect(window.getByText('No problems. This automation can run.')).toBeVisible();
  await shot(window, 'parallel-built');
});

test('Enter picks a block up, arrow keys move it, and the move undoes as one', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('branched', BRANCHED);
  const { window } = await launchShell();
  await openAutomation(window, 'Branched');
  // Arrow keys go by where blocks are, so wait until the file has been laid out.
  await expect(block(window, 'extract')).toBeVisible();
  const canvas = window.getByTestId('canvas');
  const announcer = window.getByTestId('announcer');
  await canvas.focus();
  await window.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-focused', 'start');
  await window.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-focused', 'extract');

  /** Where Extract is from Start, which holds still however the view pans. */
  async function offset(): Promise<{ x: number; y: number }> {
    const from = await block(window, 'start').boundingBox();
    const at = await block(window, 'extract').boundingBox();
    return {
      x: Math.round((at?.x ?? 0) - (from?.x ?? 0)),
      y: Math.round((at?.y ?? 0) - (from?.y ?? 0)),
    };
  }
  const before = await offset();
  await window.keyboard.press('Enter');
  await expect(announcer).toHaveText('Extract selected. Arrow keys move it, Escape stops.');
  for (let press = 0; press < 3; press += 1) await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Escape');
  await expect(announcer).toHaveText('Extract stays here.');
  const moved = await offset();
  expect(moved.y - before.y).toBeGreaterThan(20);
  expect(moved.x).toBe(before.x);

  // Out of moving, arrows go back to choosing blocks, and the block stays put.
  await window.keyboard.press('ArrowRight');
  await expect(canvas).not.toHaveAttribute('data-focused', 'extract');
  expect(await offset()).toEqual(moved);
  await window.keyboard.press('Control+z');
  await expect.poll(offset).toEqual(before);
});

test('a flow of 200 blocks opens laid out, pans, and shows a far block on request', async () => {
  test.setTimeout(90_000);
  const waits = Array.from({ length: 199 }, (_item, index) => `w${String(index + 1)}`);
  const blocks = waits.map(
    (id, index) => `  - { id: ${id}, type: wait-for-time, seconds: ${String(index + 1)} }`,
  );
  const connections = waits.map(
    (id, index) => `  - { from: ${index === 0 ? 'start' : (waits[index - 1] ?? '')}, to: ${id} }`,
  );
  await writeAutomation(
    'long',
    `name: Long\nblocks:\n  - { id: start, type: start }\n${blocks.join('\n')}\nconnections:\n${connections.join('\n')}\n`,
  );
  const { window } = await launchShell();
  await openAutomation(window, 'Long');
  await expect(block(window, 'start')).toBeVisible({ timeout: 20_000 });
  const viewport = window.locator('.react-flow__viewport');
  const transform = (await viewport.getAttribute('style')) ?? '';
  const pane = await window.locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('No canvas');
  await window.mouse.move(pane.x + pane.width / 2, pane.y + 20);
  await window.mouse.down();
  await window.mouse.move(pane.x + pane.width / 2 - 400, pane.y + 20, { steps: 8 });
  await window.mouse.up();
  await expect(viewport).not.toHaveAttribute('style', transform);

  await window.getByRole('tab', { name: 'Blocks list' }).click();
  await window
    .getByTestId('outline')
    .getByRole('button', { name: /^Wait 199 seconds/ })
    .click();
  await expect(block(window, 'w199')).toBeInViewport();
  await shot(window, 'long');
});
