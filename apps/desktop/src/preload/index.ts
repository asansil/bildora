import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CHANNELS } from '../shared/channels.js';
import type { RunOutputView, RunView } from '../shared/ipc-contract.js';
import type { ShellApi } from './api.js';

declare const process: { readonly platform: string };

/** Typed by `ShellApi`, which is where each channel's result is stated. */
async function invoke<Result>(channel: string, input?: unknown): Promise<Result> {
  return (await ipcRenderer.invoke(channel, input)) as Result;
}

const api: ShellApi = {
  platform: process.platform,
  shellInfo: () => invoke(CHANNELS.shellInfo),
  quit: () => invoke(CHANNELS.shellQuit),
  edit: (command) => invoke(CHANNELS.shellEdit, command),
  pickPath: () => invoke(CHANNELS.shellPickPath),
  listTools: () => invoke(CHANNELS.toolsList),
  pickFiles: () => invoke(CHANNELS.toolsPickFiles),
  pickFolder: (recursive) => invoke(CHANNELS.toolsPickFolder, { recursive }),
  detectPaths: (paths) => invoke(CHANNELS.toolsDetectPaths, { paths }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  registerTools: (input) => invoke(CHANNELS.toolsRegister, input),
  importManifests: (paths, scope) => invoke(CHANNELS.toolsImportManifests, { paths, scope }),
  updateTool: (id, details) => invoke(CHANNELS.toolsUpdate, { id, details }),
  removeTool: (id) => invoke(CHANNELS.toolsRemove, { id }),
  setToolScope: (id, scope) => invoke(CHANNELS.toolsSetScope, { id, scope }),
  openCategoryMenu: (category) => invoke(CHANNELS.categoriesOpenMenu, { category }),
  startRun: (toolId, request = {}) => invoke(CHANNELS.runsStart, { id: toolId, ...request }),
  cancelRun: (runId) => invoke(CHANNELS.runsCancel, { runId }),
  listRuns: () => invoke(CHANNELS.runsList),
  onRunsChanged: (listener) => {
    // The event is left out on purpose: it would hand the page a way to reach `ipcRenderer`.
    const forward = (_event: IpcRendererEvent, runs: readonly RunView[]): void => {
      listener(runs);
    };
    ipcRenderer.on(CHANNELS.runsChanged, forward);
    return () => {
      ipcRenderer.off(CHANNELS.runsChanged, forward);
    };
  },
  onRunOutput: (listener) => {
    const forward = (_event: IpcRendererEvent, output: RunOutputView): void => {
      listener(output);
    };
    ipcRenderer.on(CHANNELS.runsOutput, forward);
    return () => {
      ipcRenderer.off(CHANNELS.runsOutput, forward);
    };
  },
  readRunOutput: (runId) => invoke(CHANNELS.runsOutputRead, { runId }),
  sendRunInput: (runId, data) => invoke(CHANNELS.runsInput, { runId, data }),
  resizeRun: (runId, columns, rows) => invoke(CHANNELS.runsResize, { runId, columns, rows }),
  listProfiles: (toolId) => invoke(CHANNELS.profilesList, { id: toolId }),
  saveProfile: (input) => invoke(CHANNELS.profilesSave, input),
  removeProfile: (toolId, id) => invoke(CHANNELS.profilesRemove, { toolId, id }),
  listHistory: (toolId) => invoke(CHANNELS.historyList, toolId === undefined ? {} : { toolId }),
  getHistoryRun: (runId) => invoke(CHANNELS.historyGet, { runId }),
  recentTools: () => invoke(CHANNELS.historyRecent),
  clearHistory: () => invoke(CHANNELS.historyClear),
  getPreferences: () => invoke(CHANNELS.preferencesGet),
  setPreferences: (preferences) => invoke(CHANNELS.preferencesSet, preferences),
  listWorkspaces: () => invoke(CHANNELS.workspacesList),
  switchWorkspace: (id) => invoke(CHANNELS.workspacesSwitch, { id }),
  createWorkspace: (name) => invoke(CHANNELS.workspacesCreate, { name }),
  renameWorkspace: (id, name) => invoke(CHANNELS.workspacesRename, { id, name }),
  removeWorkspace: (id) => invoke(CHANNELS.workspacesRemove, { id }),
  updateWorkspace: (changes) => invoke(CHANNELS.workspacesUpdate, changes),
  saveLayout: (layout) => invoke(CHANNELS.workspacesUpdate, { layout }),
  listPathVariables: () => invoke(CHANNELS.pathVariablesList),
  setPathVariable: (name, value) => invoke(CHANNELS.pathVariablesSet, { name, value }),
  removePathVariable: (name) => invoke(CHANNELS.pathVariablesRemove, { name }),
};

contextBridge.exposeInMainWorld('bildora', api);
