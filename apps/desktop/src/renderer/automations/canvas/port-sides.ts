import { ERROR_OUTPUT } from '@bildora/protocol';

/** A side of a block, where a port sits. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Where a port sits: its side, and how far along it, from 0 to 1 (top to bottom, left to right). */
export interface PortPlace {
  readonly side: Side;
  readonly offset: number;
}

/** A block's ports, by id: `in` for the input, then each output's id. */
export type PortLayout = ReadonlyMap<string, PortPlace>;

export interface PortRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hasInput: boolean;
  readonly outputs: readonly string[];
}

export interface PortLink {
  readonly source: string;
  readonly sourceHandle?: string | null;
  readonly target: string;
}

export const INPUT_PORT = 'in';

/** Where a port goes while nothing is connected to it. */
function restingSide(port: string): Side {
  if (port === INPUT_PORT) return 'left';
  if (port === ERROR_OUTPUT) return 'bottom';
  return 'right';
}

const centre = (rect: PortRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/**
 * The side of `from` that faces `to`: the axis with the larger free gap between the two blocks wins,
 * so a block below and slightly to the right is reached from the bottom.
 */
export function sideFacing(
  from: PortRect,
  to: { x: number; y: number; width: number; height: number },
): Side {
  const a = centre(from);
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const gapX = Math.abs(dx) - (from.width + to.width) / 2;
  const gapY = Math.abs(dy) - (from.height + to.height) / 2;
  if (gapX >= gapY) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

interface Draft {
  readonly port: string;
  readonly order: number;
  readonly side: Side;
  /** The centre of the blocks at the other end, or undefined when nothing is connected. */
  readonly toward: { x: number; y: number } | undefined;
}

/**
 * Places every block's ports on the side facing the blocks they connect to. Ports sharing a side
 * spread evenly, ordered by where their other ends are, so connections leave without crossing;
 * unconnected ports keep their resting side and come after the connected ones.
 */
export function layoutPorts(
  rects: readonly PortRect[],
  links: readonly PortLink[],
): ReadonlyMap<string, PortLayout> {
  const byId = new Map(rects.map((rect) => [rect.id, rect]));
  const result = new Map<string, PortLayout>();
  for (const rect of rects) {
    const ports = [...(rect.hasInput ? [INPUT_PORT] : []), ...rect.outputs];
    const drafts = ports.map((port, order): Draft => {
      const others = links.flatMap((link) => {
        const other =
          port === INPUT_PORT
            ? link.target === rect.id
              ? link.source
              : undefined
            : link.source === rect.id && (link.sourceHandle ?? 'next') === port
              ? link.target
              : undefined;
        const found = other === undefined ? undefined : byId.get(other);
        return found === undefined || found.id === rect.id ? [] : [found];
      });
      if (others.length === 0) return { port, order, side: restingSide(port), toward: undefined };
      const box = {
        x: others.reduce((sum, other) => sum + other.x, 0) / others.length,
        y: others.reduce((sum, other) => sum + other.y, 0) / others.length,
        width: others.reduce((sum, other) => sum + other.width, 0) / others.length,
        height: others.reduce((sum, other) => sum + other.height, 0) / others.length,
      };
      return {
        port,
        order,
        side: sideFacing(rect, box),
        toward: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      };
    });
    const layout = new Map<string, PortPlace>();
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const along = side === 'top' || side === 'bottom' ? 'x' : 'y';
      const onSide = drafts
        .filter((draft) => draft.side === side)
        .sort((a, b) => {
          if (a.toward === undefined || b.toward === undefined) {
            if (a.toward === b.toward) return a.order - b.order;
            return a.toward === undefined ? 1 : -1;
          }
          return a.toward[along] - b.toward[along] || a.order - b.order;
        });
      onSide.forEach((draft, index) => {
        layout.set(draft.port, { side, offset: (index + 1) / (onSide.length + 1) });
      });
    }
    result.set(rect.id, layout);
  }
  return result;
}

/** A short key for a block's ports, which changes only when one of them moves. */
export function layoutKey(layout: PortLayout | undefined): string {
  if (layout === undefined) return '';
  return [...layout]
    .map(([port, place]) => `${port}:${place.side}:${place.offset.toFixed(3)}`)
    .join('|');
}
