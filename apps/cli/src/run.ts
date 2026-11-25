import { parseArgs } from 'node:util';
import {
  InputError,
  RunHistory,
  ToolRegistry,
  checkAutomation,
  createCredentialStore,
  findAutomations,
  findVisibleTool,
  getAutomation,
  getCoreInfo,
  inputsOf,
  openDataDirectory,
  parseInputText,
  readCallTree,
  readPathVariables,
  resolveDataDir,
  resolveInputs,
  startAutomationRun,
  startToolRun,
} from '@bildora/core';
import { blockingProblems, isWarning } from '@bildora/protocol';
import type { LiteralValue } from '@bildora/protocol';
import type {
  AutomationResult,
  AutomationRunOptions,
  AutomationRunView,
  FoundAutomation,
  ManualAnswer,
  SecretStore,
  StepView,
} from '@bildora/core';

const USAGE = [
  'Usage: bildora --version',
  '       bildora run <automation> [--workspace <id or name>] [--input <name>=<value>]...',
].join('\n');

export const EXIT_CODES = {
  completed: 0,
  stopped: 1,
  usage: 2,
  continuedPastFailure: 3,
  nobodyToAnswer: 4,
  cannotStart: 5,
  cancelled: 130,
} as const;

const MS_PER_SECOND = 1000;

/** What the outside world gives a command, so that tests can stand in for it. */
export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly error: (line: string) => void;
  /** Whether a person can answer. Under a scheduler nobody can. */
  readonly interactive: boolean;
  /** Waits for Enter. It resolves false if input ends, or if the signal aborts. */
  readonly waitForEnter: (signal: AbortSignal) => Promise<boolean>;
  /** Calls back when the user asks to stop, and returns how to stop listening. */
  readonly onInterrupt: (listener: () => void) => () => void;
  readonly secrets?: SecretStore | undefined;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

function exitCodeOf({ status, failure, failedSteps }: AutomationResult): number {
  if (status === 'cancelled') {
    return EXIT_CODES.cancelled;
  }
  if (status === 'failed') {
    return failure?.kind === 'no-user' ? EXIT_CODES.nobodyToAnswer : EXIT_CODES.stopped;
  }
  return failedSteps.length > 0 ? EXIT_CODES.continuedPastFailure : EXIT_CODES.completed;
}

function seconds(durationMs: number | undefined): string {
  return `${((durationMs ?? 0) / MS_PER_SECOND).toFixed(1)} s`;
}

function describeStep({ state, durationMs, failure, attempt, rounds }: StepView): string {
  const counted = rounds === undefined ? '' : `, ${String(rounds)} round${rounds === 1 ? '' : 's'}`;
  switch (state) {
    case 'completed':
      return `completed (${seconds(durationMs)}${counted})`;
    case 'failed':
      return `failed: ${failure?.message ?? 'unknown reason'}`;
    case 'running':
      return attempt === undefined || attempt === 1 ? 'running' : `running, try ${String(attempt)}`;
    default:
      return state;
  }
}

const WORK_BLOCKS = [
  'run',
  'wait-for-time',
  'wait-for-manual-action',
  'for',
  'while',
  'run-automation',
];

/**
 * Prints a line each time a step changes state, and nothing for progress within one. Steps outside
 * loops are numbered; a step inside a loop names its round instead, and a called run's lines start
 * with the automation that called it.
 */
function stepPrinter(io: CliIo, prefix = ''): (view: AutomationRunView) => void {
  const shown = new Map<string, string>();
  return ({ steps }) => {
    // Blocks that only direct the run, such as Start and If, are over as soon as they begin.
    const work = steps.filter(({ type }) => WORK_BLOCKS.includes(type));
    const numbered = work.filter(({ round }) => round === undefined);
    for (const step of work) {
      const text = describeStep(step);
      const key = `${step.id}\u0000${step.round ?? ''}`;
      if (step.state === 'idle' || shown.get(key) === text) continue;
      shown.set(key, text);
      const label =
        step.round === undefined
          ? `[${String(numbered.indexOf(step) + 1)}/${String(numbered.length)}] ${step.id}`
          : `  ${step.id} (round ${step.round})`;
      io.out(`${prefix}${label}: ${text}`);
    }
  };
}

function summaryOf(result: AutomationResult): string {
  const { status, durationMs, failedSteps, runId } = result;
  const failures = failedSteps.length === 0 ? '' : `, failed steps: ${failedSteps.join(', ')}`;
  return `Automation ${status} in ${seconds(durationMs)}${failures}. Run ${runId}.`;
}

async function openHistory(dataDir: string, io: CliIo): Promise<RunHistory> {
  try {
    return await RunHistory.open(dataDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`Warning: this run will not be kept in history. ${detail}`);
    return RunHistory.open(dataDir, { inMemory: true });
  }
}

async function ask(io: CliIo, message: string, signal: AbortSignal): Promise<ManualAnswer> {
  io.out(`${message}\nPress Enter to continue.`);
  const answered = await io.waitForEnter(signal);
  if (signal.aborted) {
    return 'cancelled';
  }
  return answered ? 'confirmed' : 'no-user';
}

/**
 * Reads `--input name=value` pairs as the automation's inputs declare them, with defaults filled
 * in. Throws an `InputError` naming every value that does not fit.
 */
