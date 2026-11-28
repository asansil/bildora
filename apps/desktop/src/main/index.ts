import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron';
import type { RegisteredTool, ToolRun } from '@bildora/core';
import appIcon from '../../resources/icon.png?asset';
import {
  RunHistory,
  ToolRegistry,
  WindowsScheduler,
  createCredentialStore,
  listAutomations,
  listWorkspaces,
  resolveDataDir,
  startToolRun,
  taskRootFor,
} from '@bildora/core';
import type { AutomationAt } from '@bildora/core';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import { AutomationService } from './automation-service.js';
import { registerIpc } from './ipc.js';
import { RunService } from './run-service.js';
import {
  SCHEDULED_RUN_ARGUMENT,
  ScheduleService,
  dataDirArgument,
  scheduledCommand,
} from './schedule-service.js';
import type { RunContext } from './run-service.js';
import { ToolService } from './tool-service.js';
import { shellWebPreferences, titleBarOverlay } from './web-preferences.js';
import { WorkspaceService } from './workspace-service.js';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(moduleDirectory, '../renderer/index.html');
const developmentUrl = process.env['ELECTRON_RENDERER_URL'];

// A scheduled task names a data directory that is not the usual one, and the command it runs finds
// the directory as the app does.
const givenDataDir = dataDirArgument(process.argv);
if (givenDataDir !== undefined) process.env['BILDORA_DATA_DIR'] = givenDataDir;
const dataDir = resolveDataDir();
/** Whether this is the usual data directory, whose tasks need not name it. */
const usualDataDir = taskRootFor(dataDir) === '\\Bildora\\';
// A packaged app named Bildora would otherwise mix Chromium's files into the data directory.
app.setPath('userData', join(dataDir, 'chromium'));

let shellWindow: BrowserWindow | undefined;

/**
 * Updates the shell, if it is still there. A timer can fire after the window has gone and before
 * the process ends, and an error at that moment shows a dialog that stops the app from closing.
 */
function sendToShell(channel: string, payload: unknown): void {
  if (shellWindow?.isDestroyed() === false) {
    shellWindow.webContents.send(channel, payload);
  }
}

function closeDetail(consoles: number, automations: number): string {
  if (automations > 0) {
    return t('close.detailAutomations');
  }
  return consoles === 0 ? t('close.detail') : t('close.detailConsoles');
}

