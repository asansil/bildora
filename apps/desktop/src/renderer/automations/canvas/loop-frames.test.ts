import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import {
  copyItems,
  dropInLoops,
  emptyDocument,
  moveItems,
  pasteItems,
  placeInLoop,
  removeItems,
  renameBlock,
  resizeLoop,
  withFramePositions,
} from './flow-document.js';
import type { FlowDocument } from './flow-document.js';
import {
  LOOP_BODY_GUTTER,
  LOOP_EMPTY,
  LOOP_HEADER,
  LOOP_PADDING,
  frameRects,
  loopAt,
} from './loop-frames.js';

const loop = (id: string, inside?: string): AutomationBlock => ({
  id,
  type: 'for',
  items: { kind: 'count', count: 2 },
  ...(inside === undefined ? {} : { loop: inside }),
});
const wait = (id: string, inside?: string): AutomationBlock => ({
  id,
  type: 'wait-for-time',
  seconds: 1,
  ...(inside === undefined ? {} : { loop: inside }),
});

function documentWith(
  blocks: readonly AutomationBlock[],
  connections: FlowDocument['connections'] = [],
): FlowDocument {
  const base = emptyDocument();
  return { ...base, blocks: [...base.blocks, ...blocks], connections };
}

describe('loop frames', () => {
  const box = { width: 160, height: 32 };

  it('frames the blocks inside a loop, with room for the header and the body port', () => {
    const blocks = [loop('Loop'), wait('A', 'Loop'), wait('B', 'Loop')];
    const rects = new Map([
      ['A', { x: 100, y: 100, ...box }],
      ['B', { x: 300, y: 200, ...box }],
    ]);
    const frame = frameRects(
      blocks,
      (id) => rects.get(id),
      () => undefined,
    ).get('Loop');
    expect(frame).toEqual({
      x: 100 - LOOP_PADDING - LOOP_BODY_GUTTER,
      y: 100 - LOOP_PADDING - LOOP_HEADER,
      width: 460 + LOOP_PADDING - (100 - LOOP_PADDING - LOOP_BODY_GUTTER),
      height: 232 + LOOP_PADDING - (100 - LOOP_PADDING - LOOP_HEADER),
    });
  });

  it('draws a frame around the rect kept for it and its blocks, in any direction', () => {
    const blocks = [loop('Loop'), wait('A', 'Loop')];
    const rectOf = (id: string) => (id === 'A' ? { x: 100, y: 100, ...box } : undefined);
    const tight = frameRects(blocks, rectOf, () => undefined).get('Loop');
    if (tight === undefined) throw new Error('No frame');
    const kept = { x: tight.x - 50, y: tight.y - 40, width: 900, height: 700 };
    expect(frameRects(blocks, rectOf, () => kept).get('Loop')).toEqual(kept);
    // A kept rect smaller than the blocks never cuts them off.
    const small = { x: tight.x, y: tight.y, width: 10, height: 10 };
    expect(frameRects(blocks, rectOf, () => small).get('Loop')).toEqual(tight);
    const empty = frameRects(
      [loop('Loop')],
      () => undefined,
      () => ({ x: 10, y: 20, width: 500, height: 90 }),
    ).get('Loop');
    expect(empty).toEqual({ x: 10, y: 20, width: 500, height: LOOP_EMPTY.height });
  });

  it('keeps an empty frame at the loop own position', () => {
    const frame = frameRects(
      [loop('Loop')],
      () => undefined,
      () => ({ x: 10, y: 20 }),
    ).get('Loop');
    expect(frame).toEqual({ x: 10, y: 20, ...LOOP_EMPTY });
  });

  it('puts an inner frame inside the outer one', () => {
    const blocks = [loop('Outer'), loop('Inner', 'Outer'), wait('A', 'Inner')];
    const frames = frameRects(
      blocks,
      (id) => (id === 'A' ? { x: 500, y: 500, ...box } : undefined),
      () => undefined,
    );
    const inner = frames.get('Inner');
    const outer = frames.get('Outer');
    expect(inner).toBeDefined();
    expect(outer).toBeDefined();
    if (inner === undefined || outer === undefined) return;
    expect(outer.x).toBeLessThan(inner.x);
    expect(outer.y).toBeLessThan(inner.y);
    expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
  });

  it('finds the innermost frame under a point, leaving out the ones being moved', () => {
    const blocks = [loop('Outer'), loop('Inner', 'Outer')];
    const frames = new Map([
      ['Outer', { x: 0, y: 0, width: 1000, height: 1000 }],
      ['Inner', { x: 100, y: 100, width: 200, height: 200 }],
    ]);
    expect(loopAt(blocks, frames, { x: 150, y: 150 })).toBe('Inner');
    expect(loopAt(blocks, frames, { x: 500, y: 500 })).toBe('Outer');
    expect(loopAt(blocks, frames, { x: 150, y: 150 }, new Set(['Inner']))).toBe('Outer');
    expect(loopAt(blocks, frames, { x: 2000, y: 0 })).toBeUndefined();
  });
});

