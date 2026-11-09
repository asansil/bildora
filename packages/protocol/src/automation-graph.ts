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

export interface GraphIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
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
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };
  const { blocks, connections } = shape;
  const byId = new Map(blocks.map((block) => [block.id, block]));

  blocks.forEach((block, index) => {
    if (blocks.findIndex(({ id }) => id === block.id) !== index) {
      add(['blocks', index, 'id'], `Block "${block.id}" is declared more than once`);
    }
  });

  const starts = blocks.filter(({ type }) => type === 'start');
  if (starts.length !== 1) {
    add(
      ['blocks'],
      `An automation needs exactly one Start block, and this one has ${String(starts.length)}`,
    );
  }

  const used = new Set<string>();
  connections.forEach((connection, index) => {
    const path = ['connections', index];
    const source = byId.get(connection.from);
    const target = byId.get(connection.to);
    if (source === undefined) {
      add(
        [...path, 'from'],
        `Connection ${String(index + 1)} starts at "${connection.from}", which does not exist`,
      );
    }
    if (target === undefined) {
      add(
        [...path, 'to'],
        `Connection ${String(index + 1)} ends at "${connection.to}", which does not exist`,
      );
    } else if (target.type === 'start') {
      add([...path, 'to'], 'Nothing can lead into the Start block');
    }
    if (source === undefined) return;
    const output = connectionOutput(connection);
    if (!outputsOf(source).includes(output)) {
      add([...path, 'output'], `Block "${source.id}" has no output "${output}"`);
      return;
    }
    const key = `${source.id}\u0000${output}`;
    if (source.type !== 'parallel' && used.has(key)) {
      add(
        [...path, 'output'],
        `The "${output}" output of "${source.id}" leads to more than one block, and only Parallel starts several paths`,
      );
    }
    used.add(key);
  });

  if (topologicalOrder(shape) === undefined) {
    add(['connections'], 'The connections go in a circle, and only a loop block may repeat work');
    return issues;
  }

  const graph = buildGraph(shape);
  blocks.forEach((block, index) => {
    if (block.type === 'parallel') {
      const branches = connections.filter(({ from }) => from === block.id).length;
      if (branches < 2) {
        add(['blocks', index], `Parallel "${block.id}" needs at least two branches`);
      }
      const joins = blocks.filter(({ type, parallel }) => type === 'join' && parallel === block.id);
      if (joins.length !== 1) {
        add(
          ['blocks', index],
          `Parallel "${block.id}" needs exactly one Join, and has ${String(joins.length)}`,
        );
      }
    }
    if (block.type !== 'join') return;
    const parallel = block.parallel === undefined ? undefined : byId.get(block.parallel);
    if (parallel?.type !== 'parallel') {
      add(['blocks', index, 'parallel'], `Join "${block.id}" must end a Parallel block`);
      return;
    }
    const region = reachableFrom(graph, parallel.id, block.id);
    if (
      !(graph.predecessors.get(block.id) ?? []).some((id) => region.has(id) || id === parallel.id)
    ) {
      add(['blocks', index], `Join "${block.id}" is never reached from Parallel "${parallel.id}"`);
    }
    const inside = new Set([...region, parallel.id]);
    for (const id of [...region, block.id]) {
      if ((graph.predecessors.get(id) ?? []).some((before) => !inside.has(before))) {
        add(
          ['blocks', index],
          `The branches of Parallel "${parallel.id}" must meet only at Join "${block.id}", and nothing may lead into them from outside`,
        );
        break;
      }
    }
  });
  return issues;
}
