import { z } from 'zod';
import { graphIssues } from './automation-graph.js';
import type { GraphIssue } from './automation-graph.js';
import { automationProblem } from './automation-problems.js';
import type { AutomationProblemCode, AutomationProblemParams } from './automation-problems.js';
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN, NAME_PATTERN } from './manifest.js';

/** Automation format this build reads and writes: blocks and connections. */
export const AUTOMATION_SCHEMA_VERSION = 2;

export const WAIT_SECONDS_MAX = 604_800;
export const RETRY_ATTEMPTS_MAX = 20;
export const RETRY_DELAY_SECONDS_MAX = 86_400;

/** Blocks in one automation, those inside loops included. */
export const AUTOMATION_BLOCK_LIMIT = 200;
export const AUTOMATION_CONNECTION_LIMIT = 1000;
export const CONDITION_RULES_MAX = 20;
export const SWITCH_CASES_MAX = 20;
export const AUTOMATION_NOTE_LIMIT = 100;
export const AUTOMATION_GROUP_LIMIT = 50;
export const NOTE_TEXT_MAX = 2000;
/** Inputs the Start block can declare. */
export const AUTOMATION_INPUTS_MAX = 50;
/** Characters in one expression, the leading `=` left out. */
export const EXPRESSION_MAX_LENGTH = 2000;

/** Names an output cannot be given by a Switch case, because they mean something else. */
const RESERVED_CASES = ['next', 'error', 'true', 'false', 'default'];

/** Names that start other kinds of values in an expression, so no block can have them as its id. */
export const RESERVED_BLOCK_IDS: readonly string[] = ['inputs', 'steps', 'run', 'paths', 'loop'];

const nonEmpty = z.string().min(1);
const blockId = z.string().max(64).regex(NAME_PATTERN);

/**
 * A value worked out when it is needed: a link such as `convert.file`, an input such as
 * `inputs.file`, or an expression over them. People write it after `=`; the file keeps it apart from
 * plain text so that it fits number, boolean and choice parameters too.
 */
const expressionSchema = z.strictObject({
  expression: z.string().trim().min(1).max(EXPRESSION_MAX_LENGTH),
});

const literalSchema = z.union([z.string(), z.number(), z.boolean()]);

/** What a block value can hold: its own value, or one worked out from others. */
const blockValueSchema = z.union([literalSchema, expressionSchema]);

const retrySchema = z.strictObject({
  retry: z.strictObject({
    /** Tries in all, the first one included. */
    attempts: z.int().min(2).max(RETRY_ATTEMPTS_MAX),
    delaySeconds: z.int().min(0).max(RETRY_DELAY_SECONDS_MAX).optional(),
  }),
});

const resultRuleSchema = z.strictObject({
  block: blockId,
  field: z.literal('result'),
  operator: z.enum(['is', 'is-not']),
  value: z.enum(['completed', 'failed', 'skipped']),
});

const exitCodeRuleSchema = z.strictObject({
  block: blockId,
  field: z.literal('exit-code'),
  operator: z.enum(['equals', 'not-equals', 'greater-than', 'less-than']),
  value: z.int(),
});

/** Operators of a rule on a value. Which ones fit depends on the value's type. */
export const VALUE_RULE_OPERATORS = [
  'equals',
  'not-equals',
  'greater-than',
  'less-than',
  'at-least',
  'at-most',
  'contains',
  'starts-with',
  'ends-with',
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
  'exists',
  'not-exists',
] as const;

export type ValueRuleOperator = (typeof VALUE_RULE_OPERATORS)[number];

/** Operators that compare with nothing, so their rule has no value. */
export const UNARY_VALUE_RULE_OPERATORS: readonly ValueRuleOperator[] = [
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
  'exists',
  'not-exists',
];

/**
 * A rule on a value: an output, an input or a link, read through an expression, and compared with a
 * value of its own or one worked out from others. `exists` asks whether a file or folder is there.
 */
const valueRuleSchema = z.strictObject({
  field: z.literal('value'),
  read: expressionSchema,
  operator: z.enum(VALUE_RULE_OPERATORS),
  value: blockValueSchema.optional(),
});

const ruleSchema = z.discriminatedUnion('field', [
  resultRuleSchema,
  exitCodeRuleSchema,
  valueRuleSchema,
]);

/** A set of rules joined with AND (`all`) or OR (`any`). */
const conditionSchema = z.strictObject({
  match: z.enum(['all', 'any']),
  rules: z.array(ruleSchema).min(1).max(CONDITION_RULES_MAX),
});

const inputFields = {
  name: z.string().max(64).regex(NAME_PATTERN),
  label: nonEmpty.max(200).optional(),
  description: nonEmpty.max(2000).optional(),
  required: z.boolean().optional(),
};

