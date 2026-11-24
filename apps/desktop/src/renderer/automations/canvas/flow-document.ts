import {
  AUTOMATION_BLOCK_LIMIT,
  AUTOMATION_CONNECTION_LIMIT,
  AUTOMATION_NOTE_LIMIT,
  BODY_OUTPUT,
  DEFAULT_OUTPUT,
  ERROR_OUTPUT,
  connectionOutput,
  isDisableable,
  findStepOutputReferences,
  isLoopType,
  isReservedBlockId,
  loopBody,
  outputsOf,
  renameInBlockExpressions,
  staysInFrame,
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
import { LOOP_EMPTY, centreOf, frameRects, insideCorner, loopAt } from './loop-frames.js';
import type { Rect } from './loop-frames.js';

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
/** Every block is one compact row, told apart by its icon and family color. */
export const BLOCK_WIDTH = 160;
export const BLOCK_HEIGHT = 32;
/** Room along a side for each output that can sit beside another, with its label. */
const OUTPUT_ROW = 16;

/**
 * How big a block is drawn. A block whose outputs share its right side grows tall enough to keep
 * them apart; Error rests on the bottom, so it never counts.
 */
export function sizeOf(block: AutomationBlock): Size {
  // A loop is drawn as a frame around its blocks; this is the frame with nothing in it.
  if (isLoopType(block.type)) return LOOP_EMPTY;
  const beside = outputsOf(block).filter((output) => output !== ERROR_OUTPUT).length;
  return { width: BLOCK_WIDTH, height: Math.max(BLOCK_HEIGHT, beside * OUTPUT_ROW + 8) };
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

/** An id for a note or a group: a word, then `-2`, `-3` and so on when it is taken. */
export function freeId(text: string, taken: ReadonlySet<string>): string {
  const base = idBase(text);
  let candidate = base;
  // Names that expressions keep for other values, such as `run`, never name a block.
  for (let suffix = 2; taken.has(candidate) || isReservedBlockId(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/**
 * What a block's name starts with: a tool's name in CamelCase, letters and digits only, with
 * accents removed. `File check` gives `FileCheck`; text that would not start with a letter gives
 * `Block`.
 */
export function nameBase(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word !== '');
  const base = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return /^[a-zA-Z]/.test(base) ? base.slice(0, 56) : 'Block';
}

/** A block's name: its base and the smallest free number from 1, such as `FileCheck1`. */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  let candidate = `${base}1`;
  // Names that expressions keep for other values never name a block.
  for (let number = 2; taken.has(candidate) || isReservedBlockId(candidate); number += 1) {
    candidate = `${base}${String(number)}`;
  }
  return candidate;
}

/** The base a pasted block is numbered from: its name without the number it ends with. */
function pastedBase(id: string): string {
  const base = id.replace(/-?\d+$/, '');
  return /^[a-zA-Z]/.test(base) ? base : 'Block';
}

/** What a block id may look like: what a link can name, as in `convert.file`. */
const BLOCK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export type BlockIdProblem = 'pattern' | 'reserved' | 'taken';

/** Why `next` cannot name the block now called `current`, or undefined when it can. */
export function blockIdProblem(
  document: FlowDocument,
  current: string,
  next: string,
): BlockIdProblem | undefined {
  if (!BLOCK_ID.test(next)) return 'pattern';
  if (isReservedBlockId(next)) return 'reserved';
  if (next !== current && takenIds(document).has(next)) return 'taken';
  return undefined;
}

/**
 * Gives a block another id. Everything that names it follows: connections, its place and group,
 * rules, the Join of a Parallel, references in text, and links and expressions.
 */
export function renameBlock(document: FlowDocument, from: string, to: string): FlowDocument {
  if (from === to) return document;
  const ids = new Map([[from, to]]);
  const renamed = (id: string): string => (id === from ? to : id);
  return {
    ...document,
    blocks: document.blocks.map((block) => renamedBlock(block, ids)),
    connections: document.connections.map((connection) => ({
      ...connection,
      from: renamed(connection.from),
      to: renamed(connection.to),
    })),
    positions: Object.fromEntries(
      Object.entries(document.positions).map(([id, position]) => [renamed(id), position]),
    ),
    groups: document.groups.map((group) => ({ ...group, blocks: group.blocks.map(renamed) })),
  };
}

/**
 * What a new block can be: a kind, and for Run tool, which tool. A tool's name gives the block's
 * name; without it, the last part of the tool's id does.
 */
export type NewBlock =
  | { readonly kind: 'run'; readonly tool: string; readonly toolName?: string }
  | {
      readonly kind: 'run-automation';
      readonly automation: string;
      readonly automationName?: string;
    }
  /** A Join, ending `parallel`, or the Parallel `parallelFor` picks when left out. */
  | { readonly kind: 'join'; readonly parallel?: string }
  | { readonly kind: Exclude<BlockKind, 'run' | 'start' | 'join' | 'run-automation'> };

/** The Parallel blocks that no Join ends yet. */
export function openParallels(document: FlowDocument): string[] {
  const ended = new Set(
    document.blocks.flatMap((block) => (block.type === 'join' ? [block.parallel] : [])),
  );
  return document.blocks
    .filter((block) => block.type === 'parallel' && !ended.has(block.id))
    .map(({ id }) => id);
}

/**
 * The Parallel a new Join ends: the only one with no Join yet, `near` when it is one of them, or
 * the one nearest to `near`. Undefined when every Parallel has its Join.
 */
export function parallelFor(document: FlowDocument, near?: string): string | undefined {
  const open = openParallels(document);
  if (open.length <= 1) return open[0];
  if (near !== undefined && open.includes(near)) return near;
  const at = near === undefined ? undefined : document.positions[near];
  if (at === undefined) return open[0];
  const distance = (id: string): number => {
    const other = document.positions[id];
    return other === undefined ? Infinity : Math.hypot(other.x - at.x, other.y - at.y);
  };
  return [...open].sort((a, b) => distance(a) - distance(b))[0];
}

/** A choice with its tool's name, which a new Run tool block is named after. */
export function namedChoice<Choice extends NewBlock>(
  choice: Choice,
  tools: readonly { readonly id: string; readonly name: string }[],
): Choice {
  if (choice.kind !== 'run' || choice.toolName !== undefined) return choice;
  const tool = tools.find(({ id }) => id === choice.tool);
  return tool === undefined ? choice : { ...choice, toolName: tool.name };
}

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
  const id = (base: string): string => {
    const value = freeName(base, taken);
    taken.add(value);
    return value;
  };
  switch (choice.kind) {
    case 'run': {
      const base = nameBase(choice.toolName ?? choice.tool.split('.').at(-1) ?? choice.tool);
      return [{ id: id(base), type: 'run', tool: choice.tool }];
    }
    case 'wait-for-time':
      return [{ id: id('Wait'), type: 'wait-for-time', seconds: 60 }];
    case 'wait-for-manual-action':
      return [{ id: id('Confirm'), type: 'wait-for-manual-action', message: defaultMessage }];
    case 'if':
      return [{ id: id('If'), type: 'if', condition: firstCondition(document, near) }];
    case 'switch':
      return [
        {
          id: id('Switch'),
          type: 'switch',
          cases: [{ id: 'case-1', condition: firstCondition(document, near) }],
        },
      ];
    case 'parallel':
      return [{ id: id('Parallel'), type: 'parallel' }];
    case 'join': {
      const parallel = choice.parallel ?? parallelFor(document, near);
      return parallel === undefined ? [] : [{ id: id('Join'), type: 'join', parallel }];
    }
    case 'for':
      return [{ id: id('For'), type: 'for', items: { kind: 'count', count: 3 } }];
    case 'while':
      return [
        {
          id: id('While'),
          type: 'while',
          // Goes on for three rounds until the person writes what it waits for.
          condition: { expression: 'loop.index < 3' },
          maxRounds: 10,
        },
      ];
    case 'run-automation': {
      const base = nameBase(choice.automationName ?? choice.automation);
      return [{ id: id(base), type: 'run-automation', automation: choice.automation }];
    }
  }
}

/**
 * Puts a new block for another tool in a Run tool block's place: a new numbered name, no values,
 * no profile and the default failure policy. Only its position and its connections stay; links
 * and rules that named the old block keep its name, so they show as problems. Gives nothing for a
 * block that is not a Run tool block.
 */
export function replaceBlock(
  document: FlowDocument,
  id: string,
  choice: Extract<NewBlock, { kind: 'run' }>,
): { readonly document: FlowDocument; readonly id: string } | undefined {
  const old = blockOf(document, id);
  if (old?.type !== 'run') return undefined;
  // The old name stays taken, so links to it are not caught by the new block.
  const [fresh] = createBlocks(document, choice, '');
  if (fresh === undefined) return undefined;
  const moved = (item: string): string => (item === id ? fresh.id : item);
  const { [id]: at, ...positions } = document.positions;
  return {
    document: {
      ...document,
      blocks: document.blocks.map((block) => (block.id === id ? fresh : block)),
      connections: document.connections.map((connection) => ({
        ...connection,
        from: moved(connection.from),
        to: moved(connection.to),
      })),
      positions: at === undefined ? positions : { ...positions, [fresh.id]: at },
      groups: document.groups
        .map((group) => ({ ...group, blocks: group.blocks.filter((block) => block !== id) }))
        .filter((group) => group.blocks.length > 0),
    },
    id: fresh.id,
  };
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
  inside?: string,
): AutomationPosition {
  // The frames a block goes into hold it; every other frame is in the way like a block.
  const holders = new Set<string>();
  for (let loop = inside; loop !== undefined && !holders.has(loop);) {
    holders.add(loop);
    loop = loopOf(blockOf(document, loop));
  }
  const frames = documentFrames(document);
  const placed = document.blocks.flatMap((block) => {
    if (isLoopType(block.type)) {
      const frame = frames.get(block.id);
      return frame === undefined || holders.has(block.id) ? [] : [frame];
    }
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
    const spot = freeSpot(current, { x, y: at.y }, size, loopOf(block));
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

/** Each loop's frame as the document places its blocks. */
export function documentFrames(document: FlowDocument): Map<string, Rect> {
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  return frameRects(
    document.blocks,
    (id) => {
      const block = byId.get(id);
      const at = document.positions[id];
      return block === undefined || at === undefined ? undefined : { ...at, ...sizeOf(block) };
    },
    (id) => document.positions[id],
  );
}

/** The innermost loop whose frame holds a point, as the document places its blocks. */
export function loopAtPoint(document: FlowDocument, point: AutomationPosition): string | undefined {
  return loopAt(document.blocks, documentFrames(document), point);
}

/** Puts new blocks into a loop, or leaves them outside every loop. */
export function inLoop(
  blocks: readonly AutomationBlock[],
  loop: string | undefined,
): AutomationBlock[] {
  return blocks.map((block) => withLoop(block, loop));
}

/**
 * Joins blocks that have just gone into a loop to its body, when nothing starts the body yet: the
 * first of them with nothing coming in becomes the first block of the body.
 */
export function joinBodies(document: FlowDocument, entered: readonly string[]): FlowDocument {
  let current = document;
  for (const id of entered) {
    const loop = loopOf(blockOf(current, id));
    if (loop === undefined || !freeOutputs(current, loop).includes(BODY_OUTPUT)) continue;
    if (current.connections.some(({ to }) => to === id)) continue;
    if (!validTargets(current, loop, BODY_OUTPUT).includes(id)) continue;
    current = connect(current, loop, BODY_OUTPUT, id);
  }
  return current;
}

/**
 * Adds a block after another, joined from the anchor's first free output that is not Error. After
 * a loop whose body is empty, it goes inside, as the first block of the body. Otherwise it joins
 * the anchor's own frame.
 */
export function addAfter(
  document: FlowDocument,
  anchorId: string,
  added: readonly AutomationBlock[],
): { readonly document: FlowDocument; readonly output?: string } {
  const anchor = blockOf(document, anchorId);
  const at = document.positions[anchorId];
  if (anchor === undefined || at === undefined) return { document };
  if (isLoopType(anchor.type) && freeOutputs(document, anchorId).includes(BODY_OUTPUT)) {
    const blocks = inLoop(added, anchorId);
    const [first] = blocks;
    if (first === undefined) return { document };
    const frame = documentFrames(document).get(anchorId);
    const placed = addBlocks(document, blocks, insideCorner(frame ?? at));
    return { document: connect(placed, anchorId, BODY_OUTPUT, first.id), output: BODY_OUTPUT };
  }
  const blocks = inLoop(added, loopOf(anchor));
  const [first] = blocks;
  if (first === undefined) return { document };
  const right = isLoopType(anchor.type)
    ? (documentFrames(document).get(anchorId) ?? { ...at, ...sizeOf(anchor) })
    : { ...at, ...sizeOf(anchor) };
  const placed = addBlocks(document, blocks, { x: right.x + right.width + GAP_X, y: at.y });
  const free = freeOutputs(document, anchorId).find(
    (name) => name !== ERROR_OUTPUT && name !== BODY_OUTPUT,
  );
  if (free !== undefined) {
    return { document: connect(placed, anchorId, free, first.id), output: free };
  }
  // A block whose only way on is taken gets the new one in between, as a list would.
  const ways = outputsOf(anchor).filter((name) => name !== ERROR_OUTPUT && name !== BODY_OUTPUT);
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
  // The blocks of a deleted loop stay, in the loop that held it, if any.
  const holder = (loop: string | undefined): string | undefined => {
    let at = loop;
    while (at !== undefined && gone.has(at)) at = loopOf(blockOf(document, at));
    return at;
  };
  return {
    ...document,
    blocks: document.blocks
      .filter(({ id }) => !gone.has(id))
      .map((block) =>
        loopOf(block) === undefined || !gone.has(loopOf(block) ?? '')
          ? block
          : withLoop(block, holder(loopOf(block))),
      ),
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
  // A loop keeps the size of its frame when it moves.
  const blockMoves = Object.fromEntries(
    Object.entries(moves)
      .filter(([id]) => document.blocks.some((block) => block.id === id))
      .map(([id, to]) => [id, withSize({ x: to.x, y: to.y }, document.positions[id])]),
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

/** Whether the run passes through a block without doing what it does. */
export function isDisabled(block: AutomationBlock): boolean {
  return 'disabled' in block && block.disabled === true;
}

function withDisabled(block: AutomationBlock, disabled: boolean): AutomationBlock {
  if (
    block.type === 'start' ||
    block.type === 'parallel' ||
    block.type === 'join' ||
    block.type === 'for' ||
    block.type === 'while'
  ) {
    return block;
  }
  if (disabled) return { ...block, disabled: true };
  const enabled = { ...block };
  delete enabled.disabled;
  return enabled;
}

/**
 * What toggling the chosen blocks does: true when it disables them, false when it enables them, and
 * undefined when none of them can be disabled.
 */
export function disablesChosen(
  document: FlowDocument,
  ids: ReadonlySet<string>,
): boolean | undefined {
  const chosen = document.blocks.filter(({ id, type }) => ids.has(id) && isDisableable(type));
  if (chosen.length === 0) return undefined;
  return chosen.some((block) => !isDisabled(block));
}

/**
 * Disables the chosen blocks, or enables them when every one of them already is disabled. Blocks
 * that cannot be disabled, such as Start, stay as they are.
 */
export function toggleDisabled(document: FlowDocument, ids: ReadonlySet<string>): FlowDocument {
  const disable = disablesChosen(document, ids);
  if (disable === undefined) return document;
  return {
    ...document,
    blocks: document.blocks.map((block) =>
      ids.has(block.id) ? withDisabled(block, disable) : block,
    ),
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

/** The loop a block is inside, if any. */
export function loopOf(block: AutomationBlock | undefined): string | undefined {
  return block === undefined || block.type === 'start' ? undefined : block.loop;
}

/** A block inside a loop, or outside every loop when `loop` is undefined. */
export function withLoop(block: AutomationBlock, loop: string | undefined): AutomationBlock {
  // Start never goes into a loop.
  if (block.type === 'start') return block;
  if (loop === undefined) {
    if (block.loop === undefined) return block;
    const outside = { ...block };
    delete outside.loop;
    return outside;
  }
  return block.loop === loop ? block : { ...block, loop };
}

/**
 * Puts blocks into a loop, or takes them out of every loop when `loop` is undefined. Blocks inside
 * moved loops go with them. Gives nothing when a connection would cross a frame, or a loop would
 * end up inside itself; nothing is changed then, so the blocks go back.
 */
export function placeInLoop(
  document: FlowDocument,
  ids: readonly string[],
  loop: string | undefined,
): FlowDocument | undefined {
  return placeInLoops(document, new Map(ids.map((id) => [id, loop])));
}

/** Puts each block into the loop it is given, or outside every loop for undefined, all at once. */
export function placeInLoops(
  document: FlowDocument,
  assignments: ReadonlyMap<string, string | undefined>,
): FlowDocument | undefined {
  const moved = new Set(
    [...assignments.keys()].filter((id) => blockOf(document, id)?.type !== 'start'),
  );
  if (moved.size === 0) return document;
  for (const id of moved) {
    const loop = assignments.get(id);
    if (loop !== undefined && !isLoopType(blockOf(document, loop)?.type ?? '')) return undefined;
  }
  const blocks = document.blocks.map((block) =>
    moved.has(block.id) ? withLoop(block, assignments.get(block.id)) : block,
  );
  const byId = new Map(blocks.map((block) => [block.id, block]));
  // A loop never ends up inside itself, however far down.
  for (const id of moved) {
    const seen = new Set<string>();
    for (let at = loopOf(byId.get(id)); at !== undefined; at = loopOf(byId.get(at))) {
      if (at === id || seen.has(at)) return undefined;
      seen.add(at);
    }
  }
  const crosses = document.connections.some((connection) => {
    if (!moved.has(connection.from) && !moved.has(connection.to)) return false;
    const source = byId.get(connection.from);
    const target = byId.get(connection.to);
    return (
      source !== undefined &&
      target !== undefined &&
      !staysInFrame(source, connectionOutput(connection), target)
    );
  });
  if (crosses) return undefined;
  const changed = blocks.some((block, index) => block !== document.blocks[index]);
  return changed ? { ...document, blocks } : document;
}

/**
 * What a drag that ended changes about loops: each block let go, with the blocks of a loop let go,
 * lands in the innermost frame under its centre, or outside every loop. `before` is the flow when
 * the drag began, `after` the flow with its new positions. Frames are measured without what moved,
 * so a block dragged out of a frame is out of it. Gives `after` with the new loops, or nothing
 * when a connection would cross a frame, so the move is refused.
 */
export function dropInLoops(
  before: FlowDocument,
  after: FlowDocument,
  dropped: readonly string[],
): FlowDocument | undefined {
  const isLoop = (id: string): boolean => isLoopType(blockOf(after, id)?.type ?? '');
  const carried = new Set(dropped.flatMap((id) => (isLoop(id) ? loopBody(after.blocks, id) : [])));
  // A block moved with its loop stays in it.
  const roots = dropped.filter((id) => !carried.has(id) && blockOf(after, id) !== undefined);
  const moving = new Set([...roots, ...carried]);
  const staying = after.blocks.filter(({ id }) => !moving.has(id));
  const byId = new Map(after.blocks.map((block) => [block.id, block]));
  const rectOf = (id: string): Rect | undefined => {
    const block = byId.get(id);
    const at = after.positions[id];
    return block === undefined || at === undefined ? undefined : { ...at, ...sizeOf(block) };
  };
  const frames = frameRects(staying, rectOf, (id) => before.positions[id]);
  const ownFrames = documentFrames(after);
  const assignments = new Map<string, string | undefined>();
  for (const id of roots) {
    const block = byId.get(id);
    const rect = isLoop(id) ? ownFrames.get(id) : rectOf(id);
    if (block === undefined || block.type === 'start' || rect === undefined) continue;
    const target = loopAt(after.blocks, frames, centreOf(rect), moving);
    if (target !== loopOf(block)) assignments.set(id, target);
  }
  if (assignments.size === 0) return after;
  const placed = placeInLoops(after, assignments);
  const entered = [...assignments].flatMap(([id, loop]) => (loop === undefined ? [] : [id]));
  return placed === undefined ? undefined : joinBodies(placed, entered);
}

/** A position with the frame size another one kept, if it kept one. */
function withSize(
  at: { readonly x: number; readonly y: number },
  kept: AutomationPosition | undefined,
): AutomationPosition {
  return {
    ...at,
    ...(kept?.width === undefined ? {} : { width: kept.width }),
    ...(kept?.height === undefined ? {} : { height: kept.height }),
  };
}

/**
 * Sets the rect a loop's frame keeps, which it never gets smaller than. Its frame still grows
 * around its blocks.
 */
export function resizeLoop(
  document: FlowDocument,
  id: string,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): FlowDocument {
  if (!isLoopType(blockOf(document, id)?.type ?? '')) return document;
  return {
    ...document,
    positions: {
      ...document.positions,
      [id]: {
        x: rect.x,
        y: rect.y,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    },
  };
}

/**
 * Keeps each loop's own position at the top-left corner of its frame, so a frame left empty stays
 * where it was drawn.
 */
export function withFramePositions(document: FlowDocument): FlowDocument {
  const frames = documentFrames(document);
  let positions: Record<string, AutomationPosition> | undefined;
  for (const block of document.blocks) {
    const frame = frames.get(block.id);
    const at = document.positions[block.id];
    if (frame === undefined || (at !== undefined && at.x === frame.x && at.y === frame.y)) continue;
    // A frame given a size keeps the rect it was given; it is drawn around it and its blocks.
    if (at?.width !== undefined) continue;
    if (!document.blocks.some((inner) => loopOf(inner) === block.id)) continue;
    positions ??= { ...document.positions };
    positions[block.id] = withSize({ x: frame.x, y: frame.y }, at);
  }
  return positions === undefined ? document : { ...document, positions };
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
  // A loop goes with the blocks inside it.
  for (const id of ids) {
    if (isLoopType(blockOf(document, id)?.type ?? '')) {
      for (const inside of loopBody(document.blocks, id)) chosen.add(inside);
    }
  }
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
        stepOutputReference({ ...reference, step }),
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
    rules: condition.rules.map((rule) =>
      rule.field === 'value' ? rule : { ...rule, block: ids.get(rule.block) ?? rule.block },
    ),
  };
}

/** A copied block under its new id, with what names other copied blocks renamed too. */
function renamedBlock(block: AutomationBlock, ids: ReadonlyMap<string, string>): AutomationBlock {
  // Links and expressions name blocks too; they follow the same new ids.
  return renameInBlockExpressions(renamedFields(block, ids), (id) => ids.get(id));
}

function renamedFields(block: AutomationBlock, ids: ReadonlyMap<string, string>): AutomationBlock {
  const current = loopOf(block);
  const loop = current === undefined ? undefined : ids.get(current);
  return renamedOwnFields(loop === undefined ? block : withLoop(block, loop), ids);
}

function renamedOwnFields(
  block: AutomationBlock,
  ids: ReadonlyMap<string, string>,
): AutomationBlock {
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
  into?: string,
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
  for (const { id } of clip.blocks) {
    // A copy of FileCheck1 is FileCheck2, not FileCheck11.
    const fresh = freeName(pastedBase(id), taken);
    taken.add(fresh);
    ids.set(id, fresh);
  }
  for (const { id } of clip.notes) {
    // A copy of note-2 is note-3, not note-2-2.
    const fresh = freeId(id.replace(/-\d+$/, ''), taken);
    taken.add(fresh);
    ids.set(id, fresh);
  }
  const newId = (id: string): string => ids.get(id) ?? id;
  // Blocks whose loop was not copied land in the loop they are pasted into, if any.
  const blocks = clip.blocks.map((block) =>
    renamedBlock(ids.has(loopOf(block) ?? '') ? block : withLoop(block, into), ids),
  );
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

/**
 * The blocks reached from these by following connections, forwards for `downstream` and backwards
 * for `upstream`, the blocks themselves included.
 */
function reach(
  document: FlowDocument,
  ids: Iterable<string>,
  direction: 'upstream' | 'downstream',
): Set<string> {
  const found = new Set([...ids].filter((id) => blockOf(document, id) !== undefined));
  const waiting = [...found];
  for (let id = waiting.pop(); id !== undefined; id = waiting.pop()) {
    for (const { from, to } of document.connections) {
      const [here, there] = direction === 'downstream' ? [from, to] : [to, from];
      if (here === id && !found.has(there)) {
        found.add(there);
        waiting.push(there);
      }
    }
  }
  return found;
}

/** These blocks and every block that leads to them. */
export function upstreamOf(document: FlowDocument, ids: Iterable<string>): Set<string> {
  return reach(document, ids, 'upstream');
}

/** These blocks and every block they lead to. */
export function downstreamOf(document: FlowDocument, ids: Iterable<string>): Set<string> {
  return reach(document, ids, 'downstream');
}

/**
 * Copies blocks and notes and pastes the copy `step` to the right of and below the original, as
 * Ctrl+C and Ctrl+V would. Gives nothing when there is nothing to copy or no room in the file.
 */
export function duplicateItems(
  document: FlowDocument,
  ids: ReadonlySet<string>,
  step: number,
): { readonly document: FlowDocument; readonly ids: readonly string[] } | undefined {
  const clip = copyItems(document, ids);
  if (clip === undefined) return undefined;
  const corner = clipCorner(clip);
  return pasteItems(document, clip, { x: corner.x + step, y: corner.y + step });
}

/** Moves blocks and notes to the nearest point of the grid. */
export function alignToGrid(
  document: FlowDocument,
  ids: ReadonlySet<string>,
  grid: number,
): FlowDocument {
  const round = (value: number): number => Math.round(value / grid) * grid;
  const moved: Record<string, AutomationPosition> = {};
  for (const id of ids) {
    const at = document.positions[id];
    if (at !== undefined) moved[id] = { x: round(at.x), y: round(at.y) };
  }
  const notes = document.notes.map((note) =>
    ids.has(note.id) ? { ...note, x: round(note.x), y: round(note.y) } : note,
  );
  return { ...moveItems(document, moved), notes };
}
