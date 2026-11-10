/*
 * Automatic layout for flows with no positions, such as a file written by hand or one converted
 * from a list of steps. MSAGL is large, so it loads only when a layout is needed, and it sits
 * behind this one function so that another library can replace it without touching anything else.
 */
import { connectionOutput, outputsOf } from '@bildora/protocol';
import type { AutomationBlock, AutomationConnection, AutomationPosition } from '@bildora/protocol';
import { GAP_X, GAP_Y, sizeOf } from './flow-document.js';
import type { FlowDocument } from './flow-document.js';

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

/** Lays every block out from left to right, top-left corners, with Start's corner at 0, 0. */
export async function layoutBlocks(
  blocks: readonly AutomationBlock[],
  connections: readonly AutomationConnection[],
): Promise<Positions> {
  const msagl = await import('@msagl/core');
  const graph = new msagl.Graph();
  const geometry = new msagl.GeomGraph(graph);
  const nodes = new Map<string, InstanceType<typeof msagl.Node>>();
  for (const block of blocks) {
    const { width, height } = sizeOf(block);
    const node = new msagl.Node(block.id);
    graph.addNode(node);
    const geomNode = new msagl.GeomNode(node);
    geomNode.boundaryCurve = msagl.CurveFactory.mkRectangleWithRoundedCorners(
      width,
      height,
      4,
      4,
      new msagl.Point(0, 0),
    );
    nodes.set(block.id, node);
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

  const raw = new Map<string, AutomationPosition>();
  for (const block of blocks) {
    const node = nodes.get(block.id);
    const geom = node === undefined ? undefined : msagl.GeomNode.getGeom(node);
    const { width, height } = sizeOf(block);
    const center = geom?.center;
    // MSAGL's y axis points up.
    raw.set(block.id, {
      x: (center?.x ?? 0) - width / 2,
      y: -(center?.y ?? 0) - height / 2,
    });
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