function inputsFrom(
  { automation }: FoundAutomation,
  pairs: readonly string[],
): Readonly<Record<string, LiteralValue>> {
  const declared = inputsOf(automation);
  const given: Record<string, LiteralValue> = {};
  const problems: string[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    const input = declared.find((candidate) => candidate.name === name);
    if (at <= 0) {
      problems.push(`"${pair}" should read <name>=<value>`);
    } else if (input === undefined) {
      problems.push(`This automation has no input "${name}"`);
    } else {
      try {
        given[name] = parseInputText(input, pair.slice(at + 1));
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        problems.push(...error.problems);
      }
    }
  }
  if (problems.length > 0) throw new InputError(problems);
  resolveInputs(automation, given);
  return given;
}

async function runAutomation(
  dataDir: string,
  found: FoundAutomation,
  inputs: Readonly<Record<string, LiteralValue>>,
  io: CliIo,
): Promise<number> {
  const { automation, workspaceId, workspaceName } = found;
  const registry = await ToolRegistry.open({ dataDir });
  // Every automation it can call is read once, so that checking and running see the same files.
  const calls = await readCallTree(automation, (id) => getAutomation(dataDir, workspaceId, id));
  const problems = await checkAutomation(automation, registry, workspaceId, calls);
  const line = ({ blockId, message }: (typeof problems)[number]): string =>
    blockId === undefined ? `  ${message}` : `  ${blockId}: ${message}`;
  const blocking = blockingProblems(problems);
  if (blocking.length > 0) {
    io.error(`"${automation.name}" cannot run:`);
    for (const problem of blocking) io.error(line(problem));
    return EXIT_CODES.cannotStart;
  }
  // Warnings let the automation run, and are said first.
  const warnings = problems.filter(isWarning);
  if (warnings.length > 0) {
    io.error(`Warnings for "${automation.name}":`);
    for (const problem of warnings) io.error(line(problem));
  }

  const history = await openHistory(dataDir, io);
  try {
    history.recoverInterrupted();
    const store = io.secrets ?? createCredentialStore(dataDir);
    io.out(`Running "${automation.name}" in Workspace "${workspaceName}".`);
    // A called run prints its steps after the automation that called it.
    const startCalled = (options: AutomationRunOptions) => {
      const name = options.automation.name;
      io.out(`Calling "${name}" from ${options.caller?.blockId ?? 'a block'}.`);
      return startAutomationRun({ ...options, onChange: stepPrinter(io, `${name} › `) });
    };
    const run = startAutomationRun({
      automation,
      workspaceId,
      trigger: 'cli',
      inputs,
      calls,
      startCalled,
      dataDir,
      history,
      pathVariables: await readPathVariables(dataDir).catch(() => undefined),
      findTool: (id) => findVisibleTool(registry, workspaceId, id),
      startStep: (tool, { automationRunId, profileId, values, onProgress, answerWithScript }) =>
        startToolRun(
          tool,
          { workspaceId, automationRunId, profileId, values, onProgress, answerWithScript },
          { dataDir, history, store },
        ),
      askForAction: io.interactive ? ({ message, signal }) => ask(io, message, signal) : undefined,
      onChange: stepPrinter(io),
    });
    const stopListening = io.onInterrupt(() => {
      run.cancel();
    });
    const result = await run.result;
    stopListening();
    if (result.failure !== undefined) {
      const round = result.failure.round === undefined ? '' : ` in round ${result.failure.round}`;
      io.error(`Stopped at "${result.failure.stepId}"${round}: ${result.failure.message}`);
    }
    io.out(summaryOf(result));
    return exitCodeOf(result);
  } finally {
    history.close();
  }
}

async function runCommand(args: readonly string[], io: CliIo): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        workspace: { type: 'string', short: 'w' },
        input: { type: 'string', short: 'i', multiple: true },
      },
    });
  } catch {
    return { exitCode: EXIT_CODES.usage, stderr: USAGE };
  }
  const { positionals, values } = parsed;
  const [wanted, ...extra] = positionals;
  if (wanted === undefined || extra.length > 0) {
    return { exitCode: EXIT_CODES.usage, stderr: USAGE };
  }

  try {
    const dataDir = resolveDataDir({ env: io.env });
    await openDataDirectory(dataDir);
    const found = await findAutomations(dataDir, wanted, values.workspace);
    const [first, ...others] = found;
    if (first === undefined) {
      const where = values.workspace === undefined ? '' : ` in Workspace "${values.workspace}"`;
      return { exitCode: EXIT_CODES.cannotStart, stderr: `No automation "${wanted}"${where}.` };
    }
    if (others.length > 0) {
      const names = found.map(({ workspaceName }) => workspaceName).join(', ');
      return {
        exitCode: EXIT_CODES.cannotStart,
        stderr: `Several Workspaces hold "${wanted}": ${names}. Choose one with --workspace.`,
      };
    }
    let inputs: Readonly<Record<string, LiteralValue>>;
    try {
      inputs = inputsFrom(first, values.input ?? []);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      const lines = [`"${first.automation.name}" cannot take these inputs:`];
      return {
        exitCode: EXIT_CODES.usage,
        stderr: [...lines, ...error.problems.map((problem) => `  ${problem}`)].join('\n'),
      };
    }
    return { exitCode: await runAutomation(dataDir, first, inputs, io) };
  } catch (error) {
    return {
      exitCode: EXIT_CODES.cannotStart,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs one CLI invocation and returns what the process should print and exit with. */
export async function runCli(
  args: readonly string[],
  version: string,
  io: CliIo,
): Promise<CliResult> {
  const [command, ...rest] = args;
  if (command === '--version' || command === '-v') {
    return { exitCode: EXIT_CODES.completed, stdout: `${getCoreInfo().productName} ${version}` };
  }
  if (command === 'run') {
    return runCommand(rest, io);
  }
  return { exitCode: EXIT_CODES.usage, stderr: USAGE };
}
