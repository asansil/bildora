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
export { ParameterError } from './runner/command-line.js';
export type { ParameterValue, ParameterValues } from './runner/command-line.js';
export { resolveExecutable } from './runner/resolve-executable.js';
export type { ResolveOptions } from './runner/resolve-executable.js';
export { startRun, startWindowRun } from './runner/run-tool.js';
export type {
  RunFailure,
  RunFailureKind,
  RunOptions,
  RunResult,
  ToolRun,
  WindowRunOptions,
} from './runner/run-tool.js';
export { SCAN_RESULT_LIMIT, detectPrograms, displayName } from './import/detect-program.js';
export type { DetectOptions, Detection, ProgramProposal } from './import/detect-program.js';
export {
  createRegisteredManifest,
  identifierFromName,
  registerPrograms,
  updateToolDetails,
} from './import/register-program.js';
export type {
  ProgramDetails,
  RegistrationFailure,
  RegistrationReport,
  ToolDetails,
} from './import/register-program.js';
export { categoryKey, checkRuntime, groupByCategory } from './tools/tool-status.js';
export type { RuntimeCheckOptions, RuntimeStatus, ToolGroup } from './tools/tool-status.js';
export {
  DEFAULT_PREFERENCES,
  THEMES,
  readPreferences,
  writePreferences,
} from './storage/preferences.js';
export type { Preferences, Theme } from './storage/preferences.js';
export {
  LOGO_EXTENSIONS,
  LOGO_MAX_BYTES,
  readCategoryLogos,
  removeCategoryLogo,
  setCategoryLogo,
} from './storage/category-logos.js';
