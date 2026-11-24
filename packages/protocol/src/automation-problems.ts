import type { z } from 'zod';

/** Names a problem's parameters can have. A message reads a missing one as empty. */
const PARAMETER_NAMES = [
  'block',
  'case',
  'count',
  'detail',
  'field',
  'from',
  'group',
  'id',
  'index',
  'input',
  'label',
  'output',
  'parallel',
  'parameter',
  'path',
  'profile',
  'reference',
  'source',
  'to',
  'tool',
  'type',
] as const;
type ParameterName = (typeof PARAMETER_NAMES)[number];
type Filled = Readonly<Record<ParameterName, string>>;

/**
 * Problems an automation can have, named by code so that the app can word each one for people who
 * did not build the flow, and translate it later. The English text here is for the CLI and logs.
 */
const MESSAGES = {
  // The shape of the file, when Zod reports it with no code of ours.
  invalid: ({ detail }) => detail,
  // Blocks and connections.
  'duplicate-block': ({ block }) => `Block "${block}" is declared more than once`,
  'duplicate-id': ({ id }) => `"${id}" names more than one item`,
  'block-reserved': ({ block }) =>
    `"${block}" cannot name a block, because expressions use it for other values`,
  'start-count': ({ count }) =>
    `An automation needs exactly one Start block, and this one has ${count}`,
  'connection-from-missing': ({ index, from }) =>
    `Connection ${index} starts at "${from}", which does not exist`,
  'connection-to-missing': ({ index, to }) =>
    `Connection ${index} ends at "${to}", which does not exist`,
  'into-start': () => 'Nothing can lead into the Start block',
  'unknown-output': ({ block, output }) => `Block "${block}" has no output "${output}"`,
  'output-to-many': ({ block, output }) =>
    `The "${output}" output of "${block}" leads to more than one block, and only Parallel starts several paths`,
  cycle: () => 'The connections go in a circle, and only a loop block may repeat work',
  'parallel-branches': ({ block }) => `Parallel "${block}" needs at least two branches`,
  'parallel-joins': ({ block, count }) =>
    `Parallel "${block}" needs exactly one Join, and has ${count}`,
  'join-without-parallel': ({ block }) => `Join "${block}" must end a Parallel block`,
  'join-unreached': ({ block, parallel }) =>
    `Join "${block}" is never reached from Parallel "${parallel}"`,
  'branches-leak': ({ block, parallel }) =>
    `The branches of Parallel "${parallel}" must meet only at Join "${block}", and nothing may lead into them from outside`,
  // Conditions and cases.
  'rule-block-missing': ({ block }) => `A rule reads block "${block}", which does not exist`,
  'case-reserved': ({ case: name }) =>
    `"${name}" cannot name a case, because it is the name of another output`,
  'case-duplicate': ({ case: name }) => `Case "${name}" is declared more than once`,
  'rule-value-missing': () => 'A rule compares a value with nothing',
  'rule-value-extra': () => 'A rule that compares with nothing is given a value',
  // Inputs of the automation.
  'input-duplicate': ({ input }) => `Input "${input}" is declared more than once`,
  'input-default-choice': ({ input }) =>
    `The default of input "${input}" is not one of its choices`,
  'exit-code-not-run': ({ source }) =>
    `Reads the exit code of "${source}", which is not a run block`,
  'exit-code-not-certain': ({ source, block }) =>
    `Reads the exit code of "${source}", which does not run on every path that reaches "${block}"`,
  // What sits beside the blocks.
  'position-unknown': ({ block }) =>
    `A position is given for block "${block}", which does not exist`,
  'group-block-missing': ({ group, block }) =>
    `Group "${group}" holds block "${block}", which does not exist`,
  'group-block-twice': ({ block }) => `Block "${block}" is in more than one group`,
  // Tools and their values.
  'tool-missing': ({ tool }) => `Tool "${tool}" is not installed, or cannot be read`,
  'profile-missing': ({ profile }) => `Profile "${profile}" no longer exists`,
  'parameter-unknown': ({ parameter }) => `The tool has no parameter "${parameter}"`,
  'parameter-secret': ({ parameter }) =>
    `"${parameter}" is secret, so it can only come from a profile`,
  'parameter-type': ({ parameter, type }) => `"${parameter}" does not fit a ${type} parameter`,
  'parameter-required': ({ label }) => `Needs a value for "${label}"`,
  'reference-unknown': ({ reference }) => `Unknown reference ${reference}`,
  'reference-not-run': ({ source }) => `Refers to "${source}", which is not a run block`,
  'reference-output-unknown': ({ source, output }) =>
    `Step "${source}" declares no output "${output}"`,
  'reference-level-0': ({ source }) =>
    `Step "${source}" runs a registered program, which declares no outputs`,
  'reference-not-certain': ({ source }) =>
    `Step "${source}" does not finish on every path that reaches this block, so its output may not exist`,
  // Links and expressions. `label` names the field, or the rule, that holds the expression.
  'expression-syntax': ({ label, detail }) => `The value of "${label}" cannot be read: ${detail}`,
  'expression-name': ({ label, detail }) => `The value of "${label}" reads a wrong name: ${detail}`,
  'expression-function': ({ label, detail }) =>
    `The value of "${label}" calls a function wrongly: ${detail}`,
  'expression-type': ({ label, detail }) => `The value of "${label}" does not fit: ${detail}`,
  'link-block-missing': ({ label, source }) =>
    `"${label}" links to block "${source}", which does not exist`,
  'link-not-run': ({ label, source }) =>
    `"${label}" links to "${source}", which runs no tool and so has no values`,
  'link-parameter-missing': ({ label, source, parameter }) =>
    `"${label}" links to "${source}.${parameter}", and that tool has no such parameter`,
  'link-secret': ({ label, source, parameter }) =>
    `"${label}" links to "${source}.${parameter}", which is secret and cannot be linked`,
  // Warnings: the automation runs, but something in it will not work as it reads.
  'output-from-disabled': ({ label, source }) =>
    `"${label}" reads an output of "${source}", which is disabled and will not run`,
  'exit-code-from-disabled': ({ label, source }) =>
    `"${label}" checks the exit code of "${source}", which is disabled and will not run`,
  'link-cycle': ({ label, reference }) =>
    `"${label}" links in a circle, back to itself: ${reference}`,
  'input-unknown': ({ label, input }) => `"${label}" reads input "${input}", which does not exist`,
  'output-field-unknown': ({ label, source, output, field }) =>
    `"${label}" reads field "${field}" of output "${output}" of "${source}", which it does not declare`,
  'output-field-secret': ({ label, source, output, field }) =>
    `"${label}" reads field "${field}" of output "${output}" of "${source}", which is secret`,
} satisfies Record<string, (params: Filled) => string>;

