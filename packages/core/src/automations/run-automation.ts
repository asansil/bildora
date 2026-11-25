import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BODY_OUTPUT,
  DEFAULT_CASE,
  ExpressionError,
  LOOP_ROUNDS_MAX,
  automationRuleIssues,
  connectionOutput,
  disabledOutput,
  expressionsOf,
  isExpressionValue,
  loopChain,
  runtimeText,
  targetOf,
  targetsOf,
  usesRunFolder,
  valueRuleHolds,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  Automation,
  ForBlock,
  LiteralValue,
  LoopBlock,
  RunAutomationBlock,
  RunBlock,
  RuntimeValue,
  WhileBlock,
} from '@bildora/protocol';
import type {
  AutomationCaller,
  AutomationFailure,
  AutomationRunTest,
  AutomationStepRecord,
  StepValueRecord,
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
import { InputError, resolveInputs } from './automation-inputs.js';
import { removeRunFolders } from './automation-store.js';
import {
  emptyValueOf,
  evaluateInRun,
  insideLoop,
  isDisabledBlock,
  parametersOf,
} from './automation-values.js';
import type { OutputValue, RunValueContext } from './automation-values.js';
import { leafTree } from './call-tree.js';
import type { CallTree } from './call-tree.js';
import { TooManyItemsError, folderItems } from './folder-items.js';
import {
  MissingOutputError,
  ValueError,
  frameValues,
  gatherTrees,
  newFrame,
  roundKey,
} from './run-frame.js';
import type { Frame, OutputTree } from './run-frame.js';
import { STEP_DATA_LIMIT, limitStepData, stepOutputs, stepValues } from './step-data.js';
import { baseFrame, blocksFrom, testRound } from './test-run.js';
import type { BaseRun, TestKind } from './test-run.js';
import { OutputError, readToolOutputs, secretOutputFields } from './tool-outputs.js';

const MS_PER_SECOND = 1000;

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
  /** The round of a step inside a loop. */
  readonly round?: string;
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
  /**
   * The automations it can call, read with `readCallTree` when the run starts. A Run automation
   * block whose call is not in it fails.
   */
  readonly calls?: CallTree | undefined;
  /** Set when a Run automation block of another run started this one. */
  readonly caller?: AutomationCaller | undefined;
  /**
   * Starts a called run. Clients pass their own to follow called runs as they follow any other;
   * `startAutomationRun` is used when they do not.
   */
  readonly startCalled?: ((options: AutomationRunOptions) => AutomationRun) | undefined;
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
  /**
   * Makes the run a test from the app: one block, or a block and everything after it, on what a
   * base run left. Check it with `planTest` first; a test that cannot start throws.
   */
  readonly test?: AutomationTest | undefined;
}

export interface AutomationTest {
  readonly kind: TestKind;
  readonly blockId: string;
  /** For Test block inside loops, the round it runs in. The last of each loop when left out. */
  readonly round?: string | undefined;
  /** The run whose values and folder it reuses. With none, only typed values are there. */
  readonly base?: BaseRun | undefined;
  /** For Test block, values typed over the block's own, by parameter or input name. */
  readonly values?: Readonly<Record<string, LiteralValue>> | undefined;
}

/** An automation whose tested block takes typed values over its own. */
function withTypedValues(
  automation: Automation,
  id: string,
  typed: Readonly<Record<string, LiteralValue>>,
): Automation {
  return {
    ...automation,
    blocks: automation.blocks.map((block) => {
      if (block.id !== id) return block;
      if (block.type === 'run') return { ...block, values: { ...block.values, ...typed } };
      if (block.type === 'run-automation') {
        return { ...block, inputs: { ...block.inputs, ...typed } };
      }
      return block;
    }),
  };
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
  /** One per block outside loops, and one per round for blocks inside them. */
  readonly steps: readonly StepView[];
  /** The connections followed so far. */
  readonly paths: readonly TakenPath[];
  readonly caller?: AutomationCaller;
  readonly test?: AutomationRunTest;
}

export type { OutputTree } from './run-frame.js';

export interface AutomationResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: number;
  /** What stopped the run. */
  readonly failure?: AutomationFailure;
  /** Every block that failed, those an Error output handled included, each once. */
  readonly failedSteps: readonly string[];
  /** What its blocks left, for a run that called this one. */
  readonly outputs: OutputTree;
}

