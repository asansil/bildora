import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** Runs the installed command as a scheduler would: no terminal, and only the given `PATH`. */
function bildora(folder: string, dataDir: string, args: string, path: readonly string[] = []) {
  const system = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
  const searched = [...path, system].join(';');
  const env = userEnvironment({ BILDORA_DATA_DIR: dataDir, Path: searched, PATH: searched });
  const command = `"${join(folder, 'app', 'bildora.cmd')}" ${args}`;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    env,
    encoding: 'utf8',
    input: '',
    windowsVerbatimArguments: true,
  });
}

/** Level 1 samples need their interpreter, which a user's machine has on `PATH`. */
const NODE_ON_PATH = [dirname(process.execPath)];

test('the packaged command runs an automation, and the app shows the run', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bildora smoke cli ñ-'));
  const dataDir = join(folder, 'data');
  const toolFolder = join(folder, 'sample tool');
  const workspace = join(dataDir, 'workspaces', 'default');
  const input = join(folder, 'notes.txt');
  await cp(UNPACKED, join(folder, 'app'), { recursive: true });
  await cp(SAMPLE, toolFolder, { recursive: true });
  await writeFile(input, 'one two three\n');
  // A level 1 step needs its interpreter, so the manifest names this machine's Node in full.
  const manifest = await readFile(join(toolFolder, 'tool.yaml'), 'utf8');
  await mkdir(join(dataDir, 'tools', 'bildora.sample.file-report'), { recursive: true });
  await writeFile(
    join(dataDir, 'tools', 'bildora.sample.file-report', 'tool.yaml'),
    manifest.replace('program: report.mjs', `program: ${join(toolFolder, 'report.mjs')}`),
  );
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
  await writeFile(
    join(workspace, 'automations', 'report.yaml'),
    `schemaVersion: 1
id: report
name: Report
steps:
  - id: report
    type: run
    tool: bildora.sample.file-report
    values:
      file: '${input}'
`,
  );
  await writeFile(
    join(workspace, 'automations', 'needs-someone.yaml'),
    `schemaVersion: 1
id: needs-someone
name: Needs Someone
steps:
  - id: look
    type: wait-for-manual-action
    message: Check it
`,
  );

  try {
    expect(bildora(folder, dataDir, '--version').stdout).toContain('alpha');
    expect(bildora(folder, dataDir, 'run missing').status).toBe(5);
    expect(bildora(folder, dataDir, 'run needs-someone').status).toBe(4);

    const run = bildora(folder, dataDir, 'run report', NODE_ON_PATH);
    expect(run.stdout).toContain('Automation completed');
    expect(run.status).toBe(0);

    const { app, window } = await launch(folder, dataDir);
    try {
      await window.getByRole('navigation').getByRole('button', { name: 'Automations' }).click();
      await window
        .getByTestId('automations-panel')
        .getByRole('button', { name: 'Report', exact: true })
        .click();
      await window.getByRole('tab', { name: 'Past runs' }).click();
      await expect(window.getByTestId('automation-runs')).toContainText('Command line');
      await expect(window.getByTestId('automation-runs')).toContainText('Completed');
    } finally {
      await app.close().catch(() => undefined);
    }
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

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

    // While the app stays open, the command reads the saved secret and writes to the same history.
    const automations = join(dataDir, 'workspaces', 'default', 'automations');
    await mkdir(automations, { recursive: true });
    await writeFile(
      join(automations, 'signed.yaml'),
      `schemaVersion: 1
id: signed
name: Signed
steps:
  - { id: report, type: run, tool: bildora.sample.file-report, profile: smoke }
`,
    );
    const signed = bildora(folder, dataDir, 'run signed', NODE_ON_PATH);
    expect(signed.stdout + signed.stderr).toContain('Automation completed');
    expect(signed.status).toBe(0);
    await window.getByRole('navigation').getByRole('button', { name: 'Automations' }).click();
    await window
      .getByTestId('automations-panel')
      .getByRole('button', { name: 'Signed', exact: true })
      .click();
    await window.getByRole('tab', { name: 'Past runs' }).click();
    await expect(window.getByTestId('automation-runs')).toContainText('Command line');
    await window.getByRole('navigation').getByRole('button', { name: 'Run history' }).click();
    await expect(window.locator('.history-row')).toHaveCount(2);
    await window.locator('.history-row').first().click();
    await expect(window.getByTestId('history-output')).toContainText('Signed with a token');

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

/** Runs a PowerShell script and gives what it printed, in UTF-8 so paths keep every letter. */
function powershell(script: string): string {
  const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `${utf8}; ${script}`],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}

/** The Task Scheduler folder the app gives a data directory that is not the usual one. */
function taskFolderOf(dataDir: string): string {
  const hash = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 8);
  return `Bildora-${hash}`;
}

