import { replaceParameterReferences } from '@bildora/protocol';
import type { ToolParameter, ToolScriptEntry } from '@bildora/protocol';
import { scriptAnswers } from './stdin-script.js';
import type { ScriptAnswer } from './stdin-script.js';

export type ParameterValue = string | number | boolean;
export type ParameterValues = Readonly<Record<string, ParameterValue>>;

/** A run was asked for with values it cannot use. Messages never quote a value: it may be secret. */
export class ParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParameterError';
  }
}

function describeProblem(parameter: ToolParameter, value: ParameterValue): string | undefined {
  switch (parameter.type) {
    case 'string':
    case 'path':
      return typeof value === 'string' ? undefined : 'must be text';
    case 'integer':
      return Number.isSafeInteger(value) ? undefined : 'must be a whole number';
    case 'number':
      return Number.isFinite(value) ? undefined : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'choice':
      return typeof value === 'string' && parameter.choices.includes(value)
        ? undefined
        : 'must be one of its choices';
  }
}

/** The value a parameter has for a run, checked, or undefined when it is optional and unset. */
function checkedValue(
  parameter: ToolParameter,
  values: ParameterValues,
): ParameterValue | undefined {
  const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : parameter.default;
  if (value === undefined) {
    if (parameter.required) {
      throw new ParameterError(`Parameter "${parameter.name}" is required`);
    }
    return undefined;
  }
  const problem = describeProblem(parameter, value);
  if (problem !== undefined) {
    throw new ParameterError(`Parameter "${parameter.name}" ${problem}`);
  }
  return value;
}

/**
 * Turns parameter values into arguments, in declared order. An unset optional disappears along
 * with its flag, and a boolean is its flag alone. A parameter with `env` is left to
 * `renderEnvironment`, and one marked `stdin` to `renderScript`.
 */
export function renderArguments(
  parameters: readonly ToolParameter[],
  values: ParameterValues,
): string[] {
  for (const name of Object.keys(values)) {
    if (!parameters.some((parameter) => parameter.name === name)) {
      throw new ParameterError(`Unknown parameter "${name}"`);
    }
  }

  return parameters.flatMap((parameter) => {
    if (parameter.stdin) {
      return [];
    }
    const value = checkedValue(parameter, values);
    if (value === undefined || parameter.env !== undefined) {
      return [];
    }
    if (parameter.type === 'boolean') {
      return value === true ? [parameter.flag] : [];
    }
    const text = String(value);
    return parameter.flag === undefined ? [text] : [parameter.flag, text];
  });
}

/** The variables that carry the parameters declaring `env`. */
export function renderEnvironment(
  parameters: readonly ToolParameter[],
  values: ParameterValues,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const parameter of parameters) {
    const value =
      parameter.env === undefined || parameter.stdin ? undefined : checkedValue(parameter, values);
    if (parameter.env !== undefined && value !== undefined) {
      const text = String(value);
      assertPassable(text);
      variables[parameter.env] = text;
    }
  }
  return variables;
}

/**
 * The answers a console script types, with each reference replaced by the text of its value. An
 * optional parameter with no value answers with an empty line. A parameter marked `stdin` is
 * checked here, since only the script hands it over.
 */
export function renderScript(
  parameters: readonly ToolParameter[],
  script: readonly ToolScriptEntry[],
  values: ParameterValues,
): readonly ScriptAnswer[] {
  const texts = new Map<string, string>();
  for (const parameter of parameters) {
    const value = checkedValue(parameter, values);
    texts.set(parameter.name, value === undefined ? '' : String(value));
  }
  return scriptAnswers(script, (send) =>
    replaceParameterReferences(send, (name) => texts.get(name) ?? ''),
  );
}

function assertPassable(value: string): void {
  if (value.includes('\0')) {
    throw new ParameterError('An argument cannot contain a NUL character');
  }
}

/** Quotes one argument the way the C runtime and `CommandLineToArgvW` read it back. */
export function quoteForProgram(value: string): string {
  assertPassable(value);
  if (value !== '' && !/[\s"]/.test(value)) {
    return value;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
    } else if (character === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      quoted += `${'\\'.repeat(backslashes)}${character}`;
      backslashes = 0;
    }
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * Quotes one argument for `cmd.exe`, which parses it again and differently, so that it stays data.
 * Inside quotes the only live characters are `"`, which doubling keeps inside the quotes, and `%`,
 * which `%cd:~,%` separates from what follows: an empty expansion that leaves the `%` literal.
 * A line break would end the command, and no quoting can stop that.
 */
export function quoteForCmd(value: string): string {
  assertPassable(value);
  if (/[\r\n]/.test(value)) {
    throw new ParameterError('An argument for a batch file cannot contain a line break');
  }
  return `"${value.replaceAll('"', '""').replaceAll('%', '%%cd:~,%')}"`;
}

export function isBatchFile(path: string): boolean {
  return /\.(?:bat|cmd)$/i.test(path);
}

/** Command line for a program that reads its arguments through the C runtime. */
export function programCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteForProgram).join(' ');
}

/**
 * Command line that runs a batch file through `cmd.exe`. `/s` strips exactly the outer quotes,
 * `/d` skips AutoRun commands, `/e:on` is what `%cd:~,%` needs and `/v:off` keeps `!` literal.
 */
export function batchCommandLine(
  commandInterpreter: string,
  batchFile: string,
  args: readonly string[],
): string {
  const inner = [batchFile, ...args].map(quoteForCmd).join(' ');
  return `${quoteForProgram(commandInterpreter)} /d /s /e:on /v:off /c "${inner}"`;
}
