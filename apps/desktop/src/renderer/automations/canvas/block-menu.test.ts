import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import type { MenuEntry } from '../../shell/menu-model.js';
import { blockCardMenu } from './block-menu.js';

const nothing = (): void => undefined;
const actions = { rename: nothing, showOnCanvas: nothing, copyId: nothing };
const labels = (entries: readonly MenuEntry[]) =>
  entries.map((entry) => (entry === 'separator' ? '—' : entry.label));

describe('blockCardMenu', () => {
  it('offers what a Run block can do, from renaming to deleting', () => {
    const block: AutomationBlock = { id: 'extract', type: 'run', tool: 'acme.extract' };
    expect(labels(blockCardMenu(block, undefined, { ...actions, openTool: nothing }))).toEqual([
      'Rename…',
      'Replace…',
      'Duplicate',
      'Disable',
      '—',
      'Show on the canvas',
      'Show what uses its values',
      'Open the tool',
      'Copy its id (extract)',
      '—',
      'Delete',
    ]);
  });

  it('keeps Start, which cannot be copied, disabled or deleted', () => {
    const block: AutomationBlock = { id: 'start', type: 'start' };
    expect(labels(blockCardMenu(block, undefined, actions))).toEqual([
      'Rename…',
      '—',
      'Show on the canvas',
      'Show what uses its values',
      'Copy its id (start)',
    ]);
  });

  it('cannot open a tool that is not installed', () => {
    const block: AutomationBlock = { id: 'extract', type: 'run', tool: 'gone' };
    const open = blockCardMenu(block, undefined, actions).find(
      (entry) => entry !== 'separator' && entry.label === 'Open the tool',
    );
    expect(open).toMatchObject({ disabled: true });
  });
});
