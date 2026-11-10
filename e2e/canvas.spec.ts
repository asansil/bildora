import { existsSync } from 'node:fs';
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
  await window.getByRole('menuitem', { name: 'Selection' }).click();
  await window.getByRole('menuitem', { name: 'Tidy up all' }).click();
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

  /**
   * Where Extract is from Start, which holds still however the view pans. Both are read at once,
   * since the view may move to show the next block between two reads.
   */
  async function offset(): Promise<{ x: number; y: number }> {
    const read: unknown = await window.evaluate(`(() => {
      const box = (id) => document.querySelector('.react-flow__node[data-id="' + id + '"]').getBoundingClientRect();
      const from = box('start');
      const at = box('extract');
      return { x: Math.round(at.x - from.x), y: Math.round(at.y - from.y) };
    })()`);
    return read as { x: number; y: number };
  }
  const before = await offset();
  await window.keyboard.press('Enter');
  await expect(announcer).toHaveText('Extract selected. Arrow keys move it, Escape stops.');
  for (let press = 0; press < 3; press += 1) await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Escape');
  await expect(announcer).toHaveText('Extract stays here.');
  // Each press adds its step, however fast they come.
  await expect.poll(async () => (await offset()).y - before.y).toBeGreaterThan(40);
  const moved = await offset();
  expect(moved.x).toBe(before.x);

  // Out of moving, arrows go back to choosing blocks, and the block stays put.
  await window.keyboard.press('ArrowRight');
  await expect(canvas).not.toHaveAttribute('data-focused', 'extract');
  expect(await offset()).toEqual(moved);
  await window.keyboard.press('Control+z');
  await expect.poll(offset).toEqual(before);
});

test('a flow of 200 blocks opens laid out, pans with the middle button, and shows a far block', async () => {
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
  await window.mouse.down({ button: 'middle' });
  await window.mouse.move(pane.x + pane.width / 2 - 400, pane.y + 20, { steps: 8 });
  await window.mouse.up({ button: 'middle' });
  await expect(viewport).not.toHaveAttribute('style', transform);

  await window.getByRole('tab', { name: 'Blocks list' }).click();
  await window
    .getByTestId('outline')
    .getByRole('button', { name: /^Wait 199 seconds/ })
    .click();
  await expect(block(window, 'w199')).toBeInViewport();
  await shot(window, 'long');
});

/** A connection, by the words a screen reader says for it. */
function connection(window: Page, from: string, output: string, to: string): Locator {
  return window.locator(`.react-flow__edge[aria-label="From ${from}, ${output}, to ${to}"]`);
}

/** Clicks a connection's line, wherever its curve runs. */
async function clickConnection(
  target: Locator,
  kind: 'click' | 'dblclick' = 'click',
): Promise<void> {
  await target.locator('.react-flow__edge-interaction').dispatchEvent(kind);
}

test('a selected connection is deleted alone, by Delete or a double-click', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('branched', BRANCHED);
  const { window } = await launchShell();
  await openAutomation(window, 'Branched');
  await expect(block(window, 'extract')).toBeVisible();
  const edges = window.locator('.react-flow__edge');
  await expect(edges).toHaveCount(5);
  await expect(window.locator('marker.react-flow__arrowhead').first()).toBeAttached();

  // A block clicked first keeps keyboard focus, which Delete must not fall back to.
  await block(window, 'extract').click();
  await clickConnection(connection(window, 'Start', 'Next', 'Extract'));
  await expect(connection(window, 'Start', 'Next', 'Extract')).toHaveClass(/selected/);
  await shot(window, 'edge-selected');
  await window.keyboard.press('Delete');
  await expect(edges).toHaveCount(4);
  await expect(window.getByTestId('canvas-block')).toHaveCount(5);

  await clickConnection(connection(window, 'Extract', 'Next', 'If the exit code of Extract is 0'));
  await window.keyboard.press('Delete');
  await expect(edges).toHaveCount(3);
  await clickConnection(connection(window, 'Extract', 'Error', 'Report'), 'dblclick');
  await expect(edges).toHaveCount(2);
  await expect(window.getByTestId('canvas-block')).toHaveCount(5);

  // A click on the empty canvas lets go of the block too, so Delete then removes nothing.
  await window.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await expect(window.getByTestId('canvas')).not.toHaveAttribute('data-focused');
  await window.getByTestId('canvas').press('Delete');
  await expect(window.getByTestId('canvas-block')).toHaveCount(5);
});

test('a note is written in place, and the writing undoes as one', async () => {
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Noted');
  await window.getByTestId('block-library').getByRole('button', { name: 'Note' }).click();
  const note = window.getByTestId('canvas-note');
  await expect(note).toHaveText('Double-click to write a note');

  await note.dblclick();
  const input = window.getByTestId('note-input');
  await expect(input).toBeFocused();
  await window.keyboard.type('Runs every morning');
  // Keys typed in the note never reach the canvas, where Delete would remove the note.
  await window.keyboard.press('Backspace');
  await window.keyboard.press('Escape');
  await expect(note).toHaveText('Runs every mornin');
  await expect(window.getByTestId('note-settings').getByLabel('Text')).toHaveValue(
    'Runs every mornin',
  );

  await window.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await window.keyboard.press('Control+z');
  await expect(note).toHaveText('Double-click to write a note');
});

