import { z } from 'zod';

/** Manifest format this build reads and writes. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Ids become folder names, so the pattern also keeps out path separators and the device names
 * Windows reserves, which it treats as devices even with an extension.
 */
const IDENTIFIER_PATTERN =
  /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const IDENTIFIER_MAX_LENGTH = 128;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FLAG_PATTERN = /^(?:--?|\/)[a-zA-Z0-9?][a-zA-Z0-9_-]*$/;
const INTERPRETER_PATTERN = /^[a-zA-Z0-9._+-]+$/;
/** Relative, inside the tool folder: no drive, no leading separator and no `..` segment. */
const CONTAINED_PATH_PATTERN = /^(?![\\/])(?![a-zA-Z]:)(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).+$/;

/** What a tool can declare it does. Declarations inform the user; they are not enforced. */
export const PERMISSIONS = [
  'filesystem.read',
  'filesystem.write',
  'network',
  'process.spawn',
  'system.modify',
  'credentials',
  'hardware',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Tells whether a value can name a tool or a Workspace, and so a folder. */
export function isValidIdentifier(value: string): boolean {
  return value.length <= IDENTIFIER_MAX_LENGTH && IDENTIFIER_PATTERN.test(value);
}

const nonEmpty = z.string().min(1);

const commandSchema = z.strictObject({
  program: nonEmpty,
  args: z.array(z.string()).default([]),
});

const parameterFields = {
  name: z.string().regex(NAME_PATTERN),
  label: nonEmpty,
  description: nonEmpty.optional(),
  required: z.boolean().default(false),
  flag: z.string().regex(FLAG_PATTERN).optional(),
};

const parameterSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...parameterFields,
    type: z.literal('string'),
    secret: z.boolean().default(false),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...parameterFields,
    type: z.literal('path'),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...parameterFields,
    type: z.literal('integer'),
    default: z.int().optional(),
  }),
  z.strictObject({
    ...parameterFields,
    type: z.literal('number'),
    default: z.number().optional(),
  }),
  z.strictObject({
    ...parameterFields,
    type: z.literal('boolean'),
    // A boolean has no value of its own, so it can only appear as a flag.
    flag: z.string().regex(FLAG_PATTERN),
    default: z.boolean().optional(),
  }),
  z.strictObject({
    ...parameterFields,
    type: z.literal('choice'),
    choices: z.array(nonEmpty).min(1),
    default: nonEmpty.optional(),
  }),
]);

const outputFields = {
  name: z.string().regex(NAME_PATTERN),
  description: nonEmpty.optional(),
};

const outputSchema = z.union([
  z.strictObject({ ...outputFields, param: z.string().regex(NAME_PATTERN) }),
  z.strictObject({ ...outputFields, path: nonEmpty }),
]);

const commonFields = {
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  id: z.string().max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN),
  name: nonEmpty,
  version: z.string().regex(SEMVER_PATTERN),
  category: nonEmpty.optional(),
  description: nonEmpty.optional(),
  interpreter: z.string().regex(INTERPRETER_PATTERN).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
  leftoverProcesses: z.enum(['end', 'keep']).default('end'),
};

const declaredFields = {
  parameters: z.array(parameterSchema).default([]),
  outputs: z.array(outputSchema).default([]),
};

const manifestShape = z.discriminatedUnion('level', [
  z.strictObject({ ...commonFields, level: z.literal(0), run: commandSchema }),
  z.strictObject({ ...commonFields, ...declaredFields, level: z.literal(1), run: commandSchema }),
  z.strictObject({
    ...commonFields,
    ...declaredFields,
    level: z.literal(2),
    entryPoint: z.strictObject({
      panel: z.string().regex(CONTAINED_PATH_PATTERN),
      backend: commandSchema,
    }),
  }),
]);

function findDuplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Adds the rules a JSON Schema cannot state, which the published schema therefore leaves out. */
export const toolManifestSchema = manifestShape.superRefine((manifest, context) => {
  if (manifest.level === 0) {
    return;
  }
  const { parameters, outputs } = manifest;

  for (const name of findDuplicates(parameters.map((parameter) => parameter.name))) {
    context.addIssue({
      code: 'custom',
      path: ['parameters'],
      message: `Parameter "${name}" is declared more than once`,
    });
  }
  for (const name of findDuplicates(outputs.map((output) => output.name))) {
    context.addIssue({
      code: 'custom',
      path: ['outputs'],
      message: `Output "${name}" is declared more than once`,
    });
  }

  let sawOptionalPositional = false;
  parameters.forEach((parameter, index) => {
    const path = ['parameters', index];
    if (parameter.type === 'string' && parameter.secret && parameter.default !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'default'],
        message: 'A secret parameter cannot have a default, because manifests are shared',
      });
    }
    if (
      parameter.type === 'choice' &&
      parameter.default !== undefined &&
      !parameter.choices.includes(parameter.default)
    ) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'default'],
        message: `Default "${parameter.default}" is not one of the choices`,
      });
    }
    if (parameter.flag === undefined) {
      if (parameter.required && sawOptionalPositional) {
        context.addIssue({
          code: 'custom',
          path,
          message: 'A required positional parameter cannot follow an optional one',
        });
      }
      sawOptionalPositional ||= !parameter.required;
    }
  });

  outputs.forEach((output, index) => {
    if ('param' in output && !parameters.some((parameter) => parameter.name === output.param)) {
      context.addIssue({
        code: 'custom',
        path: ['outputs', index, 'param'],
        message: `Output refers to unknown parameter "${output.param}"`,
      });
    }
  });
});

export type ToolManifest = z.output<typeof toolManifestSchema>;
export type ToolManifestInput = z.input<typeof toolManifestSchema>;
export type ToolParameter = z.output<typeof parameterSchema>;
export type ToolOutput = z.output<typeof outputSchema>;
export type ToolCommand = z.output<typeof commandSchema>;

/** Builds the JSON Schema published for tool authors, from the same source core validates with. */
export function buildToolManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(toolManifestSchema, { target: 'draft-2020-12', io: 'input' });
}
