import { connectionOutput, outputsOf } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import { kindLabel, outputLabel } from './block-text.js';
import { sizeOf } from './flow-document.js';
import type { FlowDocument } from './flow-document.js';

export type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const VECTORS: Readonly<Record<Direction, readonly [number, number]>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

export function isDirection(key: string): key is Direction {
  return Object.hasOwn(VECTORS, key);
}

function centers(document: FlowDocument): Map<string, { x: number; y: number }> {
  return new Map(
    document.blocks.flatMap((block) => {
      const at = document.positions[block.id];
      if (at === undefined) return [];
      const { width, height } = sizeOf(block);
      return [[block.id, { x: at.x + width / 2, y: at.y + height / 2 }]];
    }),
  );
}

/**
 * The block an arrow key moves to: the nearest one ahead in that direction, where being off to
 * the side counts twice as much as being far ahead.
 */
export function nearestInDirection(
  document: FlowDocument,
  from: string,
  direction: Direction,
): string | undefined {
  const points = centers(document);
  const origin = points.get(from);
  if (origin === undefined) return undefined;
  const [dx, dy] = VECTORS[direction];
  let best: { id: string; score: number } | undefined;
  for (const [id, point] of points) {
    if (id === from) continue;
    const along = (point.x - origin.x) * dx + (point.y - origin.y) * dy;
    if (along <= 1) continue;
    const across = Math.abs((point.x - origin.x) * dy) + Math.abs((point.y - origin.y) * dx);
    const score = along + 2 * across;
    if (best === undefined || score < best.score) best = { id, score };
  }
  return best?.id;
}

/** Where focus goes once a block is deleted: the nearest block that is left. */
export function neighbourOf(
  before: FlowDocument,
  after: FlowDocument,
  gone: string,
): string | undefined {
  const origin = centers(before).get(gone);
  const left = centers(after);
  let best: { id: string; distance: number } | undefined;
  for (const [id, point] of left) {
    const distance = origin === undefined ? 0 : Math.hypot(point.x - origin.x, point.y - origin.y);
    if (best === undefined || distance < best.distance) best = { id, distance };
  }
  return best?.id;
}

/** Where each output of a block leads, in words, for screen readers and the blocks list. */
export function outgoing(
  document: FlowDocument,
  id: string,
  nameOf: (id: string) => string,
): string[] {
  const block = document.blocks.find((item) => item.id === id);
  if (block === undefined) return [];
  return outputsOf(block).map((output) => {
    const targets = document.connections
      .filter((connection) => connection.from === id && connectionOutput(connection) === output)
      .map(({ to }) => nameOf(to));
    return targets.length === 0
      ? t('canvas.outputFree', { output: outputLabel(output) })
      : t('canvas.outputLeads', { output: outputLabel(output), to: targets.join(', ') });
  });
}

/** A block as a screen reader reads it: what it is, then where it leads. */
export function describeBlock(
  document: FlowDocument,
  id: string,
  nameOf: (id: string) => string,
): string {
  const block = document.blocks.find((item) => item.id === id);
  if (block === undefined) return id;
  return t('canvas.blockDescription', {
    name: nameOf(id),
    kind: kindLabel(block.type),
    outputs: outgoing(document, id, nameOf).join('; '),
  });
}

/** An id the DOM can hold, for `aria-activedescendant`. */
export function domId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
