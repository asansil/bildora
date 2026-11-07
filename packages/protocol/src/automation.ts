import { z } from 'zod';
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN, NAME_PATTERN } from './manifest.js';

/** Automation format this build reads and writes. */
export const AUTOMATION_SCHEMA_VERSION = 1;

export const AUTOMATION_STEP_LIMIT = 200;
export const WAIT_SECONDS_MAX = 604_800;
export const RETRY_ATTEMPTS_MAX = 20;
export const RETRY_DELAY_SECONDS_MAX = 86_400;

const nonEmpty = z.string().min(1);
const stepId = z.string().max(64).regex(NAME_PATTERN);

const retrySchema = z.strictObject({
  retry: z.strictObject({
    /** Tries in all, the first one included. */
    attempts: z.int().min(2).max(RETRY_ATTEMPTS_MAX),
    delaySeconds: z.int().min(0).max(RETRY_DELAY_SECONDS_MAX).optional(),
  }),
});

const stopOrContinue = z.enum(['stop', 'continue']);

const runStepSchema = z.strictObject({
  id: stepId,
  type: z.literal('run'),
  tool: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  profile: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN).optional(),
  /** Values for this step, by parameter. Secrets never go here, because automations are shared. */
  values: z
    .record(z.string().regex(NAME_PATTERN), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  /** Moves on without waiting. A later wait-for-completion step can name this one. */
  background: z.boolean().optional(),
  onFailure: z.union([stopOrContinue, retrySchema]).optional(),
});

const waitForCompletionStepSchema = z.strictObject({
  id: stepId,
  type: z.literal('wait-for-completion'),
  /** The background step to wait for. */
  step: stepId,
  onFailure: stopOrContinue.optional(),
});

const waitForTimeStepSchema = z.strictObject({
  id: stepId,
  type: z.literal('wait-for-time'),
  seconds: z.int().min(1).max(WAIT_SECONDS_MAX),
});

const waitForManualActionStepSchema = z.strictObject({
  id: stepId,
  type: z.literal('wait-for-manual-action'),
  message: nonEmpty,
  onFailure: stopOrContinue.optional(),
});

// A union on `type`, so later kinds of step, such as branches, have somewhere to go.
const stepSchema = z.discriminatedUnion('type', [
  runStepSchema,
  waitForCompletionStepSchema,
  waitForTimeStepSchema,
  waitForManualActionStepSchema,
]);

const automationShape = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  name: nonEmpty,
  description: nonEmpty.optional(),
  steps: z.array(stepSchema).min(1).max(AUTOMATION_STEP_LIMIT),
});

/** Adds the rules a JSON Schema cannot state, which the published schema therefore leaves out. */
export const automationSchema = automationShape.superRefine(({ steps }, context) => {
  steps.forEach((step, index) => {
    const path = ['steps', index];
    if (steps.findIndex(({ id }) => id === step.id) !== index) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'id'],
        message: `Step "${step.id}" is declared more than once`,
      });
    }
    if (step.type === 'run' && step.background === true && step.onFailure !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'onFailure'],
        message: 'A background step fails where it is waited for, so that step sets the policy',
      });
    }
    if (step.type === 'wait-for-completion') {
      const target = steps.slice(0, index).find(({ id }) => id === step.step);
      if (target?.type !== 'run' || target.background !== true) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'step'],
          message: `Step "${step.id}" must wait for an earlier background step`,
        });
      }
    }
  });
});

export type Automation = z.output<typeof automationSchema>;
export type AutomationInput = z.input<typeof automationSchema>;
export type AutomationStep = z.output<typeof stepSchema>;
export type RunStep = z.output<typeof runStepSchema>;

/** Builds the JSON Schema published for automation authors. */
export function buildAutomationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(automationSchema, { target: 'draft-2020-12', io: 'input' });
}