describe('placing blocks in loops', () => {
  it('puts a block with no connections into a loop, and takes it out again', () => {
    const document = documentWith([loop('Loop'), wait('A')]);
    const inside = placeInLoop(document, ['A'], 'Loop');
    expect(inside?.blocks.find(({ id }) => id === 'A')).toMatchObject({ loop: 'Loop' });
    const outside = inside === undefined ? undefined : placeInLoop(inside, ['A'], undefined);
    expect(outside?.blocks.find(({ id }) => id === 'A')).not.toHaveProperty('loop');
  });

  it('refuses a move that would make a connection cross a frame', () => {
    const document = documentWith([loop('Loop'), wait('A')], [{ from: 'start', to: 'A' }]);
    expect(placeInLoop(document, ['A'], 'Loop')).toBeUndefined();
  });

  it('moves connected blocks together', () => {
    const document = documentWith([loop('Loop'), wait('A'), wait('B')], [{ from: 'A', to: 'B' }]);
    expect(placeInLoop(document, ['A', 'B'], 'Loop')).toBeDefined();
  });

  it('never puts a loop inside itself or inside a loop it holds', () => {
    const document = documentWith([loop('Outer'), loop('Inner', 'Outer')]);
    expect(placeInLoop(document, ['Outer'], 'Outer')).toBeUndefined();
    expect(placeInLoop(document, ['Outer'], 'Inner')).toBeUndefined();
  });

  it('keeps the blocks of a deleted loop, in the loop around it', () => {
    const document = documentWith(
      [loop('Outer'), loop('Inner', 'Outer'), wait('A', 'Inner')],
      [{ from: 'Inner', output: 'body', to: 'A' }],
    );
    const after = removeItems(document, new Set(['Inner']));
    expect(after.blocks.find(({ id }) => id === 'A')).toMatchObject({ loop: 'Outer' });
    expect(after.connections).toEqual([]);
  });

  it('copies a loop with the blocks inside it', () => {
    const document: FlowDocument = {
      ...documentWith(
        [loop('Loop'), wait('A', 'Loop')],
        [{ from: 'Loop', output: 'body', to: 'A' }],
      ),
      positions: { start: { x: 0, y: 0 }, Loop: { x: 0, y: 100 }, A: { x: 60, y: 160 } },
    };
    const clip = copyItems(document, new Set(['Loop']));
    expect(clip?.blocks.map(({ id }) => id)).toEqual(['Loop', 'A']);
    const pasted = clip === undefined ? undefined : pasteItems(document, clip, { x: 0, y: 400 });
    const copy = pasted?.document.blocks.find(({ id }) => id === 'Wait1');
    expect(copy).toBeUndefined();
    expect(pasted?.document.blocks.at(-1)).toMatchObject({ id: 'A1', loop: 'Loop1' });
  });

  it('pastes blocks whose loop stayed behind into the loop they land in', () => {
    const document: FlowDocument = {
      ...documentWith([loop('Loop'), wait('A', 'Loop')]),
      positions: { start: { x: 0, y: 0 }, Loop: { x: 0, y: 100 }, A: { x: 60, y: 160 } },
    };
    const clip = copyItems(document, new Set(['A']));
    const outside = clip === undefined ? undefined : pasteItems(document, clip, { x: 0, y: 400 });
    expect(outside?.document.blocks.at(-1)).not.toHaveProperty('loop');
    const inside =
      clip === undefined ? undefined : pasteItems(document, clip, { x: 0, y: 400 }, 'Loop');
    expect(inside?.document.blocks.at(-1)).toMatchObject({ loop: 'Loop' });
  });

  it('renames the loop its blocks name', () => {
    const document = documentWith([loop('Loop'), wait('A', 'Loop')]);
    const renamed = renameBlock(document, 'Loop', 'Files');
    expect(renamed.blocks.find(({ id }) => id === 'A')).toMatchObject({ loop: 'Files' });
  });
});

