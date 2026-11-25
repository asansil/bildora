/*
 * Automatic layout for flows with no positions, such as a file written by hand or one converted
 * from a list of steps. MSAGL is large, so it loads only when a layout is needed, and it sits
 * behind this one function so that another library can replace it without touching anything else.
 */
import { BODY_OUTPUT, connectionOutput, isLoopType, outputsOf } from '@bildora/protocol';
import type { AutomationBlock, AutomationConnection, AutomationPosition } from '@bildora/protocol';
import { GAP_X, GAP_Y, sizeOf } from './flow-document.js';
import type { FlowDocument } from './flow-document.js';
import { LOOP_EMPTY, around, insideCorner } from './loop-frames.js';
import type { Rect } from './loop-frames.js';

const NODE_GAP = 28;
const RANK_GAP = 56;

export type Positions = Readonly<Record<string, AutomationPosition>>;

/**
 * Connections in the order their blocks draw their outputs, top to bottom. MSAGL keeps that
 * order, so True stays above False and branches do not cross at the block they leave.
 */
function drawOrder(
  blocks: readonly AutomationBlock[],
  connections: readonly AutomationConnection[],
): AutomationConnection[] {
  const index = new Map(blocks.map((block, position) => [block.id, position]));
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const rank = (connection: AutomationConnection): number => {
    const block = byId.get(connection.from);
    return block === undefined ? 0 : outputsOf(block).indexOf(connectionOutput(connection));
  };
  return [...connections].sort(
    (a, b) => (index.get(a.from) ?? 0) - (index.get(b.from) ?? 0) || rank(a) - rank(b),
  );
}

type Msagl = typeof import('@msagl/core');

