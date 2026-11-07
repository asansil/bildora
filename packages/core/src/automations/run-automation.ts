import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { findStepOutputReferences, replaceRunReferences, usesRunFolder } from '@bildora/protocol';
import type { Automation, AutomationStep, RunStep } from '@bildora/protocol';
import type {
  AutomationFailure,
  AutomationStepRecord,
  AutomationTrigger,
  RunHistory,
} from '../history/run-history.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { ParameterValue, ParameterValues } from '../runner/command-line.js';
import { expandPath } from '../runner/expand-paths.js';
import type { PathVariables } from '../runner/expand-paths.js';
import type { RunProgress } from '../runner/progress-lines.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import { automationRunFolder } from '../storage/data-directory.js';
import { DEFAULT_PREFERENCES, readPreferences } from '../storage/preferences.js';
import { removeRunFolders } from './automation-store.js';

const MS_PER_SECOND = 1000;

/** A step refers to something an earlier step did not leave. */
class MissingOutputError extends Error {}

/** Starts one tool for a step. It may throw, and that counts as the step failing. */
export type StepStarter = (
  tool: RegisteredTool,
  request: {
    readonly automationRunId: string;
    readonly profileId?: string | undefined;
    readonly values: ParameterValues;
    readonly onProgress: (progress: RunProgress) => void;
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
}

export interface AutomationResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: number;
  /** What stopped the run. */
  readonly failure?: AutomationFailure;
  /** Every step that failed, those set to continue included. */
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

function continuesAfterFailure(step: AutomationStep): boolean {
  return step.type !== 'wait-for-time' && step.onFailure === 'continue';
}

/** A step without what only matters while it is going on. */
function recordOf(step: StepView): AutomationStepRecord {
  const { id, state, toolRunId, attempt, durationMs, failure } = step;
  return {
    id,
    state,
    ...(toolRunId === undefined ? {} : { toolRunId }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined ? {} : { failure }),
  };
}

/** What a tool wrote where it declared, now that its step has run. Secret values never get here. */
function outputsOf(
  tool: RegisteredTool,
  run: RecordedToolRun,
  variables: PathVariables,
): ReadonlyMap<string, string> {
  const { manifest } = tool;
  const outputs = new Map<string, string>();
  if (manifest.level !== 1) {
    return outputs;
  }
  for (const output of manifest.outputs) {
    if ('param' in output) {
      const value = run.parameters.find(({ name }) => name === output.param)?.value;
      if (typeof value === 'string' && value !== '') {
        outputs.set(output.name, value);
      }
    } else {
      try {
        const path = expandPath(output.path, variables);
        const base = dirname(expandPath(manifest.run.program, variables));
        outputs.set(output.name, isAbsolute(path) ? path : resolve(base, path));
      } catch {
        // A variable with no value leaves the output unknown, which a step using it will report.
      }
    }
  }
  return outputs;
}

/**
 * Runs an automation's steps in order. Clients provide what differs between them, which is how a
 * tool starts and how a person answers, so the desktop app and the CLI share every rule. A problem
 * with the record never changes how a run ends.
 */
export function startAutomationRun(options: AutomationRunOptions): AutomationRun {
  const { automation, workspaceId, trigger, dataDir, history, pathVariables } = options;
  const variables: PathVariables = pathVariables ?? new Map<string, string>();
  const delay = options.delay ?? waitFor;
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const controller = new AbortController();
  const { signal } = controller;
  // A function, because `cancel()` changes this during the waits below.
  const isCancelled = (): boolean => signal.aborted;

  const steps = new Map<string, StepView>(
    automation.steps.map((step) => [step.id, { id: step.id, state: 'idle' }]),
  );
  const outputs = new Map<string, ReadonlyMap<string, string>>();
  const live = new Set<RecordedToolRun>();
  const background = new Map<string, Promise<StepOutcome>>();
  const waited = new Set<string>();
  let status: AutomationRunView['status'] = 'running';

  function view(): AutomationRunView {
    return {
      runId,
      workspaceId,
      automationId: automation.id,
      automationName: automation.name,
      status,
      steps: [...steps.values()],
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
    return steps.get(id) ?? { id, state: 'idle' };
  }

  function setStep(id: string, changes: Partial<StepView>): void {
    steps.set(id, { ...stepView(id), ...changes });
    change();
  }

  /** Settles a step and stores it, so that another process can follow the run. */
  function finishStep(id: string, outcome: StepOutcome, startedStep: number): void {
    steps.set(id, {
      ...recordOf(stepView(id)),
      state: outcome.status,
      durationMs: performance.now() - startedStep,
      ...(outcome.status === 'failed' ? { failure: outcome.failure } : {}),
    });
    change();
    record(() => {
      history.updateAutomationSteps(runId, records());
    });
  }

  async function valuesFor(step: RunStep, tool: RegisteredTool): Promise<ParameterValues> {
    const parameters = tool.manifest.level === 1 ? tool.manifest.parameters : [];
    const values: Record<string, ParameterValue> = {};
    for (const [name, value] of Object.entries(step.values ?? {})) {
      const isPath = parameters.some((item) => item.name === name && item.type === 'path');
      values[name] = isPath && typeof value === 'string' ? await expanded(value) : value;
    }
    return values;
  }

  async function expanded(value: string): Promise<string> {
    const folder = automationRunFolder(dataDir, workspaceId, automation.id, runId);
    if (usesRunFolder(value)) {
      await mkdir(folder, { recursive: true });
    }
    for (const { step, output } of findStepOutputReferences(value)) {
      if (outputs.get(step)?.get(output) === undefined) {
        throw new MissingOutputError(`Step "${step}" did not produce output "${output}"`);
      }
    }
    const replaced = replaceRunReferences(value, {
      runFolder: () => folder,
      stepOutput: ({ step, output }) => outputs.get(step)?.get(output) ?? '',
    });
    return replaced === value ? value : normalize(replaced);
  }

  async function runOnce(step: RunStep): Promise<StepOutcome> {
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
      return error instanceof MissingOutputError
        ? failed('reference', error.message)
        : failed('not-started', 'The run folder could not be created');
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
        onProgress: (progress) => {
          setStep(step.id, { progress });
        },
      });
    } catch (error) {
      return failed('not-started', error instanceof Error ? error.message : String(error));
    }
    live.add(run);
    setStep(step.id, { toolRunId: run.runId });
    if (isCancelled()) {
      run.cancel();
    }
    const result = await run.result;
    live.delete(run);
    if (result.status === 'completed') {
      outputs.set(step.id, outputsOf(tool, run, variables));
      return { status: 'completed' };
    }
    return result.status === 'cancelled'
      ? { status: 'cancelled' }
      : { status: 'failed', failure: result.failure };
  }

  /** Runs a tool step to its end, retrying as it says. */
  async function runTool(step: RunStep): Promise<StepOutcome> {
    const startedStep = performance.now();
    const retry = typeof step.onFailure === 'object' ? step.onFailure.retry : undefined;
    const attempts = retry?.attempts ?? 1;
    let outcome: StepOutcome = { status: 'cancelled' };
    for (let attempt = 1; attempt <= attempts && !isCancelled(); attempt += 1) {
      setStep(step.id, { state: 'running', ...(retry === undefined ? {} : { attempt }) });
      outcome = await runOnce(step);
      if (outcome.status !== 'failed') {
        break;
      }
      if (attempt < attempts) {
        await delay((retry?.delaySeconds ?? 0) * MS_PER_SECOND, signal);
        outcome = isCancelled() ? { status: 'cancelled' } : outcome;
      }
    }
    finishStep(step.id, outcome, startedStep);
    return outcome;
  }

  async function waitForCompletion(target: string): Promise<StepOutcome> {
    waited.add(target);
    const outcome = (await background.get(target)) ?? { status: 'completed' };
    return outcome.status === 'failed'
      ? failed(outcome.failure.kind, `Step "${target}" failed: ${outcome.failure.message}`)
      : outcome;
  }

  async function waitForAction(id: string, message: string): Promise<StepOutcome> {
    setStep(id, { message });
    const answer =
      options.askForAction === undefined
        ? 'no-user'
        : await options.askForAction({ stepId: id, message, signal });
    switch (answer) {
      case 'confirmed':
        return { status: 'completed' };
      case 'cancelled':
        return { status: 'cancelled' };
      case 'no-user':
        return failed('no-user', 'This step needs a person, and nobody is there to answer');
    }
  }

  async function waitForTime(id: string, seconds: number): Promise<StepOutcome> {
    const milliseconds = seconds * MS_PER_SECOND;
    setStep(id, { resumesAt: Date.now() + milliseconds });
    await delay(milliseconds, signal);
    return isCancelled() ? { status: 'cancelled' } : { status: 'completed' };
  }

  async function runWait(
    step: Exclude<AutomationStep, RunStep>,
    wait: () => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const startedStep = performance.now();
    setStep(step.id, { state: 'running' });
    const outcome = await wait();
    finishStep(step.id, outcome, startedStep);
    return outcome;
  }

  async function runStep(step: AutomationStep): Promise<StepOutcome> {
    switch (step.type) {
      case 'run':
        if (step.background === true) {
          // Its failure surfaces where it is waited for, or at the end.
          background.set(step.id, runTool(step));
          return { status: 'completed' };
        }
        return runTool(step);
      case 'wait-for-completion':
        return runWait(step, () => waitForCompletion(step.step));
      case 'wait-for-time':
        return runWait(step, () => waitForTime(step.id, step.seconds));
      case 'wait-for-manual-action':
        return runWait(step, () => waitForAction(step.id, step.message));
    }
  }

  /** Goes through the steps, and says what stopped them, if anything did. */
  async function runSteps(): Promise<AutomationFailure | 'cancelled' | undefined> {
    for (const step of automation.steps) {
      if (isCancelled()) {
        return 'cancelled';
      }
      const outcome = await runStep(step);
      if (outcome.status === 'cancelled') {
        return 'cancelled';
      }
      if (outcome.status === 'failed' && !continuesAfterFailure(step)) {
        return { stepId: step.id, ...outcome.failure };
      }
    }
    return undefined;
  }

  /** Waits for background steps nobody waited for. A failure among them counts as a stop. */
  async function settleBackground(): Promise<AutomationFailure | 'cancelled' | undefined> {
    let stop: AutomationFailure | 'cancelled' | undefined;
    for (const [id, pending] of background) {
      const outcome = await pending;
      if (!waited.has(id) && outcome.status === 'failed') {
        stop ??= { stepId: id, ...outcome.failure };
      } else if (!waited.has(id) && outcome.status === 'cancelled') {
        stop ??= 'cancelled';
      }
    }
    return stop;
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

    const stopped = await runSteps().catch((error: unknown): AutomationFailure => ({
      stepId: '',
      kind: 'not-started',
      message: error instanceof Error ? error.message : String(error),
    }));
    if (stopped !== undefined) {
      for (const run of live) {
        run.cancel();
      }
    }
    const left = await settleBackground();
    const stop = stopped ?? left;

    status = stop === undefined ? 'completed' : stop === 'cancelled' ? 'cancelled' : 'failed';
    const failure = typeof stop === 'object' ? stop : undefined;
    const durationMs = Date.now() - startedAt;
    const finalStatus = status;
    record(() => {
      history.finishAutomationRun(runId, {
        status: finalStatus,
        durationMs,
        failure,
        steps: records(),
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
      controller.abort();
      for (const run of live) {
        run.cancel();
      }
    },
    view,
  };
}