test('a right-click on the canvas opens its menu, which adds where it was asked', async () => {
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Menus');
  await expect(window.getByTestId('canvas-block')).toHaveCount(1);

  // Start can be added after and connected, never deleted.
  await block(window, 'start').click({ button: 'right' });
  const menu = window.getByRole('menu', { name: 'Actions for Start' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Add a block after this one…/,
    /^Connect an output…/,
  ]);
  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const pane = await window.locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('The canvas is not drawn');
  // Above Start, and far enough from the right edge that the new block shows whole.
  const at = { x: pane.x + 200, y: pane.y + 120 };
  await window.mouse.click(at.x, at.y, { button: 'right' });
  const canvasMenu = window.getByRole('menu', { name: 'Canvas actions' });
  await expect(canvasMenu.getByRole('menuitem', { name: 'Add block' })).toBeFocused();
  await canvasMenu.getByRole('menuitem', { name: 'Add block' }).click();
  await window
    .getByRole('menu', { name: 'Add block' })
    .getByRole('menuitem', { name: 'Tools' })
    .click();
  const tools = window.getByRole('menu', { name: 'Tools' });
  await expect(tools.getByRole('menuitem', { name: 'Report' }).locator('img, svg')).toHaveCount(1);
  await tools.getByRole('menuitem', { name: 'Report' }).click();
  await expect(canvasMenu).toBeHidden();
  await expect(window.getByTestId('canvas-block')).toHaveCount(2);
  // The new block's corner is where the menu was asked for.
  const added = await block(window, 'report').boundingBox();
  expect(Math.abs((added?.x ?? 0) - at.x)).toBeLessThan(4);
  expect(Math.abs((added?.y ?? 0) - at.y)).toBeLessThan(4);
  await expect(window.locator('.react-flow__edge')).toHaveCount(0);

  // Search… opens the add dialog at that point.
  await window.mouse.click(at.x, at.y + 360, { button: 'right' });
  await canvasMenu.getByRole('menuitem', { name: 'Add block' }).click();
  await window.getByRole('menuitem', { name: /^Search…/ }).click();
  const dialog = window.getByRole('dialog', { name: 'Add here' });
  await window.keyboard.type('Rep');
  await dialog.getByRole('button', { name: 'Report' }).click();
  await expect(window.getByTestId('canvas-block')).toHaveCount(3);
  await shot(window, 'canvas-menu');

  await block(window, 'report').click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect(window.getByTestId('canvas-block')).toHaveCount(2);
});

test('a tool dragged from the side panel becomes a block, and the library finds by name', async () => {
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Dragged');

  const library = window.getByTestId('block-library');
  await library.getByRole('searchbox').fill('rep');
  await expect(library.getByTestId('library-item')).toHaveText(['Report']);
  await library.getByRole('searchbox').fill('');

  await rail(window, 'Uncategorized').click();
  const row = window.locator('#tool-panel').getByRole('button', { name: 'Extract', exact: true });
  await row.first().dragTo(window.locator('.react-flow__pane'), {
    targetPosition: { x: 400, y: 300 },
  });
  await expect(block(window, 'extract')).toBeVisible();
});

test('a double-click on a block in a run goes back to editing it', async () => {
  test.setTimeout(60_000);
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('branched', BRANCHED);
  const { window } = await launchShell();
  await openAutomation(window, 'Branched');
  await expect(block(window, 'extract')).toBeVisible();
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const state = (id: string) => block(window, id).getByTestId('canvas-block');
  await expect(state('report')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });

  await block(window, 'report').dblclick();
  await expect(window.getByRole('button', { name: 'Back to editing' })).toBeHidden();
  await expect(window.getByTestId('block-settings')).toHaveAttribute('data-block-id', 'report');
});

