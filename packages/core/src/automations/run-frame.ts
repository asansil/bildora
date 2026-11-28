/**
 * What a run holds while it walks its blocks, and how its values are worked out from it. A run and
 * a test of one block share these, so a test reads earlier blocks exactly as a run would.
 */
import { normalize } from 'node:path';
import {
  ExpressionError,
  findStepOutputReferences,
  isExpressionValue,
  loopChain,
  replaceRunReferences,
  runtimeText,
  targetOf,
  targetsOf,
  toParameterValue,
} from '@bildora/protocol';
import type { Automation, BlockValue, LiteralValue, RuntimeValue } from '@bildora/protocol';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { ParameterValue } from '../runner/command-line.js';
import type { PathVariables } from '../runner/expand-paths.js';
import { evaluateInRun, isDisabledBlock } from './automation-values.js';
import type { LoopRound, OutputValue, RunValueContext } from './automation-values.js';

/** A step refers to something an earlier step did not leave. */
export class MissingOutputError extends Error {}

/** A value of a step could not be worked out. */
export class ValueError extends Error {}

/**
 * What a run's blocks left, handed back to the run that called it. A called run's own calls are
 * under the Run automation blocks that made them. Secret fields are left out.
 */
export interface OutputTree {
  readonly outputs: ReadonlyMap<string, ReadonlyMap<string, OutputValue>>;
  readonly calls: ReadonlyMap<string, OutputTree>;
}

export interface BlockResult {
  readonly result: 'completed' | 'failed';
  readonly exitCode?: number | undefined;
}

/**
 * What one stretch of the run holds: the run outside loops, or one round of a loop. A round sees
 * what the frames around it hold, and only its own round of the blocks in its body.
 */
export interface Frame {
  readonly parent?: Frame;
  readonly round?: LoopRound & { readonly key: string };
  readonly outputs: Map<string, ReadonlyMap<string, OutputValue>>;
  readonly calls: Map<string, OutputTree>;
  readonly results: Map<string, BlockResult>;
  /** A block reached from several paths still runs once in a frame. */
  readonly reached: Set<string>;
}

export function newFrame(parent?: Frame, round?: LoopRound & { readonly key: string }): Frame {
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(round === undefined ? {} : { round }),
    outputs: new Map(),
    calls: new Map(),
    results: new Map(),
    reached: new Set(),
  };
}

/** The rounds of the loops around a frame, nearest first. */
export function roundsOf(frame: Frame): LoopRound[] {
  const rounds: LoopRound[] = [];
  for (let at: Frame | undefined = frame; at !== undefined; at = at.parent) {
    if (at.round !== undefined) rounds.push(at.round);
  }
  return rounds;
}

/**
 * One value per round of a loop for one output or field, as a list of text. A round that left
 * nothing gives an empty text, so positions match rounds; lists from loops inside are joined flat.
 */
function gatherValues(values: readonly (RuntimeValue | undefined)[]): readonly string[] {
  const flat = values.some((value) => Array.isArray(value));
  return values.flatMap((value): string[] => {
    if (Array.isArray(value)) return [...(value as readonly string[])];
    if (value === undefined) return flat ? [] : [''];
    return [runtimeText(value)];
  });
}

/** What a block left in each round, as one list per output and per field. */
function gatherOutputs(
  rounds: readonly (ReadonlyMap<string, OutputValue> | undefined)[],
): ReadonlyMap<string, OutputValue> {
  const names = new Set(rounds.flatMap((outputs) => [...(outputs?.keys() ?? [])]));
  const gathered = new Map<string, OutputValue>();
  for (const name of names) {
    const each = rounds.map((outputs) => outputs?.get(name));
    const fields = new Set(each.flatMap((output) => [...(output?.fields?.keys() ?? [])]));
    gathered.set(name, {
      value: gatherValues(each.map((output) => output?.value)),
      ...(fields.size === 0
        ? {}
        : {
            fields: new Map(
              [...fields].map((field) => [
                field,
                gatherValues(each.map((output) => output?.fields?.get(field))),
              ]),
            ),
          }),
    });
  }
  return gathered;
}

/** What blocks left in each round, gathered into lists, called runs included. */
export function gatherTrees(rounds: readonly (OutputTree | undefined)[]): OutputTree {
  const ids = new Set(rounds.flatMap((tree) => [...(tree?.outputs.keys() ?? [])]));
  const calls = new Set(rounds.flatMap((tree) => [...(tree?.calls.keys() ?? [])]));
  return {
    outputs: new Map(
      [...ids].map((id) => [id, gatherOutputs(rounds.map((tree) => tree?.outputs.get(id)))]),
    ),
    calls: new Map(
      [...calls].map((id) => [id, gatherTrees(rounds.map((tree) => tree?.calls.get(id)))]),
    ),
  };
}

/** The round path of a new round: `<loop>:<index>` after the rounds of the loops around it. */
export function roundKey(frame: Frame, loop: string, index: number): string {
  const own = `${loop}:${String(index)}`;
  return frame.round === undefined ? own : `${frame.round.key}/${own}`;
}

/** What a run's values are worked out with, besides its frames. */
export interface ValueEnvironment {
  readonly automation: Automation;
  /** Tools and profiles of every run block, which links read. */
  readonly tools: ReadonlyMap<string, RegisteredTool>;
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly inputs: ReadonlyMap<string, LiteralValue>;
  readonly runFolder: string;
  readonly pathVariables: PathVariables;
}

