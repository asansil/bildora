const NAME = '[a-zA-Z][a-zA-Z0-9_-]*';
const RUN_REFERENCE_PATTERN = new RegExp(
  `\\{\\{(?:run\\.(folder)|steps\\.(${NAME})\\.outputs\\.(${NAME}))\\}\\}`,
  'g',
);
const ANY_REFERENCE_PATTERN = /\{\{[^{}]*\}\}/g;
const PARAMETER_REFERENCE_PATTERN = new RegExp(`\\{\\{params\\.(${NAME})\\}\\}`, 'g');
const ONE_PARAMETER_REFERENCE_PATTERN = new RegExp(`^\\{\\{params\\.${NAME}\\}\\}$`);
const KNOWN_REFERENCE_PATTERN = new RegExp(
  `^\\{\\{(?:paths\\.${NAME}|run\\.folder|steps\\.${NAME}\\.outputs\\.${NAME})\\}\\}$`,
);

/** The folder a run of an automation keeps to itself. */
export const RUN_FOLDER_REFERENCE = '{{run.folder}}';

export interface StepOutputReference {
  readonly step: string;
  readonly output: string;
}

export interface RunReferenceValues {
  readonly runFolder: () => string;
  readonly stepOutput: (reference: StepOutputReference) => string;
}

/** Writes the reference to an output of an earlier step. */
export function stepOutputReference({ step, output }: StepOutputReference): string {
  return `{{steps.${step}.outputs.${output}}}`;
}

/** Every step output a text refers to, in order. */
export function findStepOutputReferences(text: string): readonly StepOutputReference[] {
  return [...text.matchAll(RUN_REFERENCE_PATTERN)].flatMap(([, , step, output]) =>
    step === undefined || output === undefined ? [] : [{ step, output }],
  );
}

export function usesRunFolder(text: string): boolean {
  return text.includes(RUN_FOLDER_REFERENCE);
}

/** Double-brace text that is no reference Bildora knows, which is most likely a typing mistake. */
export function findUnknownReferences(text: string): readonly string[] {
  return (text.match(ANY_REFERENCE_PATTERN) ?? []).filter(
    (reference) => !KNOWN_REFERENCE_PATTERN.test(reference),
  );
}

/** Replaces run folder and step output references in a text. Replacements are not read again. */
export function replaceRunReferences(text: string, values: RunReferenceValues): string {
  return text.replace(
    RUN_REFERENCE_PATTERN,
    (_match, folder: string | undefined, step: string, output: string) =>
      folder === undefined ? values.stepOutput({ step, output }) : values.runFolder(),
  );
}

/** The parameters a console script answer refers to, in order. */
export function findParameterReferences(text: string): readonly string[] {
  return [...text.matchAll(PARAMETER_REFERENCE_PATTERN)].flatMap(([, name]) =>
    name === undefined ? [] : [name],
  );
}

/** Double-brace text in a console script answer that names no parameter. */
export function findUnknownParameterReferences(text: string): readonly string[] {
  return (text.match(ANY_REFERENCE_PATTERN) ?? []).filter(
    (reference) => !ONE_PARAMETER_REFERENCE_PATTERN.test(reference),
  );
}

/** Replaces parameter references in a console script answer. Replacements are not read again. */
export function replaceParameterReferences(
  text: string,
  valueOf: (name: string) => string,
): string {
  return text.replace(PARAMETER_REFERENCE_PATTERN, (_match, name: string) => valueOf(name));
}
