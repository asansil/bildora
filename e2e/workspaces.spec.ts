import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

function electronEnvironment(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

interface Session {
  readonly app: ElectronApplication;
  readonly window: Page;
}

let folder: string;
let dataDir: string;
let program: string;
let open: ElectronApplication[] = [];

async function launchShell(): Promise<Session> {
  const app = await electron.launch({
    args: ['.'],
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
  });
  open.push(app);
  return { app, window: await app.firstWindow() };
}

async function stubPicker(app: ElectronApplication, paths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...filePaths] });
  }, paths);
}

async function stubMenuChoice(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, choice) => {
    Menu.prototype.popup = function popup(this: Electron.Menu, options) {
      this.items.find((item) => item.label === choice)?.click();
      options?.callback?.();
    };
  }, label);
}

function rail(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name, exact: true });
}

/** Opens a tool from its category panel, in a pinned tab. */
async function openTool(window: Page, category: string, name: string): Promise<void> {
  await rail(window, category).click();
  await window.locator('#tool-panel').getByRole('button', { name, exact: true }).first().dblclick();
  await expect(heading(window, name)).toBeVisible();
}

/** Settings and Manage Workspaces are modal, so the rail behind them waits until they close. */
async function closeDialog(window: Page, name: string): Promise<void> {
  const dialog = window.getByRole('dialog', { name });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
}

function heading(window: Page, name: string): Locator {
  return window.getByRole('heading', { name, level: 1 });
}

async function addTool(
  { app, window }: Session,
  name: string,
  category: string,
  scope: 'workspace' | 'global' = 'workspace',
  path = program,
): Promise<void> {
  await stubPicker(app, [path]);
  await window.getByRole('menuitem', { name: 'File' }).click();
  await window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await window.getByLabel('Name').fill(name);
  await window.getByLabel('Category').fill(category);
  if (scope === 'global') {
    await window.getByRole('radio', { name: 'Global, in every Workspace' }).check();
  }
  await window.getByRole('button', { name: 'Add tool' }).click();
  await expect(heading(window, name)).toBeVisible();
}

async function createWorkspace(window: Page, name: string): Promise<void> {
  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitem', { name: 'Create Workspace…' }).click();
  await window.getByLabel('Workspace name').fill(name);
  await window.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(window.getByTestId('status-workspace')).toHaveText(`Workspace: ${name}`);
}

async function switchWorkspace(window: Page, name: string): Promise<void> {
  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitemradio', { name }).click();
  await expect(window.getByTestId('status-workspace')).toHaveText(`Workspace: ${name}`);
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-'));
  dataDir = join(folder, 'data');
  await mkdir(dataDir);
  program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  open = [];
});

test.afterEach(async () => {
  for (const app of open) {
    await app
      .evaluate(({ app: electronApp }) => {
        electronApp.exit(0);
      })
      .catch(() => undefined);
  }
  await new Promise((done) => setTimeout(done, 200));
  await rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

test('two Workspaces show different content, and global tools appear in both', async () => {
  const first = await launchShell();
  const { window } = first;
  await expect(window.getByTestId('status-workspace')).toHaveText('Workspace: Default');

  await addTool(first, 'Shared Tool', 'shared', 'global');
  await addTool(first, 'Default Tool', 'home');
  await createWorkspace(window, 'Work');

  await expect(rail(window, 'shared')).toBeVisible();
  await expect(rail(window, 'home')).toHaveCount(0);
  await addTool(first, 'Work Tool', 'office');

  await switchWorkspace(window, 'Default');
  await expect(rail(window, 'home')).toBeVisible();
  await expect(rail(window, 'office')).toHaveCount(0);
  await first.app.close();

  const second = await launchShell();
  await expect(second.window.getByTestId('status-workspace')).toHaveText('Workspace: Default');
  await expect(rail(second.window, 'home')).toBeVisible();
  await switchWorkspace(second.window, 'Work');
  await expect(rail(second.window, 'office')).toBeVisible();
});

test('a new Workspace is empty, and offers a way in', async () => {
  const { window } = await launchShell();
  await createWorkspace(window, 'Lab');
  await expect(window.getByTestId('welcome')).toBeVisible();
});

test('a tool moves between Global and a Workspace', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Moved Tool', 'moved', 'global');
  await createWorkspace(window, 'Work');
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await openTool(window, 'moved', 'Moved Tool');

  await window.getByRole('button', { name: 'Move to this Workspace' }).click();
  await window.getByRole('button', { name: 'Move tool' }).click();
  await expect(window.getByRole('button', { name: 'Move to Global' })).toBeVisible();

  await switchWorkspace(window, 'Default');
  await expect(rail(window, 'moved')).toHaveCount(0);
  expect(existsSync(join(dataDir, 'workspaces', 'work', 'tools', 'moved-tool'))).toBe(true);
});

test('history and recent tools stay in their Workspace', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Shared Tool', 'shared', 'global');
  await window.getByRole('button', { name: 'Launch' }).click();
  await expect(window.getByTestId('last-result')).toHaveText('Exit code 0', { timeout: 15_000 });

  await rail(window, 'Run history').click();
  await expect(window.getByRole('main')).toContainText('Shared Tool');

  await createWorkspace(window, 'Work');
  await rail(window, 'Run history').click();
  await expect(window.getByRole('main')).toContainText('No runs recorded yet.');
});

