import { z } from 'zod';
import type { Automation } from './automation.js';
import {
  runStepSchema,
  waitForManualActionStepSchema,
  waitForTimeStepSchema,
} from './automation-v1.js';
import { DEFAULT_OUTPUT, ERROR_OUTPUT } from './automation-graph.js';

/**
 * A step of the list editor: a tool, a timed wait or a manual wait, in a straight line. Branches,
 * parallel work and background steps need the canvas, so this list cannot say them.
 */
export const linearStepSchema = z.discriminatedUnion('type', [
  runStepSchema.omit({ background: true }),
  waitForTimeStepSchema,
  waitForManualActionStepSchema,
]);

export type LinearStep = z.output<typeof linearStepSchema>;
export type LinearRunStep = Extract<LinearStep, { type: 'run' }>;

type Block = Automation['blocks'][number];
type Connection = Automation['connections'][number];

function startId(taken: ReadonlySet<string>): string {
  let id = 'start';
  for (let n = 2; taken.has(id); n += 1) id = `start-${String(n)}`;
  return id;
}

/** The blocks and connections of a list of steps: a Start, then each step in turn. */
export function fromLinear(steps: readonly LinearStep[]): {
  blocks: Block[];
  connections: Connection[];
} {
  const start = startId(new Set(steps.map(({ id }) => id)));
  const blocks: Block[] = [{ id: start, type: 'start', mode: 'button' }];
  const connections: Connection[] = [];
  let before: string = start;
  steps.forEach((step, index) => {
    const continues = step.type !== 'wait-for-time' && step.onFailure === 'continue';
    const { onFailure, ...rest } = step as LinearStep & { onFailure?: unknown };
    const keeps = continues || onFailure === undefined ? {} : { onFailure };
    blocks.push({ ...rest, ...keeps } as Block);
    connections.push({ from: before, to: step.id });
    const previous = steps[index - 1];
    if (
      previous !== undefined &&
      previous.type !== 'wait-for-time' &&
      previous.onFailure === 'continue'
    ) {
      connections.push({ from: previous.id, output: ERROR_OUTPUT, to: step.id });
    }
    before = step.id;
  });
  return { blocks, connections };
}

/**
 * The list of steps an automation is, or nothing when it is more than a straight line. A step set to
 * continue is one whose Error output leads where its next output does.
 */
export function linearOf(automation: Automation): LinearStep[] | undefined {
  const byId = new Map(automation.blocks.map((block) => [block.id, block]));
  const leaving = new Map<string, Connection[]>();
  for (const connection of automation.connections) {
    leaving.set(connection.from, [...(leaving.get(connection.from) ?? []), connection]);
  }
  const start = automation.blocks.find(({ type }) => type === 'start');
  if (start === undefined) {
    return undefined;
  }
  const steps: LinearStep[] = [];
  const seen = new Set<string>([start.id]);
  let current: Block = start;
  let used = 0;
  for (;;) {
    const out: Connection[] = leaving.get(current.id) ?? [];
    const next = out.filter(
      (connection) => (connection.output ?? DEFAULT_OUTPUT) === DEFAULT_OUTPUT,
    );
    const error = out.filter((connection) => connection.output === ERROR_OUTPUT);
    if (next.length + error.length !== out.length || next.length > 1 || error.length > 1) {
      return undefined;
    }
    used += out.length;
    const target = next[0]?.to;
    const handled = error[0];
    if (handled !== undefined) {
      // Only a step that goes on to the same place whether it works or not can be a list item.
      if (target === undefined || handled.to !== target) {
        return undefined;
      }
      const marked = steps.at(-1);
      if (
        marked === undefined ||
        marked.id !== current.id ||
        marked.type === 'wait-for-time' ||
        typeof marked.onFailure === 'object'
      ) {
        return undefined;
      }
      steps[steps.length - 1] = { ...marked, onFailure: 'continue' };
    }
    if (target === undefined) {
      break;
    }
    const block = byId.get(target);
    if (block === undefined || seen.has(target)) {
      return undefined;
    }
    seen.add(target);
    const step = stepOf(block);
    if (step === undefined) {
      return undefined;
    }
    steps.push(step);
    current = block;
  }
  const everyBlockUsed = seen.size === automation.blocks.length;
  return everyBlockUsed && used === automation.connections.length ? steps : undefined;
}

function stepOf(block: Block): LinearStep | undefined {
  switch (block.type) {
    case 'run':
    case 'wait-for-time':
    case 'wait-for-manual-action':
      return block;
    default:
      return undefined;
  }
}
