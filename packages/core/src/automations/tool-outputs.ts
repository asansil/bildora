/**
 * What a tool leaves for later blocks: the values of the parameters it declares as outputs, the paths
 * it writes to, and the fields of the JSON files it writes. JSON files are read once the tool ends.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { replaceParameterReferences } from '@bildora/protocol';
import type { RuntimeValue, ToolJsonOutput, ToolOutputField } from '@bildora/protocol';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { expandPath } from '../runner/expand-paths.js';
import type { PathVariables } from '../runner/expand-paths.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import type { OutputValue } from './automation-values.js';

/** Bytes a JSON output may hold. A larger file fails its block rather than filling memory. */
export const JSON_OUTPUT_BYTE_LIMIT = 1024 * 1024;
/** Items a list field may hold. */
export const JSON_LIST_LIMIT = 10_000;

/** A JSON output that is missing, too large or does not hold what the manifest declares. */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputError';
  }
}

/** Where a declared path points, relative paths being read from the tool's own folder. */
function outputPath(
  tool: RegisteredTool,
  path: string,
  run: RecordedToolRun,
  variables: PathVariables,
): string {
  const { manifest } = tool;
  // The run records each value as the tool got it; secrets record no value, so they read as empty.
  const withParameters = replaceParameterReferences(path, (name) => {
    const value = run.parameters.find((parameter) => parameter.name === name)?.value;
    return value === undefined ? '' : String(value);
  });
  const expanded = expandPath(withParameters, variables);
  const base = dirname(expandPath(manifest.run.program, variables));
  return isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded);
}

function fieldValue(field: ToolOutputField, value: unknown, output: string): RuntimeValue {
  const wrong = (what: string): never => {
    throw new OutputError(`Field "${field.name}" of output "${output}" ${what}`);
  };
  switch (field.type) {
    case 'string':
    case 'path':
      return typeof value === 'string' ? value : wrong('must be text');
    case 'integer':
      return Number.isSafeInteger(value) ? (value as number) : wrong('must be a whole number');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : wrong('must be a number');
    case 'boolean':
      return typeof value === 'boolean' ? value : wrong('must be true or false');
    case 'list':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return wrong('must be a list of texts');
      }
      if (value.length > JSON_LIST_LIMIT) {
        return wrong(`holds more than ${String(JSON_LIST_LIMIT)} items`);
      }
      return value;
  }
}

async function readJsonOutput(output: ToolJsonOutput, path: string): Promise<OutputValue> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new OutputError(`The tool did not write output "${output.name}" to ${path}`);
  }
  if (size > JSON_OUTPUT_BYTE_LIMIT) {
    throw new OutputError(`Output "${output.name}" is larger than 1 MiB`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new OutputError(`Output "${output.name}" is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OutputError(`Output "${output.name}" must hold one JSON object`);
  }
  const fields = new Map<string, RuntimeValue>();
  for (const field of output.fields) {
    if (!Object.hasOwn(parsed, field.name)) {
      throw new OutputError(`Output "${output.name}" has no field "${field.name}"`);
    }
    fields.set(
      field.name,
      fieldValue(field, (parsed as Record<string, unknown>)[field.name], output.name),
    );
  }
  return { value: path, fields };
}

/**
 * Reads what a tool left, now that its block has run. Throws an `OutputError` when a JSON output is
 * missing or wrong, which fails the block. A path that needs a variable with no value is left out,
 * and a block that reads it reports so.
 */
export async function readToolOutputs(
  tool: RegisteredTool,
  run: RecordedToolRun,
  variables: PathVariables,
): Promise<ReadonlyMap<string, OutputValue>> {
  const { manifest } = tool;
  const outputs = new Map<string, OutputValue>();
  if (manifest.level !== 1) {
    return outputs;
  }
  for (const output of manifest.outputs) {
    if ('param' in output) {
      const value = run.parameters.find(({ name }) => name === output.param)?.value;
      if (value !== undefined && value !== '') {
        outputs.set(output.name, { value: String(value) });
      }
      continue;
    }
    let path: string;
    try {
      path = outputPath(tool, 'path' in output ? output.path : output.json, run, variables);
    } catch {
      if ('json' in output) {
        throw new OutputError(`Output "${output.name}" needs a path variable with no value here`);
      }
      continue;
    }
    outputs.set(
      output.name,
      'json' in output ? await readJsonOutput(output, path) : { value: path },
    );
  }
  return outputs;
}

/** The secret fields of a tool's outputs, as `output.field`, which history leaves out. */
export function secretOutputFields(tool: RegisteredTool): ReadonlySet<string> {
  const { manifest } = tool;
  if (manifest.level !== 1) return new Set();
  return new Set(
    manifest.outputs.flatMap((output) =>
      'json' in output
        ? output.fields.filter(({ secret }) => secret).map(({ name }) => `${output.name}.${name}`)
        : [],
    ),
  );
}
