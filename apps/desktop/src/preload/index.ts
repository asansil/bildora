import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CHANNELS } from '../shared/channels.js';
import type { RunView } from '../shared/ipc-contract.js';
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
  listTools: () => invoke(CHANNELS.toolsList),
  pickFiles: () => invoke(CHANNELS.toolsPickFiles),
  pickFolder: (recursive) => invoke(CHANNELS.toolsPickFolder, { recursive }),
  detectPaths: (paths) => invoke(CHANNELS.toolsDetectPaths, { paths }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  registerTools: (input) => invoke(CHANNELS.toolsRegister, input),
  updateTool: (id, details) => invoke(CHANNELS.toolsUpdate, { id, details }),
  removeTool: (id) => invoke(CHANNELS.toolsRemove, { id }),
  openCategoryMenu: (category) => invoke(CHANNELS.categoriesOpenMenu, { category }),
  startRun: (toolId) => invoke(CHANNELS.runsStart, { id: toolId }),
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
  getPreferences: () => invoke(CHANNELS.preferencesGet),
  setPreferences: (preferences) => invoke(CHANNELS.preferencesSet, preferences),
};

contextBridge.exposeInMainWorld('bildora', api);
