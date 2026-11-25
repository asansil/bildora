import { isLoopType, loopChain } from '@bildora/protocol';
import type { AutomationPosition } from '@bildora/protocol';

/** A box on the canvas, its top-left corner and its size. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Room a loop's frame leaves around its blocks. */
export const LOOP_PADDING = 24;
/** The frame's header, with the loop's name, kind and, in a run, its round. */
export const LOOP_HEADER = 32;
/** Extra room on the left, where the body port sits inside the frame. */
export const LOOP_BODY_GUTTER = 32;
/** Where the body port sits: under the header, in the middle of the left gutter. */
export const LOOP_BODY_PORT_X = 16;
export const LOOP_BODY_PORT_Y = 8;
/** The size of a frame with nothing in it yet. */
export const LOOP_EMPTY = { width: 280, height: 136 } as const;

/** What a frame needs to know about a block: its type and the loop it is in. */
export interface FrameBlock {
  readonly id: string;
  readonly type: string;
  readonly loop?: string | undefined;
}

/** How many loops hold a block, so frames nest behind each other. */
export function loopDepth(blocks: readonly FrameBlock[], id: string): number {
  return loopChain(blocks, id).length;
}

/**
 * Each loop's frame: around the blocks inside it, wherever they are now, with room for the header
 * and the body port. Inner frames count as blocks of the frames around them. A loop with nothing
 * inside keeps an empty frame at its own position. A loop whose position keeps a size has a frame
 * at least that rect, which still grows around its blocks. `rectOf` gives where a block other than
 * a loop is drawn, or undefined while it has no place.
 */
export function frameRects(
  blocks: readonly FrameBlock[],
  rectOf: (id: string) => Rect | undefined,
  positionOf: (id: string) => AutomationPosition | undefined,
): Map<string, Rect> {
  const frames = new Map<string, Rect>();
  const visiting = new Set<string>();
  const members = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.loop === undefined) continue;
    members.set(block.loop, [...(members.get(block.loop) ?? []), block.id]);
  }
  const types = new Map(blocks.map(({ id, type }) => [id, type]));
  const boxOf = (id: string): Rect | undefined =>
    isLoopType(types.get(id) ?? '') ? frameOf(id) : rectOf(id);
  const frameOf = (loop: string): Rect | undefined => {
    const known = frames.get(loop);
    if (known !== undefined) return known;
    // Loops that hold each other are a problem of the file; their frames stay empty.
    if (visiting.has(loop)) return undefined;
    visiting.add(loop);
    const inside = (members.get(loop) ?? []).flatMap((id) => {
      const box = boxOf(id);
      return box === undefined ? [] : [box];
    });
    visiting.delete(loop);
    const at = positionOf(loop);
    let frame: Rect | undefined;
    if (inside.length === 0) {
      frame = at === undefined ? undefined : { x: at.x, y: at.y, ...LOOP_EMPTY };
    } else {
      frame = around(inside);
    }
    if (frame !== undefined) frame = atLeast(frame, at);
    if (frame !== undefined) frames.set(loop, frame);
    return frame;
  };
  for (const block of blocks) {
    if (isLoopType(block.type)) frameOf(block.id);
  }
  return frames;
}

/** A frame grown to hold the rect kept for it, when its loop keeps one. */
function atLeast(frame: Rect, kept: AutomationPosition | undefined): Rect {
  if (kept?.width === undefined || kept.height === undefined) return frame;
  const x = Math.min(frame.x, kept.x);
  const y = Math.min(frame.y, kept.y);
  return {
    x,
    y,
    width: Math.max(frame.x + frame.width, kept.x + kept.width) - x,
    height: Math.max(frame.y + frame.height, kept.y + kept.height) - y,
  };
}

/** The frame around boxes, with room for the header and the body port. */
export function around(boxes: readonly Rect[]): Rect {
  const left = Math.min(...boxes.map(({ x }) => x));
  const top = Math.min(...boxes.map(({ y }) => y));
  const right = Math.max(...boxes.map(({ x, width }) => x + width));
  const bottom = Math.max(...boxes.map(({ y, height }) => y + height));
  const x = left - LOOP_PADDING - LOOP_BODY_GUTTER;
  const y = top - LOOP_PADDING - LOOP_HEADER;
  return {
    x,
    y,
    width: Math.max(right + LOOP_PADDING - x, LOOP_EMPTY.width),
    height: Math.max(bottom + LOOP_PADDING - y, LOOP_EMPTY.height),
  };
}

/** Where blocks go inside a frame whose top-left corner is `corner`. */
export function insideCorner(corner: AutomationPosition): AutomationPosition {
  return {
    x: corner.x + LOOP_PADDING + LOOP_BODY_GUTTER,
    y: corner.y + LOOP_PADDING + LOOP_HEADER,
  };
}

function contains(rect: Rect, point: AutomationPosition): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * The innermost loop whose frame holds a point, leaving out `exclude`, such as a loop being
 * dragged with everything inside it. Undefined when no frame holds it.
 */
export function loopAt(
  blocks: readonly FrameBlock[],
  frames: ReadonlyMap<string, Rect>,
  point: AutomationPosition,
  exclude: ReadonlySet<string> = new Set(),
): string | undefined {
  let found: { id: string; depth: number } | undefined;
  for (const [id, rect] of frames) {
    if (exclude.has(id) || !contains(rect, point)) continue;
    const depth = loopDepth(blocks, id);
    if (found === undefined || depth > found.depth) found = { id, depth };
  }
  return found?.id;
}

/** The centre of a box, which decides the frame a dropped block lands in. */
export function centreOf(rect: Rect): AutomationPosition {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
