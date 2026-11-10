import { automationProblem } from './automation-problems.js';
import type {
  AutomationProblem,
  AutomationProblemCode,
  AutomationProblemParams,
} from './automation-problems.js';

/** Output a connection leaves from when it names none. */
export const DEFAULT_OUTPUT = 'next';
export const ERROR_OUTPUT = 'error';
export const DEFAULT_CASE = 'default';

/** What the graph rules need to know about a block, whatever its other fields. */
export interface GraphBlock {
  readonly id: string;
  readonly type: string;
  /** The cases of a Switch. */
  readonly cases?: readonly { readonly id: string }[];
  /** The Parallel a Join ends. */
  readonly parallel?: string;
}

export interface GraphConnection {
  readonly from: string;
  readonly output?: string | undefined;
  readonly to: string;
}

export interface GraphShape {
  readonly blocks: readonly GraphBlock[];
  readonly connections: readonly GraphConnection[];
}

export interface GraphIssue extends AutomationProblem {
  readonly path: readonly (string | number)[];
}

export interface Graph {
  /** Where each block leads, by block id. Connections to unknown blocks are left out. */
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
}

/** The outputs a block offers. */
export function outputsOf(block: GraphBlock): readonly string[] {
  switch (block.type) {
    case 'run':
    case 'wait-for-manual-action':
      return [DEFAULT_OUTPUT, ERROR_OUTPUT];
    case 'if':
      return ['true', 'false'];
    case 'switch':
      return [...(block.cases ?? []).map(({ id }) => id), DEFAULT_CASE];
    default:
      return [DEFAULT_OUTPUT];
  }
}

export function connectionOutput(connection: GraphConnection): string {
  return connection.output ?? DEFAULT_OUTPUT;
}

export function buildGraph({ blocks, connections }: GraphShape): Graph {
  const ids = new Set(blocks.map(({ id }) => id));
  const successors = new Map<string, string[]>(blocks.map(({ id }) => [id, []]));
  const predecessors = new Map<string, string[]>(blocks.map(({ id }) => [id, []]));
  for (const { from, to } of connections) {
    if (ids.has(from) && ids.has(to)) {
      successors.get(from)?.push(to);
      predecessors.get(to)?.push(from);
    }
  }
  return { successors, predecessors };
}

/** Blocks reachable from `from`, not counting it, without going past `stopAt`, which is not counted either. */
export function reachableFrom(graph: Graph, from: string, stopAt?: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(graph.successors.get(from) ?? [])];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === stopAt || id === from || seen.has(id)) continue;
    seen.add(id);
    pending.push(...(graph.successors.get(id) ?? []));
  }
  return seen;
}

/** Block ids in order so that every connection goes forward, or undefined when there is a cycle. */
export function topologicalOrder(shape: GraphShape): string[] | undefined {
  const graph = buildGraph(shape);
  const waiting = new Map(
    shape.blocks.map(({ id }) => [id, graph.predecessors.get(id)?.length ?? 0]),
  );
  const ready = shape.blocks.filter(({ id }) => waiting.get(id) === 0).map(({ id }) => id);
  const order: string[] = [];
  for (let id = ready.shift(); id !== undefined; id = ready.shift()) {
    order.push(id);
    for (const next of graph.successors.get(id) ?? []) {
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return order.length === shape.blocks.length ? order : undefined;
}

/** The rules about connections that one file can break, which a JSON Schema cannot state. */
export function graphIssues(shape: GraphShape): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (
    path: (string | number)[],
    code: AutomationProblemCode,
    params: AutomationProblemParams = {},
    blockId?: string,
  ): void => {
    issues.push({ path, ...automationProblem(code, params, blockId) });
  };
  const { blocks, connections } = shape;
  const byId = new Map(blocks.map((block) => [block.id, block]));

  blocks.forEach((block, index) => {
    if (blocks.findIndex(({ id }) => id === block.id) !== index) {
      add(['blocks', index, 'id'], 'duplicate-block', { block: block.id }, block.id);
    }
  });

  const starts = blocks.filter(({ type }) => type === 'start');
  if (starts.length !== 1) {
    add(['blocks'], 'start-count', { count: String(starts.length) });
  }

  const used = new Set<string>();
  connections.forEach((connection, index) => {
    const path = ['connections', index];
    const source = byId.get(connection.from);
    const target = byId.get(connection.to);
    if (source === undefined) {
      add([...path, 'from'], 'connection-from-missing', {
        index: String(index + 1),
        from: connection.from,
      });
    }
    if (target === undefined) {
      add(
        [...path, 'to'],
        'connection-to-missing',
        { index: String(index + 1), to: connection.to },
        source?.id,
      );
    } else if (target.type === 'start') {
      add([...path, 'to'], 'into-start', {}, source?.id);
    }
    if (source === undefined) return;
    const output = connectionOutput(connection);
    if (!outputsOf(source).includes(output)) {
      add([...path, 'output'], 'unknown-output', { block: source.id, output }, source.id);
      return;
    }
    const key = `${source.id}\u0000${output}`;
    if (source.type !== 'parallel' && used.has(key)) {
      add([...path, 'output'], 'output-to-many', { block: source.id, output }, source.id);
    }
    used.add(key);
  });

  if (topologicalOrder(shape) === undefined) {
    add(['connections'], 'cycle');
    return issues;
  }

  const graph = buildGraph(shape);
  blocks.forEach((block, index) => {
    if (block.type === 'parallel') {
      const branches = connections.filter(({ from }) => from === block.id).length;
      if (branches < 2) {
        add(['blocks', index], 'parallel-branches', { block: block.id }, block.id);
      }
      const joins = blocks.filter(({ type, parallel }) => type === 'join' && parallel === block.id);
      if (joins.length !== 1) {
        add(
          ['blocks', index],
          'parallel-joins',
          { block: block.id, count: String(joins.length) },
          block.id,
        );
      }
    }
    if (block.type !== 'join') return;
    const parallel = block.parallel === undefined ? undefined : byId.get(block.parallel);
    if (parallel?.type !== 'parallel') {
      add(['blocks', index, 'parallel'], 'join-without-parallel', { block: block.id }, block.id);
      return;
    }
    const region = reachableFrom(graph, parallel.id, block.id);
    if (
      !(graph.predecessors.get(block.id) ?? []).some((id) => region.has(id) || id === parallel.id)
    ) {
      add(
        ['blocks', index],
        'join-unreached',
        { block: block.id, parallel: parallel.id },
        block.id,
      );
    }
    const inside = new Set([...region, parallel.id]);
    for (const id of [...region, block.id]) {
      if ((graph.predecessors.get(id) ?? []).some((before) => !inside.has(before))) {
        add(
          ['blocks', index],
          'branches-leak',
          { block: block.id, parallel: parallel.id },
          block.id,
        );
        break;
      }
    }
  });
  return issues;
}

/** What is certain once a path has reached a block. */
export interface Guarantee {
  /** Blocks that finished with a result before it, so their outputs exist. */
  readonly completed: ReadonlySet<string>;
  /** Blocks that ran before it, failed ones included, so their exit code exists. */
  readonly ran: ReadonlySet<string>;
}

function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  return new Set([...(first ?? [])].filter((id) => rest.every((other) => other.has(id))));
}