/** A value the automation asks for when it starts. Inputs are never secret, since files are shared. */
const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...inputFields, type: z.literal('string'), default: z.string().optional() }),
  z.strictObject({ ...inputFields, type: z.literal('path'), default: z.string().optional() }),
  z.strictObject({ ...inputFields, type: z.literal('integer'), default: z.int().optional() }),
  z.strictObject({ ...inputFields, type: z.literal('number'), default: z.number().optional() }),
  z.strictObject({ ...inputFields, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({
    ...inputFields,
    type: z.literal('choice'),
    choices: z.array(nonEmpty).min(1).max(100),
    default: nonEmpty.optional(),
  }),
]);

const startBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('start'),
  /** How the automation begins. Only a button for now; later modes must not change existing files. */
  mode: z.literal('button').optional(),
  /** What the automation asks for when it starts. Blocks read them as `inputs.<name>`. */
  inputs: z.array(inputSchema).max(AUTOMATION_INPUTS_MAX).optional(),
});

const runBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('run'),
  tool: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  profile: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN).optional(),
  /** Values for this block, by parameter. Secrets never go here, because automations are shared. */
  values: z.record(z.string().regex(NAME_PATTERN), blockValueSchema).optional(),
  onFailure: z.union([z.literal('stop'), retrySchema]).optional(),
  /** Set when the run passes through this block without doing what it does. */
  disabled: z.literal(true).optional(),
});

const waitForTimeBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('wait-for-time'),
  seconds: z.int().min(1).max(WAIT_SECONDS_MAX),
  /** Set when the run passes through this block without doing what it does. */
  disabled: z.literal(true).optional(),
});

const waitForManualActionBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('wait-for-manual-action'),
  message: nonEmpty,
  /** Set when the run passes through this block without doing what it does. */
  disabled: z.literal(true).optional(),
});

const ifBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('if'),
  condition: conditionSchema,
  /** Set when the run passes through this block without doing what it does. */
  disabled: z.literal(true).optional(),
});

const switchBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('switch'),
  /** Checked in order. The first that holds is taken, or Default when none does. */
  cases: z
    .array(z.strictObject({ id: blockId, condition: conditionSchema }))
    .min(1)
    .max(SWITCH_CASES_MAX),
  /** Set when the run passes through this block without doing what it does. */
  disabled: z.literal(true).optional(),
});

const parallelBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('parallel'),
});

const joinBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('join'),
  /** The Parallel block this one ends. */
  parallel: blockId,
  /** What a failed branch with no Error output does to the others. Stopping them is the default. */
  onBranchFailure: z.enum(['stop-others', 'let-finish']).optional(),
});

const blockSchema = z.discriminatedUnion('type', [
  startBlockSchema,
  runBlockSchema,
  waitForTimeBlockSchema,
  waitForManualActionBlockSchema,
  ifBlockSchema,
  switchBlockSchema,
  parallelBlockSchema,
  joinBlockSchema,
]);

const connectionSchema = z.strictObject({
  from: blockId,
  /** Leaves `next` when left out. Otherwise `error`, `true`, `false`, `default` or a Switch case. */
  output: blockId.optional(),
  to: blockId,
});

/** Where a block sits on the canvas. Kept apart so that moving a block does not touch the logic. */
const positionSchema = z.strictObject({ x: z.number(), y: z.number() });

/** Text on the canvas. It changes nothing that runs. */
const noteSchema = z.strictObject({
  id: blockId,
  text: z.string().max(NOTE_TEXT_MAX),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

/** A named frame around some blocks. It changes nothing that runs. */
const groupSchema = z.strictObject({
  id: blockId,
  name: nonEmpty.max(200),
  blocks: z.array(blockId).min(1).max(AUTOMATION_BLOCK_LIMIT),
});

const automationShape = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  name: nonEmpty,
  description: nonEmpty.optional(),
  blocks: z.array(blockSchema).min(1).max(AUTOMATION_BLOCK_LIMIT),
  connections: z.array(connectionSchema).max(AUTOMATION_CONNECTION_LIMIT),
  positions: z.record(blockId, positionSchema).optional(),
  notes: z.array(noteSchema).max(AUTOMATION_NOTE_LIMIT).optional(),
  groups: z.array(groupSchema).max(AUTOMATION_GROUP_LIMIT).optional(),
});

/**
 * What an automation file must be to be read or stored at all. A flow being built can break the
 * rules below and still be saved; it only cannot run, which `automationRuleIssues` tells.
 */
export const automationFileSchema = automationShape;