test('Save and run on a new automation asks for a name, then saves it and says what stops it', async () => {
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByRole('button', { name: 'New automation' }).click();
  const refused = window.getByTestId('run-refused');

  await window.getByRole('button', { name: 'Save and run', exact: true }).click();
  await expect(refused).toHaveText('Give the automation a name before running it.');
  await expect(window.getByLabel('Name', { exact: true })).toBeFocused();
  await window.getByLabel('Name', { exact: true }).fill('Fresh');
  await expect(refused).toBeHidden();

  await window
    .getByTestId('block-library')
    .getByRole('button', { name: 'Parallel', exact: true })
    .click();
  await window.getByRole('button', { name: 'Save and run', exact: true }).click();
  await expect(window.getByRole('tab', { name: 'Fresh', selected: true })).toBeVisible();
  await expect(refused).toContainText(/problems? stops? this automation from running/);
  await expect(window.getByRole('tab', { name: /Problems/, selected: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  expect(existsSync(automationFile('fresh'))).toBe(true);
});

test('the panels around the canvas resize and fold, and come back after a relaunch', async () => {
  test.setTimeout(60_000);
  await writeAutomation('branched', BRANCHED);
  const first = await launchShell();
  await openAutomation(first.window, 'Branched');
  const separator = (window: Page, name: string) => window.getByRole('separator', { name });
  const settings = (window: Page) => window.getByRole('complementary', { name: 'Block settings' });

  await drag(first.window, separator(first.window, 'Resize the blocks panel'), { x: 60, y: 0 });
  await expect(separator(first.window, 'Resize the blocks panel')).toHaveAttribute(
    'aria-valuenow',
    '260',
  );
  await separator(first.window, 'Resize the settings panel').focus();
  await first.window.keyboard.press('ArrowLeft');
  await first.window.keyboard.press('ArrowLeft');
  await expect(separator(first.window, 'Resize the settings panel')).toHaveAttribute(
    'aria-valuenow',
    '332',
  );
  await drag(first.window, separator(first.window, 'Resize the lower panel'), { x: 0, y: -100 });
  await expect(separator(first.window, 'Resize the lower panel')).toHaveAttribute(
    'aria-valuenow',
    '280',
  );

  await shot(first.window, 'canvas-panels-resized');
  await first.window.getByRole('button', { name: 'Hide settings' }).click();
  await expect(settings(first.window)).toBeHidden();
  await first.window.getByRole('button', { name: 'Hide the lower panel' }).click();
  await expect(first.window.locator('.flow-lower-body')).toBeHidden();
  await expect(separator(first.window, 'Resize the lower panel')).toHaveCount(0);
  await shot(first.window, 'canvas-panels-folded');
  const layout = join(dataDir, 'workspaces', 'default', 'workspace.yaml');
  await expect.poll(() => readFile(layout, 'utf8')).toContain('lowerCollapsed: true');
  await first.app.close();

  const { window } = await launchShell();
  await openAutomation(window, 'Branched');
  await expect(separator(window, 'Resize the blocks panel')).toHaveAttribute(
    'aria-valuenow',
    '260',
  );
  await expect(settings(window)).toBeHidden();
  await expect(window.locator('.flow-lower-body')).toBeHidden();

  // Choosing a tab of the folded lower panel opens it again, at the height it was left.
  await window.getByRole('tab', { name: 'Blocks list' }).click();
  await expect(window.locator('.flow-lower-body')).toBeVisible();
  await expect(separator(window, 'Resize the lower panel')).toHaveAttribute('aria-valuenow', '280');
  await window.getByRole('button', { name: 'Show settings' }).click();
  await expect(settings(window)).toBeVisible();
  await expect(separator(window, 'Resize the settings panel')).toHaveAttribute(
    'aria-valuenow',
    '332',
  );
  await window.getByRole('button', { name: 'Hide blocks' }).click();
  await expect(window.getByTestId('block-library')).toBeHidden();
  await window.getByRole('button', { name: 'Show blocks' }).click();
  await expect(window.getByTestId('block-library')).toBeVisible();
});

/** The connections drawn, each as "from output to". */
async function connectionsShown(window: Page): Promise<string[]> {
  const edges = await window.locator('.react-flow__edge').all();
  const ids = await Promise.all(edges.map((edge) => edge.getAttribute('data-id')));
  return ids.map((id) => (id ?? '').split('\u0000').join(' ')).sort();
}

/** Where on the screen the middle of a connection's line is, along the curve itself. */
async function connectionMiddle(
  window: Page,
  from: string,
  output: string,
  to: string,
): Promise<{ x: number; y: number }> {
  const selector = `.react-flow__edge[aria-label="From ${from}, ${output}, to ${to}"] .react-flow__edge-path`;
  // The point half way along the path, in the path's own units, is placed on the screen through
  // the path's box there: the view only moves and scales it.
  const script = `(() => {
    const line = document.querySelector(${JSON.stringify(selector)});
    if (line === null) return null;
    const point = line.getPointAtLength(line.getTotalLength() / 2);
    const own = line.getBBox();
    const shown = line.getBoundingClientRect();
    const scale = shown.width / (own.width || 1);
    return { x: shown.left + (point.x - own.x) * scale, y: shown.top + (point.y - own.y) * scale };
  })()`;
  let last = '';
  let middle = { x: 0, y: 0 };
  // A canvas just opened is still settling: connections appear once their blocks are measured,
  // and the view fits them. Two readings in a row that agree mean it has settled.
  await expect
    .poll(
      async () => {
        const found: unknown = await window.evaluate(script);
        if (typeof found !== 'object' || found === null || !('x' in found) || !('y' in found)) {
          last = '';
          return false;
        }
        const { x, y } = found as { x: number; y: number };
        const now = `${String(x)},${String(y)}`;
        const settled = now === last;
        last = now;
        middle = { x, y };
        return settled;
      },
      { intervals: [100] },
    )
    .toBe(true);
  return middle;
}

const SPACED = `name: Spaced
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - { id: report, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
positions:
  start: { x: 0, y: 0 }
  extract: { x: 700, y: 0 }
  report: { x: 300, y: 160 }
`;

/**
 * Drops a block from the library onto the canvas with Shift held. A drag the test drives does not
 * carry Shift into its drag events, so this sends them as the library would.
 */
async function dropWithShift(
  window: Page,
  choice: Record<string, string>,
  at: { x: number; y: number },
): Promise<void> {
  const dataTransfer = await window.evaluateHandle(
    `(() => { const data = new DataTransfer(); data.setData('application/x-bildora-block', ${JSON.stringify(JSON.stringify(choice))}); return data; })()`,
  );
  const canvas = window.getByTestId('canvas');
  const init = { dataTransfer, shiftKey: true, clientX: at.x, clientY: at.y, bubbles: true };
  await canvas.dispatchEvent('dragover', init);
  await canvas.dispatchEvent('drop', init);
}

/** Drags with the mouse from a block's middle to a point of the screen, in steps. */
async function dragTo(window: Page, target: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('Nothing to drag');
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y - 40, { steps: 5 });
  await window.mouse.move(to.x, to.y, { steps: 5 });
}

test('a block goes into a connection only with Shift, and that undoes as one', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('spaced', SPACED);
  const { window } = await launchShell();
  await openAutomation(window, 'Spaced');
  await expect(block(window, 'report')).toBeVisible();
  const splice = window.locator('.react-flow__edge.edge--pending');
  const middle = await connectionMiddle(window, 'Start', 'Next', 'Extract');

  // Without Shift, a block let go over a connection only moves, so none goes in by accident.
  await dragTo(window, block(window, 'report'), middle);
  await expect(splice).toHaveCount(0);
  await window.mouse.up();
  await expect.poll(() => connectionsShown(window)).toEqual(['start next extract']);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();

  await window.keyboard.down('Shift');
  await dragTo(window, block(window, 'report'), middle);
  await expect(splice).toHaveCount(2);
  await shot(window, 'splice-preview');
  await window.mouse.up();
  await window.keyboard.up('Shift');
  await expect(splice).toHaveCount(0);
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['report next extract', 'start next report']);

  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => connectionsShown(window)).toEqual(['start next extract']);
});

