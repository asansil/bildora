import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron';
import type { RegisteredTool, ToolRun } from '@bildora/core';
import appIcon from '../../resources/icon.png?asset';
import {
  RunHistory,
  ToolRegistry,
  createCredentialStore,
  resolveDataDir,
  startToolRun,
} from '@bildora/core';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import { AutomationService } from './automation-service.js';
import { registerIpc } from './ipc.js';
import { RunService } from './run-service.js';
import type { RunContext } from './run-service.js';
import { ToolService } from './tool-service.js';
import { shellWebPreferences, titleBarOverlay } from './web-preferences.js';
import { WorkspaceService } from './workspace-service.js';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(moduleDirectory, '../renderer/index.html');
const developmentUrl = process.env['ELECTRON_RENDERER_URL'];

const dataDir = resolveDataDir();
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
  const automations = new AutomationService({
    dataDir,
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
}

if (app.requestSingleInstanceLock()) {
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