/** Works out a run's values in its frames. */
export interface FrameValues {
  /** What a block left, a field of a JSON output included, read through called runs for `inner`. */
  readonly outputValue: (
    frame: Frame,
    block: string,
    output: string,
    field: string | undefined,
    inner?: readonly string[],
  ) => RuntimeValue | undefined;
  readonly resultOf: (frame: Frame, id: string) => BlockResult | undefined;
  /** Replaces `{{...}}` references in a text value. A path is tidied once something replaced. */
  readonly expandText: (frame: Frame, value: string, isPath: boolean) => string;
  readonly valueContext: (frame: Frame) => RunValueContext;
  /** Works out an expression. A missing output reads as a missing reference, as in text. */
  readonly worked: (frame: Frame, text: string, what: string) => RuntimeValue;
  /** A value of a block, worked out or expanded, as text, a number or yes or no. */
  readonly blockValue: (
    frame: Frame,
    value: BlockValue,
    kind: Parameters<typeof toParameterValue>[1],
    label: string,
  ) => ParameterValue;
}

/** The nearest frame, from `frame` outwards, where something is there. */
function frameWhere(frame: Frame, has: (at: Frame) => boolean): Frame | undefined {
  for (let at: Frame | undefined = frame; at !== undefined; at = at.parent) {
    if (has(at)) return at;
  }
  return undefined;
}

export function frameValues(environment: ValueEnvironment): FrameValues {
  const { automation, runFolder } = environment;

  function outputValue(
    frame: Frame,
    block: string,
    output: string,
    field: string | undefined,
    inner: readonly string[] = [],
  ): RuntimeValue | undefined {
    let left: ReadonlyMap<string, OutputValue> | undefined;
    if (inner.length === 0) {
      left = frameWhere(frame, (at) => at.outputs.has(block))?.outputs.get(block);
    } else {
      let tree = frameWhere(frame, (at) => at.calls.has(block))?.calls.get(block);
      for (const id of inner.slice(0, -1)) tree = tree?.calls.get(id);
      left = tree?.outputs.get(inner.at(-1) ?? '');
    }
    const value = left?.get(output);
    return field === undefined ? value?.value : value?.fields?.get(field);
  }

  function resultOf(frame: Frame, id: string): BlockResult | undefined {
    return frameWhere(frame, (at) => at.results.has(id))?.results.get(id);
  }

  function expandText(frame: Frame, value: string, isPath: boolean): string {
    for (const { step, output, field } of findStepOutputReferences(value)) {
      if (outputValue(frame, step, output, field) === undefined) {
        const what = field === undefined ? output : `${output}.${field}`;
        throw new MissingOutputError(
          isDisabledBlock(automation, step)
            ? `Step "${step}" is disabled, so it did not produce output "${what}"`
            : `Step "${step}" did not produce output "${what}"`,
        );
      }
    }
    const replaced = replaceRunReferences(value, {
      runFolder: () => runFolder,
      stepOutput: ({ step, output, field }) =>
        runtimeText(outputValue(frame, step, output, field) ?? ''),
    });
    return replaced !== value && isPath ? normalize(replaced) : replaced;
  }

  function valueContext(frame: Frame): RunValueContext {
    return {
      automation,
      tools: environment.tools,
      profiles: environment.profiles,
      inputs: environment.inputs,
      output: (block, output, field, inner) => outputValue(frame, block, output, field, inner),
      result: (block) => resultOf(frame, block)?.result ?? 'skipped',
      emptyOutput: (name) => {
        // After a loop that ran no rounds, or whose rounds all left nothing, its body reads as empty
        // lists.
        const target = targetOf(name);
        if (target.kind !== 'output') return undefined;
        const around = new Set(roundsOf(frame).map(({ loop }) => loop));
        return loopChain(automation.blocks, target.block).some((loop) => !around.has(loop))
          ? []
          : undefined;
      },
      rounds: roundsOf(frame),
      runFolder,
      pathVariables: environment.pathVariables,
      expandText: (text, isPath) => expandText(frame, text, isPath),
    };
  }

  function worked(frame: Frame, text: string, what: string): RuntimeValue {
    try {
      return evaluateInRun(valueContext(frame), text);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      const disabled = targetsOf(text).find(
        ({ target }) => target.kind === 'output' && isDisabledBlock(automation, target.block),
      );
      const reason =
        error.code === 'name' && disabled?.target.kind === 'output'
          ? `"${disabled.target.block}" is disabled, so it left no outputs`
          : error.message;
      const message = `${what}: ${reason}`;
      throw error.code === 'name' ? new MissingOutputError(message) : new ValueError(message);
    }
  }

  function blockValue(
    frame: Frame,
    value: BlockValue,
    kind: Parameters<typeof toParameterValue>[1],
    label: string,
  ): ParameterValue {
    if (isExpressionValue(value)) {
      const result = worked(frame, value.expression, label);
      try {
        return toParameterValue(result, kind, { start: 0, end: 0 });
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        throw new ValueError(`${label}: ${error.message}`);
      }
    }
    return typeof value === 'string' && (kind === 'path' || kind === 'string')
      ? expandText(frame, value, kind === 'path')
      : value;
  }

  return { outputValue, resultOf, expandText, valueContext, worked, blockValue };
}
