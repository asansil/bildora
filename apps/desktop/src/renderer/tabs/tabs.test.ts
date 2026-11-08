import { describe, expect, it } from 'vitest';
import {
  HISTORY_TAB,
  NO_TABS,
  activate,
  activeTab,
  close,
  closeOthers,
  closeToRight,
  fromLayout,
  keysToClose,
  move,
  open,
  openDraft,
  pin,
  prune,
  rename,
  step,
  tabKey,
  toLayout,
} from './tabs.js';
import type { TabRef, TabState } from './tabs.js';

const tool = (id: string): TabRef => ({ kind: 'tool', id });
const automation = (id: string): TabRef => ({ kind: 'automation', id });

function keys(state: TabState): string[] {
  return state.tabs.map(({ key }) => key);
}

function pinned(...refs: TabRef[]): TabState {
  return refs.reduce((state, ref) => open(state, ref, { pin: true }), NO_TABS);
}

describe('tabKey', () => {
  it('names tools and automations by id, and History alone', () => {
    expect(tabKey(tool('a'))).toBe('tool:a');
    expect(tabKey(automation('a'))).toBe('automation:a');
    expect(tabKey(HISTORY_TAB)).toBe('history');
  });
});

describe('open', () => {
  it('replaces the preview tab with each single click, in its place', () => {
    let state = pinned(tool('a'), tool('b'));
    state = activate(state, 'tool:a');
    state = open(state, tool('c'), { pin: false });
    expect(keys(state)).toEqual(['tool:a', 'tool:c', 'tool:b']);
    state = activate(state, 'tool:b');
    state = open(state, tool('d'), { pin: false });
    expect(keys(state)).toEqual(['tool:a', 'tool:d', 'tool:b']);
    expect(activeTab(state)).toMatchObject({ key: 'tool:d', preview: true });
  });

  it('opens a pinned tab right of the active one and leaves the preview tab alone', () => {
    let state = open(pinned(tool('a')), tool('p'), { pin: false });
    state = activate(state, 'tool:a');
    state = open(state, tool('b'), { pin: true });
    expect(keys(state)).toEqual(['tool:a', 'tool:b', 'tool:p']);
    expect(state.tabs.map(({ preview }) => preview)).toEqual([false, false, true]);
  });

  it('never gives an item two tabs, and pins an open preview tab when asked', () => {
    let state = open(pinned(tool('a')), tool('b'), { pin: false });
    state = open(state, tool('a'), { pin: false });
    expect(keys(state)).toEqual(['tool:a', 'tool:b']);
    expect(state.activeKey).toBe('tool:a');
    state = open(state, tool('b'), { pin: true });
    expect(keys(state)).toEqual(['tool:a', 'tool:b']);
    expect(activeTab(state)?.preview).toBe(false);
  });

  it('opens at the end when no tab is active', () => {
    const state = open({ tabs: pinned(tool('a')).tabs }, tool('b'), { pin: true });
    expect(keys(state)).toEqual(['tool:a', 'tool:b']);
  });
});

describe('pin', () => {
  it('keeps a preview tab so the next click opens beside it', () => {
    let state = open(NO_TABS, tool('a'), { pin: false });
    state = pin(state, 'tool:a');
    state = open(state, tool('b'), { pin: false });
    expect(keys(state)).toEqual(['tool:a', 'tool:b']);
  });
});

describe('closing', () => {
  const four = (): TabState =>
    activate(pinned(tool('a'), tool('b'), tool('c'), tool('d')), 'tool:b');

  it('passes the active tab to its right neighbour, then to its left', () => {
    expect(close(four(), 'tool:b').activeKey).toBe('tool:c');
    expect(close(activate(four(), 'tool:d'), 'tool:d').activeKey).toBe('tool:c');
    expect(close(four(), 'tool:a').activeKey).toBe('tool:b');
    expect(close(pinned(tool('a')), 'tool:a')).toEqual({ tabs: [] });
  });

  it('closes the others and those to the right', () => {
    expect(keys(closeOthers(four(), 'tool:c'))).toEqual(['tool:c']);
    expect(closeOthers(four(), 'tool:c').activeKey).toBe('tool:c');
    const right = closeToRight(activate(four(), 'tool:d'), 'tool:b');
    expect(keys(right)).toEqual(['tool:a', 'tool:b']);
    expect(right.activeKey).toBe('tool:b');
  });

  it('lists what each action closes, in order', () => {
    expect(keysToClose(four(), 'close', 'tool:b')).toEqual(['tool:b']);
    expect(keysToClose(four(), 'others', 'tool:b')).toEqual(['tool:a', 'tool:c', 'tool:d']);
    expect(keysToClose(four(), 'right', 'tool:b')).toEqual(['tool:c', 'tool:d']);
    expect(keysToClose(four(), 'all', 'tool:b')).toHaveLength(4);
  });
});

