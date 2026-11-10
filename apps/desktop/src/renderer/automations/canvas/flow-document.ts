import {
  AUTOMATION_BLOCK_LIMIT,
  AUTOMATION_CONNECTION_LIMIT,
  AUTOMATION_NOTE_LIMIT,
  DEFAULT_OUTPUT,
  ERROR_OUTPUT,
  connectionOutput,
  findStepOutputReferences,
  outputsOf,
  stepOutputReference,
  validTargets,
} from '@bildora/protocol';
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

/** One connection, by the output it leaves from. */
export interface ConnectionRef {
  readonly from: string;
  readonly output: string;
  readonly to: string;
}

/** What moves into or out of a connection as one: a block, or a Parallel with its Join. */
export interface BlockEnds {
  /** Where the flow comes in. */
  readonly first: string;
  /** Where it goes on: the block itself, or a Parallel's Join. */
  readonly tail: string;
}

function endsOf(document: FlowDocument, id: string): BlockEnds | undefined {
  const block = blockOf(document, id);
  if (block === undefined || block.type === 'start' || block.type === 'join') return undefined;
  const tail =
    block.type === 'parallel'
      ? document.blocks.find((item) => item.type === 'join' && item.parallel === id)?.id
      : id;
  return tail === undefined ? undefined : { first: id, tail };
}

/** What ties a block into the flow: what leads into it, and where its tail leads. */
function outerConnections(document: FlowDocument, ends: BlockEnds): AutomationConnection[] {
  return document.connections.filter(({ from, to }) => to === ends.first || from === ends.tail);
}

/** The ends of a block that can go into a connection: one tied to nothing outside itself. */
export function spliceEnds(document: FlowDocument, id: string): BlockEnds | undefined {
  const ends = endsOf(document, id);
  return ends !== undefined && outerConnections(document, ends).length === 0 ? ends : undefined;
}

/** True when a block, or a Parallel with its Join, is tied into the flow and can be taken out. */
export function isInFlow(document: FlowDocument, id: string): boolean {
  const ends = endsOf(document, id);
  return ends !== undefined && outerConnections(document, ends).length > 0;
}

/**
 * Takes a block out of the flow, with its Join for a Parallel, whose branches stay. What led to it
 * now leads where its Next led, where that is allowed. A decision has no Next, so it only lets go.
 */
export function extractBlock(document: FlowDocument, id: string): FlowDocument {
  const ends = endsOf(document, id);
  if (ends === undefined) return document;
  const outer = outerConnections(document, ends);
  if (outer.length === 0) return document;
  const next = outer.find(
    (connection) =>
      connection.from === ends.tail && connectionOutput(connection) === DEFAULT_OUTPUT,
  )?.to;
  let result: FlowDocument = {
    ...document,
    connections: document.connections.filter((connection) => !outer.includes(connection)),
  };
  if (next === undefined) return result;
  for (const connection of outer.filter(({ to }) => to === ends.first)) {
    const output = connectionOutput(connection);
    if (validTargets(result, connection.from, output).includes(next)) {
      result = connect(result, connection.from, output, next);
    }
  }
  return result;
}

/**
 * Puts blocks into a connection: what led to `to` now leads to `firstId`, and `tailId` goes on to
 * `to` through Next. For a Parallel, the tail is its Join. Gives nothing when that cannot be done:
 * the connection is gone, Start would move, the tail has no free Next, or a loop would form.
 */
