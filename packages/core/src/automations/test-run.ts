/**
 * Testing a block from the app: what the run it reuses left, read back from history, and whether
 * a block can be tested on it. The engine runs the test itself, from `startAutomationRun`.
 */
import { join } from 'node:path';
import {
  buildGraph,
  expressionsOf,
  findStepOutputReferences,
  loopChain,
  reachableFrom,
  targetsOf,
} from '@bildora/protocol';
import type {
  Automation,
  AutomationBlock,
  AutomationInputDeclaration,
  BlockValue,
  LiteralValue,
  RuntimeValue,
} from '@bildora/protocol';
import type {
  AutomationRunSummary,
  AutomationStepRecord,
  RunHistory,
} from '../history/run-history.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { PathVariables } from '../runner/expand-paths.js';
import { automationRunFolder } from '../storage/data-directory.js';
import { parametersOf } from './automation-values.js';
import type { OutputValue } from './automation-values.js';
import { inputsOf } from './automation-inputs.js';
import type { CallTree } from './call-tree.js';
import { MissingOutputError, ValueError, frameValues, gatherTrees, newFrame } from './run-frame.js';
import type { BlockResult, Frame, OutputTree } from './run-frame.js';

/** Block types Test block runs on its own. */
const TESTABLE: ReadonlySet<string> = new Set(['run', 'run-automation', 'if', 'switch']);

/** What a test does: one block, or a block and everything after it. */
export type TestKind = 'block' | 'from';

/** The run a test reuses, read back from history. */
export interface BaseRun {
  readonly runId: string;
  /** The run whose folder it wrote to, which a test of it writes to as well. */
  readonly folderRunId: string;
  /** The automation's inputs in that run. Runs from before they were kept lack them. */
  readonly inputs?: ReadonlyMap<string, LiteralValue>;
  readonly steps: readonly AutomationStepRecord[];
  readonly paths: AutomationRunSummary['paths'];
  /** Exit codes of tool blocks, by step key. */
  readonly exitCodes: ReadonlyMap<string, number>;
  /** What called runs handed back, by step key. */
  readonly calls: ReadonlyMap<string, OutputTree>;
}

/** A key for a step, which a block inside a loop has once per round. */
export function baseStepKey(id: string, round: string | undefined): string {
  return round === undefined ? id : `${id}\u0000${round}`;
}

/** The outputs a step record holds, or undefined when history shortened them. */
function outputsOfRecord(step: AutomationStepRecord): ReadonlyMap<string, OutputValue> | undefined {
  if (step.truncated === true || step.outputs === undefined) return undefined;
  const outputs = new Map<string, { value: RuntimeValue; fields: Map<string, RuntimeValue> }>();
  for (const record of step.outputs) {
    const dot = record.name.indexOf('.');
    if (dot < 0) {
      if (record.value === undefined) continue;
      const known = outputs.get(record.name);
      outputs.set(record.name, {
        value: record.value,
        fields: known?.fields ?? new Map<string, RuntimeValue>(),
      });
      continue;
    }
    // A secret field was kept without its value, so it stays missing.
    if (record.value === undefined) continue;
    const name = record.name.slice(0, dot);
    const known = outputs.get(name) ?? { value: '', fields: new Map<string, RuntimeValue>() };
    known.fields.set(record.name.slice(dot + 1), record.value);
    outputs.set(name, known);
  }
  return new Map(
    [...outputs].map(([name, { value, fields }]) => [
      name,
      fields.size === 0 ? { value } : { value, fields },
    ]),
  );
}

/** The automation's inputs as its Start block recorded them. */
function inputsOfRecords(
  automation: Automation,
  steps: readonly AutomationStepRecord[],
): ReadonlyMap<string, LiteralValue> | undefined {
  const start = automation.blocks.find(({ type }) => type === 'start');
  const values = steps.find((step) => step.round === undefined && step.id === start?.id)?.values;
  if (values === undefined) return undefined;
  const inputs = new Map<string, LiteralValue>();
  for (const { name, value } of values) {
    if (value !== undefined) inputs.set(name, value);
  }
  return inputs;
}

