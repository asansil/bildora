import { BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { readPreferences, writePreferences } from '@bildora/core';
import type { ZodType, z } from 'zod';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import {
  detectPathsSchema,
  editCommandSchema,
  noInputSchema,
  pickFolderSchema,
  preferencesSchema,
  registerToolsSchema,
  runIdSchema,
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
  readonly version: string;
  readonly quit: () => void;
}

type Handler<Schema extends ZodType> = (
  input: z.output<Schema>,
  event: IpcMainInvokeEvent,
) => unknown;

/** Registers every channel. Each call checks who is asking, then what is being asked. */
export function registerIpc(context: IpcContext): void {
  const { dataDir, rendererUrl, tools, runs } = context;

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

  handle(CHANNELS.shellInfo, noInputSchema, () => ({ version: context.version }));
  handle(CHANNELS.shellQuit, noInputSchema, () => {
    context.quit();
  });
  handle(CHANNELS.shellEdit, editCommandSchema, (command, event) => {
    event.sender[command]();
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
            extensions: ['exe', 'com', 'bat', 'cmd', 'py', 'pyw', 'js', 'mjs', 'ps1'],
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
  handle(CHANNELS.toolsUpdate, updateToolSchema, ({ id, details }) => tools.update(id, details));
  handle(CHANNELS.toolsRemove, toolIdSchema, async ({ id }) => {
    if (runs.isRunning(id)) {
      throw new Error(`Tool "${id}" is running`);
    }
    await tools.remove(id);
    runs.forget(id);
  });

  handle(CHANNELS.runsStart, toolIdSchema, async ({ id }) => {
    const tool = await tools.get(id);
    if (tool.manifest.level !== 0) {
      throw new Error(`Tool "${id}" needs a later version of Bildora`);
    }
    return runs.start(tool);
  });
  handle(CHANNELS.runsCancel, runIdSchema, ({ runId }) => {
    runs.cancel(runId);
  });
  handle(CHANNELS.runsList, noInputSchema, () => runs.list());

  handle(CHANNELS.preferencesGet, noInputSchema, () => readPreferences(dataDir));
  handle(CHANNELS.preferencesSet, preferencesSchema, async (preferences) => {
    await writePreferences(dataDir, preferences);
    nativeTheme.themeSource = preferences.theme;
  });
}
