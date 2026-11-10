import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { normalize } from 'node:path';
import {
  DEFAULT_CASE,
  ExpressionError,
  automationRuleIssues,
  connectionOutput,
  expressionsOf,
  findStepOutputReferences,
  isExpressionValue,
  replaceRunReferences,
  runtimeText,
  targetsOf,
  toParameterValue,
  usesRunFolder,
  valueRuleHolds,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  Automation,
  LiteralValue,
  RunBlock,
  RuntimeValue,
} from '@bildora/protocol';
import type {
  AutomationFailure,
  AutomationStepRecord,
  TakenPath,
  AutomationTrigger,
  RunHistory,
} from '../history/run-history.js';
import { getProfile } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { ParameterValue, ParameterValues } from '../runner/command-line.js';
import type { PathVariables } from '../runner/expand-paths.js';
import type { RunProgress } from '../runner/progress-lines.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import { automationRunFolder } from '../storage/data-directory.js';
import { DEFAULT_PREFERENCES, readPreferences } from '../storage/preferences.js';
import { resolveInputs } from './automation-inputs.js';
import { removeRunFolders } from './automation-store.js';
import { evaluateInRun, parametersOf } from './automation-values.js';
import type { OutputValue, RunValueContext } from './automation-values.js';
import { limitStepData, stepOutputs, stepValues } from './step-data.js';
import { OutputError, readToolOutputs, secretOutputFields } from './tool-outputs.js';

const MS_PER_SECOND = 1000;

/** A step refers to something an earlier step did not leave. */
class MissingOutputError extends Error {}

/** A value of a step could not be worked out. */
class ValueError extends Error {}

/** A condition reads something a block did not leave. */
class ConditionError extends Error {}

/** Starts one tool for a step. It may throw, and that counts as the step failing. */
export type StepStarter = (
  tool: RegisteredTool,
  request: {
    readonly automationRunId: string;
    readonly profileId?: string | undefined;
    readonly values: ParameterValues;
    readonly onProgress: (progress: RunProgress) => void;
    /** Nobody may be there to answer, so a console script always applies. */
    readonly answerWithScript: true;
  },
) => Promise<RecordedToolRun>;

/** What became of a request for someone to act. */
export type ManualAnswer = 'confirmed' | 'no-user' | 'cancelled';

export interface ManualRequest {
  readonly stepId: string;
  readonly message: string;
  /** Aborts when the run is cancelled, which must settle the answer. */
  readonly signal: AbortSignal;
}

export interface AutomationRunOptions {
  readonly automation: Automation;
  readonly workspaceId: string;
  readonly trigger: AutomationTrigger;
  /**
   * Values for the inputs its Start block declares, by name. Defaults fill the rest. Values that do
   * not fit make `startAutomationRun` throw an `InputError` before anything runs.
   */
  readonly inputs?: Readonly<Record<string, LiteralValue>> | undefined;
  readonly dataDir: string;
  readonly history: RunHistory;
  readonly startStep: StepStarter;
  /** Finds a tool as the Workspace sees it, when its step comes up. */
  readonly findTool: (id: string) => Promise<RegisteredTool | undefined>;
  readonly pathVariables?: PathVariables | undefined;
  /** Asks a person to act. With none, nobody can answer, so a manual step fails. */
  readonly askForAction?: ((request: ManualRequest) => Promise<ManualAnswer>) | undefined;
  readonly onChange?: ((view: AutomationRunView) => void) | undefined;
  readonly runId?: string | undefined;
  /** Waits for a time. It must settle early when the signal aborts. */
  readonly delay?: ((milliseconds: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface StepView extends AutomationStepRecord {
  /** The kind of block, such as `run` or `if`. */
  readonly type: string;
  readonly progress?: RunProgress;
  /** Set while a manual step waits for someone. */
  readonly message?: string;
  /** When a timed wait ends, in milliseconds since the epoch. */
  readonly resumesAt?: number;
}

export interface AutomationRunView {
  readonly runId: string;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly StepView[];
  /** The connections followed so far. */
  readonly paths: readonly TakenPath[];
}

export interface AutomationResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: number;
  /** What stopped the run. */
  readonly failure?: AutomationFailure;
  /** Every block that failed, those an Error output handled included. */
  readonly failedSteps: readonly string[];
}

export interface AutomationRun {
  readonly runId: string;
  /** Settles when every step has ended. It never rejects. */
  readonly result: Promise<AutomationResult>;
  /** Stops the run, with every tool it started. */
  cancel(): void;
  view(): AutomationRunView;
}

type StepOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: Omit<AutomationFailure, 'stepId'> };

function failed(kind: string, message: string): StepOutcome {
  return { status: 'failed', failure: { kind, message } };
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    const stop = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      settle();
    };
    const timer = setTimeout(stop, milliseconds);
    signal.addEventListener('abort', stop);
    if (signal.aborted) {
      stop();
    }
  });
}