export function spliceInto(
  document: FlowDocument,
  connection: ConnectionRef,
  firstId: string,
  tailId: string,
): FlowDocument | undefined {
  const { from, output, to } = connection;
  const exists = document.connections.some(
    (item) => item.from === from && item.to === to && connectionOutput(item) === output,
  );
  const first = blockOf(document, firstId);
  const tail = blockOf(document, tailId);
  if (!exists || first === undefined || tail === undefined) return undefined;
  if ([firstId, tailId].some((id) => id === from || id === to)) return undefined;
  if (first.type === 'start' || !outputsOf(tail).includes(DEFAULT_OUTPUT)) return undefined;
  if (!freeOutputs(document, tailId).includes(DEFAULT_OUTPUT)) return undefined;
  const opened = disconnect(document, from, output, to);
  if (!validTargets(opened, from, output).includes(firstId)) return undefined;
  const led = connect(opened, from, output, firstId);
  if (!validTargets(led, tailId, DEFAULT_OUTPUT).includes(to)) return undefined;
  return connect(led, tailId, DEFAULT_OUTPUT, to);
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

/** Blocks and notes copied from a flow, with the connections between them. */
export interface FlowClip {
  readonly blocks: readonly AutomationBlock[];
  readonly connections: readonly AutomationConnection[];
  readonly positions: Readonly<Record<string, AutomationPosition>>;
  readonly notes: readonly AutomationNote[];
}

/**
 * Copies blocks and notes. A Parallel and its Join go together, Start never goes, and only the
 * connections between copied blocks are kept. Gives nothing when there is nothing to copy.
 */
export function copyItems(document: FlowDocument, ids: ReadonlySet<string>): FlowClip | undefined {
  const chosen = new Set(ids);
  for (const block of document.blocks) {
    if (block.type === 'join' && (chosen.has(block.id) || chosen.has(block.parallel))) {
      chosen.add(block.id);
      chosen.add(block.parallel);
    }
  }
  const blocks = document.blocks.filter(
    ({ id, type }) => chosen.has(id) && type !== 'start' && document.positions[id] !== undefined,
  );
  const notes = document.notes.filter(({ id }) => chosen.has(id));
  if (blocks.length === 0 && notes.length === 0) return undefined;
  const copied = new Set(blocks.map(({ id }) => id));
  return {
    blocks,
    connections: document.connections.filter(({ from, to }) => copied.has(from) && copied.has(to)),
    positions: Object.fromEntries(
      [...copied].flatMap((id) => {
        const at = document.positions[id];
        return at === undefined ? [] : [[id, at]];
      }),
    ),
    notes,
  };
}

/** The top-left corner of what was copied. */
export function clipCorner(clip: FlowClip): AutomationPosition {
  const corners = [...Object.values(clip.positions), ...clip.notes];
  return { x: Math.min(...corners.map(({ x }) => x)), y: Math.min(...corners.map(({ y }) => y)) };
}

/** Gives a value its references to copied blocks, written with their new ids. */
function renamedReferences(text: string, ids: ReadonlyMap<string, string>): string {
  let result = text;
  for (const reference of findStepOutputReferences(text)) {
    const step = ids.get(reference.step);
    if (step !== undefined) {
      result = result.replaceAll(
        stepOutputReference(reference),
        stepOutputReference({ step, output: reference.output }),
      );
    }
  }
  return result;
}

function renamedCondition(
  condition: AutomationCondition,
  ids: ReadonlyMap<string, string>,
): AutomationCondition {
  return {
    ...condition,
    rules: condition.rules.map((rule) => ({ ...rule, block: ids.get(rule.block) ?? rule.block })),
  };
}

/** A copied block under its new id, with what names other copied blocks renamed too. */
function renamedBlock(block: AutomationBlock, ids: ReadonlyMap<string, string>): AutomationBlock {
  const id = ids.get(block.id) ?? block.id;
  switch (block.type) {
    case 'run': {
      if (block.values === undefined) return { ...block, id };
      const values = Object.fromEntries(
        Object.entries(block.values).map(([name, value]) => [
          name,
          typeof value === 'string' ? renamedReferences(value, ids) : value,
        ]),
      );
      return { ...block, id, values };
    }
    case 'if':
      return { ...block, id, condition: renamedCondition(block.condition, ids) };
    case 'switch':
      return {
        ...block,
        id,
        cases: block.cases.map((item) => ({
          ...item,
          condition: renamedCondition(item.condition, ids),
        })),
      };
    case 'join':
      return { ...block, id, parallel: ids.get(block.parallel) ?? block.parallel };
    default:
      return { ...block, id };
  }
}

/**
 * Pastes a copy with its top-left corner at `at`. Every block and note gets a new id, and
 * references between copied blocks follow them; references to blocks left behind stay. Gives
 * nothing when the flow would hold more than a file allows.
 */
export function pasteItems(
  document: FlowDocument,
  clip: FlowClip,
  at: AutomationPosition,
): { readonly document: FlowDocument; readonly ids: readonly string[] } | undefined {
  if (
    document.blocks.length + clip.blocks.length > AUTOMATION_BLOCK_LIMIT ||
    document.notes.length + clip.notes.length > AUTOMATION_NOTE_LIMIT ||
    document.connections.length + clip.connections.length > AUTOMATION_CONNECTION_LIMIT
  ) {
    return undefined;
  }
  const { x: left, y: top } = clipCorner(clip);
  const shift = (point: AutomationPosition): AutomationPosition => ({
    x: point.x - left + at.x,
    y: point.y - top + at.y,
  });
  const taken = takenIds(document);
  const ids = new Map<string, string>();
  for (const { id } of [...clip.blocks, ...clip.notes]) {
    // A copy of convert-2 is convert-3, not convert-2-2.
    const fresh = freeId(id.replace(/-\d+$/, ''), taken);
    taken.add(fresh);
    ids.set(id, fresh);
  }
  const newId = (id: string): string => ids.get(id) ?? id;
  const blocks = clip.blocks.map((block) => renamedBlock(block, ids));
  const connections = clip.connections.map((connection) => ({
    ...connection,
    from: newId(connection.from),
    to: newId(connection.to),
  }));
  const positions = Object.fromEntries(
    Object.entries(clip.positions).map(([id, point]) => [newId(id), shift(point)]),
  );
  const notes = clip.notes.map((note) => ({ ...note, id: newId(note.id), ...shift(note) }));
  return {
    document: {
      ...document,
      blocks: [...document.blocks, ...blocks],
      connections: [...document.connections, ...connections],
      positions: { ...document.positions, ...positions },
      notes: [...document.notes, ...notes],
    },
    ids: [...blocks.map(({ id }) => id), ...notes.map(({ id }) => id)],
  };
}