test('a block dropped with Shift from the library or the side panel goes into a connection', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('spaced', SPACED);
  const { window } = await launchShell();
  await openAutomation(window, 'Spaced');
  await expect(block(window, 'report')).toBeVisible();
  const pane = window.locator('.react-flow__pane');
  const at = async (from: string, output: string, to: string) => {
    const middle = await connectionMiddle(window, from, output, to);
    const area = await pane.boundingBox();
    if (area === null) throw new Error('The canvas is not drawn');
    return { x: middle.x - area.x, y: middle.y - area.y };
  };
  const library = window.getByTestId('block-library');
  const wait = library.getByRole('button', { name: 'Wait for time', exact: true });

  // Without Shift, the new block is only placed where it was dropped.
  await wait.dragTo(pane, { targetPosition: await at('Start', 'Next', 'Extract') });
  await expect(block(window, 'pause')).toBeVisible();
  expect(await connectionsShown(window)).toEqual(['start next extract']);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(block(window, 'pause')).toHaveCount(0);

  const middle = (from: string, output: string, to: string) =>
    connectionMiddle(window, from, output, to);
  await dropWithShift(window, { kind: 'wait-for-time' }, await middle('Start', 'Next', 'Extract'));
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['pause next extract', 'start next pause']);

  // An If goes on through True or False, so it is only placed where it was dropped.
  const before = await connectionsShown(window);
  await dropWithShift(window, { kind: 'if' }, await middle('Start', 'Next', 'Wait 60 seconds'));
  await expect(block(window, 'decide')).toBeVisible();
  expect(await connectionsShown(window)).toEqual(before);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();

  // A tool from the side panel is offered the same way, as a Run tool block.
  await dropWithShift(
    window,
    { kind: 'run', tool: 'acme.report' },
    await middle('Wait 60 seconds', 'Next', 'Extract'),
  );
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['pause next report-2', 'report-2 next extract', 'start next pause']);
});

const CHAIN = `name: Chain
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - { id: report, type: run, tool: acme.report }
  - { id: send, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
  - { from: extract, to: report }
  - { from: report, to: send }
positions:
  start: { x: 0, y: 0 }
  extract: { x: 280, y: 0 }
  report: { x: 0, y: -220 }
  send: { x: 380, y: -200 }
`;

test('Shift takes a block out of the flow, joining its neighbours, or moves it elsewhere', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  const all = ['extract next report', 'report next send', 'start next extract'];
  await expect.poll(() => connectionsShown(window)).toEqual(all);

  const box = await block(window, 'extract').boundingBox();
  if (box === null) throw new Error('Extract is not drawn');
  await window.keyboard.down('Shift');
  await dragTo(window, block(window, 'extract'), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2 + 160,
  });
  // Held with Shift, the block is already out, and what came before it leads past it.
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['report next send', 'start next report']);
  await shot(window, 'block-taken-out');
  await window.mouse.up();
  await window.keyboard.up('Shift');
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['report next send', 'start next report']);

  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => connectionsShown(window)).toEqual(all);

  const middle = await connectionMiddle(window, 'Report', 'Next', 'Report');
  await window.keyboard.down('Shift');
  await dragTo(window, block(window, 'extract'), middle);
  // Over another connection, the block is drawn in it, with the connection it replaces faint.
  await expect(window.locator('.react-flow__edge.edge--pending')).toHaveCount(2);
  await expect(window.locator('.react-flow__edge.edge--replaced')).toHaveCount(1);
  await shot(window, 'block-moving-in');
  await window.mouse.up();
  await window.keyboard.up('Shift');
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'report next extract', 'start next report']);
});

/** The middle of an element on the screen, once two readings in a row agree. */
async function middleOf(target: Locator): Promise<{ x: number; y: number }> {
  let last = '';
  let middle = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        const now = box === null ? '' : JSON.stringify(box);
        const settled = now !== '' && now === last;
        last = now;
        if (box !== null) middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return settled;
      },
      { intervals: [100] },
    )
    .toBe(true);
  return middle;
}

/** Presses the left button at one point and lets go at another, in steps. */
async function pull(
  window: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await window.mouse.move(to.x, to.y, { steps: 5 });
  await window.mouse.up();
}

test('a left drag on the canvas selects blocks, and the middle button pans', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');
  const viewport = window.locator('.react-flow__viewport');
  const transform = (await viewport.getAttribute('style')) ?? '';

  // From the empty canvas below Start to the middle of Extract: both are touched.
  const start = await middleOf(block(window, 'start'));
  const extract = await middleOf(block(window, 'extract'));
  await pull(window, { x: start.x - 60, y: start.y + 80 }, extract);
  await expect(window.locator('.react-flow__node-block.selected')).toHaveCount(2);
  await expect(viewport).toHaveAttribute('style', transform);
  await shot(window, 'box-selection');

  await window.mouse.move(start.x - 60, start.y + 120);
  await window.mouse.down({ button: 'middle' });
  await window.mouse.move(start.x + 40, start.y + 120, { steps: 5 });
  await window.mouse.up({ button: 'middle' });
  await expect(viewport).not.toHaveAttribute('style', transform);
});

