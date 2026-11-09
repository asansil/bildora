import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ParameterView, ProfileView } from '../../shared/ipc-contract.js';

/** What a form control holds: text for everything but a checkbox, numbers included. */
export type FormValue = string | boolean;
export type FormValues = Readonly<Record<string, FormValue>>;

/** What a form becomes when it is used. */
export interface SubmittedValues {
  readonly plain: Readonly<Record<string, string | number | boolean>>;
  /** Secrets the user typed. A saved one is never here: main adds it on its own. */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * The parameters a form shows. Those marked for the console script appear only when the script
 * answers, because otherwise the person types them in the console.
 */
export function shownParameters(
  parameters: readonly ParameterView[],
  answerWithScript: boolean,
): readonly ParameterView[] {
  return answerWithScript ? parameters : parameters.filter(({ delivery }) => delivery !== 'script');
}

/** Fills a form from a profile and from the declared defaults. Secrets always start empty. */
export function initialValues(
  parameters: readonly ParameterView[],
  profile?: ProfileView,
): FormValues {
  const values: Record<string, FormValue> = {};
  for (const parameter of parameters) {
    const value =
      parameter.secret === true ? '' : (profile?.values[parameter.name] ?? parameter.default);
    values[parameter.name] = parameter.type === 'boolean' ? value === true : String(value ?? '');
  }
  return values;
}

function isEmpty(value: FormValue | undefined): boolean {
  return typeof value === 'string' ? value.trim() === '' : value === undefined;
}

/** The problem with one field, as a message key, or undefined when it is fine. */
export function parameterProblem(
  parameter: ParameterView,
  value: FormValue | undefined,
  hasSavedSecret: boolean,
): MessageKey | undefined {
  if (isEmpty(value)) {
    return parameter.required && !hasSavedSecret ? 'runner.required' : undefined;
  }
  const text = String(value).trim();
  if (parameter.type === 'integer') {
    return /^[+-]?\d+$/.test(text) && Number.isSafeInteger(Number(text))
      ? undefined
      : 'runner.notWholeNumber';
  }
  if (parameter.type === 'number') {
    return Number.isFinite(Number(text)) ? undefined : 'runner.notNumber';
  }
  return undefined;
}

/** Every field with a problem, by parameter name. */
export function formProblems(
  parameters: readonly ParameterView[],
  values: FormValues,
  savedSecrets: readonly string[],
): Readonly<Record<string, MessageKey>> {
  const problems: Record<string, MessageKey> = {};
  for (const parameter of parameters) {
    const problem = parameterProblem(
      parameter,
      values[parameter.name],
      savedSecrets.includes(parameter.name),
    );
    if (problem !== undefined) {
      problems[parameter.name] = problem;
    }
  }
  return problems;
}

/** Turns a checked form into typed values. An empty field is simply not set. */
export function submittedValues(
  parameters: readonly ParameterView[],
  values: FormValues,
): SubmittedValues {
  const plain: Record<string, string | number | boolean> = {};
  const secrets: Record<string, string> = {};
  for (const parameter of parameters) {
    const value = values[parameter.name];
    if (typeof value === 'boolean') {
      plain[parameter.name] = value;
    } else if (value !== undefined && !isEmpty(value)) {
      if (parameter.secret === true) {
        secrets[parameter.name] = value;
      } else if (parameter.type === 'integer' || parameter.type === 'number') {
        plain[parameter.name] = Number(value);
      } else {
        plain[parameter.name] = value;
      }
    }
  }
  return { plain, secrets };
}
