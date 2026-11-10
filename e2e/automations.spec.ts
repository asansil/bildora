import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

const FAKE_TOOL = resolve('examples/fixtures/fake-tool.mjs');
/** A folder for screenshots, to look at what a test went through. */
const SHOTS = process.env['BILDORA_SHOTS'];

async function shot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

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
  return { app, window: await app.firstWindow() };
}

/** Definitions are plain files, so tests can start from what a user would have on disk. */
async function writeTool(id: string, name: string, body: string): Promise<void> {
  const directory = join(dataDir, 'tools', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'tool.yaml'),
    `schemaVersion: 1
id: ${id}
name: ${name}
version: 1.0.0
level: 1
interpreter: node
${body}`,
  );
}

function fakeTool(id: string, name: string, args: readonly string[]): Promise<void> {
  const list = args.map((argument) => `'${argument}'`).join(', ');
  return writeTool(id, name, `run:\n  program: ${FAKE_TOOL}\n  args: [${list}]\n`);
}

async function writeAutomation(id: string, name: string, steps: string): Promise<string> {
  const file = join(dataDir, 'workspaces', 'default', 'automations', `${id}.yaml`);
  await writeFile(file, `schemaVersion: 1\nid: ${id}\nname: ${name}\nsteps:\n${steps}`);
  return file;
}

function rail(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name, exact: true });
}

/** A block on the canvas. In the run view it carries its state in `data-state`. */
function step(window: Page, id: string): Locator {
  return window.locator(`.react-flow__node[data-id="${id}"] [data-testid="canvas-block"]`);
}

function settings(window: Page): Locator {
  return window.getByTestId('block-settings');
}

function runBadge(window: Page): Locator {
  return window.locator('.flow-header .state-badge');
}

function automationsPanel(window: Page): Locator {
  return window.getByTestId('automations-panel');
}

