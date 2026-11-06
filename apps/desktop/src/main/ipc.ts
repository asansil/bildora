import { BrowserWindow, Menu, dialog, ipcMain, nativeTheme } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, OpenDialogOptions } from 'electron';
import { LOGO_EXTENSIONS, readPreferences, writePreferences } from '@bildora/core';
import type { RunHistory } from '@bildora/core';
import type { ZodType, z } from 'zod';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import {
  categoryMenuSchema,
  detectPathsSchema,
  editCommandSchema,
  historyListSchema,
  importManifestsSchema,
  noInputSchema,
  pickFolderSchema,
  preferencesSchema,
  registerToolsSchema,
  removeProfileSchema,
  runIdSchema,
  runInputSchema,
  runResizeSchema,
  saveProfileSchema,
  startRunSchema,
  toolIdSchema,
  updateToolSchema,
} from '../shared/ipc-contract.js';
import type { RunService } from './run-service.js';
import type { ToolService } from './tool-service.js';
import { isTrustedSender } from './trusted-sender.js';

export interface IpcContext {
  readonly dataDir: string;
  readonly rendererUrl: string;
  readonly tools: ToolService;
  readonly runs: RunService;
  readonly history: RunHistory;
  readonly historyProblem: string | undefined;
  readonly version: string;
  readonly quit: () => void;
}

type Handler<Schema extends ZodType> = (
  input: z.output<Schema>,
  event: IpcMainInvokeEvent,
) => unknown;

type LogoAction = 'change' | 'remove';

/** Tools listed in the Recent section. */
const RECENT_TOOLS_LIMIT = 5;

/** How long a closing menu waits for a click, which can arrive just after it closes. */
const MENU_CLICK_GRACE_MS = 100;

/** Shows the native menu of a category, and resolves with what the user picked, if anything. */
function askLogoAction(window: BrowserWindow, hasLogo: boolean): Promise<LogoAction | undefined> {
  return new Promise((resolve) => {
    const item = (label: string, action: LogoAction): MenuItemConstructorOptions => ({
      label,
      click: () => {
        resolve(action);
      },
    });
    const items = [item(t('category.changeLogo'), 'change')];
    if (hasLogo) {
      items.push(item(t('category.removeLogo'), 'remove'));
    }
    Menu.buildFromTemplate(items).popup({
      window,
      callback: () => {
        setTimeout(resolve, MENU_CLICK_GRACE_MS, undefined);
      },
    });
  });
}