test('either end of a connection moves to another block, and let go on nothing it goes', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next report', 'report next send', 'start next extract']);
  const end = (from: string, to: string, side: 'source' | 'target') =>
    connection(window, from, 'Next', to).locator(`.react-flow__edgeupdater-${side}`);

  // The input end is taken straight from the block it points to, and let go on another one.
  await connectionMiddle(window, 'Extract', 'Next', 'Report');
  await pull(
    window,
    await middleOf(end('Extract', 'Report', 'target')),
    await middleOf(block(window, 'send')),
  );
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'report next send', 'start next extract']);

  // Let go on the empty canvas, the connection is removed, and that undoes.
  const box = await block(window, 'start').boundingBox();
  if (box === null) throw new Error('Start is not drawn');
  await pull(window, await middleOf(end('Start', 'Extract', 'target')), {
    x: box.x + box.width / 2,
    y: box.y + 160,
  });
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'report next send']);
  await window.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'report next send', 'start next extract']);

  // A chosen connection's output end moves to another block's output, which then leads there.
  await clickConnection(connection(window, 'Report', 'Next', 'Report'));
  const next = block(window, 'start').locator('[data-output="next"]');
  await pull(window, await middleOf(end('Report', 'Report', 'source')), await middleOf(next));
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'start next send']);
});

const NEAR = `name: Near
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - { id: report, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
positions:
  start: { x: 0, y: 0 }
  extract: { x: 280, y: 0 }
  report: { x: 0, y: 180 }
`;

test('a connection let go on a block joins it, and Shift+Space adds a block at the pointer', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('near', NEAR);
  const { window } = await launchShell();
  await openAutomation(window, 'Near');
  await expect(block(window, 'report')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');

  const output = block(window, 'report').locator('[data-output="next"]');
  await pull(window, await middleOf(output), await middleOf(block(window, 'extract')));
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['report next extract', 'start next extract']);

  const start = await middleOf(block(window, 'start'));
  const at = { x: start.x, y: start.y - 150 };
  await window.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await window.mouse.move(at.x, at.y);
  await window.keyboard.press('Shift+Space');
  const dialog = window.getByRole('dialog', { name: 'Add here' });
  await expect(dialog).toBeVisible();
  await window.keyboard.type('Rep');
  await dialog.getByRole('button', { name: 'Report' }).click();
  await expect(block(window, 'report-2')).toBeVisible();
  const added = await block(window, 'report-2').boundingBox();
  if (added === null) throw new Error('The new block is not drawn');
  expect(Math.abs(added.x - at.x)).toBeLessThan(40);
  expect(Math.abs(added.y - at.y)).toBeLessThan(40);
});

const PAIR = `name: Pair
blocks:
  - { id: start, type: start }
  - { id: extract, type: run, tool: acme.extract }
  - { id: report, type: run, tool: acme.report }
  - { id: send, type: run, tool: acme.report }
connections:
  - { from: start, to: extract }
  - { from: report, to: send }
positions:
  start: { x: 0, y: 0 }
  extract: { x: 280, y: 0 }
  report: { x: 0, y: -150 }
  send: { x: 300, y: -150 }
`;

/** Opens Pair and draws a box from left of Report to the middle of Send, which takes both. */
async function boxReportAndSend(window: Page): Promise<void> {
  await openAutomation(window, 'Pair');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');
  const report = await middleOf(block(window, 'report'));
  const send = await middleOf(block(window, 'send'));
  await pull(window, { x: report.x - 140, y: report.y - 60 }, send);
  await expect(window.locator('.react-flow__node-block.selected')).toHaveCount(2);
}

test('copied blocks paste at the pointer with their connection, selected, and undo as one', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('pair', PAIR);
  const { window } = await launchShell();
  await boxReportAndSend(window);
  await window.keyboard.press('Control+c');

  const start = await middleOf(block(window, 'start'));
  const at = { x: start.x - 60, y: start.y + 140 };
  await window.mouse.move(at.x, at.y);
  await window.keyboard.press('Control+v');
  await expect(block(window, 'report-2')).toBeVisible();
  await expect(block(window, 'send-2')).toBeVisible();
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['report next send', 'report-2 next send-2', 'start next extract']);
  await expect(window.locator('.react-flow__node-block.selected')).toHaveCount(2);
  await expect(window.locator('.react-flow__node-block.selected[data-id="report-2"]')).toHaveCount(
    1,
  );
  // The copy's top-left corner, Report's, lands where the pointer was.
  const pasted = await block(window, 'report-2').boundingBox();
  if (pasted === null) throw new Error('The pasted block is not drawn');
  expect(Math.abs(pasted.x - at.x)).toBeLessThan(4);
  expect(Math.abs(pasted.y - at.y)).toBeLessThan(4);
  await shot(window, 'pasted');

  await window.keyboard.press('Control+z');
  await expect(block(window, 'report-2')).toHaveCount(0);
  await expect(block(window, 'send-2')).toHaveCount(0);
});