test('a run goes on through a switch, and its Workspace cannot be deleted', async () => {
  const session = await launchShell();
  const { window } = session;
  const hanging = join(folder, 'hang.bat');
  await writeFile(hanging, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n');
  await addTool(session, 'Long Tool', 'long', 'workspace', hanging);
  await window.getByRole('button', { name: 'Launch' }).click();
  await expect(window.getByTestId('status')).toHaveText('1 task running');

  await createWorkspace(window, 'Work');
  await expect(window.getByTestId('status')).toHaveText('1 task running');

  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitem', { name: 'Manage Workspaces' }).click();
  await window
    .getByTestId('workspaces-view')
    .getByRole('listitem')
    .filter({ hasText: 'Default' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await window
    .getByRole('dialog', { name: 'Delete Default?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await closeDialog(window, 'Workspaces');
  await expect(window.getByRole('alert')).toContainText('tools running');

  await switchWorkspace(window, 'Default');
  await window.getByRole('button', { name: 'Stop' }).click();
  await expect(window.getByTestId('status')).toHaveText('Ready', { timeout: 15_000 });
});

test('favorites, theme and layout belong to each Workspace, across restarts', async () => {
  const first = await launchShell();
  const { window } = first;
  await addTool(first, 'Alpha Tool', 'alpha', 'global');
  await addTool(first, 'Beta Tool', 'beta', 'global');

  await window.getByRole('button', { name: 'Add Beta Tool to favorites' }).click();
  await rail(window, 'beta').click();
  await expect(window.getByTestId('favorite-tools')).toContainText('Beta Tool');

  await stubMenuChoice(first.app, 'Move up');
  await rail(window, 'beta').click({ button: 'right' });
  const names = window.getByRole('navigation').getByRole('button');
  await expect(names.first()).toHaveText('Bbeta');

  const separator = window.getByRole('separator', { name: 'Resize panel' });
  await separator.focus();
  await window.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', '480');
  await expect(window.locator('#tool-panel')).toHaveCSS('width', '480px');

  await rail(window, 'Settings').click();
  await window.getByRole('radio', { name: 'Dark' }).check();
  const isDark = (app: ElectronApplication): Promise<boolean> =>
    app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expect.poll(() => isDark(first.app)).toBe(true);
  await closeDialog(window, 'Settings');

  await createWorkspace(window, 'Work');
  await expect.poll(() => isDark(first.app)).toBe(true);
  await rail(window, 'Settings').click();
  await window.getByRole('radio', { name: 'Light' }).check();
  await expect.poll(() => isDark(first.app)).toBe(false);
  await closeDialog(window, 'Settings');
  await expect(names.first()).toHaveText('Aalpha');
  await expect(window.getByRole('separator', { name: 'Resize panel' })).toHaveCount(0);

  await rail(window, 'alpha').click();
  await expect(window.getByTestId('favorite-tools')).toHaveCount(0);
  await expect(window.locator('#tool-panel')).toHaveCSS('width', '248px');

  await switchWorkspace(window, 'Default');
  await expect.poll(() => isDark(first.app)).toBe(true);
  await expect(window.locator('#tool-panel')).toHaveCSS('width', '480px');
  await expect(window.getByTestId('favorite-tools')).toContainText('Beta Tool');
  await first.app.close();

  const second = await launchShell();
  expect(await isDark(second.app)).toBe(true);
  await expect(heading(second.window, 'Beta Tool')).toBeVisible();
  await expect(second.window.locator('#tool-panel')).toHaveCount(0);
  await rail(second.window, 'alpha').click();
  await expect(second.window.locator('#tool-panel')).toHaveCSS('width', '480px');
});

test('a Workspace can be renamed and deleted, along with what it holds', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Shared Tool', 'shared', 'global');
  await createWorkspace(window, 'Work');
  await addTool(session, 'Work Tool', 'office');

  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitem', { name: 'Manage Workspaces' }).click();
  const row = window.getByTestId('workspaces-view').getByRole('listitem');

  await row.filter({ hasText: 'Work' }).getByRole('button', { name: 'Rename' }).click();
  await window.getByLabel('Workspace name').fill('Office');
  await window
    .getByRole('dialog', { name: 'Rename Work' })
    .getByRole('button', { name: 'Rename' })
    .click();
  await expect(window.getByTestId('status-workspace')).toHaveText('Workspace: Office');

  await row.filter({ hasText: 'Office' }).getByRole('button', { name: 'Delete' }).click();
  await window
    .getByRole('dialog', { name: 'Delete Office?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(window.getByTestId('status-workspace')).toHaveText('Workspace: Default');
  await expect(rail(window, 'shared')).toBeVisible();
  expect(existsSync(join(dataDir, 'workspaces', 'work'))).toBe(false);
  await expect(
    row.filter({ hasText: 'Default' }).getByRole('button', { name: 'Delete' }),
  ).toBeDisabled();
});

test('a tool can point through a path variable, which each computer fills in', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Portable Tool', 'portable');

  await window.getByRole('button', { name: 'Edit details' }).click();
  await window.getByLabel('Program').fill(String.raw`{{paths.scripts}}\tool.bat`);
  await window.getByRole('button', { name: 'Save' }).click();
  await expect(window.getByTestId('runtime-warning')).toContainText('scripts');
  await expect(window.getByRole('button', { name: 'Launch' })).toBeDisabled();

  await rail(window, 'Settings').click();
  await window.getByLabel('Variable name').fill('scripts');
  await window.getByLabel('Absolute path').fill(folder);
  await window.getByRole('button', { name: 'Set variable' }).click();
  await expect(window.getByTestId('path-variables')).toContainText('scripts');
  await closeDialog(window, 'Settings');

  await rail(window, 'portable').click();
  await window.getByRole('button', { name: 'Portable Tool', exact: true }).click();
  await expect(window.getByTestId('runtime-warning')).toHaveCount(0);
  await window.getByRole('button', { name: 'Launch' }).click();
  await expect(window.getByTestId('last-result')).toHaveText('Exit code 0', { timeout: 15_000 });

  const stored = await readFile(
    join(dataDir, 'workspaces', 'default', 'tools', 'portable-tool', 'tool.yaml'),
    'utf8',
  );
  expect(stored).toContain('{{paths.scripts}}');
});

test('the rail reorders by dragging, and the panel resizes with the pointer', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Alpha Tool', 'alpha');
  await addTool(session, 'Beta Tool', 'beta');

  await rail(window, 'beta').dragTo(rail(window, 'alpha'));
  const names = window.getByRole('navigation').getByRole('button');
  await expect(names.first()).toHaveText('Bbeta');

  await rail(window, 'beta').click();
  const box = await window.getByRole('separator', { name: 'Resize panel' }).boundingBox();
  if (box === null) {
    throw new Error('The panel handle is not on screen');
  }
  await window.mouse.move(box.x + 2, box.y + 100);
  await window.mouse.down();
  await window.mouse.move(box.x + 102, box.y + 100, { steps: 4 });
  await window.mouse.up();
  await expect(window.locator('#tool-panel')).toHaveCSS('width', '348px');

  await window.reload();
  await expect(names.first()).toHaveText('Bbeta');
  await rail(window, 'beta').click();
  await expect(window.locator('#tool-panel')).toHaveCSS('width', '348px');
});

test('a resize stores where the pointer ended, even if the page has not drawn it yet', async () => {
  const session = await launchShell();
  const { window } = session;
  await addTool(session, 'Alpha Tool', 'alpha');
  await rail(window, 'alpha').click();
  const handle = window.getByRole('separator', { name: 'Resize panel' });
  const box = await handle.boundingBox();
  if (box === null) {
    throw new Error('The panel handle is not on screen');
  }
  await window.mouse.move(box.x + 2, box.y + 100);
  await window.mouse.down();

  // A slow machine can deliver both of these before React draws the first one.
  await window.evaluate(`{
    const element = document.querySelector('[role="separator"]');
    const options = { bubbles: true, pointerId: 1, clientX: ${String(box.x + 102)} };
    element.dispatchEvent(new PointerEvent('pointermove', options));
    element.dispatchEvent(new PointerEvent('pointerup', options));
  }`);
  await window.mouse.up();

  const file = join(dataDir, 'workspaces', 'default', 'workspace.yaml');
  await expect.poll(() => readFile(file, 'utf8')).toContain('panelWidth: 348');
});

test('a data folder from before Workspaces keeps everything', async () => {
  const toolFolder = join(dataDir, 'tools', 'old-tool');
  await mkdir(toolFolder, { recursive: true });
  await writeFile(
    join(toolFolder, 'tool.yaml'),
    [
      'schemaVersion: 1',
      'id: old-tool',
      'name: Old Tool',
      'version: 0.0.0',
      'level: 0',
      'leftoverProcesses: keep',
      'run:',
      `  program: ${JSON.stringify(program)}`,
    ].join('\n'),
  );
  await writeFile(join(dataDir, 'format.json'), '{"formatVersion":1}');
  await writeFile(
    join(dataDir, 'preferences.json'),
    '{"formatVersion":1,"theme":"dark","historyRunLimit":7}',
  );
  // Only core depends on it, and its prebuilt binary also loads under plain Node.
  const load = createRequire(resolve('packages/core/package.json'));
  const Connection = load('better-sqlite3') as new (file: string) => {
    exec(sql: string): void;
    pragma(text: string): void;
    close(): void;
  };
  const old = new Connection(join(dataDir, 'history.db'));
  old.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, tool_name TEXT NOT NULL, level INTEGER NOT NULL,
      started_at INTEGER NOT NULL, status TEXT NOT NULL, exit_code INTEGER, duration_ms REAL,
      failure_kind TEXT, failure_message TEXT, parameters TEXT NOT NULL, output TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX runs_by_tool ON runs (tool_id, started_at DESC);
    CREATE INDEX runs_by_time ON runs (started_at DESC);
    INSERT INTO runs (id, tool_id, tool_name, level, started_at, status, parameters)
    VALUES ('old-run', 'old-tool', 'Old Tool', 0, 1700000000000, 'completed', '[]');
  `);
  old.pragma('user_version = 1');
  old.close();

  const { app, window } = await launchShell();
  await expect(window.getByTestId('status-workspace')).toHaveText('Workspace: Default');
  await openTool(window, 'Uncategorized', 'Old Tool');
  await expect(window.getByRole('button', { name: 'Move to this Workspace' })).toBeVisible();
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true);

  await rail(window, 'Run history').click();
  await expect(window.getByRole('main')).toContainText('Old Tool');
  await rail(window, 'Settings').click();
  await expect(window.getByLabel('Runs kept per tool')).toHaveValue('7');
});
