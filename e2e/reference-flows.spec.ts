import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { canvasSettled } from './fixtures/canvas.js';
import { closeApps } from './fixtures/close.js';
import { electronEnvironment, runCli, setUpFlows } from './fixtures/flows.js';
import { startTrace, stopTraces } from './fixtures/trace.js';

/** Where screenshots go when a run asks for them, for a person to look at. */
const SHOTS = process.env['BILDORA_SHOTS'];
const TO_FINISH = { timeout: 20_000 };

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

/** A block of the canvas on view, which carries its run state in `data-state`. */
function block(window: Page, id: string): Locator {
  return window
    .locator('[role="tabpanel"]:visible')
    .locator(`.react-flow__node[data-id="${id}"]`)
    .getByTestId('canvas-block');
}

/** Presses Run and fills the inputs it asks for, by label. */
async function run(window: Page, inputs: Record<string, string> = {}): Promise<void> {
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  const entries = Object.entries(inputs);
  if (entries.length === 0) return;
  const dialog = window.getByTestId('run-inputs');
  await expect(dialog).toBeVisible();
  for (const [label, value] of entries) await dialog.getByLabel(label).fill(value);
  await dialog.getByRole('button', { name: 'Run' }).click();
}

/** Checks the only entry of Run history, whose state shows as an icon. */
async function lastRunIs(window: Page, name: string, state: string): Promise<void> {
  await rail(window, 'Run history').click();
  const rows = window.locator('.history-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(name);
  await expect(rows.first().locator(`.state-${state}`)).toHaveCount(1);
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-flows-'));
  dataDir = join(folder, 'data');
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const FAILING_LOG = 'INFO started\nERROR disk full\nWARN slow\nERROR retry failed\n';
const CLEAN_LOG = 'INFO started\nINFO done\n';

test.describe('Log Check, an If on a JSON output', () => {
  test('from the app, a log with errors takes the true path', async () => {
    await setUpFlows(dataDir, ['log-check']);
    const log = join(folder, 'app.log');
    await writeFile(log, FAILING_LOG);

    const window = await launchShell();
    await openAutomation(window, 'Log Check');
    await run(window, { 'Log file': log });

    await expect(block(window, 'Report')).toHaveAttribute('data-state', 'completed', TO_FINISH);
    await expect(block(window, 'AllClear')).toHaveAttribute('data-state', 'skipped');
    await expect(block(window, 'HasErrors')).toHaveAttribute('data-state', 'completed');
    await shot(window, 'flow-log-check');
    expect(await readFile(join(folder, 'app-errors.txt'), 'utf8')).toBe('2 errors found\n');
    expect(existsSync(join(folder, 'app-ok.txt'))).toBe(false);

    await lastRunIs(window, 'Log Check', 'completed');
  });

  test('from the command line, each log takes its own path', async () => {
    await setUpFlows(dataDir, ['log-check']);
    const failing = join(folder, 'failing.log');
    const clean = join(folder, 'clean.log');
    await writeFile(failing, FAILING_LOG);
    await writeFile(clean, CLEAN_LOG);

    const withErrors = await runCli(dataDir, ['run', 'log-check', '--input', `log=${failing}`]);
    expect(withErrors.stdout).toContain('Automation completed');
    expect(withErrors.status).toBe(0);
    expect(await readFile(join(folder, 'failing-errors.txt'), 'utf8')).toBe('2 errors found\n');
    expect(existsSync(join(folder, 'failing-ok.txt'))).toBe(false);

    const withNone = await runCli(dataDir, ['run', 'log-check', '--input', `log=${clean}`]);
    expect(withNone.status).toBe(0);
    expect(await readFile(join(folder, 'clean-ok.txt'), 'utf8')).toBe('No errors found\n');
    expect(existsSync(join(folder, 'clean-errors.txt'))).toBe(false);
  });
});

/** A folder of logs, with a file the loop's pattern leaves out. */
async function logFolder(): Promise<string> {
  const logs = join(folder, 'logs');
  await mkdir(logs);
  await writeFile(join(logs, 'a.log'), 'ERROR one\n');
  await writeFile(join(logs, 'b.log'), CLEAN_LOG);
  await writeFile(join(logs, 'c.log'), FAILING_LOG);
  await writeFile(join(logs, 'notes.txt'), 'ERROR not a log\n');
  return logs;
}

/** Checks what Log Folder left in its reports folder. */
async function expectReports(logs: string): Promise<void> {
  const reports = join(logs, 'reports');
  expect(await readFile(join(reports, 'a.txt'), 'utf8')).toBe('a.log: 1 errors\n');
  expect(await readFile(join(reports, 'b.txt'), 'utf8')).toBe('b.log: 0 errors\n');
  expect(await readFile(join(reports, 'c.txt'), 'utf8')).toBe('c.log: 2 errors\n');
  expect(existsSync(join(reports, 'notes.txt'))).toBe(false);
  expect(await readFile(join(reports, 'summary.txt'), 'utf8')).toBe('3 logs scanned\n');
}

test.describe('Log Folder, a For over the files of a folder', () => {
  test('from the app, each log is a round and the summary counts them', async () => {
    test.setTimeout(90_000);
    await setUpFlows(dataDir, ['log-folder']);
    const logs = await logFolder();

    const window = await launchShell();
    await openAutomation(window, 'Log Folder');
    await run(window, { 'Log folder': logs });

    await expect(block(window, 'Summary')).toHaveAttribute('data-state', 'completed', {
      timeout: 60_000,
    });
    const loop = window.locator('.react-flow__node[data-id="EachLog"]');
    await expect(loop.getByTestId('canvas-loop')).toHaveAttribute('data-state', 'completed');
    const rounds = loop.getByTestId('loop-rounds');
    await expect(rounds.getByTestId('loop-round')).toHaveText('Round 3 / 3');
    await expect(rounds.locator('[data-state="completed"]')).toHaveCount(3);
    await shot(window, 'flow-log-folder');
    await expectReports(logs);

    await lastRunIs(window, 'Log Folder', 'completed');
  });

  test('from the command line, each log is a round and the summary counts them', async () => {
    await setUpFlows(dataDir, ['log-folder']);
    const logs = await logFolder();

    const result = await runCli(dataDir, ['run', 'log-folder', '--input', `logs=${logs}`]);
    expect(result.stdout).toContain('Automation completed');
    expect(result.status).toBe(0);
    await expectReports(logs);
  });
});

test.describe('Two Logs, parallel branches and an Error output', () => {
  test('from the app, a missing log takes its Error output and the branches meet', async () => {
    test.setTimeout(60_000);
    await setUpFlows(dataDir, ['two-logs']);
    const app = join(folder, 'app.log');
    await writeFile(app, FAILING_LOG);

    const window = await launchShell();
    await openAutomation(window, 'Two Logs');
    await run(window, { 'App log': app, 'Web log': join(folder, 'missing.log') });

    await expect(window.locator('.flow-header .state-badge')).toHaveText(
      'Completed, 1 step failed',
      TO_FINISH,
    );
    await expect(block(window, 'ScanApp')).toHaveAttribute('data-state', 'completed');
    await expect(block(window, 'ScanWeb')).toHaveAttribute('data-state', 'failed');
    await expect(block(window, 'WebMissing')).toHaveAttribute('data-state', 'completed');
    await expect(block(window, 'Summary')).toHaveAttribute('data-state', 'completed');
    await shot(window, 'flow-two-logs');
    expect(await readFile(join(folder, 'summary.txt'), 'utf8')).toBe('2 errors in the app log\n');
    expect(existsSync(join(folder, 'web-missing.txt'))).toBe(true);
  });

  test('from the command line, both branches run at once, and only a handled failure exits 3', async () => {
    await setUpFlows(dataDir, ['two-logs']);
    const app = join(folder, 'app.log');
    const web = join(folder, 'web.log');
    await writeFile(app, FAILING_LOG);
    await writeFile(web, CLEAN_LOG);

    const both = await runCli(dataDir, [
      'run',
      'two-logs',
      '--input',
      `app=${app}`,
      '--input',
      `web=${web}`,
    ]);
    expect(both.status).toBe(0);
    // The second branch starts before the first ends.
    expect(both.stdout.indexOf('ScanWeb: running')).toBeGreaterThan(-1);
    expect(both.stdout.indexOf('ScanWeb: running')).toBeLessThan(
      both.stdout.indexOf('ScanApp: completed'),
    );
    expect(existsSync(join(folder, 'web-missing.txt'))).toBe(false);
    expect(await readFile(join(folder, 'summary.txt'), 'utf8')).toBe('2 errors in the app log\n');

    const missing = join(folder, 'missing.log');
    const handled = await runCli(dataDir, [
      'run',
      'two-logs',
      '--input',
      `app=${app}`,
      '--input',
      `web=${missing}`,
    ]);
    expect(handled.stdout).toContain('failed steps: ScanWeb');
    expect(handled.status).toBe(3);
    expect(await readFile(join(folder, 'web-missing.txt'), 'utf8')).toBe(
      'The web log could not be read\n',
    );
  });
});

const TAGGED_LOG = 'ERROR disk full\nWARN slow\nWARN slower\n';

test.describe('Log Notes, blocks that share an input and read each other', () => {
  test('from the app, the canvas shows who reads whom, and the notes follow the links', async () => {
    await setUpFlows(dataDir, ['log-notes']);
    const log = join(folder, 'app.log');
    await writeFile(log, TAGGED_LOG);

    const window = await launchShell();
    await openAutomation(window, 'Log Notes');
    const usedBy = (id: string) =>
      window
        .locator('[role="tabpanel"]:visible')
        .locator(`.react-flow__node[data-id="${id}"]`)
        .getByTestId('block-used-by');
    await expect(usedBy('Scan')).toHaveText('2');
    await expect(usedBy('Errors')).toHaveText('1');
    await expect(usedBy('Warnings')).toHaveCount(0);

    await run(window, { 'Log file': log, Tag: 'monday' });
    await expect(block(window, 'Warnings')).toHaveAttribute('data-state', 'completed', TO_FINISH);
    await shot(window, 'flow-log-notes');
    expect(await readFile(join(folder, 'app-monday.txt'), 'utf8')).toBe('1 errors in app.log\n');
    expect(await readFile(join(folder, 'app-monday-warnings.txt'), 'utf8')).toBe(
      '2 warnings in app.log\n',
    );

    await lastRunIs(window, 'Log Notes', 'completed');
  });

  test('from the command line, the notes follow the links', async () => {
    await setUpFlows(dataDir, ['log-notes']);
    const log = join(folder, 'app.log');
    await writeFile(log, TAGGED_LOG);

    const result = await runCli(dataDir, [
      'run',
      'log-notes',
      '--input',
      `log=${log}`,
      '--input',
      'tag=friday',
    ]);
    expect(result.stdout).toContain('Automation completed');
    expect(result.status).toBe(0);
    expect(await readFile(join(folder, 'app-friday.txt'), 'utf8')).toBe('1 errors in app.log\n');
    expect(await readFile(join(folder, 'app-friday-warnings.txt'), 'utf8')).toBe(
      '2 warnings in app.log\n',
    );
  });
});