/** A step without what only matters while it is going on. */
function recordOf(step: StepView): AutomationStepRecord {
  const { id, state, startedAt, toolRunId, toolRunIds, attempt, durationMs, failure } = step;
  const { values, outputs, truncated } = step;
  return {
    id,
    state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(toolRunId === undefined ? {} : { toolRunId }),
    ...(toolRunIds === undefined ? {} : { toolRunIds }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined ? {} : { failure }),
    ...(values === undefined ? {} : { values }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

/** Tells whether a path names something that is there. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Where a path of blocks runs, so that a Parallel can end its branches without ending the rest. */
interface Scope {
  readonly controller: AbortController;
  readonly live: Set<RecordedToolRun>;
  readonly children: Set<Scope>;
}

/** The branches of one Parallel, up to its Join. */
interface Region {
  readonly join: string;
  readonly scope: Scope;
  readonly onBranchFailure: 'stop-others' | 'let-finish';
  /** The first failure no Error output handled. */
  failure?: AutomationFailure;
}

interface BlockResult {
  readonly result: 'completed' | 'failed';
  readonly exitCode?: number | undefined;
}

function newScope(parent?: Scope): Scope {
  const scope: Scope = {
    controller: new AbortController(),
    live: new Set(),
    children: new Set(),
  };
  if (parent !== undefined) {
    parent.children.add(scope);
    if (parent.controller.signal.aborted) {
      scope.controller.abort();
    } else {
      parent.controller.signal.addEventListener('abort', () => {
        scope.controller.abort();
      });
    }
  }
  return scope;
}

/** Ends the tools of a scope and of the scopes inside it. */
function cancelScope(scope: Scope): void {
  scope.controller.abort();
  for (const run of scope.live) {
    run.cancel();
  }
  for (const child of scope.children) {
    cancelScope(child);
  }
}

/**
 * Runs an automation by walking its blocks. Clients provide what differs between them, which is how
 * a tool starts and how a person answers, so the desktop app and the CLI share every rule. A problem
 * with the record never changes how a run ends.
 */
export function startAutomationRun(options: AutomationRunOptions): AutomationRun {
  const { workspaceId, trigger, dataDir, history, pathVariables } = options;
  const { automation } = options;
  // Callers check first; a flow saved half built must never reach the scheduler.
  const [broken] = automationRuleIssues(automation);
  if (broken !== undefined) {
    throw new Error(`The automation cannot run: ${broken.message}`);
  }
  const inputs = resolveInputs(automation, options.inputs);
  const variables: PathVariables = pathVariables ?? new Map<string, string>();
  const delay = options.delay ?? waitFor;
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const root = newScope();

  const blocks = new Map(automation.blocks.map((block) => [block.id, block]));
  const steps = new Map<string, StepView>(
    automation.blocks.map(({ id, type }) => [id, { id, type, state: 'idle' }]),
  );
  const outputs = new Map<string, ReadonlyMap<string, OutputValue>>();
  /** Tools and profiles of every run block, which links read; filled when the run begins. */
  const tools = new Map<string, RegisteredTool>();
  const profiles = new Map<string, Profile>();
  const runFolder = automationRunFolder(dataDir, workspaceId, automation.id, runId);
  const usesFolder = automation.blocks.some(
    (block) =>
      (block.type === 'run' &&
        Object.values(block.values ?? {}).some(
          (value) => typeof value === 'string' && usesRunFolder(value),
        )) ||
      expressionsOf([block]).some(({ expression }) =>
        targetsOf(expression).some(({ target }) => target.kind === 'run-folder'),
      ),
  );
  const results = new Map<string, BlockResult>();
  /** A block reached from several paths still runs once. */
  const reached = new Set<string>();
  let status: AutomationRunView['status'] = 'running';
  let cancelledByUser = false;
  /** The connections the run followed, in order. */
  const taken: TakenPath[] = [];
  /** What stopped the run: the first failure that nothing handled. */
  let stopped: AutomationFailure | undefined;

  function view(): AutomationRunView {
    return {
      runId,
      workspaceId,
      automationId: automation.id,
      automationName: automation.name,
      status,
      steps: [...steps.values()],
      paths: [...taken],
    };
  }

  function records(): readonly AutomationStepRecord[] {
    return [...steps.values()].map(recordOf);
  }

  function record(action: () => void): void {
    try {
      action();
    } catch {
      // The run goes on either way, and its row becomes interrupted later if it has to.
    }
  }

  function change(): void {
    options.onChange?.(view());
  }

  function stepView(id: string): StepView {
    return steps.get(id) ?? { id, type: blocks.get(id)?.type ?? '', state: 'idle' };
  }

  function setStep(id: string, changes: Partial<StepView>): void {
    steps.set(id, { ...stepView(id), ...changes });
    change();
  }

  /** Settles a block and stores it, so that another process can follow the run. */
  function finishStep(id: string, outcome: StepOutcome, startedStep: number): void {
    steps.set(id, {
      ...recordOf(stepView(id)),
      type: stepView(id).type,
      state: outcome.status,
      durationMs: performance.now() - startedStep,
      ...(outcome.status === 'failed' ? { failure: outcome.failure } : {}),
    });
    change();
    record(() => {
      history.updateAutomationSteps(runId, records(), taken);
    });
  }

  /** Notes when the run reached a block. The change that follows reports it. */
  function reach(id: string): void {
    reached.add(id);
    steps.set(id, { ...stepView(id), startedAt: Date.now() });
  }

  /** A block that does nothing but direct the run, which is over as soon as it is reached. */
  function passThrough(id: string): void {
    results.set(id, { result: 'completed' });
    setStep(id, { state: 'completed' });
  }

  function targets(id: string, output: string): string[] {
    return automation.connections
      .filter((connection) => connection.from === id && connectionOutput(connection) === output)
      .map(({ to }) => to);
  }

  /** What an earlier block left, a field of a JSON output included. */
  function outputValue(step: string, output: string, field?: string): RuntimeValue | undefined {
    const left = outputs.get(step)?.get(output);
    return field === undefined ? left?.value : left?.fields?.get(field);
  }

  /** Replaces `{{...}}` references in a text value. A path is tidied once something replaced. */
  function expandText(value: string, isPath: boolean): string {
    for (const { step, output, field } of findStepOutputReferences(value)) {
      if (outputValue(step, output, field) === undefined) {
        const what = field === undefined ? output : `${output}.${field}`;
        throw new MissingOutputError(`Step "${step}" did not produce output "${what}"`);
      }
    }
    const replaced = replaceRunReferences(value, {
      runFolder: () => runFolder,
      stepOutput: ({ step, output, field }) => runtimeText(outputValue(step, output, field) ?? ''),
    });
    return replaced !== value && isPath ? normalize(replaced) : replaced;
  }

  function valueContext(): RunValueContext {
    return {
      automation,
      tools,
      profiles,
      inputs,
      outputs,
      runFolder,
      pathVariables: variables,
      expandText,
    };
  }

  /** Works out an expression. A missing output reads as a missing reference, as in text. */
  function worked(text: string, what: string): RuntimeValue {
    try {
      return evaluateInRun(valueContext(), text);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      const message = `${what}: ${error.message}`;
      throw error.code === 'name' ? new MissingOutputError(message) : new ValueError(message);
    }
  }

  async function valuesFor(step: RunBlock, tool: RegisteredTool): Promise<ParameterValues> {
    if (usesFolder) {
      await mkdir(runFolder, { recursive: true });
    }
    const parameters = parametersOf(tool);
    const values: Record<string, ParameterValue> = {};
    for (const [name, value] of Object.entries(step.values ?? {})) {
      const parameter = parameters.find((item) => item.name === name);
      if (isExpressionValue(value)) {
        // The check before the run reports a parameter the tool does not have.
        if (parameter === undefined) continue;
        const result = worked(value.expression, parameter.label);
        try {
          values[name] = toParameterValue(result, parameter.type, { start: 0, end: 0 });
        } catch (error) {
          if (!(error instanceof ExpressionError)) throw error;
          throw new ValueError(`${parameter.label}: ${error.message}`);
        }
        continue;
      }
      const isText = parameter?.type === 'path' || parameter?.type === 'string';
      values[name] =
        isText && typeof value === 'string' ? expandText(value, parameter.type === 'path') : value;
    }
    return values;
  }

  /** Keeps what a block received and produced on its step, within the limit history allows. */
  function recordData(id: string, data: Pick<StepView, 'values' | 'outputs'>): void {
    const current = stepView(id);
    const limited = limitStepData(
      data.values ?? current.values ?? [],
      data.outputs ?? current.outputs ?? [],
    );
    setStep(id, {
      values: limited.values,
      outputs: limited.outputs,
      ...(limited.truncated === undefined ? {} : { truncated: limited.truncated }),
    });
  }

  async function runOnce(step: RunBlock, scope: Scope): Promise<StepOutcome> {
    const isCancelled = (): boolean => scope.controller.signal.aborted;
    let tool: RegisteredTool | undefined;
    try {
      tool = await options.findTool(step.tool);
    } catch {
      tool = undefined;
    }
    if (tool === undefined) {
      return failed('tool-missing', `Tool "${step.tool}" is not installed, or cannot be read`);
    }
    let values: ParameterValues;
    try {
      values = await valuesFor(step, tool);
    } catch (error) {
      if (error instanceof MissingOutputError) return failed('reference', error.message);
      if (error instanceof ValueError) return failed('value', error.message);
      return failed('not-started', 'The run folder could not be created');
    }
    if (isCancelled()) {
      return { status: 'cancelled' };
    }

    let run: RecordedToolRun;
    try {
      run = await options.startStep(tool, {
        automationRunId: runId,
        profileId: step.profile,
        values,
        answerWithScript: true,
        onProgress: (progress) => {
          setStep(step.id, { progress });
        },
      });
    } catch (error) {
      return failed('not-started', error instanceof Error ? error.message : String(error));
    }
    scope.live.add(run);
    setStep(step.id, {
      toolRunId: run.runId,
      toolRunIds: [...(stepView(step.id).toolRunIds ?? []), run.runId],
    });
    recordData(step.id, { values: stepValues(step, run.parameters), outputs: [] });
    if (isCancelled()) {
      run.cancel();
    }
    const result = await run.result;
    scope.live.delete(run);
    if (result.status === 'completed') {
      let left: ReadonlyMap<string, OutputValue>;
      try {
        left = await readToolOutputs(tool, run, variables);
      } catch (error) {
        if (!(error instanceof OutputError)) throw error;
        // The tool ended well, but what it left cannot be used, so the block fails.
        results.set(step.id, { result: 'failed', exitCode: 0 });
        return failed('output', error.message);
      }
      outputs.set(step.id, left);
      recordData(step.id, { outputs: stepOutputs(left, secretOutputFields(tool)) });
      results.set(step.id, { result: 'completed', exitCode: 0 });
      return { status: 'completed' };
    }
    if (result.status === 'failed') {
      results.set(step.id, { result: 'failed', exitCode: result.exitCode });
    }
    return result.status === 'cancelled'
      ? { status: 'cancelled' }
      : { status: 'failed', failure: result.failure };
  }

  /** Runs a tool block to its end, retrying as it says. */
  async function runTool(step: RunBlock, scope: Scope): Promise<StepOutcome> {
    const isCancelled = (): boolean => scope.controller.signal.aborted;
    const startedStep = performance.now();
    const retry = typeof step.onFailure === 'object' ? step.onFailure.retry : undefined;
    const attempts = retry?.attempts ?? 1;
    let outcome: StepOutcome = { status: 'cancelled' };
    for (let attempt = 1; attempt <= attempts && !isCancelled(); attempt += 1) {
      setStep(step.id, { state: 'running', ...(retry === undefined ? {} : { attempt }) });
      outcome = await runOnce(step, scope);
      if (outcome.status !== 'failed') {
        break;
      }
      if (attempt < attempts) {
        await delay((retry?.delaySeconds ?? 0) * MS_PER_SECOND, scope.controller.signal);
        outcome = isCancelled() ? { status: 'cancelled' } : outcome;
      }
    }
    if (outcome.status === 'failed') {
      results.set(step.id, { result: 'failed', exitCode: results.get(step.id)?.exitCode });
    }
    finishStep(step.id, outcome, startedStep);
    return outcome;
  }

  async function waitForAction(id: string, message: string, scope: Scope): Promise<StepOutcome> {
    setStep(id, { message });
    const answer =
      options.askForAction === undefined
        ? 'no-user'
        : await options.askForAction({ stepId: id, message, signal: scope.controller.signal });
    switch (answer) {
      case 'confirmed':
        return { status: 'completed' };
      case 'cancelled':
        return { status: 'cancelled' };
      case 'no-user':
        return failed('no-user', 'This step needs a person, and nobody is there to answer');
    }
  }

  async function waitForTime(id: string, seconds: number, scope: Scope): Promise<StepOutcome> {
    const milliseconds = seconds * MS_PER_SECOND;
    setStep(id, { resumesAt: Date.now() + milliseconds });
    await delay(milliseconds, scope.controller.signal);
    return scope.controller.signal.aborted ? { status: 'cancelled' } : { status: 'completed' };
  }

  async function runWait(id: string, wait: () => Promise<StepOutcome>): Promise<StepOutcome> {
    const startedStep = performance.now();
    setStep(id, { state: 'running' });
    const outcome = await wait();
    if (outcome.status === 'completed') {
      results.set(id, { result: 'completed' });
    } else if (outcome.status === 'failed') {
      results.set(id, { result: 'failed' });
    }
    finishStep(id, outcome, startedStep);
    return outcome;
  }

  /** A failure nothing handled: it ends the branches of its Parallel, or the whole run. */
  function unhandled(failure: AutomationFailure, region: Region | undefined): void {
    if (region === undefined) {
      stopped ??= failure;
      cancelScope(root);
      return;
    }
    region.failure ??= failure;
    if (region.onBranchFailure === 'stop-others') {
      cancelScope(region.scope);
    }
  }

  /** Works out a value a rule reads. One that cannot be worked out fails the block. */
  function ruleValue(text: string): RuntimeValue {
    try {
      return worked(text, 'A rule');
    } catch (error) {
      if (error instanceof MissingOutputError || error instanceof ValueError) {
        throw new ConditionError(error.message);
      }
      throw error;
    }
  }

  async function ruleHolds(rule: AutomationCondition['rules'][number]): Promise<boolean> {
    if (rule.field === 'value') {
      const read = ruleValue(rule.read.expression);
      const value = isExpressionValue(rule.value) ? ruleValue(rule.value.expression) : rule.value;
      const asksDisk = rule.operator === 'exists' || rule.operator === 'not-exists';
      const path = runtimeText(read);
      const exists = asksDisk && path !== '' && (await pathExists(path));
      return valueRuleHolds(rule.operator, read, value, exists);
    }
    const known = results.get(rule.block);
    if (rule.field === 'result') {
      const actual = known?.result ?? 'skipped';
      return rule.operator === 'is' ? actual === rule.value : actual !== rule.value;
    }
    const code = known?.exitCode;
    if (code === undefined) {
      throw new ConditionError(`Block "${rule.block}" left no exit code to read`);
    }
    switch (rule.operator) {
      case 'equals':
        return code === rule.value;
      case 'not-equals':
        return code !== rule.value;
      case 'greater-than':
        return code > rule.value;
      case 'less-than':
        return code < rule.value;
    }
  }

  /** Rules are read in order, and stop as soon as the answer is known. */
  async function holds({ match, rules }: AutomationCondition): Promise<boolean> {
    for (const rule of rules) {
      const holding = await ruleHolds(rule);
      if (match === 'all' && !holding) return false;
      if (match === 'any' && holding) return true;
    }
    return match === 'all';
  }

  async function firstCase(block: Extract<AutomationBlock, { type: 'switch' }>): Promise<string> {
    for (const { id, condition } of block.cases) {
      if (await holds(condition)) return id;
    }
    return DEFAULT_CASE;
  }

  /** Follows the connections of an output. Only a Parallel leaves one with several. */
  async function leave(
    id: string,
    output: string,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    const next = targets(id, output);
    for (const to of next) {
      taken.push({ from: id, output, to });
    }
    await Promise.all(next.map((to) => follow(to, scope, region)));
  }

  /** What follows a block that did work: on to the next, or to wherever its failure leads. */
  async function after(
    id: string,
    outcome: StepOutcome,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    if (outcome.status === 'cancelled') {
      return;
    }
    if (outcome.status === 'completed') {
      return leave(id, 'next', scope, region);
    }
    if (targets(id, 'error').length > 0) {
      return leave(id, 'error', scope, region);
    }
    unhandled({ stepId: id, ...outcome.failure }, region);
  }

  async function runParallel(
    block: Extract<AutomationBlock, { type: 'parallel' }>,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    passThrough(block.id);
    const join = automation.blocks.find(
      (candidate) => candidate.type === 'join' && candidate.parallel === block.id,
    );
    if (join?.type !== 'join') {
      return;
    }
    const inner: Region = {
      join: join.id,
      scope: newScope(scope),
      onBranchFailure: join.onBranchFailure ?? 'stop-others',
    };
    await leave(block.id, 'next', inner.scope, inner);
    if (scope.controller.signal.aborted) {
      return;
    }
    reach(join.id);
    if (inner.failure !== undefined) {
      const { kind, message } = inner.failure;
      results.set(join.id, { result: 'failed' });
      setStep(join.id, { state: 'failed', failure: { kind, message } });
      unhandled(inner.failure, region);
      return;
    }
    passThrough(join.id);
    await leave(join.id, 'next', scope, region);
  }

  async function walk(
    block: AutomationBlock,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    switch (block.type) {
      case 'start':
        passThrough(block.id);
        return leave(block.id, 'next', scope, region);
      case 'run':
        return after(block.id, await runTool(block, scope), scope, region);
      case 'wait-for-time':
        return after(
          block.id,
          await runWait(block.id, () => waitForTime(block.id, block.seconds, scope)),
          scope,
          region,
        );
      case 'wait-for-manual-action':
        return after(
          block.id,
          await runWait(block.id, () => waitForAction(block.id, block.message, scope)),
          scope,
          region,
        );
      case 'if': {
        const taken = await holds(block.condition);
        passThrough(block.id);
        return leave(block.id, taken ? 'true' : 'false', scope, region);
      }
      case 'switch': {
        const taken = await firstCase(block);
        passThrough(block.id);
        return leave(block.id, taken, scope, region);
      }
      case 'parallel':
        return runParallel(block, scope, region);
      case 'join':
        // Reached on a path outside its Parallel, which a valid automation does not have.
        passThrough(block.id);
        return leave(block.id, 'next', scope, region);
    }
  }

  /** Runs the block, then whatever follows it, and settles when this path has ended. */
  async function follow(id: string, scope: Scope, region: Region | undefined): Promise<void> {
    const block = blocks.get(id);
    if (block === undefined || scope.controller.signal.aborted) {
      return;
    }
    if (block.type === 'join' && region?.join === id) {
      // A branch that reaches its Join ends there, and the Parallel carries on once all have.
      return;
    }
    if (reached.has(id)) {
      return;
    }
    reach(id);
    try {
      await walk(block, scope, region);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof ConditionError ? 'condition' : 'not-started';
      finishStep(id, failed(kind, message), performance.now());
      unhandled({ stepId: id, kind, message }, region);
    }
  }

  async function execute(): Promise<AutomationResult> {
    // Lets the caller hold the run before any step reaches back to it.
    await Promise.resolve();
    record(() => {
      history.startAutomationRun({
        runId,
        workspaceId,
        automationId: automation.id,
        automationName: automation.name,
        trigger,
        startedAt,
        steps: records(),
      });
    });
    change();

    // Links read what any block is set to, wherever it sits, so every tool and profile is known first.
    for (const block of automation.blocks) {
      if (block.type !== 'run') continue;
      const tool = await options.findTool(block.tool).catch(() => undefined);
      if (tool === undefined) continue;
      tools.set(block.id, tool);
      if (block.profile === undefined) continue;
      const profile = await getProfile(tool, block.profile).catch(() => undefined);
      if (profile !== undefined) profiles.set(block.id, profile);
    }

    const start = automation.blocks.find(({ type }) => type === 'start');
    if (start !== undefined) {
      await follow(start.id, root, undefined);
    }

    status = stopped !== undefined ? 'failed' : cancelledByUser ? 'cancelled' : 'completed';
    if (status === 'completed') {
      // What the run did not reach is on a path it did not take.
      for (const [id, step] of steps) {
        if (step.state === 'idle') {
          steps.set(id, { ...step, state: 'skipped' });
        }
      }
    }
    const failure = stopped;
    const durationMs = Date.now() - startedAt;
    const finalStatus = status;
    record(() => {
      history.finishAutomationRun(runId, {
        status: finalStatus,
        durationMs,
        failure,
        steps: records(),
        paths: taken,
      });
    });
    change();
    const { historyRunLimit } = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
    await Promise.resolve()
      .then(() => history.pruneAutomationRuns(workspaceId, automation.id, historyRunLimit))
      .then((removed) => removeRunFolders(dataDir, removed))
      .catch(() => undefined);

    return {
      runId,
      status: finalStatus,
      durationMs,
      ...(failure === undefined ? {} : { failure }),
      failedSteps: [...steps.values()]
        .filter(({ state }) => state === 'failed')
        .map(({ id }) => id),
    };
  }

  return {
    runId,
    result: execute(),
    cancel() {
      cancelledByUser = true;
      cancelScope(root);
    },
    view,
  };
}