/** Opens the Automations panel unless a Workspace left it open, then pins the automation. */
async function openAutomation(window: Page, name: string): Promise<void> {
  if (!(await automationsPanel(window).isVisible())) {
    await rail(window, 'Automations').click();
  }
  await automationsPanel(window).getByRole('button', { name, exact: true }).dblclick();
  await expect(window.getByRole('tab', { name, selected: true })).toBeVisible();
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-automations-'));
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

test('builds an automation in the editor and runs it, handing a file between steps', async () => {
  const script = join(folder, 'write.mjs');
  await writeFile(
    script,
    `import { readFileSync, writeFileSync } from 'node:fs';
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const from = process.argv.includes('--from') ? readFileSync(value('--from'), 'utf8') : 'start';
writeFileSync(value('--to'), from + '+more');`,
  );
  await writeTool(
    'writer',
    'Writer',
    `run:
  program: ${script}
parameters:
  - { name: from, type: path, label: From, flag: --from }
  - { name: to, type: path, label: To, flag: --to }
outputs:
  - { name: file, param: to }
`,
  );

  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await expect(window.getByText('No automations in this Workspace yet.')).toBeVisible();
  await window.getByRole('button', { name: 'New automation' }).click();
  await window.getByLabel('Name', { exact: true }).fill('Hand over');
  const library = window.getByTestId('block-library');

  // Pressing blocks in the library one after another builds a chain from Start.
  await library.getByRole('button', { name: 'Writer' }).click();
  await expect(settings(window)).toHaveAttribute('data-block-id', 'writer');
  await settings(window)
    .getByLabel('Use a reference')
    .nth(1)
    .selectOption({ label: 'Folder of this run' });
  await settings(window).getByLabel('To', { exact: true }).fill('{{run.folder}}/one.txt');

  await library.getByRole('button', { name: 'Writer' }).click();
  await expect(settings(window)).toHaveAttribute('data-block-id', 'writer-2');
  await settings(window)
    .getByLabel('Use a reference')
    .nth(0)
    .selectOption({ label: 'Writer: file' });
  await settings(window).getByLabel('To', { exact: true }).fill('{{run.folder}}/two.txt');

  // A block added after one whose way on is taken goes in between.
  await window.getByRole('button', { name: 'Fit View' }).click();
  await step(window, 'writer').click();
  await library.getByRole('button', { name: 'Wait for a person' }).click();
  await expect(settings(window)).toHaveAttribute('data-block-id', 'review');
  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('tab', { name: 'Hand over', selected: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await window.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await expect(window.getByTestId('automation-command')).toHaveText('bildora run hand-over');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  // A tool process can take seconds to start on a busy machine, as in the other run tests.
  const toFinish = { timeout: 15_000 };
  await expect(step(window, 'writer')).toHaveAttribute('data-state', 'completed', toFinish);
  await expect(step(window, 'review')).toContainText('Waiting for you');
  await expect(step(window, 'writer-2')).toHaveAttribute('data-state', 'idle');
  await expect(window.getByTestId('status')).toContainText('1 task');
  await window.getByTestId('automation-waiting').getByRole('button', { name: 'Continue' }).click();

  await expect(step(window, 'writer-2')).toHaveAttribute('data-state', 'completed', toFinish);
  await expect(runBadge(window)).toHaveAttribute('data-state', 'completed', toFinish);
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await expect(window.getByTestId('automation-runs')).toContainText('App');
  await expect(window.getByTestId('status')).toHaveText('Ready');

  const runs = join(dataDir, 'automation-runs', 'default', 'hand-over');
  const [runId] = await readdir(runs);
  expect(await readFile(join(runs, runId ?? '', 'two.txt'), 'utf8')).toBe('start+more+more');
  const stored = await readFile(
    join(dataDir, 'workspaces', 'default', 'automations', 'hand-over.yaml'),
    'utf8',
  );
  expect(stored).toContain('{{steps.writer.outputs.file}}');
});

test('a failed step stops the automation and says why', async () => {
  await fakeTool('bad', 'Bad', ['exit', '7']);
  await fakeTool('good', 'Good', ['exit', '0']);
  await writeAutomation(
    'stops',
    'Stops',
    `  - { id: first, type: run, tool: bad }
  - { id: second, type: run, tool: good }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Stops');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(step(window, 'first')).toHaveAttribute('data-state', 'failed');
  await expect(step(window, 'first')).toContainText('The tool exited with code 7');
  await expect(step(window, 'second')).toHaveAttribute('data-state', 'idle');
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await expect(window.getByTestId('automation-runs')).toContainText('exited with code 7');

  await rail(window, 'Run history').click();
  await window.locator('.history-row').first().click();
  await expect(window.getByTestId('history-detail')).toContainText('Bad');
});

test('a block answers the console script of its tool, with nobody there', async () => {
  const asker = join(folder, 'ask.mjs');
  await writeFile(
    asker,
    `import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin, output: process.stdout });
const name = await lines.question('Your name: ');
lines.close();
console.log('HELLO ' + name);`,
  );
  await writeTool(
    'asker',
    'Asker',
    `run:
  program: ${asker}
parameters:
  - { name: name, type: string, label: Name, required: true, stdin: true }
stdin:
  - { expect: 'Your name:', send: '{{params.name}}', timeout: 10 }
`,
  );
  await writeAutomation(
    'greets',
    'Greets',
    `  - { id: ask, type: run, tool: asker, values: { name: Zoe } }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Greets');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(step(window, 'ask')).toHaveAttribute('data-state', 'completed');
  await rail(window, 'Run history').click();
  await window.locator('.history-row').first().click();
  await window.locator('.timeline-row[data-block="ask"]').click();
  await expect(window.getByTestId('history-output')).toContainText('HELLO Zoe');
});

test('history shows an automation run as one entry, with its blocks over time', async () => {
  const flaky = join(folder, 'flaky.mjs');
  const marker = join(folder, 'tried-once');
  await writeFile(
    flaky,
    `import { existsSync, writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(marker)};
if (existsSync(marker)) {
  console.log('SECOND TRY');
} else {
  writeFileSync(marker, '');
  console.log('FIRST TRY');
  process.exitCode = 3;
}`,
  );
  await writeTool(
    'flaky',
    'Flaky',
    `run:
  program: ${flaky}
`,
  );
  await fakeTool('quick', 'Quick', ['exit', '0']);
  await writeAutomation(
    'nightly',
    'Nightly',
    `  - { id: first, type: run, tool: quick }
  - { id: shaky, type: run, tool: flaky, onFailure: { retry: { attempts: 2, delaySeconds: 0 } } }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(step(window, 'shaky')).toHaveAttribute('data-state', 'completed', {
    timeout: 20_000,
  });

  await rail(window, 'Run history').click();
  const rows = window.locator('.history-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-kind', 'automation');
  await expect(rows.first()).toContainText('Nightly');
  await rows.first().click();

  const timeline = window.getByTestId('history-timeline');
  await expect(timeline.locator('.timeline-row')).toHaveCount(3);
  await expect(timeline.locator('.timeline-row').nth(0)).toHaveAttribute('data-block', 'start');
  const shaky = timeline.locator('.timeline-row[data-block="shaky"]');
  await expect(shaky).toContainText('2 tries');
  await expect(shaky.locator('.timeline-bar')).toHaveCount(2);
  await shaky.click();
  await expect(window.getByTestId('history-output')).toContainText('SECOND TRY');
  await window.getByRole('button', { name: 'Try 1' }).click();
  await expect(window.getByTestId('history-output')).toContainText('FIRST TRY');
  await shot(window, 'history-automation-run');

  await window.getByLabel('Show').selectOption({ label: 'Quick' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-kind', 'automation');
  await rows.first().click();
  await expect(window.locator('.timeline-row[data-block="first"]')).toHaveAttribute(
    'aria-current',
    'true',
  );

  await window.getByRole('button', { name: 'Show on canvas' }).click();
  await expect(window.getByRole('tab', { name: /Nightly/, selected: true })).toBeVisible();
  await expect(window.locator('.automation-run[aria-pressed="true"]')).toBeVisible();
  await expect(step(window, 'shaky')).toHaveAttribute('data-state', 'completed');
});

test('a run that went on past a failed step says so', async () => {
  await fakeTool('bad', 'Bad', ['exit', '7']);
  await writeAutomation(
    'goes-on',
    'Goes on',
    `  - { id: first, type: run, tool: bad, onFailure: continue }
  - { id: pause, type: wait-for-time, seconds: 1 }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Goes on');
  await window.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(runBadge(window)).toHaveText('Completed, 1 step failed');
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'failed');
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await expect(window.getByTestId('automation-runs')).toContainText('Completed, 1 step failed');
});

test('a step whose tool has gone shows as broken, and nothing changes on its own', async () => {
  const file = await writeAutomation(
    'broken',
    'Broken',
    `  - { id: first, type: run, tool: gone }\n`,
  );
  const before = await readFile(file, 'utf8');

  const { window } = await launchShell();
  await openAutomation(window, 'Broken');

  const problem = window.getByTestId('automation-problem');
  await expect(problem).toContainText('The tool gone is not installed in this Workspace.');
  await expect(problem).toContainText('Install the tool again');
  await expect(step(window, 'first').locator('.block-problem')).toBeVisible();

  // Run stays there to press, and says why nothing ran.
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(window.getByTestId('run-refused')).toHaveText(
    '1 problem stops this automation from running. It is listed below.',
  );
  await expect(window.getByRole('tab', { name: /Problems/, selected: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await problem.click();
  await expect(settings(window)).toHaveAttribute('data-block-id', 'first');
  // Opening lays the converted blocks out, which is not an edit, so the file stays as it was.
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await readFile(file, 'utf8')).toBe(before);
});

test('a damaged file shows as a problem, beside the healthy automations', async () => {
  await writeAutomation('good', 'Healthy', `  - { id: a, type: wait-for-time, seconds: 1 }\n`);
  await writeFile(
    join(dataDir, 'workspaces', 'default', 'automations', 'bad.yaml'),
    'schemaVersion: 1\nid: [',
  );
  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await expect(automationsPanel(window).getByRole('button', { name: 'Healthy' })).toBeVisible();
  await expect(window.getByTestId('automation-file-problems')).toContainText('bad.yaml');
});

test('opening and closing a category panel leaves the automation in view', async () => {
  await fakeTool('quick', 'Quick', ['exit', '0']);
  await writeAutomation('nightly', 'Nightly', '  - { id: quick, type: run, tool: quick }\n');

  const { window } = await launchShell();
  await openAutomation(window, 'Nightly');
  await expect(window.getByTestId('canvas')).toBeVisible();

  await rail(window, 'Uncategorized').click();
  await expect(window.locator('#tool-panel')).toBeVisible();
  await expect(window.getByTestId('canvas')).toBeVisible();

  await rail(window, 'Uncategorized').click();
  await expect(window.locator('#tool-panel')).toBeHidden();
  await expect(window.getByTestId('canvas')).toBeVisible();
});

test('a run keeps going across a Workspace switch, and can be stopped', async () => {
  await fakeTool('hang', 'Hang', ['hang']);
  await writeAutomation('long', 'Long', `  - { id: first, type: run, tool: hang }\n`);

  const { window } = await launchShell();
  await openAutomation(window, 'Long');
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'running');

  await window.getByRole('button', { name: /Workspaces/ }).click();
  await window.getByRole('menuitem', { name: 'Create Workspace' }).click();
  await window.getByRole('dialog').getByLabel('Name').fill('Other');
  await window.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(window.getByTestId('status-workspace')).toContainText('Other');
  await expect(window.getByTestId('status')).toContainText('1 task');
  await rail(window, 'Automations').click();
  await expect(window.getByText('No automations in this Workspace yet.')).toBeVisible();

  await window.getByRole('button', { name: /Workspaces/ }).click();
  await window.getByRole('menuitemradio', { name: 'Default' }).click();
  await expect(window.getByTestId('status-workspace')).toContainText('Default');
  await openAutomation(window, 'Long');
  await window.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(step(window, 'first')).toHaveAttribute('data-state', 'cancelled');
  await expect(window.getByTestId('status')).toHaveText('Ready');
});

test('Run saves the flow first, and Output shows what a tool wrote, live and later', async () => {
  await fakeTool('hang', 'Hang', ['hang']);
  await fakeTool('lines', 'Lines', ['lines', '3']);
  const file = await writeAutomation(
    'talks',
    'Talks',
    `  - { id: first, type: run, tool: lines }
  - { id: second, type: run, tool: hang }
`,
  );

  const { window } = await launchShell();
  await openAutomation(window, 'Talks');
  await window.getByLabel('Description').fill('Says a few lines');
  await window.getByRole('button', { name: 'Save and run', exact: true }).click();
  await expect(step(window, 'second')).toHaveAttribute('data-state', 'running', {
    timeout: 15_000,
  });
  expect(await readFile(file, 'utf8')).toContain('Says a few lines');
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  // Choosing a block in a run shows what its tool wrote, as it writes it.
  await step(window, 'second').click();
  await expect(window.getByRole('tab', { name: 'Output', selected: true })).toBeVisible();
  const output = window.getByTestId('block-output');
  await expect(output).toHaveAttribute('data-live', 'true');
  await expect(output.locator('.xterm-rows')).toContainText('READY');

  await step(window, 'first').click();
  await expect(output).toContainText('LINE 3');
  await expect(output).toContainText('END');

  await window.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(step(window, 'second')).toHaveAttribute('data-state', 'cancelled');

  // A past run keeps the output too, and a double click on it goes straight there.
  await window.getByRole('button', { name: 'Back to editing' }).click();
  await expect(window.getByRole('tab', { name: 'Output' })).toHaveCount(0);
  await window.getByRole('tab', { name: 'Past runs' }).click();
  await window.locator('.automation-run').first().dblclick();
  await expect(window.getByRole('tab', { name: 'Output', selected: true })).toBeVisible();
  await expect(output).toHaveCount(0);
  await step(window, 'first').click();
  await expect(output).toContainText('LINE 3');
});

test('closing asks while an automation only waits, and ends it', async () => {
  await writeAutomation('waits', 'Waits', `  - { id: pause, type: wait-for-time, seconds: 600 }\n`);

  const first = await launchShell();
  await openAutomation(first.window, 'Waits');
  await first.window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(step(first.window, 'pause')).toHaveAttribute('data-state', 'running');
  await expect(first.window.getByTestId('status')).toContainText('1 task');

  // Holds the process after its window has gone, as a slow machine does, and notes any error
  // from then on: Electron shows it in a dialog that stops the app from ever closing.
  const errors = join(folder, 'main-errors.txt');
  await first.app.evaluate(({ app, dialog }, file) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
    process.on('uncaughtException', (error) => {
      process.getBuiltinModule('node:fs').appendFileSync(file, `${error.message}\n`);
    });
    app.once('will-quit', (event) => {
      event.preventDefault();
      setTimeout(() => {
        app.exit(0);
      }, 300);
    });
  }, errors);
  const closed = first.app.waitForEvent('close');
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
  open = [];
  expect(existsSync(errors)).toBe(false);

  const second = await launchShell();
  await openAutomation(second.window, 'Waits');
  await second.window.getByRole('tab', { name: 'Past runs' }).click();
  await expect(second.window.getByTestId('automation-runs')).toContainText('Cancelled');
});

test('the command palette starts an automation', async () => {
  await writeAutomation(
    'quick',
    'Quick One',
    `  - { id: pause, type: wait-for-time, seconds: 1 }\n`,
  );
  const { window } = await launchShell();
  await expect(window.getByTestId('status')).toHaveText('Ready');
  await window.keyboard.press('Control+K');
  await window.getByRole('combobox', { name: 'Find a tool or action' }).fill('Quick One');
  await window.keyboard.press('Enter');

  await expect(window.getByTestId('canvas')).toBeVisible();
  await expect(runBadge(window)).toHaveAttribute('data-state', 'completed');
});

test('an automation with branches runs on the canvas, and shows what it skipped', async () => {
  test.setTimeout(90_000);
  await fakeTool('bad', 'Bad', ['exit', '7']);
  await fakeTool('good', 'Good', ['exit', '0']);
  const file = join(dataDir, 'workspaces', 'default', 'automations', 'branching.yaml');
  const text = `schemaVersion: 2
id: branching
name: Branching
blocks:
  - { id: start, type: start }
  - { id: check, type: run, tool: bad }
  - { id: handled, type: if, condition: { match: all, rules: [{ block: check, field: exit-code, operator: equals, value: 7 }] } }
  - { id: cleanup, type: run, tool: good }
  - { id: other, type: run, tool: good }
connections:
  - { from: start, to: check }
  - { from: check, output: error, to: handled }
  - { from: handled, output: 'true', to: cleanup }
  - { from: handled, output: 'false', to: other }
`;
  await writeFile(file, text);

  const { window } = await launchShell();
  await openAutomation(window, 'Branching');

  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runBadge(window)).toHaveText('Completed, 1 step failed', { timeout: 30_000 });
  await expect(step(window, 'check')).toHaveAttribute('data-state', 'failed');
  await expect(step(window, 'cleanup')).toHaveAttribute('data-state', 'completed');
  await expect(step(window, 'other')).toHaveAttribute('data-state', 'skipped');
  await expect(step(window, 'other')).toContainText('On a path this run did not take');
  expect(await readFile(file, 'utf8')).toBe(text);
});

test('a list of steps from before blocks still runs, and is rewritten only when saved', async () => {
  test.setTimeout(90_000);
  await fakeTool('good', 'Good', ['exit', '0']);
  const old = await writeAutomation(
    'old-list',
    'Old list',
    `  - { id: first, type: run, tool: good, onFailure: continue }
  - { id: second, type: run, tool: good }
`,
  );
  const before = await readFile(old, 'utf8');

  const { window } = await launchShell();
  await openAutomation(window, 'Old list');
  await window.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runBadge(window)).toHaveText('Completed', { timeout: 30_000 });
  expect(await readFile(old, 'utf8')).toBe(before);

  await window.getByRole('button', { name: 'Back to editing' }).click();
  await window.getByLabel('Description', { exact: true }).fill('Converted');
  await window.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const saved = await readFile(old, 'utf8');
  expect(saved).toContain('schemaVersion: 2');
  expect(saved).toContain('blocks:');
  expect(saved).toContain('positions:');
});

test('a list of steps that cannot become blocks shows as a problem and stays as it is', async () => {
  await fakeTool('good', 'Good', ['exit', '0']);
  const file = await writeAutomation(
    'overlap',
    'Overlap',
    `  - { id: one, type: run, tool: good, background: true }
  - { id: two, type: run, tool: good, background: true }
  - { id: w1, type: wait-for-completion, step: one }
  - { id: w2, type: wait-for-completion, step: two }
`,
  );
  const before = await readFile(file, 'utf8');

  const { window } = await launchShell();
  await rail(window, 'Automations').click();
  await expect(automationsPanel(window)).toContainText('overlap.yaml');
  await expect(automationsPanel(window)).toContainText('cannot be converted');
  expect(await readFile(file, 'utf8')).toBe(before);
});
