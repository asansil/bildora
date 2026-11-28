/** Current version of the tool protocol. */
export const PROTOCOL_VERSION = 1;

/** Tells whether a value received from a tool names a protocol version this build speaks. */
export function isSupportedProtocolVersion(version: unknown): boolean {
  return version === PROTOCOL_VERSION;
}

export {
  MANIFEST_SCHEMA_VERSION,
  OUTPUT_FIELD_TYPES,
  OUTPUT_FIELDS_MAX,
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
  ToolJsonOutput,
  ToolManifest,
  ToolManifestInput,
  ToolOutput,
  ToolOutputField,
  ToolOutputFieldType,
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
  AUTOMATION_GROUP_LIMIT,
  AUTOMATION_INPUTS_MAX,
  AUTOMATION_NOTE_LIMIT,
  AUTOMATION_SCHEMA_VERSION,
  CALL_DEPTH_MAX,
  EXPRESSION_MAX_LENGTH,
  LOOP_PATTERN_MAX_LENGTH,
  LOOP_ROUNDS_MAX,
  NOTE_TEXT_MAX,
  CONDITION_RULES_MAX,
  RESERVED_BLOCK_IDS,
  RETRY_ATTEMPTS_MAX,
  RETRY_DELAY_SECONDS_MAX,
  SCHEDULE_DAYS,
  SCHEDULE_EVERY_HOURS_MAX,
  SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES,
  SCHEDULE_TIME_LIMIT_MAX_MINUTES,
  SWITCH_CASES_MAX,
  UNARY_VALUE_RULE_OPERATORS,
  VALUE_RULE_OPERATORS,
  WAIT_SECONDS_MAX,
  automationFileSchema,
  automationRuleIssues,
  automationSchema,
  buildAutomationJsonSchema,
  isExpressionValue,
  isLoopBlock,
} from './automation.js';
export { startBlocker } from './schedule-blocker.js';
export type { ScheduleBlocker } from './schedule-blocker.js';
export type {
  Automation,
  AutomationBlock,
  AutomationCondition,
  AutomationConnection,
  AutomationGroup,
  AutomationInput,
  AutomationInputDeclaration,
  AutomationNote,
  AutomationPosition,
  AutomationRule,
  AutomationSchedule,
  BlockValue,
  ExpressionValue,
  ForBlock,
  ForItems,
  LiteralValue,
  LoopBlock,
  WhileBlock,
  RunAutomationBlock,
  RunBlock,
  ScheduleDay,
  StartBlock,
  ValueRule,
  ValueRuleOperator,
} from './automation.js';
export {
  AUTOMATION_PROBLEM_CODES,
  automationProblem,
  blockingProblems,
  describeProblem,
  isWarning,
  problemsOfIssues,
} from './automation-problems.js';
export type {
  AutomationProblem,
  AutomationProblemCode,
  AutomationProblemParams,
} from './automation-problems.js';
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
export {
  BODY_OUTPUT,
  DEFAULT_CASE,
  DEFAULT_OUTPUT,
  ERROR_OUTPUT,
  buildGraph,
  connectionOutput,
  disabledOutput,
  endGuarantee,
  graphIssues,
  guarantees,
  isDisableable,
  isLoopType,
  loopBody,
  loopChain,
  outputsOf,
  reachableFrom,
  staysInFrame,
  topologicalOrder,
  validTargets,
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
export * from './expressions/index.js';
