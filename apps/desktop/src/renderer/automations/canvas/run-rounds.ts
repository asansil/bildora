import type { StepRunView, StepStateView, TakenPathView } from '../../../shared/ipc-contract.js';

/** What a frame needs to know about a block: the loop it is in. */
interface RoundBlock {
  readonly id: string;
  readonly loop?: string | undefined;
}

/** The rounds of one loop, as its frame shows them. */
export interface LoopRounds {
  /** The round its blocks show, from 1. */
  readonly index: number;
  readonly count: number;
  /** How each round went, in order. */
  readonly results: readonly StepStateView[];
}

export interface ShownRounds {
  /** The step each block shows: outside loops its only one, inside them the chosen round's. */
  readonly steps: ReadonlyMap<string, StepRunView>;
  /** The rounds of each loop that has run any. */
  readonly rounds: ReadonlyMap<string, LoopRounds>;
  /** The round path each loop's blocks show, such as `Outer:2/Inner:3`. */
  readonly keys: ReadonlyMap<string, string>;
}

/** The number of a round path's segment for `loop`, when the path goes through it right after `base`. */
function indexAfter(round: string, base: string, loop: string): number | undefined {
  const start = `${base}${loop}:`;
  if (!round.startsWith(start)) return undefined;
  const rest = round.slice(start.length);
  const end = rest.indexOf('/');
  const index = Number(end === -1 ? rest : rest.slice(0, end));
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

/** How a round went, from the steps that ran in it. */
function resultOf(states: readonly StepStateView[]): StepStateView {
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  if (states.includes('cancelled')) return 'cancelled';
  return 'completed';
}

/**
 * Which round each loop's frame shows, and so which step each block shows. A loop with no choice
 * follows its latest round, as a live run should until someone picks one. An inner loop counts its
 * rounds within the round its outer loop shows.
 */
export function shownRounds(
  blocks: readonly RoundBlock[],
  steps: readonly StepRunView[],
  choices: ReadonlyMap<string, number>,
): ShownRounds {
  const loopOf = new Map(blocks.map(({ id, loop }) => [id, loop]));
  const rounds = new Map<string, LoopRounds>();
  const keys = new Map<string, string>();
  const done = new Set<string>();
  const visiting = new Set<string>();

  /** The round path the blocks inside `loop` show, or undefined while it has run no round. */
  const keyOf = (loop: string): string | undefined => {
    if (done.has(loop)) return keys.get(loop);
    if (visiting.has(loop)) return undefined;
    visiting.add(loop);
    const parent = loopOf.get(loop);
    const parentKey = parent === undefined ? '' : keyOf(parent);
    visiting.delete(loop);
    done.add(loop);
    if (parentKey === undefined) return undefined;
    const base = parentKey === '' ? '' : `${parentKey}/`;
    const byRound = new Map<number, StepStateView[]>();
    for (const step of steps) {
      if (step.round === undefined) continue;
      const index = indexAfter(step.round, base, loop);
      if (index === undefined) continue;
      byRound.set(index, [...(byRound.get(index) ?? []), step.state]);
    }
    if (byRound.size === 0) return undefined;
    const count = Math.max(...byRound.keys());
    const chosen = choices.get(loop);
    const index = chosen === undefined ? count : Math.min(Math.max(chosen, 1), count);
    const results = Array.from({ length: count }, (_, position) => {
      const states = byRound.get(position + 1);
      return states === undefined ? 'skipped' : resultOf(states);
    });
    rounds.set(loop, { index, count, results });
    const key = `${base}${loop}:${String(index)}`;
    keys.set(loop, key);
    return key;
  };

  const shown = new Map<string, StepRunView>();
  for (const block of blocks) {
    const round = block.loop === undefined ? undefined : keyOf(block.loop);
    if (block.loop !== undefined && round === undefined) continue;
    const step = steps.find((candidate) => candidate.id === block.id && candidate.round === round);
    if (step !== undefined) shown.set(block.id, step);
  }
  return { steps: shown, rounds, keys };
}

/**
 * Whether a connection the run followed was followed in the rounds the frames show. A path is
 * recorded in the round its source block ran in, so the body connection of a loop belongs to the
 * round around the loop.
 */
export function isShownPath(
  path: TakenPathView,
  loopOfSource: string | undefined,
  keys: ReadonlyMap<string, string>,
): boolean {
  if (loopOfSource === undefined) return path.round === undefined;
  return path.round !== undefined && keys.get(loopOfSource) === path.round;
}
