/** Current version of the tool protocol. */
export const PROTOCOL_VERSION = 1;

/** Tells whether a value received from a tool names a protocol version this build speaks. */
export function isSupportedProtocolVersion(version: unknown): boolean {
  return version === PROTOCOL_VERSION;
}

export {
  MANIFEST_SCHEMA_VERSION,
  PERMISSIONS,
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
} from './manifest.js';
export {
  isPathVariableName,
  replacePathVariables,
  startsWithPathVariable,
} from './path-variables.js';
export {
  AUTOMATION_SCHEMA_VERSION,
  AUTOMATION_STEP_LIMIT,
  RETRY_ATTEMPTS_MAX,
  RETRY_DELAY_SECONDS_MAX,
  WAIT_SECONDS_MAX,
  automationSchema,
  buildAutomationJsonSchema,
} from './automation.js';
export type { Automation, AutomationInput, AutomationStep, RunStep } from './automation.js';
export {
  AUTOMATION_BLOCK_LIMIT,
  AUTOMATION_CONNECTION_LIMIT,
  AUTOMATION_V2_SCHEMA_VERSION,
  CONDITION_RULES_MAX,
  SWITCH_CASES_MAX,
  automationV2Schema,
  buildAutomationV2JsonSchema,
} from './automation-v2.js';
export type {
  AutomationBlock,
  AutomationCondition,
  AutomationConnection,
  AutomationV2,
  AutomationV2Input,
  RunBlock,
} from './automation-v2.js';
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
  findStepOutputReferences,
  findUnknownReferences,
  replaceRunReferences,
  stepOutputReference,
  usesRunFolder,
} from './references.js';
export type { RunReferenceValues, StepOutputReference } from './references.js';
