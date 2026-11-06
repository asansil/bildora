import { contextBridge } from 'electron';
import type { ShellApi } from './api.js';

declare const process: { readonly platform: string };

const api: ShellApi = { platform: process.platform };

contextBridge.exposeInMainWorld('bildora', api);