/** Where a block is on the canvas, from the transform the canvas gives it. */
async function placeOf(window: Page, id: string): Promise<{ x: number; y: number }> {
  const style = (await block(window, id).getAttribute('style')) ?? '';
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(style);
  if (match === null) throw new Error(`${id} has no position`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** A canvas option in View > Options, which the menu bar opens. */
async function canvasOption(window: Page, name: string): Promise<Locator> {
  await window.getByRole('menuitem', { name: 'View' }).click();
  await window
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Options' })
    .click();
  return window.getByRole('menu', { name: 'Options' }).getByRole('menuitemcheckbox', { name });
}

async function toggleOption(window: Page, name: string): Promise<void> {
  await (await canvasOption(window, name)).click();
  await expect(window.getByRole('menu', { name: 'View' })).toHaveCount(0);
}

async function optionIs(window: Page, name: string, on: boolean): Promise<void> {
  await expect(await canvasOption(window, name)).toHaveAttribute('aria-checked', String(on));
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(window.getByRole('menu', { name: 'View' })).toHaveCount(0);
}

test('the canvas options snap, turn connections and hide the grid and navigator, after a relaunch too', async () => {
  test.setTimeout(60_000);
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const first = await launchShell();
  await openAutomation(first.window, 'Chain');
  await expect(block(first.window, 'send')).toBeVisible();
  const path = (window: Page) =>
    window
      .locator(
        '.react-flow__edge[aria-label="From Start, Next, to Extract"] .react-flow__edge-path',
      )
      .getAttribute('d');
  const grid = (window: Page) => window.locator('.react-flow__background');
  const navigator = (window: Page) => window.locator('.react-flow__minimap');
  await connectionMiddle(first.window, 'Start', 'Next', 'Extract');
  expect(await path(first.window)).toContain('C');
  // The option buttons have left the canvas: zoom in, zoom out and fit stay.
  await expect(first.window.locator('.react-flow__controls-button')).toHaveCount(3);
  await optionIs(first.window, 'Show grid', true);
  await optionIs(first.window, 'Show navigator', true);
  await expect(grid(first.window)).toHaveCount(1);
  await expect(navigator(first.window)).toHaveCount(1);

  await toggleOption(first.window, 'Snap to grid');
  await toggleOption(first.window, 'Right-angle connections');
  await toggleOption(first.window, 'Show grid');
  await toggleOption(first.window, 'Show navigator');
  await optionIs(first.window, 'Snap to grid', true);
  await optionIs(first.window, 'Right-angle connections', true);
  await expect.poll(() => path(first.window)).not.toContain('C');
  await expect(grid(first.window)).toHaveCount(0);
  await expect(navigator(first.window)).toHaveCount(0);

  await drag(first.window, block(first.window, 'report'), { x: 37, y: 23 });
  await expect
    .poll(async () => {
      const { x, y } = await placeOf(first.window, 'report');
      return x % 16 === 0 && y % 16 === 0 && x !== 0;
    })
    .toBe(true);
  await shot(first.window, 'canvas-grid-right-angles');
  const layout = join(dataDir, 'workspaces', 'default', 'workspace.yaml');
  await expect.poll(() => readFile(layout, 'utf8')).toContain('hideNavigator: true');
  expect(await readFile(layout, 'utf8')).toContain('hideGrid: true');
  await first.app.close();

  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await optionIs(window, 'Snap to grid', true);
  await optionIs(window, 'Show grid', false);
  await optionIs(window, 'Show navigator', false);
  await expect(grid(window)).toHaveCount(0);
  await expect(navigator(window)).toHaveCount(0);
  await expect.poll(() => path(window)).not.toContain('C');

  await toggleOption(window, 'Right-angle connections');
  await toggleOption(window, 'Show grid');
  await toggleOption(window, 'Show navigator');
  await expect.poll(() => path(window)).toContain('C');
  await expect(grid(window)).toHaveCount(1);
  await expect(navigator(window)).toHaveCount(1);
  await expect.poll(() => readFile(layout, 'utf8')).not.toContain('hideGrid');
});

test('Delete removes every block a selection box took', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('pair', PAIR);
  const { window } = await launchShell();
  await boxReportAndSend(window);
  await window.keyboard.press('Delete');
  await expect(block(window, 'report')).toHaveCount(0);
  await expect(block(window, 'send')).toHaveCount(0);
  await expect(block(window, 'extract')).toBeVisible();
});

/** The view's pan and zoom, from the transform the canvas gives its viewport. */
async function viewOf(window: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await window.locator('.react-flow__viewport').getAttribute('style')) ?? '';
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([\d.]+)\)/.exec(style);
  if (match === null) throw new Error('The view has no transform');
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

test('the wheel moves the view, Shift+wheel moves it sideways, and Ctrl+wheel zooms', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');
  const start = await middleOf(block(window, 'start'));
  await window.mouse.move(start.x - 60, start.y + 120);

  const before = await viewOf(window);
  await window.mouse.wheel(0, 100);
  await expect.poll(async () => (await viewOf(window)).y).toBeLessThan(before.y - 20);
  const scrolled = await viewOf(window);
  expect(scrolled.zoom).toBe(before.zoom);
  expect(scrolled.x).toBe(before.x);

  await window.keyboard.down('Shift');
  await window.mouse.wheel(0, 100);
  await window.keyboard.up('Shift');
  await expect.poll(async () => (await viewOf(window)).x).toBeLessThan(scrolled.x - 20);
  expect((await viewOf(window)).zoom).toBe(before.zoom);

  await window.keyboard.down('Control');
  await window.mouse.wheel(0, -100);
  await window.keyboard.up('Control');
  await expect.poll(async () => (await viewOf(window)).zoom).toBeGreaterThan(before.zoom);
});

/** Opens the empty canvas's menu below Start, where Chain has nothing. */
async function canvasMenuBelowStart(window: Page): Promise<Locator> {
  const start = await middleOf(block(window, 'start'));
  await window.mouse.click(start.x, start.y + 160, { button: 'right' });
  const menu = window.getByRole('menu', { name: 'Canvas actions' });
  await expect(menu).toBeVisible();
  return menu;
}