/** Removes a test's folder from Task Scheduler, with any task left in it. */
function removeTaskFolder(name: string): void {
  powershell(
    `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $root = $s.GetFolder('\\'); try { $top = $root.GetFolder('${name}'); foreach ($f in @($top.GetFolders(0))) { foreach ($t in @($f.GetTasks(1))) { $f.DeleteTask($t.Name, 0) }; $top.DeleteFolder($f.Name, 0) }; $root.DeleteFolder('${name}', 0) } catch {}`,
  );
}

test('a schedule turned on in the packaged app runs its automation with no window', async () => {
  test.setTimeout(180_000);
  const folder = await mkdtemp(join(tmpdir(), 'bildora smoke schedule ñ-'));
  const dataDir = join(folder, 'data');
  const workspace = join(dataDir, 'workspaces', 'default');
  const tasks = taskFolderOf(dataDir);
  const task = `-TaskPath '\\${tasks}\\default\\' -TaskName 'nightly'`;
  await cp(UNPACKED, join(folder, 'app'), { recursive: true });
  await mkdir(join(workspace, 'automations'), { recursive: true });
  await writeFile(join(workspace, 'workspace.yaml'), 'formatVersion: 1\nname: Default\n');
  await writeFile(
    join(workspace, 'automations', 'nightly.yaml'),
    `schemaVersion: 2
id: nightly
name: Nightly
blocks:
  - { id: start, type: start }
  - { id: Wait1, type: wait-for-time, seconds: 1 }
connections:
  - { from: start, to: Wait1 }
`,
  );

  const opened: ElectronApplication[] = [];
  try {
    const first = await launch(folder, dataDir);
    opened.push(first.app);
    const { window } = first;
    await window.getByRole('navigation').getByRole('button', { name: 'Automations' }).click();
    await window
      .getByTestId('automations-panel')
      .getByRole('button', { name: 'Nightly', exact: true })
      .dblclick();
    await window.locator('.react-flow__node[data-id="start"]').click();
    const settings = window.getByTestId('block-settings');
    await settings.getByTestId('starts-on-schedule').click();
    await settings.getByLabel('Repeats').selectOption('daily');
    await settings.getByLabel('At', { exact: true }).fill('03:00');
    await settings.getByTestId('schedule-switch').click();
    await expect(settings.getByTestId('schedule-times')).toBeVisible({ timeout: 60_000 });
    await first.app.close();

    // The task names this data directory, since a task runs with the user's own environment.
    const action = powershell(`(Get-ScheduledTask ${task}).Actions[0].Arguments`);
    expect(action).toContain(`--data-dir "${dataDir}"`);

    // Started now instead of at three, it runs as it would then: with the app closed, no window.
    powershell(`Start-ScheduledTask ${task}`);
    await expect
      .poll(() => powershell(`(Get-ScheduledTaskInfo ${task}).LastTaskResult`), {
        message: 'the scheduled run should end with exit code 0',
        timeout: 90_000,
      })
      .toBe('0');

    const again = await launch(folder, dataDir);
    opened.push(again.app);
    await again.window.getByRole('navigation').getByRole('button', { name: 'Automations' }).click();
    await again.window
      .getByTestId('automations-panel')
      .getByRole('button', { name: 'Nightly', exact: true })
      .click();
    await again.window.getByRole('tab', { name: 'Past runs' }).click();
    await expect(again.window.getByTestId('automation-runs')).toContainText('Schedule');
    await expect(again.window.getByTestId('automation-runs')).toContainText('Completed');
  } finally {
    for (const app of opened) await app.close().catch(() => undefined);
    removeTaskFolder(tasks);
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
