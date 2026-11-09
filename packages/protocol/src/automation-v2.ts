import { z } from 'zod';
import { graphIssues } from './automation-graph.js';
import { RETRY_ATTEMPTS_MAX, RETRY_DELAY_SECONDS_MAX, WAIT_SECONDS_MAX } from './automation.js';
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN, NAME_PATTERN } from './manifest.js';

/** Automation format with blocks and connections. */
export const AUTOMATION_V2_SCHEMA_VERSION = 2;

/** Blocks in one automation, those inside loops included. */
export const AUTOMATION_BLOCK_LIMIT = 200;
export const AUTOMATION_CONNECTION_LIMIT = 1000;
export const CONDITION_RULES_MAX = 20;
export const SWITCH_CASES_MAX = 20;

/** Names an output cannot be given by a Switch case, because they mean something else. */
const RESERVED_CASES = ['next', 'error', 'true', 'false', 'default'];

const nonEmpty = z.string().min(1);
const blockId = z.string().max(64).regex(NAME_PATTERN);

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

const ruleSchema = z.discriminatedUnion('field', [resultRuleSchema, exitCodeRuleSchema]);

/** A set of rules joined with AND (`all`) or OR (`any`). */
const conditionSchema = z.strictObject({
  match: z.enum(['all', 'any']),
  rules: z.array(ruleSchema).min(1).max(CONDITION_RULES_MAX),
});

const startBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('start'),
  /** How the automation begins. Only a button for now; later modes must not change existing files. */
  mode: z.literal('button').optional(),
});

const runBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('run'),
  tool: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  profile: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN).optional(),
  /** Values for this block, by parameter. Secrets never go here, because automations are shared. */
  values: z
    .record(z.string().regex(NAME_PATTERN), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  onFailure: z.union([z.literal('stop'), retrySchema]).optional(),
});

const waitForTimeBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('wait-for-time'),
  seconds: z.int().min(1).max(WAIT_SECONDS_MAX),
});

const waitForManualActionBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('wait-for-manual-action'),
  message: nonEmpty,
});

const ifBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('if'),
  condition: conditionSchema,
});

const switchBlockSchema = z.strictObject({
  id: blockId,
  type: z.literal('switch'),
  /** Checked in order. The first that holds is taken, or Default when none does. */
  cases: z
    .array(z.strictObject({ id: blockId, condition: conditionSchema }))
    .min(1)
    .max(SWITCH_CASES_MAX),
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

const automationShape = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_V2_SCHEMA_VERSION),
  id: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  name: nonEmpty,
  description: nonEmpty.optional(),
  blocks: z.array(blockSchema).min(1).max(AUTOMATION_BLOCK_LIMIT),
  connections: z.array(connectionSchema).max(AUTOMATION_CONNECTION_LIMIT),
  positions: z.record(blockId, positionSchema).optional(),
});

/** Adds the rules a JSON Schema cannot state, which the published schema therefore leaves out. */
export const automationV2Schema = automationShape.superRefine((automation, context) => {
  for (const { path, message } of graphIssues(automation)) {
    context.addIssue({ code: 'custom', path: [...path], message });
  }
  const ids = new Set(automation.blocks.map(({ id }) => id));
  const checkCondition = (
    condition: z.output<typeof conditionSchema>,
    path: (string | number)[],
  ) => {
    condition.rules.forEach(({ block }, index) => {
      if (!ids.has(block)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'rules', index, 'block'],
          message: `A rule reads block "${block}", which does not exist`,
        });
      }
    });
  };
  automation.blocks.forEach((block, index) => {
    const path: (string | number)[] = ['blocks', index];
    if (block.type === 'if') checkCondition(block.condition, [...path, 'condition']);
    if (block.type !== 'switch') return;
    block.cases.forEach((branch, position) => {
      const casePath = [...path, 'cases', position];
      if (RESERVED_CASES.includes(branch.id)) {
        context.addIssue({
          code: 'custom',
          path: [...casePath, 'id'],
          message: `"${branch.id}" cannot name a case, because it is the name of another output`,
        });
      }
      if (block.cases.findIndex(({ id }) => id === branch.id) !== position) {
        context.addIssue({
          code: 'custom',
          path: [...casePath, 'id'],
          message: `Case "${branch.id}" is declared more than once`,
        });
      }
      checkCondition(branch.condition, [...casePath, 'condition']);
    });
  });
  for (const id of Object.keys(automation.positions ?? {})) {
    if (!ids.has(id)) {
      context.addIssue({
        code: 'custom',
        path: ['positions', id],
        message: `A position is given for block "${id}", which does not exist`,
      });
    }
  }
});

export type AutomationV2 = z.output<typeof automationV2Schema>;
export type AutomationV2Input = z.input<typeof automationV2Schema>;
export type AutomationBlock = z.output<typeof blockSchema>;
export type AutomationConnection = z.output<typeof connectionSchema>;
export type AutomationCondition = z.output<typeof conditionSchema>;
export type RunBlock = z.output<typeof runBlockSchema>;

/** Builds the JSON Schema published for automation authors. */
export function buildAutomationV2JsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(automationV2Schema, { target: 'draft-2020-12', io: 'input' });
}
