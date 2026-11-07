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
  RUN_FOLDER_REFERENCE,
  findStepOutputReferences,
  findUnknownReferences,
  replaceRunReferences,
  stepOutputReference,
  usesRunFolder,
} from './references.js';
export type { RunReferenceValues, StepOutputReference } from './references.js';
