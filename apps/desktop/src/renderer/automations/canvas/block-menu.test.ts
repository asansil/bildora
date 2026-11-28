import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import type { MenuEntry } from '../../shell/menu-model.js';
import { blockMenu, noteMenu } from './block-menu.js';
import type { BlockMenuActions } from './block-menu.js';

const nothing = (): void => undefined;
const add: MenuEntry[] = [{ label: 'Search…', run: nothing }];
const actions: BlockMenuActions = { addAfter: add, rename: nothing, copyId: nothing };
const labels = (entries: readonly MenuEntry[]) =>
  entries.map((entry) => (entry === 'separator' ? '—' : entry.label));
const item = (entries: readonly MenuEntry[], label: string) =>
  entries.find((entry) => entry !== 'separator' && entry.label === label);

const run: AutomationBlock = { id: 'extract', type: 'run', tool: 'acme.extract' };
const runActions: BlockMenuActions = {
  ...actions,
  connect: add,
  replace: add,
  open: { label: 'Open tool', run: nothing },
  test: nothing,
  runFrom: nothing,
};

describe('blockMenu', () => {
  it('offers what a Run block can do, in flat sections from adding to deleting', () => {
    expect(labels(blockMenu(run, undefined, runActions, false))).toEqual([
      'Add after',
      'Connect',
      'Replace',
      'Rename…',
      'Open tool',
      '—',
      'Test…',
      'Run from here…',
      '—',
      'Cut',
      'Copy',
      'Duplicate',
      '—',
      'Disabled',
      'Take out',
      'Group',
      '—',
      'Select',
      'Show uses',
      'Copy ID',
      '—',
      'Delete',
    ]);
  });

  it('keeps Start, which cannot be copied, disabled or deleted', () => {
    const start: AutomationBlock = { id: 'start', type: 'start' };
    expect(labels(blockMenu(start, undefined, { ...actions, connect: add }, false))).toEqual([
      'Add after',
      'Connect',
      'Rename…',
      '—',
      'Select downstream',
      'Show uses',
      'Copy ID',
    ]);
  });

  it('adds Show on canvas from the card, and Inside to the Select submenu of a loop', () => {
    const loop: AutomationBlock = {
      id: 'each',
      type: 'for',
      items: { list: [] },
    } as unknown as AutomationBlock;
    const menu = blockMenu(
      loop,
      undefined,
      { ...actions, selectInside: nothing, showOnCanvas: nothing },
      false,
    );
    expect(item(menu, 'Show on canvas')).toBeDefined();
    const select = item(menu, 'Select');
    expect(
      select !== undefined && select !== 'separator' ? labels(select.items ?? []) : [],
    ).toEqual(['Upstream', 'Downstream', 'Inside']);
  });

  it('greys what needs one block while several are chosen, keeping the shape', () => {
    const one = blockMenu(run, undefined, runActions, false);
    const several = blockMenu(run, undefined, runActions, true);
    expect(labels(several)).toEqual(labels(one));
    for (const label of [
      'Add after',
      'Connect',
      'Replace',
      'Rename…',
      'Open tool',
      'Test…',
      'Copy ID',
    ]) {
      expect(item(several, label)).toMatchObject({ disabled: true });
    }
  });

  it('cannot open a tool that is not installed', () => {
    const menu = blockMenu(run, undefined, { ...runActions, open: { label: 'Open tool' } }, false);
    expect(item(menu, 'Open tool')).toMatchObject({ disabled: true });
  });

  it('greys a submenu with nothing in it', () => {
    const menu = blockMenu(run, undefined, { ...runActions, replace: [] }, false);
    expect(item(menu, 'Replace')).toMatchObject({ disabled: true });
  });
});

describe('noteMenu', () => {
  it('writes the note, and greys that while several items are chosen', () => {
    expect(labels(noteMenu(undefined, nothing, false))).toEqual([
      'Edit text',
      '—',
      'Cut',
      'Copy',
      'Duplicate',
      '—',
      'Delete',
    ]);
    expect(item(noteMenu(undefined, nothing, true), 'Edit text')).toMatchObject({ disabled: true });
  });
});