/**
 * For each block, the blocks that ran on every path that reaches it. A block that failed and led on
 * through its Error output ran, but left no outputs. Branches of a Parallel cannot see one another,
 * and what each leaves is certain after the Join. Blocks that no path reaches know nothing.
 */
export function guarantees(shape: GraphShape): ReadonlyMap<string, Guarantee> {
  const known = new Map<string, Guarantee>();
  const order = topologicalOrder(shape);
  if (order === undefined) {
    return known;
  }
  const graph = buildGraph(shape);
  const byId = new Map(shape.blocks.map((block) => [block.id, block]));
  const incoming = new Map<string, GraphConnection[]>(shape.blocks.map(({ id }) => [id, []]));
  for (const connection of shape.connections) {
    if (byId.has(connection.from)) incoming.get(connection.to)?.push(connection);
  }
  const none: Guarantee = { completed: new Set(), ran: new Set() };

  /** What a path carries when it leaves a block through a connection. */
  const along = (connection: GraphConnection): Guarantee => {
    const before = known.get(connection.from) ?? none;
    const completed = new Set(before.completed);
    if (connectionOutput(connection) !== ERROR_OUTPUT) completed.add(connection.from);
    return { completed, ran: new Set([...before.ran, connection.from]) };
  };
  const meet = (paths: readonly Guarantee[]): Guarantee => ({
    completed: intersection(paths.map(({ completed }) => completed)),
    ran: intersection(paths.map(({ ran }) => ran)),
  });

  for (const id of order) {
    const block = byId.get(id);
    const edges = (incoming.get(id) ?? []).filter(({ to }) => byId.has(to));
    if (block?.type !== 'join' || block.parallel === undefined || !byId.has(block.parallel)) {
      known.set(id, meet(edges.map(along)));
      continue;
    }
    // Each branch is certain on its own, and the Join brings them together.
    const opening = known.get(block.parallel) ?? none;
    const completed = new Set([...opening.completed, block.parallel]);
    const ran = new Set([...opening.ran, block.parallel]);
    for (const root of graph.successors.get(block.parallel) ?? []) {
      const branch = new Set([root, ...reachableFrom(graph, root, id)]);
      const ends = edges.filter(({ from }) => branch.has(from)).map(along);
      const certain = meet(ends);
      certain.completed.forEach((other) => completed.add(other));
      certain.ran.forEach((other) => ran.add(other));
    }
    known.set(id, { completed, ran });
  }
  return known;
}

/**
 * The blocks an output may lead to without breaking a rule, for the canvas to offer. The output's
 * current connection is left out of the trial, since connecting replaces it except on Parallel.
 * Rules that only a later block can satisfy, such as a Parallel's second branch, are not held
 * against a target.
 */
export function validTargets(shape: GraphShape, from: string, output: string): string[] {
  const source = shape.blocks.find(({ id }) => id === from);
  if (source === undefined || !outputsOf(source).includes(output)) return [];
  const kept = shape.connections.filter(
    (connection) =>
      source.type === 'parallel' ||
      connection.from !== from ||
      connectionOutput(connection) !== output,
  );
  const before = new Set(graphIssues({ blocks: shape.blocks, connections: kept }).map(issueKey));
  const graph = buildGraph({ blocks: shape.blocks, connections: kept });
  return shape.blocks
    .filter((target) => {
      if (target.id === from || target.type === 'start') return false;
      if (reachableFrom(graph, target.id).has(from)) return false;
      if (
        kept.some((c) => c.from === from && c.to === target.id && connectionOutput(c) === output)
      ) {
        return false;
      }
      const trial = [...kept, { from, output, to: target.id }];
      return graphIssues({ blocks: shape.blocks, connections: trial })
        .filter(({ code }) => code === 'branches-leak' || code === 'output-to-many')
        .every((issue) => before.has(issueKey(issue)));
    })
    .map(({ id }) => id);
}

function issueKey({ code, blockId }: GraphIssue): string {
  return `${code}\u0000${blockId ?? ''}`;
}
