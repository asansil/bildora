import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

/** VS Code leaks ELECTRON_RUN_AS_NODE to child processes, which stops Electron opening a window. */
function electronEnvironment(extra: Record<string, string> = {}): Record<string, string> {
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
let open: ElectronApplication[] = [];
/** Tools a test started, which a failing test would otherwise leave running. */
let toolPids: number[] = [];

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

async function stubCloseAnswer(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    dialog.showMessageBox = () => Promise.resolve({ response: answer, checkboxChecked: false });
  }, response);
}

/** Native menus cannot be driven from a page, so this picks the item as soon as one pops up. */
async function stubMenuChoice(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, choice) => {
    Menu.prototype.popup = function popup(this: Electron.Menu, options) {
      this.items.find((item) => item.label === choice)?.click();
      options?.callback?.();
    };
  }, label);
}

function categoryButton(window: Page, name: string): Locator {
  return window.getByRole('navigation').getByRole('button', { name });
}

async function workAreaWidth(window: Page): Promise<number> {
  const box = await window.getByRole('main').boundingBox();
  if (box === null) {
    throw new Error('The work area is not on screen');
  }
  return box.width;
}

async function addTool(
  session: Session,
  program: string,
  name: string,
  category?: string,
): Promise<void> {
  await stubPicker(session.app, [program]);
  await session.window.getByRole('menuitem', { name: 'File' }).click();
  await session.window.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await session.window.getByLabel('Name').fill(name);
  if (category !== undefined) {
    await session.window.getByLabel('Category').fill(category);
  }
  await session.window.getByRole('button', { name: 'Add tool' }).click();
  await expect(session.window.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** A script that records its pid, then stays alive until something ends it. */
async function hangingScript(): Promise<{ program: string; pidFile: string }> {
  const pidFile = join(folder, 'pid.txt');
  const program = join(folder, 'hang.mjs');
  await writeFile(
    program,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => undefined, 1000);`,
  );
  return { program, pidFile };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile: string): Promise<number> {
  await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  toolPids.push(pid);
  return pid;
}

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bildora-e2e-'));
  dataDir = join(folder, 'data');
  await mkdir(dataDir);
  open = [];
  toolPids = [];
});

test.afterEach(async () => {
  for (const pid of toolPids.filter(isAlive)) {
    process.kill(pid);
  }
  for (const app of open) {
    await app
      .evaluate(({ app: electronApp }) => {
        electronApp.exit(0);
      })
      .catch(() => undefined);
  }
  await new Promise((done) => setTimeout(done, 200));
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the shell opens sandboxed, with a welcome and no categories', async () => {
  const { window } = await launchShell();

  await expect(window).toHaveTitle('Bildora');
  await expect(window.getByTestId('welcome')).toBeVisible();
  await expect(window.getByTestId('status')).toHaveText('Ready');
  await expect(window.getByRole('navigation').getByRole('button')).toHaveText([
    'Workspaces',
    'Automations',
    'Run history',
    'Settings',
  ]);
  expect(await window.evaluate(() => typeof Reflect.get(globalThis, 'require'))).toBe('undefined');
});

test('a registered tool is still there after a restart', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');

  const first = await launchShell();
  await addTool(first, program, 'My Tool');
  // The open tab is stored a moment after it shows, so the restart waits for it.
  const stored = join(dataDir, 'workspaces', 'default', 'workspace.yaml');
  await expect.poll(() => readFile(stored, 'utf8').catch(() => '')).toContain('tool:my-tool');
  await first.app.close();

  const { window } = await launchShell();
  await expect(window.getByRole('heading', { name: 'My Tool', level: 1 })).toBeVisible();
});

test('launching shows the run and its exit code', async () => {
  const program = join(folder, 'fails.bat');
  await writeFile(program, '@echo off\r\nping -n 2 127.0.0.1 >nul\r\nexit /b 3\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Failing Tool');
  const { window } = session;

  await window.getByRole('button', { name: 'Launch' }).click();
  await expect(window.getByTestId('status')).toHaveText('1 task running');

  await expect(window.getByTestId('last-result')).toHaveText('Exit code 3', { timeout: 15_000 });
  await expect(window.getByTestId('run-failure')).toHaveText('The tool exited with code 3.');
  await expect(window.getByTestId('tool-details').locator('[data-state]')).toHaveText('Failed');
  await expect(window.getByTestId('status')).toHaveText('Ready');
});

test('Stop ends a running tool', async () => {
  const { program, pidFile } = await hangingScript();
  const session = await launchShell();
  await addTool(session, program, 'Hanging Tool');
  const { window } = session;

  await window.getByRole('button', { name: 'Launch' }).click();
  const pid = await readPid(pidFile);
  await window.getByRole('button', { name: 'Stop' }).click();

  await expect(window.getByTestId('tool-details').locator('[data-state]')).toHaveText('Cancelled');
  await expect.poll(() => isAlive(pid)).toBe(false);
});

test('a missing interpreter is explained, and blocks launching until it is fixed', async () => {
  const program = join(folder, 'tool.mjs');
  await writeFile(program, '');
  const session = await launchShell();
  await addTool(session, program, 'Script');
  const { window } = session;

  await window.getByRole('button', { name: 'Edit details' }).click();
  await window.getByLabel('Interpreter').fill('no-such-runtime');
  await window.getByRole('button', { name: 'Save' }).click();

  await expect(window.getByTestId('runtime-warning')).toContainText(
    'no-such-runtime is not installed',
  );
  await expect(window.getByRole('button', { name: 'Launch' })).toBeDisabled();
});

test('importing a folder asks for review, and runs nothing', async () => {
  const marker = join(folder, 'ran.txt');
  const source = join(folder, 'scripts');
  await mkdir(source);
  await writeFile(join(source, 'keep_me.bat'), `@echo x > "${marker}"\r\n`);
  await writeFile(join(source, 'leave_out.bat'), `@echo x > "${marker}"\r\n`);
  await writeFile(join(source, 'notes.txt'), '');
  const session = await launchShell();
  await stubPicker(session.app, [source]);
  const { window } = session;

  await window.getByRole('button', { name: 'Import from folder' }).click();
  const review = window.getByTestId('import-review');
  await expect(review).toContainText('2 programs found. Nothing has been run.');
  await review.getByRole('checkbox', { name: 'Import Leave Out' }).uncheck();
  await review.getByRole('button', { name: 'Import 1 tool' }).click();

  await expect(window.getByRole('heading', { name: 'Keep Me', level: 1 })).toBeVisible();
  await categoryButton(window, 'Scripts').click();
  await expect(window.getByRole('complementary').getByText('Keep Me')).toBeVisible();
  await expect(window.getByRole('complementary').getByText('Leave Out')).toHaveCount(0);
  expect(existsSync(marker)).toBe(false);
});

test('the side panel starts closed, and a category opens and closes it', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Alpha Tool', 'Alpha');
  await addTool(session, program, 'Beta Tool', 'Beta');
  const { window } = session;
  const panel = window.getByRole('complementary');
  const alpha = categoryButton(window, 'Alpha');
  const shown = window.getByRole('heading', { name: 'Beta Tool', level: 1 });

  await expect(panel).toHaveCount(0);
  const closedWidth = await workAreaWidth(window);

  await alpha.click();
  await expect(alpha).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('button', { name: 'Alpha Tool' })).toBeVisible();
  expect(await workAreaWidth(window)).toBeLessThan(closedWidth);
  await expect(shown).toBeVisible();

  await categoryButton(window, 'Beta').click();
  await expect(alpha).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('button', { name: 'Beta Tool' })).toBeVisible();

  await categoryButton(window, 'Beta').click();
  await expect(panel).toHaveCount(0);
  expect(await workAreaWidth(window)).toBe(closedWidth);
  await expect(shown).toBeVisible();

  await alpha.click();
  await panel.getByRole('button', { name: 'Alpha Tool' }).click();
  await expect(window.getByRole('heading', { name: 'Alpha Tool', level: 1 })).toBeVisible();
  await expect(panel).toBeVisible();
});

test('Settings opens over the work, leaving the panel and the tool as they were', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Alpha Tool', 'Alpha');
  const { window } = session;
  const tool = window.getByRole('heading', { name: 'Alpha Tool', level: 1 });

  await categoryButton(window, 'Alpha').click();
  await categoryButton(window, 'Settings').click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(categoryButton(window, 'Settings')).not.toHaveAttribute('aria-current', 'true');

  await window.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(window.getByRole('complementary')).toBeVisible();
  await expect(tool).toBeVisible();
});

test('a category shows its initial until it is given a logo, which is remembered', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const onePixelPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const logo = join(folder, 'logo.png');
  await writeFile(logo, Buffer.from(onePixelPng, 'base64'));
  const broken = join(folder, 'broken.png');
  await writeFile(broken, 'not an image');

  const first = await launchShell();
  await addTool(first, program, 'Alpha Tool', 'alpha');
  const image = (window: Page): Locator => categoryButton(window, 'alpha').locator('img');

  await expect(categoryButton(first.window, 'alpha')).toContainText('A');
  await expect(image(first.window)).toHaveCount(0);

  await stubPicker(first.app, [broken]);
  await stubMenuChoice(first.app, 'Change logo…');
  await categoryButton(first.window, 'alpha').click({ button: 'right' });
  await expect(first.window.getByRole('alert')).toContainText('damaged');
  await expect(image(first.window)).toHaveCount(0);

  await stubPicker(first.app, [logo]);
  await categoryButton(first.window, 'alpha').click({ button: 'right' });
  await expect(image(first.window)).toBeVisible();
  await expect
    .poll(() =>
      image(first.window).evaluate((element) => Reflect.get(element, 'naturalWidth') as number),
    )
    .toBe(1);
  await first.app.close();

  const second = await launchShell();
  await expect(image(second.window)).toBeVisible();

  await stubMenuChoice(second.app, 'Remove logo');
  await categoryButton(second.window, 'alpha').click({ button: 'right' });
  await expect(image(second.window)).toHaveCount(0);
  await expect(categoryButton(second.window, 'alpha')).toContainText('A');
});

test('a tool already added starts excluded on import', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Tool');
  await stubPicker(session.app, [folder]);
  const { window } = session;

  await window.getByRole('menuitem', { name: 'File' }).click();
  await window.getByRole('menuitem', { name: 'Import from folder…' }).click();

  const review = window.getByTestId('import-review');
  await expect(review).toContainText('Already added');
  await expect(review.getByRole('checkbox')).not.toBeChecked();
  await expect(review.getByRole('button', { name: /^Import/ })).toBeDisabled();
});

test('the palette finds and launches a tool from the keyboard', async () => {
  const { program, pidFile } = await hangingScript();
  const session = await launchShell();
  await addTool(session, program, 'Hanging Tool');
  const { window } = session;

  await window.keyboard.press('Control+k');
  await expect(window.getByRole('combobox')).toBeFocused();
  await window.keyboard.type('hang');
  await expect(window.getByRole('option')).toHaveCount(1);
  await window.keyboard.press('Enter');

  await expect(window.getByTestId('status')).toHaveText('1 task running');
  await readPid(pidFile);
  await window.getByRole('button', { name: 'Stop' }).click();
  await expect(window.getByTestId('status')).toHaveText('Ready');
});

test('the main menus work from the keyboard', async () => {
  const { window } = await launchShell();
  await expect(window.getByTestId('welcome')).toBeVisible();

  await window.keyboard.press('Alt');
  await expect(window.getByRole('menuitem', { name: 'File' })).toBeFocused();
  await window.keyboard.press('ArrowLeft');
  await expect(window.getByRole('menuitem', { name: 'Help' })).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(window.getByRole('menuitem', { name: 'About Bildora' })).toBeFocused();
  await window.keyboard.press('Enter');

  await expect(window.getByRole('dialog', { name: 'About Bildora' })).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByRole('dialog')).toHaveCount(0);
});

test('the theme changes, and is remembered', async () => {
  const first = await launchShell();
  await first.window.getByRole('button', { name: 'Settings' }).click();
  await first.window.getByRole('radio', { name: 'Dark' }).check();
  const isDark = (app: ElectronApplication): Promise<boolean> =>
    app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expect.poll(() => isDark(first.app)).toBe(true);
  await first.window.getByRole('radio', { name: 'Light' }).check();
  await expect.poll(() => isDark(first.app)).toBe(false);
  await first.app.close();

  const stored = await readFile(join(dataDir, 'workspaces', 'default', 'workspace.yaml'), 'utf8');
  expect(stored).toContain('theme: light');
  const second = await launchShell();
  expect(await isDark(second.app)).toBe(false);
});

test('a damaged tool is reported, and an empty list still offers a way in', async () => {
  const broken = join(dataDir, 'tools', 'broken-tool');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'tool.yaml'), 'not: [valid');

  const { window } = await launchShell();

  await expect(window.getByTestId('welcome')).toBeVisible();
  await window.getByRole('button', { name: /Problems/ }).click();
  const problems = window.getByRole('dialog', { name: 'Tools that cannot be read' });
  await expect(problems).toContainText('broken-tool');
  await problems.getByRole('button', { name: 'Close' }).click();
  await expect(window.getByTestId('welcome')).toBeVisible();
});

test('a program that moves is explained, and found again when it returns', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Tool');
  const { window } = session;

  await rm(program);
  await window.evaluate("window.dispatchEvent(new Event('focus'))");

  await expect(window.getByTestId('runtime-warning')).toContainText(
    'The program is no longer there',
  );
  await expect(window.getByRole('button', { name: 'Launch' })).toBeDisabled();

  await writeFile(program, '@echo off\r\n');
  await window.getByRole('button', { name: 'Check again' }).click();

  await expect(window.getByTestId('runtime-warning')).toHaveCount(0);
  await expect(window.getByRole('button', { name: 'Launch' })).toBeEnabled();
});

test('a program shows the icon Windows gives its file, and a plain one when it is missing', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Tool', 'Icons');
  const { window } = session;

  const png = /^data:image\/png;base64,/;
  await expect(window.locator('.tool-header img.program-icon')).toHaveAttribute('src', png);
  await categoryButton(window, 'Icons').click();
  const row = window.getByRole('complementary').getByRole('button', { name: 'Tool' });
  await expect(row.locator('img.program-icon')).toHaveAttribute('src', png);

  await rm(program);
  await session.app.close();
  const relaunched = await launchShell();
  await expect(relaunched.window.getByTestId('runtime-warning')).toBeVisible();
  await expect(relaunched.window.locator('.tool-header > svg.icon')).toBeVisible();
  await expect(relaunched.window.locator('.tool-header > img')).toHaveCount(0);
});

test('removing a tool forgets it and leaves the program alone', async () => {
  const program = join(folder, 'tool.bat');
  await writeFile(program, '@echo off\r\n');
  const session = await launchShell();
  await addTool(session, program, 'Tool');
  const { window } = session;

  await window.getByRole('button', { name: 'Remove' }).click();
  const confirm = window.getByRole('dialog', { name: 'Remove Tool?' });
  await expect(confirm).toContainText('nothing is deleted from your files');
  await confirm.getByRole('button', { name: 'Remove tool' }).click();

  await expect(window.getByTestId('welcome')).toBeVisible();
  expect(existsSync(program)).toBe(true);
  expect(existsSync(join(dataDir, 'workspaces', 'default', 'tools', 'tool'))).toBe(false);
});

test('a second instance leaves and keeps the first one open', async () => {
  const { app, window } = await launchShell();
  await expect(window.getByTestId('welcome')).toBeVisible();
  const electronPath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;

  await promisify(execFile)(electronPath, ['.'], {
    cwd: resolve('apps/desktop'),
    env: electronEnvironment({ BILDORA_DATA_DIR: dataDir }),
    timeout: 15_000,
  });

  await expect(window.getByTestId('welcome')).toBeVisible();
  expect(app.windows()).toHaveLength(1);
});

test.describe('closing with a tool running', () => {
  async function runningTool(): Promise<Session & { pid: number }> {
    const { program, pidFile } = await hangingScript();
    const session = await launchShell();
    await addTool(session, program, 'Hanging Tool');
    await session.window.getByRole('button', { name: 'Launch' }).click();
    return { ...session, pid: await readPid(pidFile) };
  }

  test('Cancel keeps the app open', async () => {
    const { app, window, pid } = await runningTool();
    await stubCloseAnswer(app, 2);

    await window.getByRole('menuitem', { name: 'File' }).click();
    await window.getByRole('menuitem', { name: 'Exit' }).click();

    await expect(window.getByTestId('status')).toHaveText('1 task running');
    expect(isAlive(pid)).toBe(true);
  });

  test('End all stops the tool and closes', async () => {
    const { app, window, pid } = await runningTool();
    await stubCloseAnswer(app, 1);
    const closed = new Promise((done) => app.process().once('exit', done));

    await window.getByRole('menuitem', { name: 'File' }).click();
    // The click closes the app, which can happen before Playwright hears the click has ended.
    await window
      .getByRole('menuitem', { name: 'Exit' })
      .click()
      .catch(() => undefined);

    await closed;
    await expect.poll(() => isAlive(pid)).toBe(false);
  });

  test('Leave open closes the app and the tool stays', async () => {
    const { app, window, pid } = await runningTool();
    await stubCloseAnswer(app, 0);
    const closed = new Promise((done) => app.process().once('exit', done));

    await window.getByRole('menuitem', { name: 'File' }).click();
    // The click closes the app, which can happen before Playwright hears the click has ended.
    await window
      .getByRole('menuitem', { name: 'Exit' })
      .click()
      .catch(() => undefined);

    await closed;
    await new Promise((done) => setTimeout(done, 500));
    expect(isAlive(pid)).toBe(true);
  });
});

test('the PTY runner works inside Electron', async () => {
  const resultFile = join(folder, 'pty.json');
  const electronPath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;

  await promisify(execFile)(
    electronPath,
    [resolve('e2e/fixtures/pty-in-electron.mjs'), resultFile],
    { env: electronEnvironment(), timeout: 30_000 },
  );

  const report = JSON.parse(await readFile(resultFile, 'utf8')) as {
    result: unknown;
    output: string;
    electron?: string;
  };
  expect(report.electron).toBeDefined();
  expect(report.result).toMatchObject({ status: 'completed', exitCode: 0 });
  expect(report.output).toContain('ARGS ["one"]');
});
