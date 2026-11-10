import { DEFAULT_OUTPUT, ERROR_OUTPUT, connectionOutput, outputsOf } from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  AutomationConnection,
  AutomationGroup,
  AutomationNote,
  AutomationPosition,
} from '@bildora/protocol';
import type { AutomationDraft, AutomationView } from '../../../shared/ipc-contract.js';

/** What the canvas edits: the automation as its file holds it, with every section present. */
export interface FlowDocument {
  readonly name: string;
  readonly description: string;
  readonly blocks: readonly AutomationBlock[];
  readonly connections: readonly AutomationConnection[];
  readonly positions: Readonly<Record<string, AutomationPosition>>;
  readonly notes: readonly AutomationNote[];
  readonly groups: readonly AutomationGroup[];
}

export type BlockKind = AutomationBlock['type'];

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Room between blocks placed one after another. */
export const GAP_X = 64;
export const GAP_Y = 28;
const OUTPUT_ROW = 22;

/** How big a block is drawn. Shapes differ so that kinds read apart without color. */
export function sizeOf(block: AutomationBlock): Size {
  switch (block.type) {
    case 'start':
      return { width: 156, height: 44 };
    case 'if':
      return { width: 208, height: 64 };
    case 'switch':
      return { width: 184, height: Math.max(64, (block.cases.length + 1) * OUTPUT_ROW + 12) };
    case 'parallel':
    case 'join':
      return { width: 36, height: 88 };
    default:
      return { width: 216, height: 56 };
  }
}

const START: AutomationBlock = { id: 'start', type: 'start' };

export function emptyDocument(): FlowDocument {
  return {
    name: '',
    description: '',
    blocks: [START],
    connections: [],
    positions: { start: { x: 0, y: 0 } },
    notes: [],
    groups: [],
  };
}

export function documentOf(automation: AutomationView | undefined): FlowDocument {
  if (automation === undefined) {
    return emptyDocument();
  }
  const { name, description, blocks, connections, positions, notes, groups } = automation;
  return { name, description: description ?? '', blocks, connections, positions, notes, groups };
}

/** The document as the channel carries it. Positions of blocks that are gone are left out. */
export function draftOf(document: FlowDocument, id?: string): AutomationDraft {
  const name = document.name.trim();
  const description = document.description.trim();
  const ids = new Set(document.blocks.map((block) => block.id));
  const positions = Object.fromEntries(
    Object.entries(document.positions).filter(([block]) => ids.has(block)),
  );
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(description === '' ? {} : { description }),
    blocks: document.blocks,
    connections: document.connections,
    positions,
    notes: document.notes,
    groups: document.groups,
  };
}

/** A block id is a name a reference can hold, so a tool's dotted id gives only its last part. */
function idBase(text: string): string {
  const last = text.split('.').at(-1) ?? text;
  const cleaned = last.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[^a-zA-Z]+/, '');
  return cleaned === '' ? 'block' : cleaned.slice(0, 56);
}

/** Ids that blocks, notes and groups already use, since they share one namespace. */
export function takenIds(document: FlowDocument): Set<string> {
  return new Set([
    ...document.blocks.map(({ id }) => id),
    ...document.notes.map(({ id }) => id),
    ...document.groups.map(({ id }) => id),
  ]);
}

