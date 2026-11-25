import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import { affectedCallers, renamedCallerBlocks } from './caller-rename.js';
import type { CallingFlow } from './caller-rename.js';

const reading = (id: string, expression: string): AutomationBlock => ({
  id,
  type: 'run',
  tool: 'acme.tool',
  values: { file: { expression } },
});

const report: CallingFlow = {
  id: 'report',
  name: 'Report',
  blocks: [
    { id: 'start', type: 'start' },
    { id: 'Extract1', type: 'run', tool: 'acme.tool' },
  ],
};
const archive: CallingFlow = {
  id: 'archive',
  name: 'Archive',
  blocks: [
    { id: 'start', type: 'start' },
    { id: 'Report1', type: 'run-automation', automation: 'report' },
    reading('Use1', 'steps.Report1.Extract1.outputs.result'),
  ],
};
const nightly: CallingFlow = {
  id: 'nightly',
  name: 'Nightly',
  blocks: [
    { id: 'start', type: 'start' },
    { id: 'Archive1', type: 'run-automation', automation: 'archive' },
    reading('Use2', 'steps.Archive1.Report1.Extract1.outputs.result.count'),
  ],
};
const other: CallingFlow = {
  id: 'other',
  name: 'Other',
  blocks: [{ id: 'start', type: 'start' }, reading('Extract1', 'steps.start.outputs.x')],
};
const all = [report, archive, nightly, other];
const rename = { called: 'report', from: 'Extract1', to: 'Totals' };

describe('renaming a block that others read through calls', () => {
  it('rewrites a direct caller', () => {
    const blocks = renamedCallerBlocks(archive, all, rename);
    expect(blocks?.at(-1)).toMatchObject({
      values: { file: { expression: 'steps.Report1.Totals.outputs.result' } },
    });
  });

  it('rewrites a caller further up the chain', () => {
    const blocks = renamedCallerBlocks(nightly, all, rename);
    expect(blocks?.at(-1)).toMatchObject({
      values: { file: { expression: 'steps.Archive1.Report1.Totals.outputs.result.count' } },
    });
  });

  it('names only the automations it changes', () => {
    expect(affectedCallers(all, rename).map(({ id }) => id)).toEqual(['archive', 'nightly']);
  });

  it('leaves alone a block of the same name in another automation', () => {
    expect(affectedCallers(all, { ...rename, called: 'other' })).toEqual([]);
  });
});
