import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, OpenDialogOptions } from 'electron';
import {
  LOGO_EXTENSIONS,
  readPathVariables,
  readPreferences,
  removePathVariable,
  removeRunFolders,
  setPathVariable,
  toolKey,
  writePreferences,
} from '@bildora/core';
import type { RunHistory } from '@bildora/core';
import type { ZodType, z } from 'zod';
import { CHANNELS } from '../shared/channels.js';
import { t } from '../shared/i18n/translate.js';
import {
  automationDraftSchema,
  automationIdSchema,
  automationStartSchema,
  automationConfirmSchema,
  automationRunIdSchema,
  categoryMenuSchema,
  createWorkspaceSchema,
  detectPathsSchema,
  editCommandSchema,
  historyListSchema,
  importManifestsSchema,
  noInputSchema,
  pathVariableNameSchema,
  pathVariableSchema,
  pickFolderSchema,
  preferencesSchema,
  registerToolsSchema,
  removeProfileSchema,
  renameWorkspaceSchema,
  runIdSchema,
  runInputSchema,
  runResizeSchema,
  saveProfileSchema,
  setToolScopeSchema,
  startRunSchema,
  toolIdSchema,
  updateToolSchema,
  updateWorkspaceSchema,
  workspaceIdSchema,
} from '../shared/ipc-contract.js';
import type { AutomationService } from './automation-service.js';
import type { RunService } from './run-service.js';
import type { ToolService } from './tool-service.js';
import { isTrustedSender } from './trusted-sender.js';
import type { WorkspaceService } from './workspace-service.js';

export interface IpcContext {
  readonly dataDir: string;
  readonly rendererUrl: string;
  readonly tools: ToolService;
  readonly workspaces: WorkspaceService;
  readonly runs: RunService;
  readonly automations: AutomationService;
  readonly history: RunHistory;
  readonly historyProblem: string | undefined;
  readonly version: string;
  readonly quit: () => void;
}

type Handler<Schema extends ZodType> = (
  input: z.output<Schema>,
  event: IpcMainInvokeEvent,
) => unknown;

type CategoryAction = 'up' | 'down' | 'change' | 'remove';