describe('move', () => {
  it('drops a tab where another one was, from either side', () => {
    const state = pinned(tool('a'), tool('b'), tool('c'));
    expect(keys(move(state, 'tool:a', 'tool:c'))).toEqual(['tool:b', 'tool:c', 'tool:a']);
    expect(keys(move(state, 'tool:c', 'tool:a'))).toEqual(['tool:c', 'tool:a', 'tool:b']);
    expect(move(state, 'tool:a', 'tool:x')).toBe(state);
    expect(move(state, 'tool:a', 'tool:c').activeKey).toBe(state.activeKey);
  });
});

describe('step', () => {
  it('goes round at both ends', () => {
    const state = activate(pinned(tool('a'), tool('b'), tool('c')), 'tool:c');
    expect(step(state, 1).activeKey).toBe('tool:a');
    expect(step(activate(state, 'tool:a'), -1).activeKey).toBe('tool:c');
    expect(step(NO_TABS, 1)).toBe(NO_TABS);
  });
});

describe('prune', () => {
  it('drops tabs whose item is gone, but never History or a draft', () => {
    let state = pinned(tool('a'), tool('gone'), HISTORY_TAB);
    state = openDraft(activate(state, 'tool:gone'), 'new-1');
    state = activate(state, 'tool:gone');
    const kept = prune(state, (tab) => tab.id !== 'gone');
    expect(keys(kept)).toEqual(['tool:a', 'automation:new-1', 'history']);
    expect(kept.activeKey).toBe('automation:new-1');
  });
});

describe('rename', () => {
  it('turns a saved draft into its automation, in place and pinned', () => {
    const state = openDraft(pinned(tool('a'), tool('b')), 'new-1');
    const saved = rename(state, 'automation:new-1', automation('nightly'));
    expect(keys(saved)).toEqual(['tool:a', 'tool:b', 'automation:nightly']);
    expect(activeTab(saved)).toMatchObject({ draft: false, preview: false });
  });

  it('closes the draft when the automation already has a tab', () => {
    const state = openDraft(pinned(automation('nightly')), 'new-1');
    const saved = rename(state, 'automation:new-1', automation('nightly'));
    expect(keys(saved)).toEqual(['automation:nightly']);
    expect(saved.activeKey).toBe('automation:nightly');
  });
});

describe('layout', () => {
  it('stores tabs and the active one, leaving drafts out', () => {
    let state = open(pinned(tool('a'), HISTORY_TAB), automation('b'), { pin: false });
    state = openDraft(state, 'new-1');
    expect(toLayout(state)).toEqual({
      tabs: [
        { kind: 'tool', id: 'a' },
        { kind: 'history' },
        { kind: 'automation', id: 'b', preview: true },
      ],
      activeTab: null,
    });
    expect(toLayout(activate(state, 'history')).activeTab).toBe('history');
  });

  it('reads back what it stored', () => {
    const state = activate(open(pinned(tool('a')), automation('b'), { pin: false }), 'tool:a');
    const layout = toLayout(state);
    const restored = fromLayout({
      categoryOrder: [],
      tabs: layout.tabs ?? [],
      ...(typeof layout.activeTab === 'string' ? { activeTab: layout.activeTab } : {}),
    });
    expect(restored).toEqual(state);
  });

  it('falls back to the first tab when the stored active one is unknown', () => {
    const restored = fromLayout({
      categoryOrder: [],
      tabs: [{ kind: 'tool', id: 'a' }],
      activeTab: 'tool:x',
    });
    expect(restored.activeKey).toBe('tool:a');
    expect(fromLayout(undefined)).toEqual(NO_TABS);
  });
});
