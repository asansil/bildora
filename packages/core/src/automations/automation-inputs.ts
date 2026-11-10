/**
 * Inputs an automation asks for when it starts: checked against what its Start block declares, with
 * defaults filled in. Messages may quote a value, since inputs are never secret.
 */
import type { Automation, AutomationInputDeclaration, LiteralValue } from '@bildora/protocol';

/** Values given for a run that its inputs cannot take. Each problem is one sentence. */
export class InputError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'InputError';
    this.problems = problems;
  }
}

/** The inputs an automation declares on its Start block. */
export function inputsOf(automation: Automation): readonly AutomationInputDeclaration[] {
  const start = automation.blocks.find(({ type }) => type === 'start');
  return start?.type === 'start' ? (start.inputs ?? []) : [];
}

/** Says why a value does not fit an input, or undefined when it does. */
function misfit(input: AutomationInputDeclaration, value: LiteralValue): string | undefined {
  switch (input.type) {
    case 'string':
    case 'path':
      return typeof value === 'string' ? undefined : 'must be text';
    case 'integer':
      return Number.isSafeInteger(value) ? undefined : 'must be a whole number';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'choice':
      return typeof value === 'string' && input.choices.includes(value)
        ? undefined
        : `must be one of ${input.choices.join(', ')}`;
  }
}

/** Reads an input from text, as the command line gives it. Throws an `InputError` if it cannot. */
export function parseInputText(input: AutomationInputDeclaration, text: string): LiteralValue {
  const fail = (what: string): never => {
    throw new InputError([`Input "${input.name}" ${what}`]);
  };
  switch (input.type) {
    case 'integer':
    case 'number': {
      const value = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(value)) fail('must be a number');
      if (input.type === 'integer' && !Number.isSafeInteger(value)) fail('must be a whole number');
      return value;
    }
    case 'boolean': {
      const lower = text.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) return true;
      if (['false', 'no', '0'].includes(lower)) return false;
      return fail('must be true or false');
    }
    default:
      return text;
  }
}

/**
 * The value of every input for a run: what was given, or the default. Inputs left with neither are
 * left out, and a block that reads one fails. Unknown names, values that do not fit, and required
 * inputs with no value throw one `InputError` listing all of them.
 */
export function resolveInputs(
  automation: Automation,
  given: Readonly<Record<string, LiteralValue>> = {},
): ReadonlyMap<string, LiteralValue> {
  const declared = inputsOf(automation);
  const problems: string[] = [];
  for (const name of Object.keys(given)) {
    if (!declared.some((input) => input.name === name)) {
      problems.push(`This automation has no input "${name}"`);
    }
  }
  const values = new Map<string, LiteralValue>();
  for (const input of declared) {
    const value = Object.hasOwn(given, input.name) ? given[input.name] : input.default;
    if (value === undefined || value === '') {
      if (input.required === true) problems.push(`Input "${input.name}" needs a value`);
      if (value === '') values.set(input.name, value);
      continue;
    }
    const problem = misfit(input, value);
    if (problem === undefined) values.set(input.name, value);
    else problems.push(`Input "${input.name}" ${problem}`);
  }
  if (problems.length > 0) throw new InputError(problems);
  return values;
}
