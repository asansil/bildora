import { PROTOCOL_VERSION } from '@bildora/protocol';

export interface CoreInfo {
  readonly productName: string;
  readonly protocolVersion: number;
}

/** Identifies this build of the core to its clients. */
export function getCoreInfo(): CoreInfo {
  return { productName: 'Bildora', protocolVersion: PROTOCOL_VERSION };
}

export { parseManifest, serializeManifest } from './manifest/parse-manifest.js';
export { DefinitionError } from './storage/definition-error.js';
export type { DefinitionIssue } from './storage/definition-error.js';
export { GLOBAL_SCOPE, openDataDirectory, resolveDataDir } from './storage/data-directory.js';
export type { DataDirectoryOptions, InstallScope } from './storage/data-directory.js';
export { ToolRegistry } from './registry/tool-registry.js';
export type {
  RegisterOptions,
  RegisteredTool,
  RegistryProblem,
  ToolList,
} from './registry/tool-registry.js';
