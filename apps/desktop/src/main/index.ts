import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron';
import {
  DEFAULT_PREFERENCES,
  ToolRegistry,
  readPreferences,
  resolveDataDir,
  startWindowRun,
} from '@bildora/core';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import { registerIpc } from './ipc.js';
import { RunService } from './run-service.js';
import { ToolService } from './tool-service.js';
import { shellWebPreferences, titleBarOverlay } from './web-preferences.js';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(moduleDirectory, '../renderer/index.html');
const developmentUrl = process.env['ELECTRON_RENDERER_URL'];

const dataDir = resolveDataDir();
// A packaged app named Bildora would otherwise mix Chromium's files into the data directory.
app.setPath('userData', join(dataDir, 'chromium'));

let shellWindow: BrowserWindow | undefined;

function askAboutRunningTools(window: BrowserWindow, count: number) {
  return dialog.showMessageBox(window, {
    type: 'question',
    title: t('close.title'),
    message: t('close.message', { count }),
    detail: t('close.detail'),
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
    void askAboutRunningTools(window, runs.activeCount).then(async ({ response }) => {
      if (response === 2) {
        return;
      }
      if (response === 1) {
        await runs.cancelAll();
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

async function start(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const preferences = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
  nativeTheme.themeSource = preferences.theme;

  const runs = new RunService(
    (tool) => startWindowRun(tool),
    () => {
      shellWindow?.webContents.send(CHANNELS.runsChanged, runs.list());
    },
  );
  registerIpc({
    dataDir,
    rendererUrl: developmentUrl ?? pathToFileURL(rendererFile).href,
    tools: new ToolService(await ToolRegistry.open({ dataDir }), dataDir),
    runs,
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
