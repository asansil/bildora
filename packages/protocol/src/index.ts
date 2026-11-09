/** Current version of the tool protocol. */
export const PROTOCOL_VERSION = 1;

/** Tells whether a value received from a tool names a protocol version this build speaks. */
export function isSupportedProtocolVersion(version: unknown): boolean {
  return version === PROTOCOL_VERSION;
}

export {
  MANIFEST_SCHEMA_VERSION,
  PERMISSIONS,
  STDIN_SCRIPT_MAX_ENTRIES,
  STDIN_TIMEOUT_DEFAULT_SECONDS,
  buildToolManifestJsonSchema,
  isValidIdentifier,
  toolManifestSchema,
} from './manifest.js';
export type {
  Permission,
  ToolCommand,
  ToolManifest,
  ToolManifestInput,
  ToolOutput,
  ToolParameter,
  ToolScriptEntry,
} from './manifest.js';
export {
  isPathVariableName,
  replacePathVariables,
  startsWithPathVariable,
} from './path-variables.js';
export {
  AUTOMATION_BLOCK_LIMIT,
  AUTOMATION_CONNECTION_LIMIT,
  AUTOMATION_SCHEMA_VERSION,
  CONDITION_RULES_MAX,
  RETRY_ATTEMPTS_MAX,
  RETRY_DELAY_SECONDS_MAX,
  SWITCH_CASES_MAX,
  WAIT_SECONDS_MAX,
  automationSchema,
  buildAutomationJsonSchema,
} from './automation.js';
export type {
  Automation,
  AutomationBlock,
  AutomationCondition,
  AutomationConnection,
  AutomationInput,
  RunBlock,
} from './automation.js';
export {
  AUTOMATION_V1_SCHEMA_VERSION,
  AUTOMATION_V1_STEP_LIMIT,
  automationV1Schema,
} from './automation-v1.js';
export type {
  AutomationV1,
  AutomationV1Input,
  AutomationV1Step,
  RunStepV1,
} from './automation-v1.js';
export { fromLinear, linearOf, linearStepSchema } from './automation-linear.js';
export type { LinearRunStep, LinearStep } from './automation-linear.js';
export {
  DEFAULT_CASE,
  DEFAULT_OUTPUT,
  ERROR_OUTPUT,
  buildGraph,
  connectionOutput,
  graphIssues,
  guarantees,
  outputsOf,
  reachableFrom,
  topologicalOrder,
} from './automation-graph.js';
export type {
  Graph,
  GraphBlock,
  GraphConnection,
  GraphIssue,
  GraphShape,
  Guarantee,
} from './automation-graph.js';
export {
  RUN_FOLDER_REFERENCE,
  findParameterReferences,
  findStepOutputReferences,
  findUnknownParameterReferences,
  findUnknownReferences,
  replaceParameterReferences,
  replaceRunReferences,
  stepOutputReference,
  usesRunFolder,
} from './references.js';
export type { RunReferenceValues, StepOutputReference } from './references.js';