interface Box {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** Lays boxes out from left to right with MSAGL, and gives each one's top-left corner. */
function layoutLevel(
  msagl: Msagl,
  boxes: readonly Box[],
  connections: readonly AutomationConnection[],
  blocks: readonly AutomationBlock[],
): Map<string, AutomationPosition> {
  const graph = new msagl.Graph();
  const geometry = new msagl.GeomGraph(graph);
  const nodes = new Map<string, InstanceType<typeof msagl.Node>>();
  for (const { id, width, height } of boxes) {
    const node = new msagl.Node(id);
    graph.addNode(node);
    const geomNode = new msagl.GeomNode(node);
    geomNode.boundaryCurve = msagl.CurveFactory.mkRectangleWithRoundedCorners(
      width,
      height,
      4,
      4,
      new msagl.Point(0, 0),
    );
    nodes.set(id, node);
  }
  for (const connection of drawOrder(blocks, connections)) {
    const source = nodes.get(connection.from);
    const target = nodes.get(connection.to);
    if (source !== undefined && target !== undefined && source !== target) {
      new msagl.GeomEdge(new msagl.Edge(source, target));
    }
  }
  const settings = new msagl.SugiyamaLayoutSettings();
  settings.layerDirection = msagl.LayerDirectionEnum.LR;
  settings.LayerSeparation = RANK_GAP;
  settings.commonSettings.NodeSeparation = NODE_GAP;
  geometry.layoutSettings = settings;
  msagl.layoutGeomGraph(geometry);

  const placed = new Map<string, AutomationPosition>();
  for (const { id, width, height } of boxes) {
    const node = nodes.get(id);
    const center = node === undefined ? undefined : msagl.GeomNode.getGeom(node).center;
    // MSAGL's y axis points up.
    placed.set(id, { x: (center?.x ?? 0) - width / 2, y: -(center?.y ?? 0) - height / 2 });
  }
  return placed;
}

function loopOfBlock(block: AutomationBlock): string | undefined {
  return block.type === 'start' ? undefined : block.loop;
}

/**
 * Lays every block out from left to right, top-left corners, with Start's corner at 0, 0. The
 * blocks inside a loop are laid out first, and the loop then takes the size of its frame around
 * them, so frames never overlap what is beside them.
 */
export async function layoutBlocks(
  blocks: readonly AutomationBlock[],
  connections: readonly AutomationConnection[],
): Promise<Positions> {
  const msagl = await import('@msagl/core');
  const visiting = new Set<string>();

  /** Lays out the blocks of one frame, with the frames inside them, from the frame's corner. */
  const layoutFrame = (
    loop: string | undefined,
  ): { positions: Map<string, AutomationPosition>; box: Rect | undefined } => {
    const members = blocks.filter(
      (block) => loopOfBlock(block) === loop && block.id !== loop && !visiting.has(block.id),
    );
    const inner = new Map<string, ReturnType<typeof layoutFrame>>();
    const boxes = members.map((block): Box => {
      if (!isLoopType(block.type)) return { id: block.id, ...sizeOf(block) };
      visiting.add(block.id);
      const nested = layoutFrame(block.id);
      visiting.delete(block.id);
      inner.set(block.id, nested);
      const frame = nested.box === undefined ? { ...LOOP_EMPTY } : around([nested.box]);
      return { id: block.id, width: frame.width, height: frame.height };
    });
    const ids = new Set(members.map(({ id }) => id));
    const placed = layoutLevel(
      msagl,
      boxes,
      connections.filter(
        (connection) =>
          ids.has(connection.from) &&
          ids.has(connection.to) &&
          connectionOutput(connection) !== BODY_OUTPUT,
      ),
      blocks,
    );
    const positions = new Map(placed);
    for (const [id, nested] of inner) {
      const corner = placed.get(id);
      if (corner === undefined || nested.box === undefined) continue;
      const target = insideCorner(corner);
      const dx = target.x - nested.box.x;
      const dy = target.y - nested.box.y;
      for (const [innerId, at] of nested.positions) {
        positions.set(innerId, { x: at.x + dx, y: at.y + dy });
      }
    }
    const placedBoxes = boxes.flatMap(({ id, width, height }) => {
      const at = placed.get(id);
      return at === undefined ? [] : [{ ...at, width, height }];
    });
    const box =
      placedBoxes.length === 0
        ? undefined
        : (() => {
            const left = Math.min(...placedBoxes.map(({ x }) => x));
            const top = Math.min(...placedBoxes.map(({ y }) => y));
            const right = Math.max(...placedBoxes.map(({ x, width }) => x + width));
            const bottom = Math.max(...placedBoxes.map(({ y, height }) => y + height));
            return { x: left, y: top, width: right - left, height: bottom - top };
          })();
    return { positions, box };
  };

  const top = layoutFrame(undefined);
  const raw = new Map(top.positions);
  // Blocks in a loop that is missing, or in loops that hold each other, go below the rest.
  for (const block of blocks) {
    if (!raw.has(block.id)) {
      raw.set(block.id, { x: 0, y: (top.box?.y ?? 0) + (top.box?.height ?? 0) + RANK_GAP });
    }
  }
  const start = blocks.find(({ type }) => type === 'start');
  const origin = (start === undefined ? undefined : raw.get(start.id)) ?? { x: 0, y: 0 };
  return Object.fromEntries(
    [...raw].map(([id, { x, y }]) => [
      id,
      { x: Math.round(x - origin.x), y: Math.round(y - origin.y) },
    ]),
  );
}

/**
 * Places what has no position yet. With nothing placed, the whole flow is laid out; otherwise a
 * new block goes right of the block that leads to it, below anything already there.
 */
export async function placeMissing(document: FlowDocument): Promise<Positions | undefined> {
  const missing = document.blocks.filter(({ id }) => document.positions[id] === undefined);
  if (missing.length === 0) return undefined;
  const placed = document.blocks.filter(({ id }) => document.positions[id] !== undefined);
  if (placed.length <= 1) {
    return layoutBlocks(document.blocks, document.connections);
  }
  const positions: Record<string, AutomationPosition> = { ...document.positions };
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const taken = (spot: AutomationPosition, block: AutomationBlock): boolean => {
    const size = sizeOf(block);
    return Object.entries(positions).some(([id, other]) => {
      const otherBlock = byId.get(id);
      if (otherBlock === undefined) return false;
      const otherSize = sizeOf(otherBlock);
      return (
        spot.x < other.x + otherSize.width &&
        other.x < spot.x + size.width &&
        spot.y < other.y + otherSize.height + GAP_Y &&
        other.y < spot.y + size.height + GAP_Y
      );
    });
  };
  for (const block of missing) {
    const before = document.connections.find(
      ({ from, to }) => to === block.id && positions[from] !== undefined,
    );
    const anchor = before === undefined ? undefined : positions[before.from];
    const anchorBlock = before === undefined ? undefined : byId.get(before.from);
    const spot =
      anchor === undefined || anchorBlock === undefined
        ? { x: 0, y: Math.max(...Object.values(positions).map(({ y }) => y)) + 120 }
        : { x: anchor.x + sizeOf(anchorBlock).width + GAP_X, y: anchor.y };
    while (taken(spot, block)) spot.y += GAP_Y + 4;
    positions[block.id] = spot;
  }
  return positions;
}