export function freeId(text: string, taken: ReadonlySet<string>): string {
  const base = idBase(text);
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/** What a new block can be: a kind, and for Run tool, which tool. */
export type NewBlock =
  | { readonly kind: 'run'; readonly tool: string }
  | { readonly kind: Exclude<BlockKind, 'run' | 'start' | 'join'> };

/** A first rule for a new decision, which the person then changes. */
function firstCondition(document: FlowDocument, near?: string): AutomationCondition {
  const nearBlock = document.blocks.find(({ id }) => id === near);
  const source =
    nearBlock?.type === 'run'
      ? nearBlock.id
      : ([...document.blocks].reverse().find(({ type }) => type === 'run')?.id ?? 'start');
  return {
    match: 'all',
    rules: [{ block: source, field: 'result', operator: 'is', value: 'completed' }],
  };
}

/**
 * Makes the blocks for a choice in the library. A Parallel comes with its Join, since one never
 * works without the other.
 */
export function createBlocks(
  document: FlowDocument,
  choice: NewBlock,
  defaultMessage: string,
  near?: string,
): AutomationBlock[] {
  const taken = takenIds(document);
  const id = (text: string): string => {
    const value = freeId(text, taken);
    taken.add(value);
    return value;
  };
  switch (choice.kind) {
    case 'run':
      return [{ id: id(choice.tool), type: 'run', tool: choice.tool }];
    case 'wait-for-time':
      return [{ id: id('pause'), type: 'wait-for-time', seconds: 60 }];
    case 'wait-for-manual-action':
      return [{ id: id('review'), type: 'wait-for-manual-action', message: defaultMessage }];
    case 'if':
      return [{ id: id('decide'), type: 'if', condition: firstCondition(document, near) }];
    case 'switch':
      return [
        {
          id: id('choose'),
          type: 'switch',
          cases: [{ id: 'case-1', condition: firstCondition(document, near) }],
        },
      ];
    case 'parallel': {
      const parallel = id('parallel');
      return [
        { id: parallel, type: 'parallel' },
        { id: id('join'), type: 'join', parallel },
      ];
    }
  }
}

function overlaps(a: AutomationPosition & Size, b: AutomationPosition & Size): boolean {
  return (
    a.x < b.x + b.width + GAP_X / 2 &&
    b.x < a.x + a.width + GAP_X / 2 &&
    a.y < b.y + b.height + GAP_Y &&
    b.y < a.y + a.height + GAP_Y
  );
}

/** Moves a spot down until a block of that size fits there without covering another. */
export function freeSpot(
  document: FlowDocument,
  at: AutomationPosition,
  size: Size,
): AutomationPosition {
  const placed = document.blocks.flatMap((block) => {
    const position = document.positions[block.id];
    return position === undefined ? [] : [{ ...position, ...sizeOf(block) }];
  });
  const spot = { ...at };
  while (placed.some((other) => overlaps({ ...spot, ...size }, other))) {
    spot.y += GAP_Y + 4;
  }
  return spot;
}

/** Adds blocks from the left, one after another; a Join goes past its Parallel's branches. */
export function addBlocks(
  document: FlowDocument,
  blocks: readonly AutomationBlock[],
  at: AutomationPosition,
): FlowDocument {
  let current = document;
  let x = at.x;
  for (const block of blocks) {
    const size = sizeOf(block);
    const spot = freeSpot(current, { x, y: at.y }, size);
    current = {
      ...current,
      blocks: [...current.blocks, block],
      positions: { ...current.positions, [block.id]: spot },
    };
    x += size.width + (block.type === 'parallel' ? 216 + GAP_X * 2 : GAP_X);
  }
  return current;
}

export function blockOf(document: FlowDocument, id: string): AutomationBlock | undefined {
  return document.blocks.find((block) => block.id === id);
}

/** Outputs of a block that lead nowhere yet. A Parallel's output always has room for more. */
export function freeOutputs(document: FlowDocument, id: string): string[] {
  const block = blockOf(document, id);
  if (block === undefined) return [];
  const used = new Set(
    document.connections.filter(({ from }) => from === id).map(connectionOutput),
  );
  return outputsOf(block).filter((output) => block.type === 'parallel' || !used.has(output));
}

/**
 * Connects an output to a block. Every output but a Parallel's leads to one block, so connecting
 * it again replaces where it led.
 */
export function connect(
  document: FlowDocument,
  from: string,
  output: string,
  to: string,
): FlowDocument {
  const source = blockOf(document, from);
  if (source === undefined || from === to) return document;
  const same = (connection: AutomationConnection): boolean =>
    connection.from === from && connectionOutput(connection) === output;
  if (document.connections.some((connection) => same(connection) && connection.to === to)) {
    return document;
  }
  const kept =
    source.type === 'parallel'
      ? document.connections
      : document.connections.filter((connection) => !same(connection));
  const connection: AutomationConnection =
    output === DEFAULT_OUTPUT ? { from, to } : { from, output, to };
  return { ...document, connections: [...kept, connection] };
}

export function disconnect(
  document: FlowDocument,
  from: string,
  output: string,
  to: string,
): FlowDocument {
  return {
    ...document,
    connections: document.connections.filter(
      (connection) =>
        !(
          connection.from === from &&
          connection.to === to &&
          connectionOutput(connection) === output
        ),
    ),
  };
}

/** Adds a block after another, joined from the anchor's first free output that is not Error. */
export function addAfter(
  document: FlowDocument,
  anchorId: string,
  blocks: readonly AutomationBlock[],
): { readonly document: FlowDocument; readonly output?: string } {
  const anchor = blockOf(document, anchorId);
  const [first] = blocks;
  const at = document.positions[anchorId];
  if (anchor === undefined || first === undefined || at === undefined) {
    return { document };
  }
  const placed = addBlocks(document, blocks, { x: at.x + sizeOf(anchor).width + GAP_X, y: at.y });
  const free = freeOutputs(document, anchorId).find((name) => name !== ERROR_OUTPUT);
  if (free !== undefined) {
    return { document: connect(placed, anchorId, free, first.id), output: free };
  }
  // A block whose only way on is taken gets the new one in between, as a list would.
  const ways = outputsOf(anchor).filter((name) => name !== ERROR_OUTPUT);
  const [only] = ways;
  const after = document.connections.find(
    (connection) => connection.from === anchorId && connectionOutput(connection) === only,
  );
  const tail = blocks.find((block) => block.type === 'join') ?? blocks.at(-1);
  if (ways.length !== 1 || only === undefined || after === undefined || tail === undefined) {
    return { document: placed };
  }
  let joined = connect(placed, anchorId, only, first.id);
  if (outputsOf(tail).includes(DEFAULT_OUTPUT)) {
    joined = connect(joined, tail.id, DEFAULT_OUTPUT, after.to);
  }
  return { document: joined, output: only };
}

/**
 * Removes blocks, notes and groups, with whatever names them. A Parallel and its Join go together,
 * since neither works alone.
 */
export function removeItems(document: FlowDocument, ids: ReadonlySet<string>): FlowDocument {
  // Every automation keeps its one Start block.
  const gone = new Set([...ids].filter((id) => blockOf(document, id)?.type !== 'start'));
  for (const block of document.blocks) {
    if (block.type === 'join' && (gone.has(block.id) || gone.has(block.parallel))) {
      gone.add(block.id);
      gone.add(block.parallel);
    }
  }
  return {
    ...document,
    blocks: document.blocks.filter(({ id }) => !gone.has(id)),
    connections: document.connections.filter(({ from, to }) => !gone.has(from) && !gone.has(to)),
    positions: Object.fromEntries(
      Object.entries(document.positions).filter(([id]) => !gone.has(id)),
    ),
    notes: document.notes.filter(({ id }) => !gone.has(id)),
    groups: document.groups
      .filter(({ id }) => !gone.has(id))
      .map((group) => ({ ...group, blocks: group.blocks.filter((id) => !gone.has(id)) }))
      .filter((group) => group.blocks.length > 0),
  };
}

export function moveItems(
  document: FlowDocument,
  moves: Readonly<Record<string, AutomationPosition>>,
): FlowDocument {
  const notes = document.notes.map((note) => {
    const to = moves[note.id];
    return to === undefined ? note : { ...note, x: to.x, y: to.y };
  });
  const blockMoves = Object.fromEntries(
    Object.entries(moves).filter(([id]) => document.blocks.some((block) => block.id === id)),
  );
  return { ...document, positions: { ...document.positions, ...blockMoves }, notes };
}

/**
 * Replaces a block's settings. Outputs it no longer has lose their connections, and renamed
 * outputs, such as a Switch case, keep theirs.
 */
export function updateBlock(
  document: FlowDocument,
  block: AutomationBlock,
  renamed: Readonly<Record<string, string>> = {},
): FlowDocument {
  const outputs = new Set(outputsOf(block));
  const connections = document.connections.flatMap((connection) => {
    if (connection.from !== block.id) return [connection];
    const output = renamed[connectionOutput(connection)] ?? connectionOutput(connection);
    if (!outputs.has(output)) return [];
    return [
      output === DEFAULT_OUTPUT
        ? { from: connection.from, to: connection.to }
        : { ...connection, output },
    ];
  });
  return {
    ...document,
    blocks: document.blocks.map((item) => (item.id === block.id ? block : item)),
    connections,
  };
}

/** Blocks with no position, which a file written by hand may have. */
export function unplaced(document: FlowDocument): string[] {
  return document.blocks
    .filter(({ id }) => document.positions[id] === undefined)
    .map(({ id }) => id);
}

export const NOTE_SIZE: Size = { width: 220, height: 96 };

/** Adds a note, its top-left corner where asked, with nothing written yet. */
export function addNote(
  document: FlowDocument,
  at: AutomationPosition,
  text: string,
): { readonly document: FlowDocument; readonly id: string } {
  const id = freeId('note', takenIds(document));
  return {
    document: { ...document, notes: [...document.notes, { id, text, x: at.x, y: at.y }] },
    id,
  };
}

export function updateNote(document: FlowDocument, note: AutomationNote): FlowDocument {
  return {
    ...document,
    notes: document.notes.map((item) => (item.id === note.id ? note : item)),
  };
}

/** Frames blocks under a name. A block leaves any group it was in, since it sits in one at most. */
export function groupBlocks(
  document: FlowDocument,
  blocks: readonly string[],
  name: string,
): { readonly document: FlowDocument; readonly id?: string } {
  const members = blocks.filter((id) => blockOf(document, id) !== undefined);
  if (members.length === 0) return { document };
  const id = freeId('group', takenIds(document));
  const others = document.groups
    .map((group) => ({
      ...group,
      blocks: group.blocks.filter((block) => !members.includes(block)),
    }))
    .filter((group) => group.blocks.length > 0);
  return { document: { ...document, groups: [...others, { id, name, blocks: members }] }, id };
}

export function updateGroup(document: FlowDocument, group: AutomationGroup): FlowDocument {
  return {
    ...document,
    groups: document.groups.map((item) => (item.id === group.id ? group : item)),
  };
}

/** Removes a group's frame and leaves its blocks where they are. */
export function ungroup(document: FlowDocument, id: string): FlowDocument {
  return { ...document, groups: document.groups.filter((group) => group.id !== id) };
}
