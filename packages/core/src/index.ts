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
export { ToolRegistry, toolKey } from './registry/tool-registry.js';
export type {
  RegisterOptions,
  RegisteredTool,
  RegistryProblem,
  ToolList,
} from './registry/tool-registry.js';
export { ParameterError } from './runner/command-line.js';
export type { ParameterValue, ParameterValues } from './runner/command-line.js';
export { defaultLauncherPath } from './runner/launcher.js';
export { resolveExecutable } from './runner/resolve-executable.js';
export type { ResolveOptions } from './runner/resolve-executable.js';
export { startRun, startWindowRun } from './runner/run-tool.js';
export { startRecordedRun } from './runner/recorded-run.js';
export type { RecordedRunOptions, RecordedToolRun } from './runner/recorded-run.js';
export { MissingPathVariableError, expandPath } from './runner/expand-paths.js';
export type { PathVariables } from './runner/expand-paths.js';
export { resolveRunValues } from './runner/resolve-values.js';
export type { RecordedParameter, ResolvedValues } from './runner/resolve-values.js';
export type { RunProgress } from './runner/progress-lines.js';
export { RunHistory } from './history/run-history.js';
export type {
  AutomationFailure,
  AutomationRunSummary,
  AutomationStepRecord,
  AutomationTrigger,
  RecordedStatus,
  RemovedAutomationRun,
  RunFinish,
  RunRecord,
  RunStart,
  RunSummary,
  StepState,
} from './history/run-history.js';
export {
  findAutomations,
  getAutomation,
  listAutomations,
  newAutomationId,
  parseAutomation,
  removeAutomation,
  removeRunFolders,
  saveAutomation,
} from './automations/automation-store.js';
export type {
  AutomationFileProblem,
  AutomationList,
  FoundAutomation,
} from './automations/automation-store.js';
export { checkAutomation } from './automations/check-automation.js';
export type { AutomationProblem } from './automations/check-automation.js';
export { startAutomationRun } from './automations/run-automation.js';
export type {
  AutomationResult,
  AutomationRun,
  AutomationRunOptions,
  AutomationRunView,
  ManualAnswer,
  ManualRequest,
  StepStarter,
  StepView,
} from './automations/run-automation.js';
export { startToolRun } from './automations/tool-starter.js';
export type { ToolStartRequest, ToolStarterContext } from './automations/tool-starter.js';
export {
  createChunkedStore,
  createCredentialStore,
  createMemorySecretStore,
} from './secrets/secret-store.js';
export type { SecretStore } from './secrets/secret-store.js';
export {
  getProfile,
  isSecretParameter,
  listProfiles,
  removeProfile,
  saveProfile,
} from './profiles/profile-store.js';
export type { Profile, ProfileInput } from './profiles/profile-store.js';
export { importManifests } from './import/import-manifest.js';
export type {
  ManifestImportReport,
  ManifestProposal,
  RefusedManifest,
} from './import/import-manifest.js';
export { moveTool } from './tools/move-tool.js';
export { removeTool } from './tools/remove-tool.js';
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
  ToolChanges,
  ToolDetails,
} from './import/register-program.js';
export {
  categoryKey,
  checkRuntime,
  groupByCategory,
  moveCategory,
  orderGroups,
} from './tools/tool-status.js';
export type { RuntimeCheckOptions, RuntimeStatus, ToolGroup } from './tools/tool-status.js';
export {
  DEFAULT_HISTORY_RUN_LIMIT,
  DEFAULT_PREFERENCES,
  HISTORY_RUN_LIMIT_MAX,
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
export {
  readPathVariables,
  removePathVariable,
  setPathVariable,
} from './storage/path-variables.js';
export { findVisibleTool, listVisibleTools, workspaceScope } from './workspaces/visible-tools.js';
export { removeWorkspace } from './workspaces/remove-workspace.js';
export {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  WORKSPACE_NAME_MAX_LENGTH,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  openWorkspaces,
  updateWorkspace,
} from './workspaces/workspace-store.js';
export type {
  LayoutChanges,
  Workspace,
  WorkspaceChanges,
  WorkspaceLayout,
  WorkspaceList,
  WorkspaceProblem,
} from './workspaces/workspace-store.js';