function askAboutRunningTools(
  window: BrowserWindow,
  count: number,
  consoles: number,
  automations: number,
) {
  return dialog.showMessageBox(window, {
    type: 'question',
    title: t('close.title'),
    message: t('close.message', { count }),
    detail: closeDetail(consoles, automations),
    buttons: [t('close.leaveOpen'), t('close.endAll'), t('close.cancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
}

function createShellWindow(runs: RunService, automations: AutomationService): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: t('app.name'),
    icon: appIcon,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(nativeTheme.shouldUseDarkColors),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191b' : '#e9edef',
    webPreferences: shellWebPreferences(join(moduleDirectory, '../preload/index.cjs')),
  });

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let closeDecided = false;
  window.on('close', (event) => {
    const working = automations.activeCount;
    if (closeDecided || (runs.activeCount === 0 && working === 0)) {
      return;
    }
    event.preventDefault();
    const consoles = runs.consoleCount;
    // An automation waiting between steps has no tool running, but it still counts as work.
    const count = runs.activeCount === 0 ? working : runs.activeCount;
    void askAboutRunningTools(window, count, consoles, working).then(async ({ response }) => {
      if (response === 2) {
        return;
      }
      // An automation cannot outlive the app, because it is this process that runs its steps.
      await automations.cancelAll();
      if (response === 1) {
        await runs.cancelAll();
      } else {
        // A console belongs to this process, so its tool ends here whatever the answer. Waiting
        // lets the run reach history as cancelled, rather than interrupted.
        await runs.cancelConsoleRuns();
      }
      closeDecided = true;
      window.close();
    });
  });

  if (developmentUrl === undefined) {
    void window.loadFile(rendererFile);
  } else {
    void window.loadURL(developmentUrl);
  }
  return window;
}

/**
 * Opens run history. A file that cannot be opened must not stop the app, so runs are then kept in
 * memory for this session, and the shell says so.
 */
async function openHistory(): Promise<{ history: RunHistory; problem?: string }> {
  try {
    return { history: await RunHistory.open(dataDir) };
  } catch (error) {
    return {
      history: await RunHistory.open(dataDir, { inMemory: true }),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Keeps scheduled tasks in step with every automation of every Workspace, as Bildora starts. A
 * Workspace or file that cannot be read keeps its tasks, since its automations may only be damaged.
 */
async function reviewSchedules(schedules: ScheduleService): Promise<void> {
  const { workspaces, problems } = await listWorkspaces(dataDir);
  const targets: AutomationAt[] = [];
  let complete = problems.length === 0;
  for (const workspace of workspaces) {
    const list = await listAutomations(dataDir, workspace.id);
    complete &&= list.problems.length === 0;
    targets.push(
      ...list.automations.map((automation) => ({ workspaceId: workspace.id, automation })),
    );
  }
  await schedules.review(targets, complete);
}

async function start(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const { history, problem: historyProblem } = await openHistory();
  history.recoverInterrupted();
  const secrets = createCredentialStore(dataDir);
  const registry = await ToolRegistry.open({ dataDir });
  const workspaces = await WorkspaceService.open(registry, secrets, history);
  nativeTheme.themeSource = workspaces.current.theme;

  function startTool(tool: RegisteredTool, context: RunContext): Promise<ToolRun> {
    const { runId, workspaceId, request, onOutput, onProgress } = context;
    return startToolRun(
      tool,
      { ...request, runId, workspaceId, onOutput, onProgress },
      { dataDir, history, store: secrets },
    );
  }

  const runs = new RunService(
    startTool,
    () => {
      sendToShell(CHANNELS.runsChanged, runs.list());
    },
    (output) => {
      sendToShell(CHANNELS.runsOutput, output);
    },
  );
  // Only Windows has a scheduler Bildora can drive so far.
  const schedules =
    process.platform === 'win32'
      ? new ScheduleService(
          dataDir,
          new WindowsScheduler({ root: taskRootFor(dataDir) }),
          (location) =>
            scheduledCommand(
              process.execPath,
              app.isPackaged ? undefined : app.getAppPath(),
              location,
              usualDataDir ? undefined : dataDir,
            ),
        )
      : undefined;
  const automations = new AutomationService({
    dataDir,
    ...(schedules === undefined ? {} : { schedules }),
    registry,
    history,
    workspaceId: () => workspaces.activeId,
    startStep: (tool, workspaceId, request) => runs.startStep(tool, workspaceId, request),
    onChange: (views) => {
      sendToShell(CHANNELS.automationsChanged, views);
    },
  });
  registerIpc({
    dataDir,
    rendererUrl: developmentUrl ?? pathToFileURL(rendererFile).href,
    tools: new ToolService(registry, dataDir, secrets, () => workspaces.activeId),
    workspaces,
    runs,
    automations,
    history,
    historyProblem,
    version: app.getVersion(),
    quit: () => {
      shellWindow?.close();
    },
  });

  nativeTheme.on('updated', () => {
    shellWindow?.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
  });

  shellWindow = createShellWindow(runs, automations);
  // Nothing waits for this: a task out of step shows in its Start block when someone opens it.
  if (schedules !== undefined) void reviewSchedules(schedules).catch(() => undefined);
}

/** What the command module gives: the bildora command, run in this process. */
interface CommandModule {
  readonly main: (args: readonly string[], trigger: 'cli' | 'schedule') => Promise<number>;
}

function isCommandModule(value: unknown): value is CommandModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'main' in value &&
    typeof value.main === 'function'
  );
}

/**
 * Runs one automation for a scheduled task, with no window, and quits with the command's exit code,
 * which Task Scheduler shows as the task's last result.
 */
async function runScheduled(args: readonly string[]): Promise<void> {
  const exitCodeCannotStart = 5;
  try {
    const entry = createRequire(import.meta.url).resolve('@bildora/cli/dist/main.js');
    const command: unknown = await import(pathToFileURL(entry).href);
    app.exit(isCommandModule(command) ? await command.main(args, 'schedule') : exitCodeCannotStart);
  } catch {
    app.exit(exitCodeCannotStart);
  }
}

const scheduledAt = process.argv.indexOf(SCHEDULED_RUN_ARGUMENT);
if (scheduledAt !== -1) {
  // Before the single-instance lock: a scheduled run must not hand over to an open app.
  void runScheduled(process.argv.slice(scheduledAt + 1));
} else if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (shellWindow?.isMinimized() === true) {
      shellWindow.restore();
    }
    shellWindow?.focus();
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
  void start();
} else {
  app.quit();
}
