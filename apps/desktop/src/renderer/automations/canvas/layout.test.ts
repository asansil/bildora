import { describe, expect, it } from 'vitest';
import type { AutomationBlock, AutomationConnection } from '@bildora/protocol';
import { sizeOf } from './flow-document.js';
import { layoutBlocks, placeMissing } from './layout.js';
import { emptyDocument } from './flow-document.js';

const run = (id: string): AutomationBlock => ({ id, type: 'run', tool: 'acme.tool' });

const blocks: AutomationBlock[] = [
  { id: 'start', type: 'start' },
  run('extract'),
  {
    id: 'check',
    type: 'if',
    condition: {
      match: 'all',
      rules: [{ block: 'extract', field: 'result', operator: 'is', value: 'completed' }],
    },
  },
  run('report'),
  run('notify'),
  run('done'),
];
const connections: AutomationConnection[] = [
  { from: 'start', to: 'extract' },
  { from: 'extract', to: 'check' },
  { from: 'check', output: 'false', to: 'notify' },
  { from: 'check', output: 'true', to: 'report' },
  { from: 'report', to: 'done' },
  { from: 'notify', to: 'done' },
];

// MSAGL is large, and its first import goes through Vite's transform.
const FIRST_LOAD_MS = 60_000;

describe('layout', () => {
  it(
    'places every block left to right, Start at the origin, with no overlaps',
    async () => {
      const positions = await layoutBlocks(blocks, connections);
      expect(Object.keys(positions).sort()).toEqual(blocks.map(({ id }) => id).sort());
      expect(positions['start']).toEqual({ x: 0, y: 0 });
      for (const { from, to } of connections) {
        expect(positions[to]?.x).toBeGreaterThan(positions[from]?.x ?? Infinity);
      }
      // True is drawn above False, so the block behind it stays above.
      expect(positions['report']?.y).toBeLessThan(positions['notify']?.y ?? -Infinity);
      for (const a of blocks) {
        for (const b of blocks) {
          if (a.id >= b.id) continue;
          const pa = positions[a.id];
          const pb = positions[b.id];
          if (pa === undefined || pb === undefined) throw new Error('Unplaced');
          const sa = sizeOf(a);
          const sb = sizeOf(b);
          const overlap =
            pa.x < pb.x + sb.width &&
            pb.x < pa.x + sa.width &&
            pa.y < pb.y + sb.height &&
            pb.y < pa.y + sa.height;
          expect(overlap, `${a.id} and ${b.id}`).toBe(false);
        }
      }
    },
    FIRST_LOAD_MS,
  );

  it('lays out a flow with no positions, and leaves a placed one as it is', async () => {
    const document = { ...emptyDocument(), blocks, connections, positions: {} };
    expect(Object.keys((await placeMissing(document)) ?? {})).toHaveLength(blocks.length);
    expect(await placeMissing(emptyDocument())).toBeUndefined();
  });

  it('puts a block with no position right of the block that leads to it', async () => {
    const document = {
      ...emptyDocument(),
      blocks: blocks.slice(0, 2),
      connections: connections.slice(0, 1),
      positions: { start: { x: 0, y: 0 }, other: { x: 0, y: 100 } },
    };
    const placed = await placeMissing({
      ...document,
      blocks: [...document.blocks, run('other')],
    });
    expect(placed?.['extract']?.x).toBeGreaterThan(sizeOf({ id: 'start', type: 'start' }).width);
    expect(placed?.['extract']?.y).toBe(0);
  });
});
