import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, session } from 'electron';
import { getCoreInfo } from '@bildora/core';
import { shellWebPreferences } from './web-preferences.js';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));

function createShellWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: getCoreInfo().productName,
    webPreferences: shellWebPreferences(join(moduleDirectory, '../preload/index.cjs')),
  });

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  void window.loadFile(join(moduleDirectory, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  createShellWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