export type AutomationProblemCode = keyof typeof MESSAGES;
export type AutomationProblemParams = Readonly<Partial<Record<ParameterName, string>>>;

export const AUTOMATION_PROBLEM_CODES = Object.keys(MESSAGES) as readonly AutomationProblemCode[];

/** Codes that warn about an automation without keeping it from running. */
const WARNINGS: ReadonlySet<AutomationProblemCode> = new Set([
  'output-from-disabled',
  'exit-code-from-disabled',
]);

/**
 * Something wrong with an automation. An error keeps it from running; a warning, which says so in
 * `severity`, lets it run.
 */
export interface AutomationProblem {
  readonly code: AutomationProblemCode;
  readonly params: AutomationProblemParams;
  readonly severity?: 'warning';
  /** The block it concerns, when it concerns one. */
  readonly blockId?: string;
  /** The problem in English, for the CLI and logs. The app words it from the code. */
  readonly message: string;
}

export function describeProblem(
  code: AutomationProblemCode,
  params: AutomationProblemParams = {},
): string {
  const filled = Object.fromEntries(
    PARAMETER_NAMES.map((name) => [name, params[name] ?? '']),
  ) as Filled;
  return MESSAGES[code](filled);
}

export function automationProblem(
  code: AutomationProblemCode,
  params: AutomationProblemParams = {},
  blockId?: string,
): AutomationProblem {
  return {
    code,
    params,
    ...(WARNINGS.has(code) ? { severity: 'warning' as const } : {}),
    ...(blockId === undefined ? {} : { blockId }),
    message: describeProblem(code, params),
  };
}

export function isWarning(problem: { readonly severity?: 'warning' }): boolean {
  return problem.severity === 'warning';
}

/** The problems that keep an automation from running: all but the warnings. */
export function blockingProblems<T extends { readonly severity?: 'warning' }>(
  problems: readonly T[],
): T[] {
  return problems.filter((problem) => !isWarning(problem));
}

function isCode(value: unknown): value is AutomationProblemCode {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value);
}

/** The block a path into an automation points at, if it points into its blocks. */
function blockAt(path: readonly PropertyKey[], input: unknown): string | undefined {
  const [section, index] = path;
  if (section !== 'blocks' || typeof index !== 'number') return undefined;
  const blocks = (input as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return undefined;
  const id = (blocks[index] as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Turns what Zod found in an automation into problems. Rules of ours carry their code in `params`;
 * anything else is a malformed file, reported with Zod's own words.
 */
export function problemsOfIssues(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): AutomationProblem[] {
  return issues.map((issue) => {
    const ours = issue.code === 'custom' ? (issue.params?.['problem'] as unknown) : undefined;
    if (ours !== undefined && typeof ours === 'object' && ours !== null) {
      const { code, params, blockId } = ours as Partial<AutomationProblem>;
      if (isCode(code)) {
        return automationProblem(code, params ?? {}, blockId ?? blockAt(issue.path, input));
      }
    }
    const where = issue.path.map(String).join('.');
    return automationProblem(
      'invalid',
      { detail: where === '' ? issue.message : `${where}: ${issue.message}`, path: where },
      blockAt(issue.path, input),
    );
  });
}
