import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { canvasSettled } from './fixtures/canvas.js';
import { closeApps } from './fixtures/close.js';
import { startTrace, stopTraces } from './fixtures/trace.js';

/** Creating a task goes through PowerShell, which can take a few seconds on a busy machine. */
const TASK_TIMEOUT_MS = 30_000;

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

/** The Task Scheduler folder of this test's data directory, as `taskRootFor` names it. */
function taskFolder(): string {
  const hash = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 8);
  return `Bildora-${hash}`;
}

function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** The tasks in this test's folder, as `\<folder>\<workspace>\<automation>`. */
function tasks(): string {
  return powershell(
    `Get-ScheduledTask -TaskPath '\\${taskFolder()}\\*' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskPath + $_.TaskName }`,
  );
}

/** Removes this test's folders from Task Scheduler, which removing their tasks leaves behind. */
function removeTaskFolders(): void {
  powershell(
    `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $root = $s.GetFolder('\\'); try { $top = $root.GetFolder('${taskFolder()}'); foreach ($t in @($top.GetTasks(1))) { $top.DeleteTask($t.Name, 0) }; foreach ($f in @($top.GetFolders(0))) { foreach ($t in @($f.GetTasks(1))) { $f.DeleteTask($t.Name, 0) }; $top.DeleteFolder($f.Name, 0) }; $root.DeleteFolder('${taskFolder()}', 0) } catch {}`,
  );
}

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

function automationFile(id: string): string {
  return join(dataDir, 'workspaces', 'default', 'automations', `${id}.yaml`);
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

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-schedules-'));
  dataDir = join(folder, 'data');
  const workspace = join(dataDir, 'workspaces', 'default');
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
  await writeFile(
    automationFile('nightly'),
    'schemaVersion: 2\nid: nightly\nname: Nightly\nblocks:\n  - { id: start, type: start }\n  - { id: Wait1, type: wait-for-time, seconds: 1 }\nconnections:\n  - { from: start, to: Wait1 }\n',
  );
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  removeTaskFolders();
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('schedules an automation on this computer, and turns it off again', async () => {
  test.skip(process.platform !== 'win32', 'Only Windows has a scheduler Bildora drives');
  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  await window.locator('.react-flow__node[data-id="start"]').click();
  const settings = window.getByTestId('block-settings');

  await settings.getByTestId('starts-on-schedule').click();
  await settings.getByLabel('Repeats').selectOption('weekly');
  await settings.getByRole('button', { name: 'Friday' }).click();
  await settings.getByLabel('At', { exact: true }).fill('07:30');
  await expect(window.getByTestId('block-schedule')).toHaveText('Mon, Fri 07:30');
  await expect(window.getByTestId('block-schedule')).toHaveAttribute('data-on', 'false');

  // Turning it on saves the automation first, so the task follows what is on screen.
  await settings.getByTestId('schedule-switch').click();
  await expect(settings.getByTestId('schedule-times')).toBeVisible({ timeout: TASK_TIMEOUT_MS });
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(window.getByTestId('block-schedule')).toHaveAttribute('data-on', 'true');
  const saved = await readFile(automationFile('nightly'), 'utf8');
  expect(saved).toContain('mode: scheduled');
  expect(saved).toContain('repeat: weekly');
  expect(tasks()).toBe(`\\${taskFolder()}\\default\\nightly`);

  await settings.getByTestId('schedule-switch').click();
  // The switch moves at once; the task is gone only when it is no longer busy.
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-busy', 'false', {
    timeout: TASK_TIMEOUT_MS,
  });
  expect(tasks()).toBe('');
});

test('a single run set in the past says why it cannot be turned on, and turns on once fixed', async () => {
  test.skip(process.platform !== 'win32', 'Only Windows has a scheduler Bildora drives');
  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  await window.locator('.react-flow__node[data-id="start"]').click();
  const settings = window.getByTestId('block-settings');

  await settings.getByTestId('starts-on-schedule').click();
  await settings.getByLabel('Repeats').selectOption('once');
  await settings.getByLabel('On', { exact: true }).fill('2020-01-01');
  await expect(settings.getByTestId('schedule-notice')).toContainText('has gone by');
  await expect(settings.getByTestId('schedule-switch')).toBeDisabled();

  await settings.getByLabel('On', { exact: true }).fill('2099-01-01');
  await expect(settings.getByTestId('schedule-notice')).toHaveCount(0);
  await settings.getByTestId('schedule-switch').click();
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByTestId('schedule-times')).toBeVisible({ timeout: TASK_TIMEOUT_MS });
  await expect(window.getByTestId('app-error')).toHaveCount(0);

  await settings.getByTestId('schedule-switch').click();
  // The switch moves at once; the task is gone only when it is no longer busy.
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByTestId('schedule-switch')).toHaveAttribute('aria-busy', 'false', {
    timeout: TASK_TIMEOUT_MS,
  });
  expect(tasks()).toBe('');
});