export interface AutomationRun {
  readonly runId: string;
  /** Settles when every step has ended. It never rejects. */
  readonly result: Promise<AutomationResult>;
  /** Stops the run, with every tool and called run it started. */
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
  const { id, round, state, startedAt, toolRunId, toolRunIds, attempt, durationMs, failure } = step;
  const { values, outputs, truncated, rounds, calledRunId, items, reused, took } = step;
  return {
    id,
    ...(round === undefined ? {} : { round }),
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
    ...(rounds === undefined ? {} : { rounds }),
    ...(calledRunId === undefined ? {} : { calledRunId }),
    ...(items === undefined ? {} : { items }),
    ...(reused === undefined ? {} : { reused }),
    ...(took === undefined ? {} : { took }),
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

/** Something a scope can stop: a tool run or a called automation run. */
interface Stoppable {
  cancel(): void;
}

/** Where a path of blocks runs, so that a Parallel can end its branches without ending the rest. */
interface Scope {
  readonly controller: AbortController;
  readonly live: Set<Stoppable>;
  readonly children: Set<Scope>;
}

/** The branches of one Parallel up to its Join, or one round of a loop. */
interface Region {
  /** The Join that ends the branches. A round has none. */
  readonly join?: string;
  readonly scope: Scope;
  readonly onBranchFailure: 'stop-others' | 'let-finish';
  /** The first failure no Error output handled. */
  failure?: AutomationFailure;
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

/** Whether a scope was stopped. A function, so that a check after a wait reads it afresh. */
function isAborted(scope: Scope): boolean {
  return scope.controller.signal.aborted;
}

/** The first failure a region met, read afresh after a wait. */
function failureOf(region: Region): AutomationFailure | undefined {
  return region.failure;
}

/** Ends the tools and called runs of a scope and of the scopes inside it. */
function cancelScope(scope: Scope): void {
  scope.controller.abort();
  for (const run of scope.live) {
    run.cancel();
  }
  for (const child of scope.children) {
    cancelScope(child);
  }
}

/** A key for a step, which a block inside a loop has once per round. */
function stepKey(id: string, round: string | undefined): string {
  return round === undefined ? id : `${id}\u0000${round}`;
}

/**
 * Runs an automation by walking its blocks. Clients provide what differs between them, which is how
 * a tool starts and how a person answers, so the desktop app and the CLI share every rule. A problem
 * with the record never changes how a run ends.
 */
export function startAutomationRun(options: AutomationRunOptions): AutomationRun {
  const { workspaceId, trigger, dataDir, history, pathVariables, test } = options;
  const automation =
    test?.kind === 'block' && test.values !== undefined
      ? withTypedValues(options.automation, test.blockId, test.values)
      : options.automation;
  // Callers check first; a flow saved half built must never reach the scheduler.
  const [broken] = automationRuleIssues(automation);
  if (broken !== undefined) {
    throw new Error(`The automation cannot run: ${broken.message}`);
  }
  const inputs = test?.base?.inputs ?? resolveInputs(automation, options.inputs);
  const callTree = options.calls ?? leafTree(automation);
  const variables: PathVariables = pathVariables ?? new Map<string, string>();
  const delay = options.delay ?? waitFor;
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const root = newScope();
  // A test writes to the folder of the run it reuses, where earlier blocks left their files.
  const runFolder = automationRunFolder(
    dataDir,
    workspaceId,
    automation.id,
    test?.base?.folderRunId ?? runId,
  );
  const tested =
    test === undefined
      ? undefined
      : {
          ...test,
          round:
            test.kind === 'block'
              ? testRound(automation, test.base, test.blockId, test.round)
              : undefined,
          again:
            test.kind === 'from' ? blocksFrom(automation, test.blockId) : new Set([test.blockId]),
        };
  /** Where the run starts: the top, or for a test, the frame of the tested block. */
  const first = ((): Frame => {
    if (tested === undefined) return newFrame();
    const found = baseFrame(automation, tested.base, {
      kind: tested.kind,
      blockId: tested.blockId,
      round: tested.round,
      runFolder,
    });
    if ('blocker' in found) throw new Error(`The test cannot start: ${found.blocker.code}`);
    return found;
  })();
  const testRecord: AutomationRunTest | undefined =
    tested === undefined
      ? undefined
      : {
          kind: tested.kind,
          blockId: tested.blockId,
          ...(tested.round === undefined ? {} : { round: tested.round }),
          ...(tested.base === undefined ? {} : { baseRunId: tested.base.runId }),
        };
  let top = first;
  while (top.parent !== undefined) top = top.parent;

  const blocks = new Map(automation.blocks.map((block) => [block.id, block]));
  /** Whether a step is one a test runs again, rather than one it reuses. */
  const runsAgain = (id: string, round: string | undefined): boolean =>
    tested === undefined ||
    (tested.kind === 'from'
      ? tested.again.has(id)
      : id === tested.blockId && round === tested.round);
  // Blocks inside loops get a step per round, as their rounds come. A test starts with the steps it
  // reuses.
  const steps = new Map<string, StepView>([
    ...(tested?.base?.steps ?? [])
      .filter((step) => !runsAgain(step.id, step.round))
      .map((step): [string, StepView] => [
        stepKey(step.id, step.round),
        { ...step, type: blocks.get(step.id)?.type ?? '', reused: true },
      ]),
    ...automation.blocks
      .filter((block) =>
        tested === undefined
          ? !('loop' in block) || block.loop === undefined
          : tested.kind === 'from'
            ? tested.again.has(block.id) && (!('loop' in block) || block.loop === undefined)
            : block.id === tested.blockId,
      )
      .map(({ id, type }): [string, StepView] => {
        const round = tested?.kind === 'block' ? tested.round : undefined;
        return [
          stepKey(id, round),
          { id, type, state: 'idle', ...(round === undefined ? {} : { round }) },
        ];
      }),
  ]);
  /** Tools and profiles of every run block, which links read; filled when the run begins. */
  const tools = new Map<string, RegisteredTool>();
  const profiles = new Map<string, Profile>();
  /** JSON fields marked secret, by block, which a called run does not hand back. */
  const secretFields = new Map<string, ReadonlySet<string>>();
  const usesFolder = automation.blocks.some(
    (block) =>
      (block.type === 'run' &&
        Object.values(block.values ?? {}).some(
          (value) => typeof value === 'string' && usesRunFolder(value),
        )) ||
      expressionsOf([block]).some(({ expression }) =>
        targetsOf(expression).some(
          ({ target }) =>
            target.kind === 'run-folder' || (target.kind === 'loop' && target.value === 'folder'),
        ),
      ),
  );
  let status: AutomationRunView['status'] = 'running';
  let cancelledByUser = false;
  /** The connections the run followed, in order. */
  const taken: TakenPath[] = (tested?.base?.paths ?? []).filter(
    ({ from, round }) => !runsAgain(from, round),
  );
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
      ...(options.caller === undefined ? {} : { caller: options.caller }),
      ...(testRecord === undefined ? {} : { test: testRecord }),
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

  function stepView(id: string, frame: Frame): StepView {
    const round = frame.round?.key;
    return (
      steps.get(stepKey(id, round)) ?? {
        id,
        ...(round === undefined ? {} : { round }),
        type: blocks.get(id)?.type ?? '',
        state: 'idle',
      }
    );
  }

  function setStep(id: string, frame: Frame, changes: Partial<StepView>): void {
    steps.set(stepKey(id, frame.round?.key), { ...stepView(id, frame), ...changes });
    change();
  }

  /** Settles a block and stores it, so that another process can follow the run. */
  function finishStep(id: string, frame: Frame, outcome: StepOutcome, startedStep: number): void {
    const current = stepView(id, frame);
    steps.set(stepKey(id, frame.round?.key), {
      ...recordOf(current),
      type: current.type,
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
  function reach(id: string, frame: Frame): void {
    frame.reached.add(id);
    steps.set(stepKey(id, frame.round?.key), { ...stepView(id, frame), startedAt: Date.now() });
  }

  /** A block that does nothing but direct the run, which is over as soon as it is reached. */
  function passThrough(id: string, frame: Frame): void {
    frame.results.set(id, { result: 'completed' });
    setStep(id, frame, { state: 'completed' });
  }

  function targets(id: string, output: string): string[] {
    return automation.connections
      .filter((connection) => connection.from === id && connectionOutput(connection) === output)
      .map(({ to }) => to);
  }

  const { expandText, valueContext, worked, blockValue, resultOf } = frameValues({
    automation,
    tools,
    profiles,
    inputs,
    runFolder,
    pathVariables: variables,
  });

  async function valuesFor(
    frame: Frame,
    step: RunBlock,
    tool: RegisteredTool,
  ): Promise<ParameterValues> {
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
        values[name] = blockValue(frame, value, parameter.type, parameter.label);
        continue;
      }
      const isText = parameter?.type === 'path' || parameter?.type === 'string';
      values[name] =
        isText && typeof value === 'string'
          ? expandText(frame, value, parameter.type === 'path')
          : value;
    }
    return values;
  }

  /** Keeps what a block received and produced on its step, within the limit history allows. */
  function recordData(id: string, frame: Frame, data: Pick<StepView, 'values' | 'outputs'>): void {
    const current = stepView(id, frame);
    const limited = limitStepData(
      data.values ?? current.values ?? [],
      data.outputs ?? current.outputs ?? [],
    );
    setStep(id, frame, {
      values: limited.values,
      outputs: limited.outputs,
      ...(limited.truncated === undefined ? {} : { truncated: limited.truncated }),
    });
  }

  async function runOnce(step: RunBlock, frame: Frame, scope: Scope): Promise<StepOutcome> {
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
      values = await valuesFor(frame, step, tool);
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
          setStep(step.id, frame, { progress });
        },
      });
    } catch (error) {
      return failed('not-started', error instanceof Error ? error.message : String(error));
    }
    scope.live.add(run);
    setStep(step.id, frame, {
      toolRunId: run.runId,
      toolRunIds: [...(stepView(step.id, frame).toolRunIds ?? []), run.runId],
    });
    recordData(step.id, frame, { values: stepValues(step, run.parameters), outputs: [] });
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
        frame.results.set(step.id, { result: 'failed', exitCode: 0 });
        return failed('output', error.message);
      }
      frame.outputs.set(step.id, left);
      secretFields.set(step.id, secretOutputFields(tool));
      recordData(step.id, frame, { outputs: stepOutputs(left, secretOutputFields(tool)) });
      frame.results.set(step.id, { result: 'completed', exitCode: 0 });
      return { status: 'completed' };
    }
    if (result.status === 'failed') {
      frame.results.set(step.id, { result: 'failed', exitCode: result.exitCode });
    }
    return result.status === 'cancelled'
      ? { status: 'cancelled' }
      : { status: 'failed', failure: result.failure };
  }

  /** Runs a block that can retry to its end, retrying as it says. */
  async function withRetries(
    block: RunBlock | RunAutomationBlock,
    frame: Frame,
    scope: Scope,
    once: () => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const isCancelled = (): boolean => scope.controller.signal.aborted;
    const startedStep = performance.now();
    const retry = typeof block.onFailure === 'object' ? block.onFailure.retry : undefined;
    const attempts = retry?.attempts ?? 1;
    let outcome: StepOutcome = { status: 'cancelled' };
    for (let attempt = 1; attempt <= attempts && !isCancelled(); attempt += 1) {
      setStep(block.id, frame, { state: 'running', ...(retry === undefined ? {} : { attempt }) });
      outcome = await once();
      if (outcome.status !== 'failed') {
        break;
      }
      if (attempt < attempts) {
        await delay((retry?.delaySeconds ?? 0) * MS_PER_SECOND, scope.controller.signal);
        outcome = isCancelled() ? { status: 'cancelled' } : outcome;
      }
    }
    if (outcome.status === 'failed') {
      frame.results.set(block.id, {
        result: 'failed',
        exitCode: frame.results.get(block.id)?.exitCode,
      });
    }
    finishStep(block.id, frame, outcome, startedStep);
    return outcome;
  }

  /** What a called run hands back: its outputs without the fields marked secret. */
  function handedBack(frame: Frame): OutputTree {
    return {
      outputs: new Map(
        [...frame.outputs].map(([id, left]) => {
          const secret = secretFields.get(id);
          if (secret === undefined || secret.size === 0) return [id, left];
          return [
            id,
            new Map(
              [...left].map(([name, output]) => [
                name,
                {
                  value: output.value,
                  ...(output.fields === undefined
                    ? {}
                    : {
                        fields: new Map(
                          [...output.fields].filter(([field]) => !secret.has(`${name}.${field}`)),
                        ),
                      }),
                },
              ]),
            ),
          ];
        }),
      ),
      calls: frame.calls,
    };
  }

  /** Runs the automation a Run automation block calls, once, and keeps what it hands back. */
  async function callOnce(
    block: RunAutomationBlock,
    frame: Frame,
    scope: Scope,
  ): Promise<StepOutcome> {
    const called = callTree.calls.get(block.id);
    if (called === undefined) {
      return failed(
        'automation-missing',
        `Automation "${block.automation}" does not exist in this Workspace, or cannot be read`,
      );
    }
    const start = called.automation.blocks.find(({ type }) => type === 'start');
    const declared = start?.type === 'start' ? (start.inputs ?? []) : [];
    const given: Record<string, LiteralValue> = {};
    const recorded: StepValueRecord[] = [];
    try {
      for (const [name, value] of Object.entries(block.inputs ?? {})) {
        const input = declared.find((candidate) => candidate.name === name);
        if (input === undefined) continue;
        const label = input.label ?? input.name;
        given[name] = blockValue(frame, value, input.type, label);
        recorded.push({
          name,
          label,
          value: given[name],
          ...(isExpressionValue(value) ? { from: value.expression } : {}),
        });
      }
    } catch (error) {
      if (error instanceof MissingOutputError) return failed('reference', error.message);
      if (error instanceof ValueError) return failed('value', error.message);
      throw error;
    }
    recordData(block.id, frame, { values: recorded, outputs: [] });
    if (scope.controller.signal.aborted) return { status: 'cancelled' };
    let child: AutomationRun;
    try {
      child = (options.startCalled ?? startAutomationRun)({
        automation: called.automation,
        workspaceId,
        trigger,
        inputs: given,
        calls: called,
        caller: {
          runId,
          blockId: block.id,
          ...(frame.round === undefined ? {} : { round: frame.round.key }),
        },
        startCalled: options.startCalled,
        dataDir,
        history,
        startStep: options.startStep,
        findTool: options.findTool,
        pathVariables: options.pathVariables,
        askForAction: options.askForAction,
        delay: options.delay,
      });
    } catch (error) {
      if (error instanceof InputError) return failed('value', error.message);
      return failed('not-started', error instanceof Error ? error.message : String(error));
    }
    scope.live.add(child);
    setStep(block.id, frame, { calledRunId: child.runId });
    const result = await child.result;
    scope.live.delete(child);
    if (result.status === 'cancelled') {
      // Cancelling a called run cancels the run that called it, as the other way round.
      if (!isAborted(scope)) {
        cancelledByUser = true;
        cancelScope(root);
      }
      return { status: 'cancelled' };
    }
    if (result.status === 'failed') {
      const reason = result.failure?.message ?? 'it failed';
      return failed('called-run', `"${called.automation.name}" failed: ${reason}`);
    }
    frame.calls.set(block.id, result.outputs);
    frame.results.set(block.id, { result: 'completed' });
    return { status: 'completed' };
  }

  async function waitForAction(
    id: string,
    frame: Frame,
    message: string,
    scope: Scope,
  ): Promise<StepOutcome> {
    setStep(id, frame, { message });
    const answer =
      options.askForAction === undefined
        ? 'no-user'
        : await options.askForAction({
            stepId: id,
            ...(frame.round === undefined ? {} : { round: frame.round.key }),
            message,
            signal: scope.controller.signal,
          });
    switch (answer) {
      case 'confirmed':
        return { status: 'completed' };
      case 'cancelled':
        return { status: 'cancelled' };
      case 'no-user':
        return failed('no-user', 'This step needs a person, and nobody is there to answer');
    }
  }

  async function waitForTime(
    id: string,
    frame: Frame,
    seconds: number,
    scope: Scope,
  ): Promise<StepOutcome> {
    const milliseconds = seconds * MS_PER_SECOND;
    setStep(id, frame, { resumesAt: Date.now() + milliseconds });
    await delay(milliseconds, scope.controller.signal);
    return scope.controller.signal.aborted ? { status: 'cancelled' } : { status: 'completed' };
  }

  async function runWait(
    id: string,
    frame: Frame,
    wait: () => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const startedStep = performance.now();
    setStep(id, frame, { state: 'running' });
    const outcome = await wait();
    if (outcome.status === 'completed') {
      frame.results.set(id, { result: 'completed' });
    } else if (outcome.status === 'failed') {
      frame.results.set(id, { result: 'failed' });
    }
    finishStep(id, frame, outcome, startedStep);
    return outcome;
  }

  /** A failure nothing handled: it ends its round, the branches of its Parallel, or the run. */
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
  function ruleValue(frame: Frame, text: string): RuntimeValue {
    try {
      return worked(frame, text, 'A rule');
    } catch (error) {
      if (error instanceof MissingOutputError || error instanceof ValueError) {
        throw new ConditionError(error.message);
      }
      throw error;
    }
  }

  async function ruleHolds(
    frame: Frame,
    rule: AutomationCondition['rules'][number],
  ): Promise<boolean> {
    if (rule.field === 'value') {
      const read = ruleValue(frame, rule.read.expression);
      const value = isExpressionValue(rule.value)
        ? ruleValue(frame, rule.value.expression)
        : rule.value;
      const asksDisk = rule.operator === 'exists' || rule.operator === 'not-exists';
      const path = runtimeText(read);
      const exists = asksDisk && path !== '' && (await pathExists(path));
      return valueRuleHolds(rule.operator, read, value, exists);
    }
    const known = resultOf(frame, rule.block);
    if (rule.field === 'result') {
      const actual = known?.result ?? 'skipped';
      return rule.operator === 'is' ? actual === rule.value : actual !== rule.value;
    }
    const code = known?.exitCode;
    if (code === undefined) {
      throw new ConditionError(
        isDisabledBlock(automation, rule.block)
          ? `Block "${rule.block}" is disabled, so it left no exit code to read`
          : `Block "${rule.block}" left no exit code to read`,
      );
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
  async function holds(frame: Frame, { match, rules }: AutomationCondition): Promise<boolean> {
    for (const rule of rules) {
      const holding = await ruleHolds(frame, rule);
      if (match === 'all' && !holding) return false;
      if (match === 'any' && holding) return true;
    }
    return match === 'all';
  }

  async function firstCase(
    frame: Frame,
    block: Extract<AutomationBlock, { type: 'switch' }>,
  ): Promise<string> {
    for (const { id, condition } of block.cases) {
      if (await holds(frame, condition)) return id;
    }
    return DEFAULT_CASE;
  }

  /**
   * Whether a While goes on, read in `previous`, the round before. Before the first round it is an
   * empty one, where the body's outputs read as empty values.
   */
  function whileHolds(previous: Frame, block: WhileBlock): boolean {
    const base = valueContext(previous);
    const inside = insideLoop(automation, block.id);
    const context: RunValueContext = {
      ...base,
      emptyOutput: (name) => {
        const target = targetOf(name);
        if (target.kind !== 'output') return undefined;
        return loopChain(automation.blocks, target.block).includes(block.id)
          ? emptyValueOf(base, inside, name)
          : base.emptyOutput?.(name);
      },
    };
    try {
      return evaluateInRun(context, block.condition.expression) === true;
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      throw new ConditionError(`The condition: ${error.message}`);
    }
  }

  /** Follows the connections of an output. Only a Parallel leaves one with several. */
  async function leave(
    id: string,
    output: string,
    frame: Frame,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    const next = targets(id, output);
    for (const to of next) {
      taken.push({
        from: id,
        output,
        to,
        ...(frame.round === undefined ? {} : { round: frame.round.key }),
      });
    }
    // Test block shows where the block leads, and goes no further.
    if (tested?.kind === 'block') return;
    await Promise.all(next.map((to) => follow(to, frame, scope, region)));
  }

  /** What follows a block that did work: on to the next, or to wherever its failure leads. */
  async function after(
    id: string,
    outcome: StepOutcome,
    frame: Frame,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    if (outcome.status === 'cancelled') {
      return;
    }
    if (outcome.status === 'completed') {
      return leave(id, 'next', frame, scope, region);
    }
    // A tested block that failed is what the test is about, whatever its Error output does.
    if (targets(id, 'error').length > 0 && tested?.kind !== 'block') {
      return leave(id, 'error', frame, scope, region);
    }
    unhandled(
      {
        stepId: id,
        ...(frame.round === undefined ? {} : { round: frame.round.key }),
        ...outcome.failure,
      },
      region,
    );
  }

  async function runParallel(
    block: Extract<AutomationBlock, { type: 'parallel' }>,
    frame: Frame,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    passThrough(block.id, frame);
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
    await leave(block.id, 'next', frame, inner.scope, inner);
    if (scope.controller.signal.aborted) {
      return;
    }
    reach(join.id, frame);
    if (inner.failure !== undefined) {
      const { kind, message } = inner.failure;
      frame.results.set(join.id, { result: 'failed' });
      setStep(join.id, frame, { state: 'failed', failure: { kind, message } });
      unhandled(inner.failure, region);
      return;
    }
    passThrough(join.id, frame);
    await leave(join.id, 'next', frame, scope, region);
  }

  /** The items a For goes through, or the failure that stops it before its first round. */
  async function itemsOf(
    block: ForBlock,
    frame: Frame,
  ): Promise<readonly RuntimeValue[] | StepOutcome> {
    const { items } = block;
    const tooMany = failed(
      'too-many-items',
      `There are more than ${String(LOOP_ROUNDS_MAX)} items to go through`,
    );
    try {
      switch (items.kind) {
        case 'list': {
          const list = worked(frame, items.list.expression, 'The items');
          if (!Array.isArray(list)) return failed('items', 'The items are not a list');
          return list.length > LOOP_ROUNDS_MAX ? tooMany : (list as readonly string[]);
        }
        case 'count': {
          const count = isExpressionValue(items.count)
            ? worked(frame, items.count.expression, 'The number of times')
            : items.count;
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
            return failed('items', 'The number of times is not a whole number from 0');
          }
          if (count > LOOP_ROUNDS_MAX) return tooMany;
          return Array.from({ length: count }, (_, index) => index + 1);
        }
        case 'folder': {
          const folder = runtimeText(blockValue(frame, items.folder, 'path', 'The folder'));
          try {
            return await folderItems(folder, items, LOOP_ROUNDS_MAX);
          } catch (error) {
            if (error instanceof TooManyItemsError) return tooMany;
            return failed('items', `The folder "${folder}" cannot be read`);
          }
        }
      }
    } catch (error) {
      if (error instanceof MissingOutputError) return failed('reference', error.message);
      if (error instanceof ValueError) return failed('value', error.message);
      throw error;
    }
  }

  /**
   * Runs a loop's body once per round, one round at a time, then gathers what its blocks left
   * into lists, one value per round, for the blocks after it.
   */
  async function runLoop(block: LoopBlock, frame: Frame, scope: Scope): Promise<StepOutcome> {
    const startedStep = performance.now();
    setStep(block.id, frame, { state: 'running', rounds: 0 });
    const finish = (outcome: StepOutcome, rounds: readonly Frame[]): StepOutcome => {
      const gathered = gatherTrees(rounds.map((round) => round));
      gathered.outputs.forEach((left, id) => frame.outputs.set(id, left));
      gathered.calls.forEach((tree, id) => frame.calls.set(id, tree));
      frame.outputs.set(block.id, new Map([['rounds', { value: rounds.length }]]));
      if (outcome.status !== 'cancelled') {
        frame.results.set(block.id, {
          result: outcome.status === 'completed' ? 'completed' : 'failed',
        });
      }
      finishStep(block.id, frame, outcome, startedStep);
      return outcome;
    };
    let items: readonly RuntimeValue[] | undefined;
    if (block.type === 'for') {
      const found = await itemsOf(block, frame);
      if (!Array.isArray(found)) return finish(found as StepOutcome, []);
      items = found as readonly RuntimeValue[];
      if (block.items.kind !== 'count') {
        // Each round's item, while they fit, so that a test can repeat a round.
        const texts = items.map((item) => runtimeText(item));
        if (JSON.stringify(texts).length <= STEP_DATA_LIMIT)
          setStep(block.id, frame, { items: texts });
      }
    }
    const [body] = targets(block.id, BODY_OUTPUT);
    const most = items?.length ?? (block.type === 'while' ? block.maxRounds : 0);
    const goOn = block.onRoundFailure === 'continue';
    const rounds: Frame[] = [];
    let firstFailure: AutomationFailure | undefined;
    const ended = (): StepOutcome =>
      finish(
        firstFailure === undefined
          ? { status: 'completed' }
          : failed('rounds-failed', `A round failed: ${firstFailure.message}`),
        rounds,
      );
    /** For a While, whether it goes on after `previous`, or the failure of its condition. */
    const goesOn = (previous: Frame): boolean | StepOutcome => {
      if (block.type !== 'while') return true;
      try {
        return whileHolds(previous, block);
      } catch (error) {
        if (!(error instanceof ConditionError)) throw error;
        return failed('condition', error.message);
      }
    };
    // Before the first round, the condition reads a round that left nothing.
    let previous = newFrame(frame, {
      loop: block.id,
      item: 0,
      index: 0,
      folder: '',
      key: roundKey(frame, block.id, 0),
    });
    for (let index = 1; index <= most; index += 1) {
      if (scope.controller.signal.aborted) return finish({ status: 'cancelled' }, rounds);
      const going = goesOn(previous);
      if (typeof going !== 'boolean') return finish(going, rounds);
      if (!going) return ended();
      if (index > 1 && block.type === 'while' && block.waitSeconds !== undefined) {
        await delay(block.waitSeconds * MS_PER_SECOND, scope.controller.signal);
        if (isAborted(scope)) return finish({ status: 'cancelled' }, rounds);
      }
      const key = roundKey(frame, block.id, index);
      const parentFolder = frame.round?.folder ?? runFolder;
      const folder = join(parentFolder, block.id, String(index));
      const round = newFrame(frame, {
        loop: block.id,
        item: items?.[index - 1] ?? index,
        index,
        folder,
        key,
      });
      rounds.push(round);
      previous = round;
      setStep(block.id, frame, { rounds: index });
      if (usesFolder) {
        await mkdir(folder, { recursive: true }).catch(() => undefined);
      }
      const region: Region = { scope: newScope(scope), onBranchFailure: 'stop-others' };
      if (body !== undefined) {
        taken.push({
          from: block.id,
          output: BODY_OUTPUT,
          to: body,
          ...(frame.round === undefined ? {} : { round: frame.round.key }),
        });
        await follow(body, round, region.scope, region);
      }
      if (isAborted(scope)) return finish({ status: 'cancelled' }, rounds);
      const roundFailure = failureOf(region);
      if (roundFailure !== undefined) {
        firstFailure ??= roundFailure;
        if (!goOn) {
          return finish(
            failed('round', `Round ${String(index)} failed: ${roundFailure.message}`),
            rounds,
          );
        }
      }
    }
    if (block.type === 'while') {
      const going = goesOn(previous);
      if (typeof going !== 'boolean') return finish(going, rounds);
      if (going) {
        return finish(
          failed('max-rounds', `The condition still held after ${String(block.maxRounds)} rounds`),
          rounds,
        );
      }
    }
    return ended();
  }

  async function walk(
    block: AutomationBlock,
    frame: Frame,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    if ('disabled' in block && block.disabled === true) {
      // Passed through: it leaves no result, so rules on it read Skipped, and no outputs.
      setStep(block.id, frame, { state: 'disabled' });
      return leave(block.id, disabledOutput(block.type), frame, scope, region);
    }
    switch (block.type) {
      case 'start':
        // The inputs are kept with the Start block, so that a test can reuse them.
        recordData(block.id, frame, {
          values:
            block.inputs?.flatMap((input) => {
              const value = inputs.get(input.name);
              return value === undefined
                ? []
                : [{ name: input.name, label: input.label ?? input.name, value }];
            }) ?? [],
          outputs: [],
        });
        passThrough(block.id, frame);
        return leave(block.id, 'next', frame, scope, region);
      case 'run':
        return after(
          block.id,
          await withRetries(block, frame, scope, () => runOnce(block, frame, scope)),
          frame,
          scope,
          region,
        );
      case 'run-automation':
        return after(
          block.id,
          await withRetries(block, frame, scope, () => callOnce(block, frame, scope)),
          frame,
          scope,
          region,
        );
      case 'wait-for-time':
        return after(
          block.id,
          await runWait(block.id, frame, () => waitForTime(block.id, frame, block.seconds, scope)),
          frame,
          scope,
          region,
        );
      case 'wait-for-manual-action':
        return after(
          block.id,
          await runWait(block.id, frame, () =>
            waitForAction(block.id, frame, block.message, scope),
          ),
          frame,
          scope,
          region,
        );
      case 'if': {
        const taken = await holds(frame, block.condition);
        passThrough(block.id, frame);
        setStep(block.id, frame, { took: taken ? 'true' : 'false' });
        return leave(block.id, taken ? 'true' : 'false', frame, scope, region);
      }
      case 'switch': {
        const taken = await firstCase(frame, block);
        passThrough(block.id, frame);
        setStep(block.id, frame, { took: taken });
        return leave(block.id, taken, frame, scope, region);
      }
      case 'parallel':
        return runParallel(block, frame, scope, region);
      case 'join':
        // Reached on a path outside its Parallel, which a valid automation does not have.
        passThrough(block.id, frame);
        return leave(block.id, 'next', frame, scope, region);
      case 'for':
      case 'while':
        return after(block.id, await runLoop(block, frame, scope), frame, scope, region);
    }
  }

  /** Runs the block, then whatever follows it, and settles when this path has ended. */
  async function follow(
    id: string,
    frame: Frame,
    scope: Scope,
    region: Region | undefined,
  ): Promise<void> {
    const block = blocks.get(id);
    if (block === undefined || scope.controller.signal.aborted) {
      return;
    }
    if (block.type === 'join' && region?.join === id) {
      // A branch that reaches its Join ends there, and the Parallel carries on once all have.
      return;
    }
    if (frame.reached.has(id)) {
      return;
    }
    reach(id, frame);
    try {
      await walk(block, frame, scope, region);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof ConditionError ? 'condition' : 'not-started';
      finishStep(id, frame, failed(kind, message), performance.now());
      unhandled(
        {
          stepId: id,
          ...(frame.round === undefined ? {} : { round: frame.round.key }),
          kind,
          message,
        },
        region,
      );
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
        caller: options.caller,
        ...(testRecord === undefined ? {} : { test: testRecord }),
        ...(tested?.base === undefined ? {} : { folderRunId: tested.base.folderRunId }),
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
    if (tested !== undefined) {
      await follow(tested.blockId, first, root, undefined);
    } else if (start !== undefined) {
      await follow(start.id, top, root, undefined);
    }

    status = stopped !== undefined ? 'failed' : cancelledByUser ? 'cancelled' : 'completed';
    if (status === 'completed') {
      // What the run did not reach is on a path it did not take.
      for (const [key, step] of steps) {
        if (step.state === 'idle' && step.reused !== true) {
          steps.set(key, { ...step, state: 'skipped' });
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
      failedSteps: [
        ...new Set(
          [...steps.values()].filter(({ state }) => state === 'failed').map(({ id }) => id),
        ),
      ],
      outputs: handedBack(top),
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
