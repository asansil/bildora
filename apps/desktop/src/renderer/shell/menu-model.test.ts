import { describe, expect, it } from 'vitest';
import { isEnabled, nextEnabled } from './menu-model.js';
import type { MenuEntry } from './menu-model.js';

const ENTRIES: readonly MenuEntry[] = [
  { label: 'Cut', disabled: true },
  { label: 'Copy' },
  'separator',
  { label: 'Paste' },
  { label: 'Delete', disabled: true },
];

describe('menu entries', () => {
  it('treats separators and disabled items as unreachable', () => {
    expect(ENTRIES.map((entry) => isEnabled(entry))).toEqual([false, true, false, true, false]);
    expect(isEnabled(undefined)).toBe(false);
  });

  it('starts at either end when nothing is active', () => {
    expect(nextEnabled(ENTRIES, -1, 1)).toBe(1);
    expect(nextEnabled(ENTRIES, -1, -1)).toBe(3);
  });

  it('skips separators and disabled items, and wraps round', () => {
    expect(nextEnabled(ENTRIES, 1, 1)).toBe(3);
    expect(nextEnabled(ENTRIES, 3, 1)).toBe(1);
    expect(nextEnabled(ENTRIES, 1, -1)).toBe(3);
  });

  it('stays on the only reachable item', () => {
    expect(nextEnabled([{ label: 'Only' }, 'separator'], 0, 1)).toBe(0);
  });

  it('finds nothing in a menu with no reachable item', () => {
    expect(nextEnabled([{ label: 'Off', disabled: true }, 'separator'], -1, 1)).toBe(-1);
    expect(nextEnabled([], -1, 1)).toBe(-1);
  });
});
