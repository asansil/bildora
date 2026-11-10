import { z } from 'zod';
import { findParameterReferences, findUnknownParameterReferences } from './references.js';

/** Manifest format this build reads and writes. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Answers a console script can hold. */
export const STDIN_SCRIPT_MAX_ENTRIES = 100;
/** How long a console script waits for its text when the entry sets no `timeout`. */
export const STDIN_TIMEOUT_DEFAULT_SECONDS = 30;
const STDIN_TIMEOUT_MAX_SECONDS = 86_400;

/**
 * Ids become folder names, so the pattern also keeps out path separators and the device names
 * Windows reserves, which it treats as devices even with an extension.
 */
export const IDENTIFIER_PATTERN =
  /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const IDENTIFIER_MAX_LENGTH = 128;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FLAG_PATTERN = /^(?:--?|\/)[a-zA-Z0-9?][a-zA-Z0-9_-]*$/;
const INTERPRETER_PATTERN = /^[a-zA-Z0-9._+-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
  /** Hands the value over in this environment variable rather than as an argument. */
  env: z.string().regex(ENVIRONMENT_NAME_PATTERN).optional(),
  /** Hands the value over only through the console script, never as an argument. */
  stdin: z.boolean().default(false),
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
    env: z.never().optional(),
    stdin: z.literal(false).default(false),
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

/** Fields a JSON output can declare. */
export const OUTPUT_FIELDS_MAX = 100;

/** Types a field of a JSON output can have. A list holds text, such as file names. */
export const OUTPUT_FIELD_TYPES = [
  'string',
  'path',
  'integer',
  'number',
  'boolean',
  'list',
] as const;

const outputFieldSchema = z.strictObject({
  name: z.string().regex(NAME_PATTERN),
  type: z.enum(OUTPUT_FIELD_TYPES),
  description: nonEmpty.optional(),
  /** Kept from history and from other blocks. Only text can be secret. */
  secret: z.boolean().default(false),
});

const outputSchema = z.union([
  z.strictObject({ ...outputFields, param: z.string().regex(NAME_PATTERN) }),
  z.strictObject({ ...outputFields, path: nonEmpty }),
  /**
   * A JSON file the tool writes, holding one object with these fields. Bildora reads it after the
   * tool ends. A relative path is read from the tool's folder, and it may use path variables.
   */
  z.strictObject({
    ...outputFields,
    json: nonEmpty,
    fields: z.array(outputFieldSchema).min(1).max(OUTPUT_FIELDS_MAX),
  }),
]);

/** One answer of a console script: wait for `expect` in the output, then type `send` and Enter. */
const scriptEntrySchema = z.strictObject({
  /** Literal text, never a pattern. Without it, the answer follows the one before at once. */
  expect: nonEmpty.optional(),
  send: z.string(),
  /** Seconds to wait for `expect`. */
  timeout: z.int().positive().max(STDIN_TIMEOUT_MAX_SECONDS).optional(),
});

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

const manifestShape = z.discriminatedUnion(
  'level',
  [
    z.strictObject({ ...commonFields, level: z.literal(0), run: commandSchema }),
    z.strictObject({
      ...commonFields,
      ...declaredFields,
      level: z.literal(1),
      run: commandSchema,
      stdin: z.array(scriptEntrySchema).min(1).max(STDIN_SCRIPT_MAX_ENTRIES).optional(),
    }),
  ],
  {
    // The only issue the union raises itself is a level it does not know.
    error: () => 'Level must be 0 or 1: this version of Bildora runs no level 2 tools',
  },
);

function findDuplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

type DeclaredManifest = Extract<z.output<typeof manifestShape>, { level: 1 }>;

/** Answers may refer only to declared parameters, and every stdin parameter needs an answer. */
function checkScript(manifest: DeclaredManifest, context: z.RefinementCtx): void {
  const script = manifest.stdin ?? [];
  const declared = new Set(manifest.parameters.map(({ name }) => name));
  const answered = new Set<string>();

  script.forEach((entry, index) => {
    const path = ['stdin', index];
    if (entry.timeout !== undefined && entry.expect === undefined) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'timeout'],
        message: 'A time limit needs an expect text to wait for',
      });
    }
    for (const reference of findUnknownParameterReferences(entry.send)) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'send'],
        message: `"${reference}" is not a reference an answer can use`,
      });
    }
    for (const name of findParameterReferences(entry.send)) {
      answered.add(name);
      if (!declared.has(name)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'send'],
          message: `Answer refers to unknown parameter "${name}"`,
        });
      }
    }
  });

  manifest.parameters.forEach((parameter, index) => {
    if (!parameter.stdin) {
      return;
    }
    if (manifest.stdin === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', index, 'stdin'],
        message: `Parameter "${parameter.name}" is marked stdin, but the manifest has no stdin script`,
      });
    } else if (!answered.has(parameter.name)) {
      context.addIssue({
        code: 'custom',
        path: ['parameters', index, 'stdin'],
        message: `Parameter "${parameter.name}" is marked stdin, but no answer refers to it`,
      });
    }
  });
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

  const environmentNames = parameters.flatMap(({ env }) => (env === undefined ? [] : [env]));
  // Windows reads environment names without regard to case.
  for (const name of findDuplicates(environmentNames.map((env) => env.toUpperCase()))) {
    context.addIssue({
      code: 'custom',
      path: ['parameters'],
      message: `Environment variable "${name}" is used more than once`,
    });
  }

  checkScript(manifest, context);

  let sawOptionalPositional = false;
  parameters.forEach((parameter, index) => {
    const path = ['parameters', index];
    if (parameter.stdin && (parameter.flag !== undefined || parameter.env !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'stdin'],
        message: 'A parameter marked stdin reaches the tool only through the script',
      });
    }
    if (parameter.env !== undefined && parameter.flag !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [...path, 'env'],
        message: 'A parameter reaches the tool as a flag or as a variable, not both',
      });
    }
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
    if (parameter.flag === undefined && parameter.env === undefined && !parameter.stdin) {
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
    if ('json' in output) {
      for (const name of findDuplicates(output.fields.map((field) => field.name))) {
        context.addIssue({
          code: 'custom',
          path: ['outputs', index, 'fields'],
          message: `Field "${name}" is declared more than once`,
        });
      }
      output.fields.forEach((field, position) => {
        if (field.secret && field.type !== 'string') {
          context.addIssue({
            code: 'custom',
            path: ['outputs', index, 'fields', position, 'secret'],
            message: `Field "${field.name}" cannot be secret: only text fields can`,
          });
        }
      });
      return;
    }
    if (!('param' in output)) {
      return;
    }
    const parameter = parameters.find(({ name }) => name === output.param);
    if (parameter === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['outputs', index, 'param'],
        message: `Output refers to unknown parameter "${output.param}"`,
      });
    } else if (parameter.type === 'string' && parameter.secret) {
      context.addIssue({
        code: 'custom',
        path: ['outputs', index, 'param'],
        message: `Output cannot come from secret parameter "${output.param}"`,
      });
    }
  });
});

export type ToolManifest = z.output<typeof toolManifestSchema>;
export type ToolManifestInput = z.input<typeof toolManifestSchema>;
export type ToolParameter = z.output<typeof parameterSchema>;
export type ToolOutput = z.output<typeof outputSchema>;
export type ToolJsonOutput = Extract<ToolOutput, { json: string }>;
export type ToolOutputField = z.output<typeof outputFieldSchema>;
export type ToolOutputFieldType = (typeof OUTPUT_FIELD_TYPES)[number];
export type ToolCommand = z.output<typeof commandSchema>;
export type ToolScriptEntry = z.output<typeof scriptEntrySchema>;

/** Builds the JSON Schema published for tool authors, from the same source core validates with. */
export function buildToolManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(toolManifestSchema, { target: 'draft-2020-12', io: 'input' });
}