/** What one stretch of a recorded run holds, with what the loops in it gathered. */
function recordedFrame(
  base: Pick<BaseRun, 'steps' | 'exitCodes' | 'calls'>,
  round: string | undefined,
  options: {
    readonly parent?: Frame;
    readonly roundInfo?: Frame['round'];
    /** Blocks that run again, whose earlier values must not be read. */
    readonly except?: ReadonlySet<string>;
    /** Loops around the tested block, whose rounds are not gathered into lists. */
    readonly open?: ReadonlySet<string>;
  } = {},
): Frame {
  const frame = newFrame(options.parent, options.roundInfo);
  const except = options.except ?? new Set<string>();
  for (const step of base.steps) {
    if (step.round !== round || except.has(step.id)) continue;
    const key = baseStepKey(step.id, step.round);
    if (step.state === 'completed' || step.state === 'failed') {
      const exitCode = base.exitCodes.get(key);
      const result: BlockResult = {
        result: step.state,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      frame.results.set(step.id, result);
    }
    if (step.state === 'completed') {
      const outputs = outputsOfRecord(step);
      if (outputs !== undefined) frame.outputs.set(step.id, outputs);
      const called = base.calls.get(key);
      if (called !== undefined) frame.calls.set(step.id, called);
    }
    if (step.rounds !== undefined && !(options.open?.has(step.id) ?? false)) {
      // A loop: its body's values, one per round, as the blocks after it read them.
      const rounds = Array.from({ length: step.rounds }, (_, index) => {
        const own = `${step.id}:${String(index + 1)}`;
        return recordedFrame(base, round === undefined ? own : `${round}/${own}`, { except });
      });
      const gathered = gatherTrees(rounds);
      gathered.outputs.forEach((left, id) => frame.outputs.set(id, left));
      gathered.calls.forEach((tree, id) => frame.calls.set(id, tree));
      frame.outputs.set(step.id, new Map([['rounds', { value: rounds.length }]]));
    }
  }
  return frame;
}

/** What a recorded run handed back to its caller, as the engine gathers it. */
function treeOf(base: Pick<BaseRun, 'steps' | 'exitCodes' | 'calls'>): OutputTree {
  const frame = recordedFrame(base, undefined);
  return { outputs: frame.outputs, calls: frame.calls };
}

async function readRecorded(
  history: RunHistory,
  workspaceId: string,
  run: AutomationRunSummary,
  depth: number,
): Promise<Pick<BaseRun, 'steps' | 'exitCodes' | 'calls'>> {
  const exitCodes = new Map<string, number>();
  const calls = new Map<string, OutputTree>();
  for (const step of run.steps) {
    const key = baseStepKey(step.id, step.round);
    if (step.toolRunId !== undefined && (step.state === 'completed' || step.state === 'failed')) {
      const exitCode = history.get(workspaceId, step.toolRunId)?.exitCode;
      if (exitCode !== undefined) exitCodes.set(key, exitCode);
    }
    if (step.calledRunId !== undefined && step.state === 'completed' && depth > 0) {
      const called = history.getAutomationRun(workspaceId, step.calledRunId);
      if (called !== undefined) {
        calls.set(key, treeOf(await readRecorded(history, workspaceId, called, depth - 1)));
      }
    }
  }
  return { steps: run.steps, exitCodes, calls };
}

/** Calls deep a base run is read through, as deep as a run can call. */
const READ_DEPTH = 5;

/** Reads a run back from history, so that a test can reuse what it left. */
export async function readBaseRun(
  history: RunHistory,
  automation: Automation,
  run: AutomationRunSummary,
): Promise<BaseRun> {
  const recorded = await readRecorded(history, run.workspaceId, run, READ_DEPTH);
  const inputs = inputsOfRecords(automation, run.steps);
  return {
    runId: run.runId,
    folderRunId: run.folderRunId ?? run.runId,
    ...(inputs === undefined ? {} : { inputs }),
    paths: run.paths,
    ...recorded,
  };
}

/**
 * The latest run a test can reuse: the newest that ended, tests included, since a test records
 * the values it reused. A run from before blocks has none to give.
 */
export function latestBaseRun(
  runs: readonly AutomationRunSummary[],
): AutomationRunSummary | undefined {
  return runs.find(
    (run) => run.format === 'blocks' && run.status !== 'running' && run.caller === undefined,
  );
}

/** Blocks that run again when a run starts from `from`: it and everything after it. */
export function blocksFrom(automation: Automation, from: string): ReadonlySet<string> {
  return new Set([from, ...reachableFrom(buildGraph(automation), from)]);
}

/** Whether a block is on a branch of a Parallel, between it and its Join. */
function insideBranch(automation: Automation, id: string): boolean {
  const graph = buildGraph(automation);
  return automation.blocks.some((block) => {
    if (block.type !== 'parallel') return false;
    const join = automation.blocks.find(
      (candidate) => candidate.type === 'join' && candidate.parallel === block.id,
    );
    return reachableFrom(graph, block.id, join?.id).has(id);
  });
}

/** The loop round a block inside loops is tested in: the given one, or the last of each loop. */
export function testRound(
  automation: Automation,
  base: BaseRun | undefined,
  id: string,
  round?: string,
): string | undefined {
  if (round !== undefined) return round;
  const loops = loopChain(automation.blocks, id).reverse();
  if (loops.length === 0 || base === undefined) return undefined;
  let key: string | undefined;
  for (const loop of loops) {
    const step = base.steps.find((candidate) => candidate.id === loop && candidate.round === key);
    if (step?.rounds === undefined || step.rounds === 0) return undefined;
    const own = `${loop}:${String(step.rounds)}`;
    key = key === undefined ? own : `${key}/${own}`;
  }
  return key;
}

/** Why a test cannot start, as a code the app words, with the block it is about. */
export type TestBlocker =
  | { readonly code: 'not-testable' | 'start' | 'inside-loop' | 'inside-branch' | 'no-run' }
  | { readonly code: 'round-gone'; readonly round: string }
  | {
      readonly code: 'value-missing';
      readonly block: string;
      readonly why: 'not-run' | 'failed' | 'absent' | 'secret' | 'shortened' | 'no-output';
    };

/** The frame a test of `id` reads in, with the round chain of a block inside loops. */
export function baseFrame(
  automation: Automation,
  base: BaseRun | undefined,
  options: {
    readonly kind: TestKind;
    readonly blockId: string;
    readonly round?: string | undefined;
    readonly runFolder: string;
  },
): Frame | { readonly blocker: TestBlocker } {
  if (base === undefined) return newFrame();
  const except =
    options.kind === 'from' ? blocksFrom(automation, options.blockId) : new Set<string>();
  const loops = loopChain(automation.blocks, options.blockId).reverse();
  const open = new Set(loops);
  let frame = recordedFrame(base, undefined, { except, open });
  if (options.kind === 'from' || options.round === undefined) return frame;
  let key: string | undefined;
  let folder = options.runFolder;
  for (const part of options.round.split('/')) {
    const [loop = '', text = ''] = part.split(':');
    const index = Number(text);
    const block = automation.blocks.find((candidate) => candidate.id === loop);
    const step = base.steps.find((candidate) => candidate.id === loop && candidate.round === key);
    if (block === undefined || step?.rounds === undefined || index < 1 || index > step.rounds) {
      return { blocker: { code: 'round-gone', round: options.round } };
    }
    let item: RuntimeValue = index;
    if (block.type === 'for' && block.items.kind !== 'count') {
      const kept = step.items?.[index - 1];
      if (kept === undefined) return { blocker: { code: 'round-gone', round: options.round } };
      item = kept;
    }
    key = key === undefined ? part : `${key}/${part}`;
    folder = join(folder, loop, String(index));
    frame = recordedFrame(base, key, {
      parent: frame,
      roundInfo: { loop, item, index, folder, key },
      open,
    });
  }
  return frame;
}

/** The blocks a block reads outputs or exit codes of, as they are named. */
function readsOf(block: AutomationBlock): { block: string; output?: string; field?: string }[] {
  const reads: { block: string; output?: string; field?: string }[] = [];
  for (const { expression } of expressionsOf([block])) {
    for (const { target } of targetsOf(expression)) {
      if (target.kind === 'output') {
        reads.push({
          block: target.block,
          output: target.output,
          ...(target.field === undefined ? {} : { field: target.field }),
        });
      }
    }
  }
  const texts: string[] = [];
  if (block.type === 'run') {
    for (const value of Object.values(block.values ?? {})) {
      if (typeof value === 'string') texts.push(value);
    }
  }
  if (block.type === 'run-automation') {
    for (const value of Object.values(block.inputs ?? {})) {
      if (typeof value === 'string') texts.push(value);
    }
  }
  for (const text of texts) {
    for (const { step, output, field } of findStepOutputReferences(text)) {
      reads.push({ block: step, output, ...(field === undefined ? {} : { field }) });
    }
  }
  const conditions =
    block.type === 'if'
      ? [block.condition]
      : block.type === 'switch'
        ? block.cases.map(({ condition }) => condition)
        : [];
  for (const condition of conditions) {
    for (const rule of condition.rules) {
      if (rule.field === 'exit-code') reads.push({ block: rule.block });
    }
  }
  return reads;
}

/** Why the base run has no value for what a block reads of another. */
function whyMissing(
  base: BaseRun,
  block: string,
  output: string | undefined,
  field: string | undefined,
): Extract<TestBlocker, { code: 'value-missing' }>['why'] {
  const steps = base.steps.filter((step) => step.id === block);
  if (steps.length === 0) return 'absent';
  if (steps.some((step) => step.truncated === true)) return 'shortened';
  if (steps.every((step) => step.state === 'failed')) return 'failed';
  if (steps.every((step) => step.state !== 'completed')) return 'not-run';
  const name =
    output === undefined ? undefined : field === undefined ? output : `${output}.${field}`;
  if (
    name !== undefined &&
    steps.some((step) => step.outputs?.some((record) => record.name === name && record.secret))
  ) {
    return 'secret';
  }
  return 'no-output';
}

/** What a test reads values with. */
export interface TestEnvironment {
  readonly tools: ReadonlyMap<string, RegisteredTool>;
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly pathVariables: PathVariables;
  /** The automations it calls, for the inputs of a Run automation block. */
  readonly calls?: CallTree | undefined;
}

/**
 * A field of a tested block: a parameter of its tool, or an input of the automation it calls, with
 * the value the base run gives it, or why it gives none.
 */
export interface TestField {
  readonly name: string;
  readonly value?: LiteralValue;
  /** Why the base run gives no value, when the block links one that it lacks. */
  readonly missing?: string;
}

/** Whether a test can start, and for Test block, the fields it opens with. */
export interface TestPlan {
  readonly blocker?: TestBlocker;
  /** The round a block inside loops is tested in. */
  readonly round?: string;
  /** For Test block on a Run or Run automation block, the fields the block sets. */
  readonly fields?: readonly TestField[];
}

/**
 * Says whether a block can be tested on a base run, and for Test block, what each field the block
 * sets would get. A field with no value can still be typed, so only Run from here and conditions
 * are stopped by a value the base run lacks.
 */
export function planTest(
  automation: Automation,
  base: BaseRun | undefined,
  request: {
    readonly kind: TestKind;
    readonly blockId: string;
    readonly round?: string | undefined;
    readonly dataDir: string;
    readonly workspaceId: string;
  },
  environment: TestEnvironment,
): TestPlan {
  const block = automation.blocks.find((candidate) => candidate.id === request.blockId);
  if (block === undefined) return { blocker: { code: 'not-testable' } };
  if (request.kind === 'block' && !TESTABLE.has(block.type)) {
    return { blocker: { code: 'not-testable' } };
  }
  if (request.kind === 'from') {
    if (block.type === 'start') return { blocker: { code: 'start' } };
    if (loopChain(automation.blocks, block.id).length > 0) {
      return { blocker: { code: 'inside-loop' } };
    }
    if (insideBranch(automation, block.id)) return { blocker: { code: 'inside-branch' } };
    if (base === undefined) return { blocker: { code: 'no-run' } };
  }
  const round =
    request.kind === 'block' ? testRound(automation, base, block.id, request.round) : undefined;
  const roundPart = round === undefined ? {} : { round };
  const runFolder = automationRunFolder(
    request.dataDir,
    request.workspaceId,
    automation.id,
    base?.folderRunId ?? 'untested',
  );
  const frame = baseFrame(automation, base, {
    kind: request.kind,
    blockId: block.id,
    round,
    runFolder,
  });
  if ('blocker' in frame) return { ...roundPart, blocker: frame.blocker };
  const values = frameValues({
    automation,
    tools: environment.tools,
    profiles: environment.profiles,
    inputs: base?.inputs ?? defaultInputs(automation),
    runFolder,
    pathVariables: environment.pathVariables,
  });

  // Run from here and conditions must find every value they read; nobody types them.
  if (request.kind === 'from' || block.type === 'if' || block.type === 'switch') {
    for (const read of readsOf(block)) {
      if (base === undefined) return { ...roundPart, blocker: { code: 'no-run' } };
      const known =
        read.output === undefined
          ? values.resultOf(frame, read.block)?.exitCode
          : values.outputValue(frame, read.block, read.output, read.field);
      if (known === undefined) {
        const why = whyMissing(base, read.block, read.output, read.field);
        return { ...roundPart, blocker: { code: 'value-missing', block: read.block, why } };
      }
    }
  }
  if (request.kind !== 'block') return roundPart;

  const field = (
    name: string,
    own: BlockValue | undefined,
    kind: AutomationInputDeclaration['type'],
    label: string,
  ): TestField => {
    if (own === undefined) return { name };
    try {
      const value = values.blockValue(frame, own, kind, label);
      return { name, value };
    } catch (error) {
      if (error instanceof MissingOutputError || error instanceof ValueError) {
        return { name, missing: error.message };
      }
      throw error;
    }
  };
  if (block.type === 'run') {
    const fields = parametersOf(environment.tools.get(block.id)).map((parameter) =>
      field(parameter.name, block.values?.[parameter.name], parameter.type, parameter.label),
    );
    return { ...roundPart, fields };
  }
  if (block.type === 'run-automation') {
    const called = environment.calls?.calls.get(block.id)?.automation;
    const fields = (called === undefined ? [] : inputsOf(called)).map((input) =>
      field(input.name, block.inputs?.[input.name], input.type, input.label ?? input.name),
    );
    return { ...roundPart, fields };
  }
  return roundPart;
}

/** The automation's inputs from their defaults, for a test with no run to take them from. */
function defaultInputs(automation: Automation): ReadonlyMap<string, LiteralValue> {
  return new Map(
    inputsOf(automation).flatMap((input) =>
      input.default === undefined ? [] : [[input.name, input.default] as const],
    ),
  );
}