/** Registers every channel. Each call checks who is asking, then what is being asked. */
export function registerIpc(context: IpcContext): void {
  const { dataDir, rendererUrl, tools, runs, history, historyProblem } = context;

  function handle<Schema extends ZodType>(
    channel: string,
    schema: Schema,
    handler: Handler<Schema>,
  ): void {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isTrustedSender(event.senderFrame?.url, rendererUrl)) {
        throw new Error('This page may not use the Bildora API');
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        // The message stays generic: a value in it could be anything, even a secret.
        throw new Error(`Invalid request on ${channel}`);
      }
      return handler(parsed.data, event);
    });
  }

  function dialogWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error('The request has no window');
    }
    return window;
  }

  async function pick(
    event: IpcMainInvokeEvent,
    options: OpenDialogOptions,
    recursive: boolean,
  ): Promise<unknown> {
    const { canceled, filePaths } = await dialog.showOpenDialog(dialogWindow(event), options);
    return canceled || filePaths.length === 0 ? undefined : tools.detect(filePaths, recursive);
  }

  handle(CHANNELS.shellInfo, noInputSchema, () => ({
    version: context.version,
    ...(historyProblem === undefined ? {} : { historyProblem }),
  }));
  handle(CHANNELS.shellQuit, noInputSchema, () => {
    context.quit();
  });
  handle(CHANNELS.shellEdit, editCommandSchema, (command, event) => {
    event.sender[command]();
  });

  handle(CHANNELS.shellPickPath, noInputSchema, async (_input, event) => {
    const { filePaths } = await dialog.showOpenDialog(dialogWindow(event), {
      title: t('dialog.pickPath'),
      properties: ['openFile'],
    });
    return filePaths[0];
  });

  handle(CHANNELS.toolsList, noInputSchema, () => tools.catalog());
  handle(CHANNELS.toolsPickFiles, noInputSchema, (_input, event) =>
    pick(
      event,
      {
        title: t('dialog.pickFiles'),
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: t('dialog.programs'),
            extensions: ['exe', 'com', 'bat', 'cmd', 'py', 'pyw', 'js', 'mjs', 'ps1', 'yaml'],
          },
        ],
      },
      false,
    ),
  );
  handle(CHANNELS.toolsPickFolder, pickFolderSchema, ({ recursive }, event) =>
    pick(event, { title: t('dialog.pickFolder'), properties: ['openDirectory'] }, recursive),
  );
  handle(CHANNELS.toolsDetectPaths, detectPathsSchema, ({ paths }) => tools.detect(paths));
  handle(CHANNELS.toolsRegister, registerToolsSchema, (input) => tools.register(input));
  handle(CHANNELS.toolsImportManifests, importManifestsSchema, ({ paths }) =>
    tools.importManifests(paths),
  );
  handle(CHANNELS.toolsUpdate, updateToolSchema, ({ id, details }) => tools.update(id, details));
  handle(CHANNELS.toolsRemove, toolIdSchema, async ({ id }) => {
    if (runs.isRunning(id)) {
      throw new Error(`Tool "${id}" is running`);
    }
    await tools.remove(id);
    runs.forget(id);
  });

  handle(CHANNELS.categoriesOpenMenu, categoryMenuSchema, async ({ category }, event) => {
    const window = dialogWindow(event);
    const action = await askLogoAction(window, await tools.hasLogo(category));
    if (action === 'remove') {
      await tools.removeLogo(category);
      return true;
    }
    if (action === undefined) {
      return false;
    }
    const { filePaths } = await dialog.showOpenDialog(window, {
      title: t('dialog.pickLogo'),
      properties: ['openFile'],
      filters: [{ name: t('dialog.images'), extensions: [...LOGO_EXTENSIONS] }],
    });
    const [source] = filePaths;
    if (source === undefined) {
      return false;
    }
    await tools.setLogo(category, source);
    return true;
  });

  handle(CHANNELS.runsStart, startRunSchema, async ({ id, ...request }) => {
    const tool = await tools.get(id);
    if (tool.manifest.level === 2) {
      throw new Error(`Tool "${id}" needs a later version of Bildora`);
    }
    if (tool.manifest.level === 1 && runs.isRunning(id)) {
      throw new Error(`Tool "${id}" is already running`);
    }
    return runs.start(tool, request);
  });
  handle(CHANNELS.runsCancel, runIdSchema, ({ runId }) => {
    runs.cancel(runId);
  });
  handle(CHANNELS.runsList, noInputSchema, () => runs.list());
  handle(CHANNELS.runsOutputRead, runIdSchema, ({ runId }) => runs.readOutput(runId));
  handle(CHANNELS.runsInput, runInputSchema, ({ runId, data }) => {
    runs.write(runId, data);
  });
  handle(CHANNELS.runsResize, runResizeSchema, ({ runId, columns, rows }) => {
    runs.resize(runId, columns, rows);
  });

  handle(CHANNELS.profilesList, toolIdSchema, ({ id }) => tools.profiles(id));
  handle(CHANNELS.profilesSave, saveProfileSchema, (input) => tools.saveProfile(input));
  handle(CHANNELS.profilesRemove, removeProfileSchema, ({ toolId, id }) =>
    tools.removeProfile(toolId, id),
  );

  handle(CHANNELS.historyList, historyListSchema, ({ toolId }) => history.list(toolId));
  handle(CHANNELS.historyGet, runIdSchema, ({ runId }) => history.get(runId));
  handle(CHANNELS.historyRecent, noInputSchema, () => history.recentToolIds(RECENT_TOOLS_LIMIT));
  handle(CHANNELS.historyClear, noInputSchema, () => {
    history.clear();
  });

  handle(CHANNELS.preferencesGet, noInputSchema, () => readPreferences(dataDir));
  handle(CHANNELS.preferencesSet, preferencesSchema, async ({ theme, historyRunLimit }) => {
    await writePreferences(dataDir, {
      ...(theme === undefined ? {} : { theme }),
      ...(historyRunLimit === undefined ? {} : { historyRunLimit }),
    });
    if (theme !== undefined) {
      nativeTheme.themeSource = theme;
    }
    if (historyRunLimit !== undefined) {
      history.pruneAll(historyRunLimit);
    }
  });
}
