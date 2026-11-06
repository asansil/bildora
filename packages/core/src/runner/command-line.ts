import type { ToolParameter } from '@bildora/protocol';

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

/**
 * Turns parameter values into arguments, in declared order. An unset optional disappears along
 * with its flag, and a boolean is its flag alone.
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
    const value = Object.hasOwn(values, parameter.name)
      ? values[parameter.name]
      : parameter.default;
    if (value === undefined) {
      if (parameter.required) {
        throw new ParameterError(`Parameter "${parameter.name}" is required`);
      }
      return [];
    }
    const problem = describeProblem(parameter, value);
    if (problem !== undefined) {
      throw new ParameterError(`Parameter "${parameter.name}" ${problem}`);
    }
    if (parameter.type === 'boolean') {
      return value === true ? [parameter.flag] : [];
    }
    const text = String(value);
    return parameter.flag === undefined ? [text] : [parameter.flag, text];
  });
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