describe('dropping blocks on frames', () => {
  const placed = (document: FlowDocument, positions: FlowDocument['positions']): FlowDocument => ({
    ...document,
    positions: { ...document.positions, ...positions },
  });
  const base = placed(documentWith([loop('Loop'), wait('A', 'Loop'), wait('B')]), {
    start: { x: 0, y: 0 },
    Loop: { x: 300, y: 0 },
    A: { x: 360, y: 60 },
    B: { x: 0, y: 400 },
  });

  it('keeps the rect a frame was given, and moves it with its loop', () => {
    const sized = resizeLoop(base, 'Loop', { x: 280, y: -20, width: 812.4, height: 500 });
    expect(sized.positions['Loop']).toEqual({ x: 280, y: -20, width: 812, height: 500 });
    expect(resizeLoop(base, 'A', { x: 0, y: 0, width: 900, height: 900 })).toBe(base);
    const moved = withFramePositions(
      moveItems(sized, { Loop: { x: 0, y: 0 }, A: { x: 80, y: 80 } }),
    );
    expect(moved.positions['Loop']).toEqual({ x: 0, y: 0, width: 812, height: 500 });
  });

  it('joins a block let go in a frame to its body, when nothing starts the body yet', () => {
    const after = placed(base, { B: { x: 380, y: 100 } });
    const dropped = dropInLoops(base, after, ['B']);
    expect(dropped?.connections).toContainEqual({ from: 'Loop', output: 'body', to: 'B' });
    const started = { ...base, connections: [{ from: 'Loop', output: 'body', to: 'A' }] };
    const second = dropInLoops(started, placed(started, { B: { x: 380, y: 100 } }), ['B']);
    expect(second?.connections).toEqual(started.connections);
  });

  it('puts a block let go inside a frame into its loop', () => {
    const after = placed(base, { B: { x: 380, y: 100 } });
    const dropped = dropInLoops(base, after, ['B']);
    expect(dropped?.blocks.find(({ id }) => id === 'B')).toMatchObject({ loop: 'Loop' });
  });

  it('takes a block dragged out of its frame out of the loop', () => {
    const after = placed(base, { A: { x: 0, y: 800 } });
    const dropped = dropInLoops(base, after, ['A']);
    expect(dropped?.blocks.find(({ id }) => id === 'A')).not.toHaveProperty('loop');
  });

  it('leaves a block moved within its frame where it is', () => {
    const after = placed(base, { A: { x: 370, y: 70 } });
    expect(dropInLoops(base, after, ['A'])).toBe(after);
  });

  it('refuses to take a connected block out of its frame', () => {
    const connected = { ...base, connections: [{ from: 'Loop', output: 'body', to: 'A' }] };
    const after = placed(connected, { A: { x: 0, y: 800 } });
    expect(dropInLoops(connected, after, ['A'])).toBeUndefined();
  });
});
