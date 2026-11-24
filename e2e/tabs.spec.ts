import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { closeApps } from './fixtures/close.js';
import { startTrace, stopTraces } from './fixtures/trace.js';

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
  await startTrace(app);
  return { app, window: await app.firstWindow() };
}

/** A level 1 tool that runs the fake tool, with one text field to type into. */
async function writeTool(id: string, name: string, mode: readonly string[]): Promise<void> {
  const directory = join(dataDir, 'tools', id);
  await mkdir(directory, { recursive: true });
  const args = mode.map((argument) => `'${argument}'`).join(', ');
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1
id: ${id}
name: ${name}
version: 1.0.0
level: 1
category: Work
interpreter: node
run:
  program: ${FAKE_TOOL}
  args: [${args}]
parameters:
  - { name: note, type: string, label: Note, flag: --note }
`,
  );
}

async function writeAutomation(id: string, name: string): Promise<void> {
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'automations', `${id}.yaml`),
    `schemaVersion: 1\nid: ${id}\nname: ${name}\nsteps:\n  - { id: a, type: wait-for-time, seconds: 1 }\n`,
  );
}

function rail(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name, exact: true });
}

function panelRow(window: Page, name: string): Locator {
  return window.locator('#tool-panel').getByRole('button', { name, exact: true }).first();
}

function tab(window: Page, name: string): Locator {
  return window.getByRole('tab', { name, exact: true });
}

function tabNames(window: Page): Locator {
  return window.getByRole('tablist').getByRole('tab');
}

function heading(window: Page, name: string): Locator {
  return window.getByRole('heading', { name, level: 1 });
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-tabs-'));
  dataDir = join(folder, 'data');
  await mkdir(join(dataDir, 'workspaces', 'default', 'automations'), { recursive: true });
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'workspace.yaml'),
    'formatVersion: 2\nname: Default\n',
  );
  await writeTool('alpha', 'Alpha', ['exit', '0']);
  await writeTool('beta', 'Beta', ['exit', '0']);
  await writeTool('gamma', 'Gamma', ['exit', '0']);
});

test.afterEach(async () => {
  await stopTraces(open);
  await closeApps(open);
  open = [];
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('a single click previews, the next replaces it, and a double click or use keeps it', async () => {
  const { window } = await launchShell();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await rail(window, 'Work').click();

  await panelRow(window, 'Alpha').click();
  await expect(tab(window, 'Alpha')).toHaveAttribute('data-preview', 'true');
  await panelRow(window, 'Beta').click();
  await expect(tabNames(window)).toHaveText(['Beta']);

  await panelRow(window, 'Beta').dblclick();
  await expect(tab(window, 'Beta')).not.toHaveAttribute('data-preview', 'true');
  await panelRow(window, 'Gamma').click();
  await expect(tabNames(window)).toHaveText(['Beta', 'Gamma']);

  await window.getByRole('textbox', { name: 'Note' }).fill('typed');
  await expect(tab(window, 'Gamma, unsaved')).not.toHaveAttribute('data-preview', 'true');
  await panelRow(window, 'Alpha').click();
  await expect(tabNames(window)).toHaveText(['Beta', 'Gamma', 'Alpha']);

  await tab(window, 'Alpha').dblclick();
  await expect(tab(window, 'Alpha')).not.toHaveAttribute('data-preview', 'true');
});

test('a tab keeps what was typed while another is shown', async () => {
  const { window } = await launchShell();
  await rail(window, 'Work').click();
  await panelRow(window, 'Alpha').dblclick();
  await window.getByRole('textbox', { name: 'Note' }).fill('first draft');
  await panelRow(window, 'Beta').dblclick();
  await expect(heading(window, 'Beta')).toBeVisible();

  await tab(window, 'Alpha, unsaved').click();
  await expect(window.getByRole('tabpanel').getByLabel('Note')).toHaveValue('first draft');
});

test('the keyboard and the pointer move between tabs and close them', async () => {
  const { app, window } = await launchShell();
  await rail(window, 'Work').click();
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    await panelRow(window, name).dblclick();
  }
  await expect(tab(window, 'Gamma')).toHaveAttribute('aria-selected', 'true');

  await window.keyboard.press('Control+Tab');
  await expect(tab(window, 'Alpha')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('Control+Shift+Tab');
  await expect(tab(window, 'Gamma')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('Control+PageUp');
  await expect(tab(window, 'Beta')).toHaveAttribute('aria-selected', 'true');

  await window.keyboard.press('Control+W');
  await expect(tabNames(window)).toHaveText(['Alpha', 'Gamma']);
  await expect(tab(window, 'Gamma')).toHaveAttribute('aria-selected', 'true');
  expect(app.windows()).toHaveLength(1);

  await tab(window, 'Alpha').click({ button: 'middle' });
  await expect(tabNames(window)).toHaveText(['Gamma']);

  await panelRow(window, 'Alpha').dblclick();
  await panelRow(window, 'Beta').dblclick();
  await tab(window, 'Alpha').click({ button: 'right' });
  await window.getByRole('menuitem', { name: 'Close Others' }).click();
  await expect(tabNames(window)).toHaveText(['Alpha']);

  await panelRow(window, 'Beta').dblclick();
  await panelRow(window, 'Gamma').dblclick();
  await tab(window, 'Gamma').dragTo(tab(window, 'Alpha'));
  await expect(tabNames(window)).toHaveText(['Gamma', 'Alpha', 'Beta']);
  await window.keyboard.press('Control+W');
  await expect(tab(window, 'Alpha')).toHaveAttribute('aria-selected', 'true');
  // An inactive tab shows its close button on hover.
  await tab(window, 'Beta').hover();
  await tab(window, 'Beta').getByRole('button', { name: 'Close Beta' }).click();
  await window.keyboard.press('Control+W');
  await expect(window.getByTestId('start-screen')).toBeVisible();
});

test('closing a running tool asks, and can leave it running or stop it', async () => {
  await writeTool('slow', 'Slow', ['hang']);
  const { window } = await launchShell();
  await rail(window, 'Work').click();
  await panelRow(window, 'Slow').dblclick();
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(window.getByTestId('status')).toHaveText('1 task running', { timeout: 15_000 });

  await window.keyboard.press('Control+W');
  const asking = window.getByRole('dialog', { name: 'Slow is running' });
  await asking.getByRole('button', { name: 'Cancel' }).click();
  await expect(tab(window, 'Slow')).toBeVisible();

  await window.keyboard.press('Control+W');
  await asking.getByRole('button', { name: 'Keep running' }).click();
  await expect(tabNames(window)).toHaveCount(0);
  await expect(window.getByTestId('status')).toHaveText('1 task running');

  await panelRow(window, 'Slow').dblclick();
  await window.keyboard.press('Control+W');
  await asking.getByRole('button', { name: 'Stop and close' }).click();
  await expect(window.getByTestId('status')).toHaveText('Ready', { timeout: 15_000 });
  await expect(tabNames(window)).toHaveCount(0);
});

test('a new automation with changes asks before its tab closes', async () => {
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window
    .getByTestId('automations-panel')
    .getByRole('button', { name: 'New automation' })
    .click();
  await expect(tab(window, 'New automation')).toBeVisible();
  await window.getByLabel('Name', { exact: true }).fill('Draft');

  await window.keyboard.press('Control+W');
  const asking = window.getByRole('dialog', { name: 'Discard changes to New automation?' });
  await asking.getByRole('button', { name: 'Cancel' }).click();
  await expect(window.getByLabel('Name', { exact: true })).toHaveValue('Draft');

  await window.keyboard.press('Control+W');
  await asking.getByRole('button', { name: 'Discard' }).click();
  await expect(tabNames(window)).toHaveCount(0);
  const stored = await readFile(join(dataDir, 'workspaces', 'default', 'workspace.yaml'), 'utf8');
  expect(stored).not.toContain('new-');
});

test('a tab with unsaved changes shows a dot, which saving clears', async () => {
  await writeAutomation('chain', 'Chain');
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await window.getByTestId('automations-panel').getByRole('button', { name: 'Chain' }).dblclick();
  await expect(tab(window, 'Chain')).not.toHaveAttribute('data-unsaved', 'true');
  await window.getByLabel('Name', { exact: true }).fill('Chain two');
  const edited = tab(window, 'Chain, unsaved');
  await expect(edited).toHaveAttribute('data-unsaved', 'true');
  await expect(edited.locator('.tab-unsaved')).toBeVisible();
  await expect(edited.getByRole('button', { name: 'Close Chain' })).toBeHidden();
  // The close button takes the dot's place under the pointer.
  await edited.hover();
  await expect(edited.getByRole('button', { name: 'Close Chain' })).toBeVisible();
  await expect(edited.locator('.tab-unsaved')).toBeHidden();

  await window.getByLabel('Name', { exact: true }).click();
  await window.keyboard.press('Control+S');
  await expect(tab(window, 'Chain two')).not.toHaveAttribute('data-unsaved', 'true');

  await rail(window, 'Work').click();
  await panelRow(window, 'Alpha').dblclick();
  await window.getByRole('textbox', { name: 'Note' }).fill('changed');
  await expect(tab(window, 'Alpha, unsaved')).toHaveAttribute('data-unsaved', 'true');
  await window.getByRole('textbox', { name: 'Note' }).fill('');
  await expect(tab(window, 'Alpha')).not.toHaveAttribute('data-unsaved', 'true');

  await window.getByRole('textbox', { name: 'Note' }).fill('kept');
  await window.getByRole('button', { name: 'Save as…' }).click();
  await window.getByRole('dialog').getByLabel('Name').fill('Mine');
  await window.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(tab(window, 'Alpha')).not.toHaveAttribute('data-unsaved', 'true');

  // A tool's form is scratch work, so its tab closes without asking.
  await window.getByRole('textbox', { name: 'Note' }).fill('scratch');
  await expect(tab(window, 'Alpha, unsaved')).toBeVisible();
  await window.keyboard.press('Control+W');
  await expect(tab(window, 'Alpha, unsaved')).toHaveCount(0);
  await expect(tab(window, 'Chain two')).toHaveAttribute('aria-selected', 'true');
  await expect(window.getByRole('dialog')).toHaveCount(0);
});

test('the rail marks what owns the active tab, and an open panel moves nothing', async () => {
  await writeAutomation('nightly', 'Nightly');
  const { window } = await launchShell();
  const work = rail(window, 'Work');
  const automations = rail(window, 'Automations');
  const history = rail(window, 'Run history');

  await work.click();
  await expect(work).not.toHaveAttribute('aria-current', 'true');
  await panelRow(window, 'Alpha').dblclick();
  await expect(work).toHaveAttribute('aria-current', 'true');

  await automations.click();
  await expect(work).toHaveAttribute('aria-current', 'true');
  await expect(heading(window, 'Alpha')).toBeVisible();
  await window
    .getByTestId('automations-panel')
    .getByRole('button', { name: 'Nightly', exact: true })
    .dblclick();
  await expect(automations).toHaveAttribute('aria-current', 'true');
  await expect(work).not.toHaveAttribute('aria-current', 'true');

  await history.click();
  await expect(history).toHaveAttribute('aria-current', 'true');
  await expect(tab(window, 'Run history')).toHaveAttribute('aria-selected', 'true');

  await tab(window, 'Alpha').click();
  await expect(work).toHaveAttribute('aria-current', 'true');
  await rail(window, 'Settings').click();
  await window.keyboard.press('Escape');
  await expect(work).toHaveAttribute('aria-current', 'true');
});

test('each Workspace keeps its tabs, across a switch and a relaunch', async () => {
  await writeAutomation('nightly', 'Nightly');
  const first = await launchShell();
  const { window } = first;
  await rail(window, 'Work').click();
  await panelRow(window, 'Alpha').dblclick();
  await rail(window, 'Automations').click();
  await window
    .getByTestId('automations-panel')
    .getByRole('button', { name: 'Nightly', exact: true })
    .dblclick();
  // Opened last, so no later single click takes the preview tab's place.
  await rail(window, 'Work').click();
  await panelRow(window, 'Beta').click();
  await tab(window, 'Alpha').click();

  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitem', { name: 'Create Workspace…' }).click();
  await window.getByLabel('Workspace name').fill('Other');
  await window.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(window.getByTestId('status-workspace')).toHaveText('Workspace: Other');
  await expect(tabNames(window)).toHaveCount(0);

  await rail(window, 'Workspaces').click();
  await window.getByRole('menuitemradio', { name: 'Default' }).click();
  await expect(tabNames(window)).toHaveText(['Alpha', 'Nightly', 'Beta']);
  await expect(tab(window, 'Alpha')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(window, 'Beta')).toHaveAttribute('data-preview', 'true');
  await first.app.close();

  const second = await launchShell();
  await expect(tabNames(second.window)).toHaveText(['Alpha', 'Nightly', 'Beta']);
  await expect(heading(second.window, 'Alpha')).toBeVisible();
});

test('a tab whose item is gone closes quietly', async () => {
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'workspace.yaml'),
    `formatVersion: 2
name: Default
layout:
  tabs:
    - { kind: tool, id: alpha }
    - { kind: tool, id: removed }
    - { kind: automation, id: missing }
  activeTab: tool:removed
`,
  );
  const { window } = await launchShell();
  await expect(tabNames(window)).toHaveText(['Alpha']);
  await expect(heading(window, 'Alpha')).toBeVisible();
});

test('the tool a version 1 Workspace had selected opens as one tab', async () => {
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'workspace.yaml'),
    'formatVersion: 1\nname: Default\nlayout:\n  selectedTool: beta\n',
  );
  const { window } = await launchShell();
  await expect(tabNames(window)).toHaveText(['Beta']);
  await expect(tab(window, 'Beta')).not.toHaveAttribute('data-preview', 'true');
  await expect(heading(window, 'Beta')).toBeVisible();
});