interface CategoryMenuState {
  readonly hasLogo: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

/** Tools listed in the Recent section. */
const RECENT_TOOLS_LIMIT = 5;

/** How long a closing menu waits for a click, which can arrive just after it closes. */
const MENU_CLICK_GRACE_MS = 100;

/** Shows the native menu of a category, and resolves with what the user picked, if anything. */
function askCategoryAction(
  window: BrowserWindow,
  { hasLogo, canMoveUp, canMoveDown }: CategoryMenuState,
): Promise<CategoryAction | undefined> {
  return new Promise((resolve) => {
    const item = (
      label: string,
      action: CategoryAction,
      enabled = true,
    ): MenuItemConstructorOptions => ({
      label,
      enabled,
      click: () => {
        resolve(action);
      },
    });
    const items: MenuItemConstructorOptions[] = [
      item(t('category.moveUp'), 'up', canMoveUp),
      item(t('category.moveDown'), 'down', canMoveDown),
      { type: 'separator' },
      item(t('category.changeLogo'), 'change'),
    ];
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
  const { dataDir, rendererUrl, tools, workspaces, runs, automations, history, historyProblem } =
    context;

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
  handle(CHANNELS.toolsImportManifests, importManifestsSchema, ({ paths, scope }) =>
    tools.importManifests(paths, scope),
  );
  handle(CHANNELS.toolsUpdate, updateToolSchema, ({ id, details }) => tools.update(id, details));
  handle(CHANNELS.toolsRemove, toolIdSchema, async ({ id }) => {
    const tool = await tools.get(id);
    const key = toolKey(tool);
    if (runs.isRunning(key)) {
      throw new Error(`Tool "${id}" is running`);
    }
    await tools.remove(tool);
    runs.forget(key);
  });
  // Keyed by path, so tools sharing a program, or a path variable changed, read it once each.
  const icons = new Map<string, Promise<string | undefined>>();
  handle(CHANNELS.toolsIcon, toolIdSchema, async ({ id }) => {
    const path = await tools.programPath(id).catch(() => undefined);
    if (path === undefined) {
      return undefined;
    }
    let icon = icons.get(path);
    if (icon === undefined) {
      icon = app
        .getFileIcon(path, { size: 'normal' })
        .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
        .catch(() => undefined);
      icons.set(path, icon);
    }
    return icon;
  });
  handle(CHANNELS.toolsSetScope, setToolScopeSchema, async ({ id, scope }) => {
    const tool = await tools.get(id);
    const key = toolKey(tool);
    if (runs.isRunning(key)) {
      throw new Error(`Tool "${id}" is running`);
    }
    await tools.setScope(tool, scope);
    runs.forget(key);
  });

  handle(CHANNELS.categoriesOpenMenu, categoryMenuSchema, async ({ category }, event) => {
    const window = dialogWindow(event);
    const [hasLogo, moveUp, moveDown] = await Promise.all([
      tools.hasLogo(category),
      tools.movedCategoryOrder(category, -1),
      tools.movedCategoryOrder(category, 1),
    ]);
    const action = await askCategoryAction(window, {
      hasLogo,
      canMoveUp: moveUp !== undefined,
      canMoveDown: moveDown !== undefined,
    });
    if (action === 'up' || action === 'down') {
      await workspaces.update({
        layout: { categoryOrder: action === 'up' ? moveUp : moveDown },
      });
      return true;
    }
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
    if (tool.manifest.level === 1 && runs.isRunning(toolKey(tool))) {
      throw new Error(`Tool "${id}" is already running`);
    }
    return runs.start(tool, workspaces.activeId, request);
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

  handle(CHANNELS.automationsList, noInputSchema, () => automations.list());
  handle(CHANNELS.automationsSave, automationDraftSchema, (draft) => automations.save(draft));
  handle(CHANNELS.automationsCheck, automationDraftSchema, (draft) => automations.check(draft));
  handle(CHANNELS.automationsRemove, automationIdSchema, ({ id }) => automations.remove(id));
  handle(CHANNELS.automationsStart, automationStartSchema, ({ id, inputs }) =>
    automations.start(id, inputs),
  );
  handle(CHANNELS.automationsCancel, automationRunIdSchema, ({ runId }) => {
    automations.cancel(runId);
  });
  handle(CHANNELS.automationsConfirm, automationConfirmSchema, ({ runId, stepId }) => {
    automations.confirm(runId, stepId);
  });
  handle(CHANNELS.automationsRuns, noInputSchema, () => automations.views());
  handle(CHANNELS.automationsHistory, automationIdSchema, ({ id }) =>
    history.listAutomationRuns(workspaces.activeId, id),
  );

  handle(CHANNELS.profilesList, toolIdSchema, ({ id }) => tools.profiles(id));
  handle(CHANNELS.profilesSave, saveProfileSchema, (input) => tools.saveProfile(input));
  handle(CHANNELS.profilesRemove, removeProfileSchema, ({ toolId, id }) =>
    tools.removeProfile(toolId, id),
  );

  handle(CHANNELS.historyList, historyListSchema, (filter) =>
    history.entries(workspaces.activeId, filter),
  );
  handle(CHANNELS.historyAutomationRun, runIdSchema, ({ runId }) => {
    const run = history.getAutomationRun(workspaces.activeId, runId);
    return run === undefined
      ? undefined
      : {
          run: { kind: 'automation' as const, ...run },
          toolRuns: history.stepRuns(workspaces.activeId, runId),
        };
  });
  handle(CHANNELS.historyGet, runIdSchema, ({ runId }) => history.get(workspaces.activeId, runId));
  handle(CHANNELS.historyRecent, noInputSchema, () =>
    history.recentToolIds(workspaces.activeId, RECENT_TOOLS_LIMIT),
  );
  handle(CHANNELS.historyClear, noInputSchema, () =>
    removeRunFolders(dataDir, history.clear(workspaces.activeId)),
  );

  handle(CHANNELS.preferencesGet, noInputSchema, async () => {
    const { historyRunLimit } = await readPreferences(dataDir);
    return { historyRunLimit };
  });
  handle(CHANNELS.preferencesSet, preferencesSchema, async ({ historyRunLimit }) => {
    if (historyRunLimit !== undefined) {
      await writePreferences(dataDir, { historyRunLimit });
      await removeRunFolders(dataDir, history.pruneAll(historyRunLimit));
    }
  });

  function followTheme(): void {
    nativeTheme.themeSource = workspaces.current.theme;
  }

  handle(CHANNELS.workspacesList, noInputSchema, () => workspaces.list());
  handle(CHANNELS.workspacesSwitch, workspaceIdSchema, async ({ id }) => {
    const list = await workspaces.switchTo(id);
    followTheme();
    return list;
  });
  handle(CHANNELS.workspacesCreate, createWorkspaceSchema, async ({ name }) => {
    const list = await workspaces.create(name);
    followTheme();
    return list;
  });
  handle(CHANNELS.workspacesRename, renameWorkspaceSchema, ({ id, name }) =>
    workspaces.rename(id, name),
  );
  handle(CHANNELS.workspacesRemove, workspaceIdSchema, async ({ id }) => {
    if (runs.isWorkspaceBusy(id) || automations.isWorkspaceBusy(id)) {
      throw new Error('This Workspace has tools running');
    }
    const list = await workspaces.remove(id);
    followTheme();
    return list;
  });
  handle(CHANNELS.workspacesUpdate, updateWorkspaceSchema, async (changes) => {
    const workspace = await workspaces.update(changes);
    followTheme();
    return workspace;
  });

  handle(CHANNELS.pathVariablesList, noInputSchema, async () =>
    [...(await readPathVariables(dataDir))]
      .map(([name, value]) => ({ name, value }))
      .sort((first, second) => first.name.localeCompare(second.name)),
  );
  handle(CHANNELS.pathVariablesSet, pathVariableSchema, ({ name, value }) =>
    setPathVariable(dataDir, name, value),
  );
  handle(CHANNELS.pathVariablesRemove, pathVariableNameSchema, ({ name }) =>
    removePathVariable(dataDir, name),
  );
}