/** The rules a JSON Schema cannot state, which the published schema therefore leaves out. */
export function automationRuleIssues(automation: z.output<typeof automationShape>): GraphIssue[] {
  const issues: GraphIssue[] = graphIssues(automation);
  const report = (
    path: (string | number)[],
    code: AutomationProblemCode,
    params: AutomationProblemParams,
    blockId?: string,
  ): void => {
    issues.push({ path, ...automationProblem(code, params, blockId) });
  };
  const ids = new Set(automation.blocks.map(({ id }) => id));
  const checkInputs = (
    inputs: readonly z.output<typeof inputSchema>[],
    path: (string | number)[],
    owner: string,
  ) => {
    inputs.forEach((input, index) => {
      if (inputs.findIndex(({ name }) => name === input.name) !== index) {
        report([...path, index, 'name'], 'input-duplicate', { input: input.name }, owner);
      }
      if (
        input.type === 'choice' &&
        input.default !== undefined &&
        !input.choices.includes(input.default)
      ) {
        report([...path, index, 'default'], 'input-default-choice', { input: input.name }, owner);
      }
    });
  };
  const checkCondition = (
    condition: z.output<typeof conditionSchema>,
    path: (string | number)[],
    owner: string,
  ) => {
    condition.rules.forEach((rule, index) => {
      const rulePath = [...path, 'rules', index];
      if (rule.field === 'value') {
        const unary = UNARY_VALUE_RULE_OPERATORS.includes(rule.operator);
        if (unary && rule.value !== undefined) {
          report([...rulePath, 'value'], 'rule-value-extra', {}, owner);
        } else if (!unary && rule.value === undefined) {
          report([...rulePath, 'value'], 'rule-value-missing', {}, owner);
        }
      } else if (!ids.has(rule.block)) {
        report([...rulePath, 'block'], 'rule-block-missing', { block: rule.block }, owner);
      }
    });
  };
  automation.blocks.forEach((block, index) => {
    const path: (string | number)[] = ['blocks', index];
    if (RESERVED_BLOCK_IDS.includes(block.id)) {
      report([...path, 'id'], 'block-reserved', { block: block.id }, block.id);
    }
    if (block.type === 'start') checkInputs(block.inputs ?? [], [...path, 'inputs'], block.id);
    if (block.type === 'if') checkCondition(block.condition, [...path, 'condition'], block.id);
    if (block.type !== 'switch') return;
    block.cases.forEach((branch, position) => {
      const casePath = [...path, 'cases', position];
      if (RESERVED_CASES.includes(branch.id)) {
        report([...casePath, 'id'], 'case-reserved', { case: branch.id }, block.id);
      }
      if (block.cases.findIndex(({ id }) => id === branch.id) !== position) {
        report([...casePath, 'id'], 'case-duplicate', { case: branch.id }, block.id);
      }
      checkCondition(branch.condition, [...casePath, 'condition'], block.id);
    });
  });
  for (const id of Object.keys(automation.positions ?? {})) {
    if (!ids.has(id)) {
      report(['positions', id], 'position-unknown', { block: id });
    }
  }
  // Notes and groups share the blocks' names, so that one id finds one thing on the canvas.
  const named = new Set(ids);
  const claim = (id: string, path: (string | number)[]): void => {
    if (named.has(id)) report(path, 'duplicate-id', { id });
    named.add(id);
  };
  automation.notes?.forEach(({ id }, index) => {
    claim(id, ['notes', index, 'id']);
  });
  const grouped = new Set<string>();
  automation.groups?.forEach((group, index) => {
    claim(group.id, ['groups', index, 'id']);
    group.blocks.forEach((block, position) => {
      const path = ['groups', index, 'blocks', position];
      if (!ids.has(block)) {
        report(path, 'group-block-missing', { group: group.name, block });
      } else if (grouped.has(block)) {
        report(path, 'group-block-twice', { block }, block);
      }
      grouped.add(block);
    });
  });
  return issues;
}

/** A file that breaks none of the rules, so that it can run once its tools are there. */
export const automationSchema = automationShape.superRefine((automation, context) => {
  for (const { path, ...problem } of automationRuleIssues(automation)) {
    context.addIssue({
      code: 'custom',
      path: [...path],
      message: problem.message,
      params: { problem },
    });
  }
});

export type Automation = z.output<typeof automationSchema>;
export type AutomationInput = z.input<typeof automationSchema>;
export type AutomationBlock = z.output<typeof blockSchema>;
export type AutomationConnection = z.output<typeof connectionSchema>;
export type AutomationCondition = z.output<typeof conditionSchema>;
export type RunBlock = z.output<typeof runBlockSchema>;
export type AutomationNote = z.output<typeof noteSchema>;
export type AutomationGroup = z.output<typeof groupSchema>;
export type AutomationPosition = z.output<typeof positionSchema>;
export type AutomationRule = z.output<typeof ruleSchema>;
export type ValueRule = z.output<typeof valueRuleSchema>;
export type StartBlock = z.output<typeof startBlockSchema>;
export type AutomationInputDeclaration = z.output<typeof inputSchema>;
export type ExpressionValue = z.output<typeof expressionSchema>;
export type LiteralValue = z.output<typeof literalSchema>;
export type BlockValue = z.output<typeof blockValueSchema>;

/** Tells a value worked out from others from one held as it is. */
export function isExpressionValue(value: unknown): value is ExpressionValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { expression?: unknown }).expression === 'string'
  );
}

/** Builds the JSON Schema published for automation authors. */
export function buildAutomationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(automationSchema, { target: 'draft-2020-12', io: 'input' });
}
