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

async function launchShell(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  await startTrace(app);
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
  await canvasSettled(window);
}

/** The canvas of the tab on view. */
function canvas(window: Page): Locator {
  return window.locator('[role="tabpanel"]:visible');
}

function node(window: Page, id: string): Locator {
  return canvas(window).locator(`.react-flow__node[data-id="${id}"]`);
}

/** A loop's frame, which carries its state in `data-state` in the run view. */
function frame(window: Page, id: string): Locator {
  return node(window, id).getByTestId('canvas-loop');
}

function header(window: Page, id: string): Locator {
  return node(window, id).locator('.loop-header');
}

/** Drags with the mouse from one point to another, in steps, as a person would. */
async function dragTo(
  window: Page,
  target: Locator,
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('Nothing to drag');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move((x + to.x) / 2, (y + to.y) / 2, { steps: 5 });
  await window.mouse.move(to.x, to.y, { steps: 5 });
  await window.mouse.up();
}

async function save(window: Page): Promise<void> {
  const button = window.getByRole('button', { name: 'Save', exact: true });
  await button.click();
  await expect(button).toBeDisabled();
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-loops-'));
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

const COUNTED = `name: Counted
blocks:
  - { id: start, type: start }
  - { id: For1, type: for, items: { kind: count, count: 3 } }
  - { id: Step1, type: run, tool: acme.step, loop: For1 }
  - { id: After1, type: run, tool: acme.step }
connections:
  - { from: start, to: For1 }
  - { from: For1, output: body, to: Step1 }
  - { from: For1, to: After1 }
`;

test('a For runs its body once per round, and the run view and history show each round', async () => {
  test.setTimeout(120_000);
  await fakeTool('acme.step', 'Step', ['exit', '0']);
  await writeAutomation('counted', COUNTED);
  const { window } = await launchShell();
  await openAutomation(window, 'Counted');

  // The loop is a frame around its body, in its own family.
  await expect(frame(window, 'For1')).toHaveClass(/family-loop/);
  await expect(header(window, 'For1')).toContainText('Repeat 3 times');
  await expect(header(window, 'For1').locator('.loop-chip')).toHaveText('3');

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const step = (id: string) => node(window, id).getByTestId('canvas-block');
  await expect(step('After1')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(frame(window, 'For1')).toHaveAttribute('data-state', 'completed');

  // The frame follows the latest round, and a dot per round jumps to it.
  const rounds = node(window, 'For1').getByTestId('loop-rounds');
  await expect(rounds.getByTestId('loop-round')).toHaveText('Round 3 / 3');
  await expect(rounds.getByTestId('loop-round-dot')).toHaveCount(3);
  await expect(rounds.locator('[data-state="completed"]')).toHaveCount(3);
  await shot(window, 'loop-run');
  await rounds.getByRole('button', { name: 'Previous round' }).click();
  await expect(rounds.getByTestId('loop-round')).toHaveText('Round 2 / 3');
  await node(window, 'Step1').click();
  await expect(window.getByTestId('run-details-round')).toHaveText('For1 round 2');
  await rounds.getByTestId('loop-round-dot').first().click();
  await expect(rounds.getByTestId('loop-round')).toHaveText('Round 1 / 3');
  await expect(window.getByTestId('run-details-round')).toHaveText('For1 round 1');

  // History keeps a row for each round of the body.
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await window.getByRole('button', { name: 'Open in history' }).first().click();
  const timeline = window.getByTestId('history-timeline');
  await expect(timeline.locator('[data-block="Step1"]')).toHaveCount(3);
  await expect(timeline.locator('[data-block="Step1"][data-round="For1:2"]')).toContainText(
    'For1 round 2',
  );
  await expect(window.getByTestId('history-detail')).toBeVisible();
});

const LOOSE = `name: Loose
blocks:
  - { id: start, type: start }
  - { id: For1, type: for, items: { kind: count, count: 2 } }
  - { id: Inside1, type: wait-for-time, seconds: 1, loop: For1 }
  - { id: Loose1, type: wait-for-time, seconds: 1 }
connections:
  - { from: start, to: For1 }
  - { from: For1, output: body, to: Inside1 }
positions:
  start: { x: 0, y: 0 }
  For1: { x: 240, y: -40 }
  Inside1: { x: 296, y: 16 }
  Loose1: { x: 0, y: 140 }
`;

test('blocks go into a loop by the library or a drag, and a drag that would cross its frame is refused', async () => {
  test.setTimeout(90_000);
  await writeAutomation('loose', LOOSE);
  const { window } = await launchShell();
  await openAutomation(window, 'Loose');
  const library = window.getByTestId('block-library');

  // A block dragged onto the frame goes into the loop.
  const box = await frame(window, 'For1').boundingBox();
  if (box === null) throw new Error('No frame');
  await dragTo(window, node(window, 'Loose1'), {
    x: box.x + box.width - 60,
    y: box.y + box.height - 24,
  });
  await save(window);
  await expect
    .poll(() => readFile(automationFile('loose'), 'utf8'))
    .toMatch(/id: Loose1\s+type: wait-for-time\s+seconds: 1\s+loop: For1|Loose1.*loop: For1/s);

  // Inside1 is joined to the body port, so taking it out would cross the frame.
  await dragTo(window, node(window, 'Inside1'), { x: box.x - 200, y: box.y + box.height + 160 });
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(window.locator('[aria-live]').filter({ hasText: 'cross a loop frame' })).toHaveCount(
    1,
  );

  // A block dropped into a frame whose body starts nowhere becomes its first block.
  await node(window, 'start').click();
  await library.getByRole('button', { name: 'For', exact: true }).click();
  await expect(frame(window, 'For2')).toBeVisible();
  const empty = await frame(window, 'For2').boundingBox();
  if (empty === null) throw new Error('No frame');
  await library
    .getByRole('button', { name: 'Wait for time', exact: true })
    .dragTo(frame(window, 'For2'), {
      targetPosition: { x: empty.width / 2 - 60, y: empty.height / 2 },
    });
  await save(window);
  await expect
    .poll(() => readFile(automationFile('loose'), 'utf8'))
    .toMatch(/from: For2\s+output: body/);

  // A new loop takes the next block from the library inside it, joined to its body.
  await node(window, 'start').click();
  await library.getByRole('button', { name: 'While', exact: true }).click();
  await expect(frame(window, 'While1')).toBeVisible();
  await library.getByRole('button', { name: 'Wait for time', exact: true }).click();
  await save(window);
  const text = await readFile(automationFile('loose'), 'utf8');
  expect(text).toContain('loop: While1');
  expect(text).toMatch(/from: While1\s+output: body/);
  await shot(window, 'loop-built');
});

const POLLED = `name: Polled
blocks:
  - { id: start, type: start }
  - id: While1
    type: while
    condition: { expression: 'loop.index < 2' }
    maxRounds: 5
  - { id: Step1, type: run, tool: acme.step, loop: While1 }
connections:
  - { from: start, to: While1 }
  - { from: While1, output: body, to: Step1 }
`;

test('a While checks before each round, reads its condition back, and its frame can be made bigger', async () => {
  test.setTimeout(120_000);
  await fakeTool('acme.step', 'Step', ['exit', '0']);
  await writeAutomation('polled', POLLED);
  const { window } = await launchShell();
  await openAutomation(window, 'Polled');

  await expect(header(window, 'While1')).toHaveAttribute(
    'title',
    /While rounds done is less than 2, at most 5/,
  );
  await header(window, 'While1').click();
  const settings = window.getByTestId('block-settings');
  await expect(settings.getByTestId('while-readback')).toHaveText(
    'Goes on while rounds done is less than 2',
  );
  await expect(settings.getByTestId('while-reads')).toHaveCount(0);
  await shot(window, 'while-settings');

  // Cut inside a value, the header's "…" stays in that value's chip.
  const text = node(window, 'While1').getByTestId('loop-header');
  await expect(text.locator('.loop-chip').first()).toHaveText(/…$/);
  await expect(text.locator('.loop-words', { hasText: '…' })).toHaveCount(0);

  // The corners of the selected frame make it bigger, also up and to the left.
  const box = async () => {
    const found = await frame(window, 'While1').boundingBox();
    if (found === null) throw new Error('No frame');
    return found;
  };
  const before = await box();
  await dragTo(window, node(window, 'While1').locator('.loop-corner.bottom.right'), {
    x: before.x + before.width + 180,
    y: before.y + before.height + 120,
  });
  await expect.poll(async () => (await box()).width).toBeGreaterThan(before.width + 100);
  await expect(text.getByText('…')).toHaveCount(0);
  const wide = await box();
  await dragTo(window, node(window, 'While1').locator('.loop-corner.top.left'), {
    x: wide.x - 60,
    y: wide.y - 40,
  });
  await expect.poll(async () => (await box()).x).toBeLessThan(wide.x - 30);
  const grown = await box();
  expect(grown.y).toBeLessThan(wide.y - 20);
  expect(grown.width).toBeGreaterThan(wide.width + 30);

  // Dragged by its header, it keeps its size and lands where it is let go.
  const grip = await header(window, 'While1').boundingBox();
  if (grip === null) throw new Error('No header');
  await window.mouse.move(grip.x + 40, grip.y + grip.height / 2);
  await window.mouse.down();
  await window.mouse.move(grip.x + 120, grip.y + 60, { steps: 6 });
  await window.mouse.move(grip.x + 200, grip.y + 120, { steps: 6 });
  expect(Math.abs((await box()).width - grown.width)).toBeLessThan(2);
  await window.mouse.up();
  await expect.poll(async () => (await box()).x).toBeGreaterThan(grown.x + 120);
  const landed = await box();
  expect(Math.abs(landed.width - grown.width)).toBeLessThan(2);
  expect(Math.abs(landed.height - grown.height)).toBeLessThan(2);
  await save(window);
  await expect
    .poll(() => readFile(automationFile('polled'), 'utf8'))
    .toMatch(
      /While1: \{ x: [-\d.]+, y: [-\d.]+, width: \d+, height: \d+ \}|While1:\s+x: [-\d.]+\s+y: [-\d.]+\s+width: \d+\s+height: \d+/,
    );

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame(window, 'While1')).toHaveAttribute('data-state', 'completed', {
    timeout: 60_000,
  });
  await expect(node(window, 'While1').getByTestId('loop-round')).toHaveText('Round 2 / 2');
  await shot(window, 'while-run');
});

const REPORT = `name: Report
blocks:
  - { id: start, type: start }
  - { id: Pause1, type: wait-for-time, seconds: 1 }
connections:
  - { from: start, to: Pause1 }
`;

const NIGHTLY = `name: Nightly
blocks:
  - { id: start, type: start }
  - { id: Report1, type: run-automation, automation: report }
connections:
  - { from: start, to: Report1 }
`;

test('a Run automation block runs another automation, whose run opens from it and leads back', async () => {
  test.setTimeout(90_000);
  await writeAutomation('report', REPORT);
  await writeAutomation('nightly', NIGHTLY);
  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');

  await node(window, 'Report1').click();
  const settings = window.getByTestId('block-settings');
  await expect(settings.getByTestId('called-automation')).toHaveText('Report');
  await expect(settings.getByRole('button', { name: 'Go to automation' })).toBeVisible();

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const call = node(window, 'Report1').getByTestId('canvas-block');
  await expect(call).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await node(window, 'Report1').click();
  await window.getByTestId('open-called-run').click();

  // The called run opens in its own tab, and says which run called it.
  await expect(window.getByRole('tab', { name: 'Report', selected: true })).toBeVisible();
  const calledBy = window.getByTestId('called-by');
  await expect(calledBy).toHaveText('Called by Nightly › Report1');
  await shot(window, 'called-run');
  await calledBy.click();
  await expect(window.getByRole('tab', { name: 'Nightly', selected: true })).toBeVisible();

  // In the run view, a double-click on the block opens the run it started too.
  await node(window, 'Report1').dblclick();
  await expect(window.getByRole('tab', { name: 'Report', selected: true })).toBeVisible();
  await expect(window.getByTestId('called-by')).toBeVisible();
});

test('an automation dragged from the sidebar becomes a call, and a double-click opens what it calls', async () => {
  test.setTimeout(90_000);
  await writeAutomation('report', REPORT);
  await writeAutomation('nightly', NIGHTLY);
  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  const pane = canvas(window).locator('.react-flow__pane');
  const row = (name: string) => automationsPanel(window).getByRole('button', { name, exact: true });

  await row('Report').dragTo(pane, { targetPosition: { x: 600, y: 300 } });
  await expect(node(window, 'Report2')).toBeVisible();
  await save(window);
  const text = await readFile(automationFile('nightly'), 'utf8');
  expect(text).toMatch(/id: Report2\s+type: run-automation\s+automation: report/);

  // An automation cannot call itself.
  await row('Nightly').dragTo(pane, { targetPosition: { x: 600, y: 420 } });
  await expect(window.locator('[aria-live]').filter({ hasText: 'cannot call itself' })).toHaveCount(
    1,
  );
  await expect(canvas(window).locator('.react-flow__node')).toHaveCount(3);

  await node(window, 'Report1').dblclick();
  await expect(window.getByRole('tab', { name: 'Report', selected: true })).toBeVisible();
});
