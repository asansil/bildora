import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron';
import type { RegisteredTool, ToolRun } from '@bildora/core';
import {
  DEFAULT_PREFERENCES,
  RunHistory,
  ToolRegistry,
  createCredentialStore,
  defaultLauncherPath,
  getProfile,
  readPreferences,
  resolveDataDir,
  startRecordedRun,
} from '@bildora/core';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import { registerIpc } from './ipc.js';
import { RunService } from './run-service.js';
import type { RunContext } from './run-service.js';
import { ToolService } from './tool-service.js';
import { shellWebPreferences, titleBarOverlay } from './web-preferences.js';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(moduleDirectory, '../renderer/index.html');
const developmentUrl = process.env['ELECTRON_RENDERER_URL'];

const dataDir = resolveDataDir();
// A packaged app named Bildora would otherwise mix Chromium's files into the data directory.
app.setPath('userData', join(dataDir, 'chromium'));

let shellWindow: BrowserWindow | undefined;

function askAboutRunningTools(window: BrowserWindow, count: number, consoles: number) {
  return dialog.showMessageBox(window, {
    type: 'question',
    title: t('close.title'),
    message: t('close.message', { count }),
    detail: consoles === 0 ? t('close.detail') : t('close.detailConsoles'),
    buttons: [t('close.leaveOpen'), t('close.endAll'), t('close.cancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
}

function createShellWindow(runs: RunService): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: t('app.name'),
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
    if (closeDecided || runs.activeCount === 0) {
      return;
    }
    event.preventDefault();
    const consoles = runs.consoleCount;
    void askAboutRunningTools(window, runs.activeCount, consoles).then(async ({ response }) => {
      if (response === 2) {
        return;
      }
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

/** Inside a packaged app the launcher is unpacked, because Windows cannot run a file in an ASAR. */
function launcherOptions(): { launcherPath?: string } {
  if (!app.isPackaged) {
    return {};
  }
  const packed = `${sep}app.asar${sep}`;
  return { launcherPath: defaultLauncherPath().replace(packed, `${sep}app.asar.unpacked${sep}`) };
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

  const preferences = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
  nativeTheme.themeSource = preferences.theme;

  const { history, problem: historyProblem } = await openHistory();
  history.recoverInterrupted();
  const secrets = createCredentialStore(dataDir);

  async function startTool(tool: RegisteredTool, context: RunContext): Promise<ToolRun> {
    const { runId, request, onOutput, onProgress } = context;
    const { profileId, values, columns, rows } = request;
    const { historyRunLimit } = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
    const profile = profileId === undefined ? undefined : await getProfile(tool, profileId);
    if (profileId !== undefined && profile === undefined) {
      throw new Error('The chosen profile no longer exists');
    }
    return startRecordedRun(tool, {
      history,
      store: secrets,
      historyRunLimit,
      runId,
      profile,
      values,
      onOutput,
      onProgress,
      ...(columns === undefined ? {} : { columns }),
      ...(rows === undefined ? {} : { rows }),
      ...launcherOptions(),
    });
  }

  const runs = new RunService(
    startTool,
    () => {
      shellWindow?.webContents.send(CHANNELS.runsChanged, runs.list());
    },
    (output) => {
      shellWindow?.webContents.send(CHANNELS.runsOutput, output);
    },
  );
  registerIpc({
    dataDir,
    rendererUrl: developmentUrl ?? pathToFileURL(rendererFile).href,
    tools: new ToolService(await ToolRegistry.open({ dataDir }), dataDir, secrets),
    runs,
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

  shellWindow = createShellWindow(runs);
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