test('the canvas menu scales the view and tidies up, and its submenus work from the keyboard', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');

  const menu = await canvasMenuBelowStart(window);
  const addBlock = menu.getByRole('menuitem', { name: 'Add block' });
  await expect(addBlock).toBeFocused();
  await window.keyboard.press('ArrowRight');
  await expect(window.getByRole('menuitem', { name: /^Search…/ })).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(window.getByRole('menu', { name: 'Add block' })).toHaveCount(0);
  await expect(addBlock).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Scale' }).click();
  await window.getByRole('menuitemcheckbox', { name: '200%', exact: true }).click();
  await expect.poll(async () => (await viewOf(window)).zoom).toBe(2);
  await shot(window, 'canvas-scale-200');
  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Scale' }).click();
  await expect(window.getByRole('menuitemcheckbox', { name: '200%', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(window.getByRole('menuitemcheckbox', { name: '100%', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await window.getByRole('menuitem', { name: 'Default scale' }).click();
  await expect.poll(async () => (await viewOf(window)).zoom).toBe(1);

  // Chain draws Report above Start; tidied up, it follows Extract to the right.
  expect((await placeOf(window, 'report')).x).toBeLessThan((await placeOf(window, 'extract')).x);
  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Arrange' }).click();
  await window.getByRole('menuitem', { name: 'Tidy up all' }).click();
  await expect
    .poll(async () => (await placeOf(window, 'report')).x > (await placeOf(window, 'extract')).x)
    .toBe(true);
});

test('Scale to rectangle zooms to a box drawn on the canvas, and Escape cancels it', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');

  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Scale' }).click();
  await window.getByRole('menuitem', { name: 'Scale to rectangle' }).click();
  await expect(window.getByTestId('scale-rectangle')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('scale-rectangle')).toHaveCount(0);
  expect((await viewOf(window)).zoom).toBe(1);

  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Scale' }).click();
  await window.getByRole('menuitem', { name: 'Scale to rectangle' }).click();
  const start = await block(window, 'start').boundingBox();
  if (start === null) throw new Error('Start is not drawn');
  await pull(
    window,
    { x: start.x - 10, y: start.y - 10 },
    { x: start.x + start.width + 10, y: start.y + start.height + 10 },
  );
  await expect(window.getByTestId('scale-rectangle')).toHaveCount(0);
  await expect.poll(async () => (await viewOf(window)).zoom).toBeGreaterThan(1.5);
  // Start now fills the canvas's width or height.
  await expect
    .poll(async () => (await block(window, 'start').boundingBox())?.width ?? 0)
    .toBeGreaterThan(start.width * 1.5);
});

test('a block menu duplicates and takes out, and Selection selects downstream', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  await connectionMiddle(window, 'Start', 'Next', 'Extract');

  await block(window, 'extract').click({ button: 'right' });
  const menu = window.getByRole('menu', { name: 'Actions for Extract' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Add a block after this one…/,
    /^Connect an output…/,
    /^Copy/,
    /^Duplicate/,
    /^Take out of the flow/,
    /^Group/,
    /^Delete/,
  ]);
  await menu.getByRole('menuitem', { name: /^Duplicate/ }).click();
  await expect(block(window, 'extract-2')).toBeVisible();
  await expect(window.locator('.react-flow__node-block.selected[data-id="extract-2"]')).toHaveCount(
    1,
  );

  await block(window, 'report').click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^Take out of the flow/ }).click();
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'start next extract']);
  await block(window, 'report').click({ button: 'right' });
  await expect(window.getByRole('menuitem', { name: /^Take out of the flow/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await window.keyboard.press('Escape');
  // Its copy sits a grid step down and right, over its middle.
  await block(window, 'extract').click({ position: { x: 8, y: 8 } });
  await window.getByRole('menuitem', { name: 'Selection' }).click();
  await window.getByRole('menuitem', { name: 'Select downstream' }).click();
  await expect(window.locator('.react-flow__node-block.selected')).toHaveCount(2);
  await expect(window.locator('.react-flow__node-block.selected[data-id="send"]')).toHaveCount(1);

  // Ctrl+D duplicates the selection one grid step away.
  await window.keyboard.press('Control+d');
  await expect(block(window, 'extract-3')).toBeVisible();
  await expect(block(window, 'send-2')).toBeVisible();
  await expect
    .poll(() => connectionsShown(window))
    .toEqual(['extract next send', 'extract-3 next send-2', 'start next extract']);
  const original = await placeOf(window, 'extract');
  expect(await placeOf(window, 'extract-3')).toEqual({ x: original.x + 16, y: original.y + 16 });

  // Ctrl+S saves the flow, wherever the focus is in the tab.
  await window.getByLabel('Name', { exact: true }).click();
  await window.keyboard.press('Control+s');
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect.poll(() => readFile(automationFile('chain'), 'utf8')).toContain('send-2');
});

test('the menus act on the automation on view, and are disabled for other tabs', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();

  const selection = window.getByRole('menuitem', { name: 'Selection' });
  await selection.click();
  await window.getByRole('menuitem', { name: /^Select all blocks/ }).click();
  await expect(window.locator('.react-flow__node-block.selected')).toHaveCount(4);
  await window.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(window.getByRole('menuitem', { name: /^Delete/ })).not.toHaveAttribute(
    'aria-disabled',
  );
  await window.keyboard.press('Escape');

  await rail(window, 'Run history').click();
  await selection.click();
  const items = window.getByRole('menu', { name: 'Selection' }).getByRole('menuitem');
  await expect(items).toHaveCount(10);
  for (const item of await items.all()) {
    await expect(item).toHaveAttribute('aria-disabled', 'true');
  }
  await window.keyboard.press('Escape');
  await window.getByRole('menuitem', { name: 'View' }).click();
  await expect(window.getByRole('menuitem', { name: 'Scale' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await window.keyboard.press('Escape');

  await window.getByRole('tab', { name: 'Chain' }).click();
  await selection.click();
  await expect(window.getByRole('menuitem', { name: 'Deselect all' })).not.toHaveAttribute(
    'aria-disabled',
  );
});

test('the header has icon buttons with tooltips, and F5 saves and runs', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await openAutomation(window, 'Chain');
  await expect(block(window, 'send')).toBeVisible();
  const header = window.locator('.flow-header');
  await expect(header.getByRole('button')).toHaveCount(4);
  await expect(header.getByRole('button', { name: 'Undo' })).toHaveAttribute(
    'title',
    'Undo (Ctrl+Z)',
  );
  await expect(header.getByRole('button', { name: 'Redo' })).toHaveAttribute(
    'title',
    'Redo (Ctrl+Y)',
  );
  await expect(header.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute(
    'title',
    'Save (Ctrl+S)',
  );
  await expect(header.getByRole('button', { name: 'Run', exact: true })).toHaveAttribute(
    'title',
    'Run (F5)',
  );
  await shot(window, 'header');

  await drag(window, block(window, 'report'), { x: 0, y: 40 });
  const saveAndRun = header.getByRole('button', { name: 'Save and run', exact: true });
  await expect(saveAndRun).toHaveAttribute('title', 'Save and run (F5)');
  await window.getByTestId('canvas').focus();
  await window.keyboard.press('F5');
  await expect(header.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const state = block(window, 'send').getByTestId('canvas-block');
  await expect(state).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
});

test('the sidebar menu opens, renames, duplicates and deletes an automation', async () => {
  await fakeTool('acme.extract', 'Extract', ['exit', '0']);
  await fakeTool('acme.report', 'Report', ['exit', '0']);
  await writeAutomation('chain', CHAIN);
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  const row = (name: string) => automationsPanel(window).getByRole('button', { name, exact: true });

  await row('Chain').click({ button: 'right' });
  const menu = window.getByRole('menu', { name: 'Actions for Chain' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', /^Rename…/, 'Duplicate', 'Delete']);
  await menu.getByRole('menuitem', { name: /^Rename…/ }).click();
  await expect(window.getByRole('tab', { name: 'Chain', selected: true })).toBeVisible();
  await expect(window.getByLabel('Name', { exact: true })).toBeFocused();

  // F2 on a row does the same.
  await row('Chain').focus();
  await window.keyboard.press('F2');
  await expect(window.getByLabel('Name', { exact: true })).toBeFocused();

  await row('Chain').click({ button: 'right' });
  await window.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(row('Chain copy')).toBeVisible();
  await expect(window.getByRole('tab', { name: 'Chain copy', selected: true })).toBeVisible();

  // The menu opens from the keyboard too, and Delete asks first.
  await row('Chain copy').focus();
  await window.keyboard.press('Shift+F10');
  await expect(window.getByRole('menu', { name: 'Actions for Chain copy' })).toBeVisible();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  const dialog = window.getByRole('dialog', { name: 'Delete Chain copy?' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row('Chain copy')).toHaveCount(0);
  await expect(window.getByRole('tab', { name: 'Chain copy' })).toHaveCount(0);
  await expect(row('Chain')).toBeVisible();
});

test('a tool shows its program icon in the library, on its block, in the menu and in search', async () => {
  const program = join(folder, 'report.bat');
  await writeFile(program, '@echo off\r\n');
  const directory = join(dataDir, 'tools', 'acme.report');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1\nid: acme.report\nname: Report\nversion: 1.0.0\nlevel: 1\nrun:\n  program: '${program}'\n`,
  );
  await writeAutomation(
    'single',
    `name: Single
blocks:
  - { id: start, type: start }
  - { id: report, type: run, tool: acme.report }
connections:
  - { from: start, to: report }
positions:
  start: { x: 0, y: 0 }
  report: { x: 280, y: 0 }
`,
  );
  const { window } = await launchShell();
  await openAutomation(window, 'Single');
  await expect(block(window, 'report')).toBeVisible();

  const png = /^data:image\/png;base64,/;
  await expect(block(window, 'report').locator('img.program-icon')).toHaveAttribute('src', png);
  const row = window.getByTestId('library-item').filter({ hasText: 'Report' });
  await expect(row.locator('img.program-icon')).toHaveAttribute('src', png);

  const menu = await canvasMenuBelowStart(window);
  await menu.getByRole('menuitem', { name: 'Add block' }).click();
  await window
    .getByRole('menu', { name: 'Add block' })
    .getByRole('menuitem', { name: 'Tools' })
    .click();
  const item = window
    .getByRole('menu', { name: 'Tools' })
    .getByRole('menuitem', { name: 'Report' });
  await expect(item.locator('img.program-icon')).toHaveAttribute('src', png);
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await (await canvasMenuBelowStart(window)).getByRole('menuitem', { name: 'Add block' }).click();
  await window.getByRole('menuitem', { name: /^Search…/ }).click();
  const choice = window.getByTestId('add-choices').getByRole('button', { name: 'Report' });
  await expect(choice.locator('img.program-icon')).toHaveAttribute('src', png);
  await shot(window, 'canvas-program-icons');
});
