import type { LayoutUpdate, WorkspaceLayoutView } from '../../shared/ipc-contract.js';

export type TabKind = 'tool' | 'automation' | 'history';

/** Names what a tab shows. History has a single tab, so it has no id. */
export interface TabRef {
  readonly kind: TabKind;
  readonly id?: string;
}

export interface Tab extends TabRef {
  readonly key: string;
  /** The one tab that the next single click in a panel replaces. */
  readonly preview: boolean;
  /** A new automation not saved yet, which is never stored. */
  readonly draft: boolean;
}

export interface TabState {
  /** In the order shown. */
  readonly tabs: readonly Tab[];
  readonly activeKey?: string;
}

export const NO_TABS: TabState = { tabs: [] };

/** The most tabs a Workspace stores, the same limit `workspaces:update` checks. */
export const STORED_TABS_MAX = 100;

export const HISTORY_TAB: TabRef = { kind: 'history' };

/** Matches the key core stores, so a stored active tab finds its tab again. */
export function tabKey({ kind, id }: TabRef): string {
  return kind === 'history' ? 'history' : `${kind}:${id ?? ''}`;
}

function makeTab(ref: TabRef, preview: boolean, draft = false): Tab {
  return {
    kind: ref.kind,
    ...(ref.kind === 'history' || ref.id === undefined ? {} : { id: ref.id }),
    key: tabKey(ref),
    preview,
    draft,
  };
}

function withActive(tabs: readonly Tab[], activeKey: string | undefined): TabState {
  return activeKey === undefined ? { tabs } : { tabs, activeKey };
}

export function activeTab(state: TabState): Tab | undefined {
  return state.tabs.find(({ key }) => key === state.activeKey);
}

export function activate(state: TabState, key: string): TabState {
  return state.tabs.some((tab) => tab.key === key) ? withActive(state.tabs, key) : state;
}

/**
 * Opens what `ref` names and makes it active. An item that has a tab keeps it. Otherwise a preview
 * opening takes the place of the preview tab, and anything else opens right of the active tab.
 */
export function open(state: TabState, ref: TabRef, options: { readonly pin: boolean }): TabState {
  const key = tabKey(ref);
  if (state.tabs.some((tab) => tab.key === key)) {
    const pinned = options.pin ? pin(state, key) : state;
    return withActive(pinned.tabs, key);
  }
  const created = makeTab(ref, !options.pin);
  const previewIndex = state.tabs.findIndex(({ preview }) => preview);
  if (!options.pin && previewIndex !== -1) {
    return withActive(
      state.tabs.map((tab, index) => (index === previewIndex ? created : tab)),
      key,
    );
  }
  const activeIndex = state.tabs.findIndex((tab) => tab.key === state.activeKey);
  const at = activeIndex === -1 ? state.tabs.length : activeIndex + 1;
  return withActive([...state.tabs.slice(0, at), created, ...state.tabs.slice(at)], key);
}

/** Opens a tab for a new automation, which has no id until it is saved. */
export function openDraft(state: TabState, draftId: string): TabState {
  const ref: TabRef = { kind: 'automation', id: draftId };
  const opened = open(state, ref, { pin: true });
  return {
    ...opened,
    tabs: opened.tabs.map((tab) => (tab.key === tabKey(ref) ? { ...tab, draft: true } : tab)),
  };
}

export function pin(state: TabState, key: string): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.key === key && tab.preview ? { ...tab, preview: false } : tab,
    ),
  };
}

/** Keeps the tabs `keep` accepts. A closed active tab passes to its right neighbour, then left. */
function keepTabs(state: TabState, keep: (tab: Tab, index: number) => boolean): TabState {
  const tabs = state.tabs.filter(keep);
  if (tabs.some((tab) => tab.key === state.activeKey)) {
    return withActive(tabs, state.activeKey);
  }
  const activeIndex = state.tabs.findIndex((tab) => tab.key === state.activeKey);
  if (activeIndex === -1) {
    return withActive(tabs, undefined);
  }
  const right = state.tabs.slice(activeIndex + 1).find((tab) => tabs.includes(tab));
  const left = state.tabs
    .slice(0, activeIndex)
    .reverse()
    .find((tab) => tabs.includes(tab));
  return withActive(tabs, (right ?? left)?.key);
}

export function close(state: TabState, key: string): TabState {
  return keepTabs(state, (tab) => tab.key !== key);
}

export function closeOthers(state: TabState, key: string): TabState {
  const kept = keepTabs(state, (tab) => tab.key === key);
  return kept.tabs.length === 0 ? kept : withActive(kept.tabs, key);
}

export function closeToRight(state: TabState, key: string): TabState {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  return index === -1 ? state : keepTabs(state, (_, position) => position <= index);
}

/** The keys each close action would remove, in the order shown. */
export function keysToClose(
  state: TabState,
  action: 'close' | 'others' | 'right' | 'all',
  key: string,
): readonly string[] {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  return state.tabs
    .filter((tab, position) => {
      switch (action) {
        case 'close':
          return tab.key === key;
        case 'others':
          return tab.key !== key;
        case 'right':
          return index !== -1 && position > index;
        case 'all':
          return true;
      }
    })
    .map((tab) => tab.key);
}

/** Moves a tab to where another one is, as dragging one onto the other does. */
export function move(state: TabState, fromKey: string, toKey: string): TabState {
  const from = state.tabs.findIndex((tab) => tab.key === fromKey);
  const to = state.tabs.findIndex((tab) => tab.key === toKey);
  if (from === -1 || to === -1 || from === to) {
    return state;
  }
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  if (moved !== undefined) {
    tabs.splice(to, 0, moved);
  }
  return withActive(tabs, state.activeKey);
}

/** Activates the next tab, or the previous one with a negative step, going round at the ends. */
export function step(state: TabState, delta: 1 | -1): TabState {
  const count = state.tabs.length;
  if (count === 0) {
    return state;
  }
  const index = state.tabs.findIndex((tab) => tab.key === state.activeKey);
  const next = index === -1 ? 0 : (index + delta + count) % count;
  return withActive(state.tabs, state.tabs[next]?.key);
}

/** Drops tabs whose item is gone, without asking. */
export function prune(state: TabState, exists: (tab: Tab) => boolean): TabState {
  return keepTabs(state, (tab) => tab.kind === 'history' || tab.draft || exists(tab));
}

/** Gives a tab what it shows now, such as a saved draft's id. An item with a tab already wins. */
export function rename(state: TabState, fromKey: string, ref: TabRef): TabState {
  const key = tabKey(ref);
  if (fromKey === key) {
    return state;
  }
  if (state.tabs.some((tab) => tab.key === key)) {
    const closed = close(state, fromKey);
    return state.activeKey === fromKey ? withActive(closed.tabs, key) : closed;
  }
  const tabs = state.tabs.map((tab) => (tab.key === fromKey ? makeTab(ref, false) : tab));
  return withActive(tabs, state.activeKey === fromKey ? key : state.activeKey);
}

export function fromLayout(layout: WorkspaceLayoutView | undefined): TabState {
  const tabs = (layout?.tabs ?? []).map(({ kind, id, preview }) =>
    makeTab(id === undefined ? { kind } : { kind, id }, preview === true),
  );
  const known = tabs.some((tab) => tab.key === layout?.activeTab);
  return withActive(tabs, known ? layout?.activeTab : tabs[0]?.key);
}

/** What the Workspace stores. Drafts stay out, and so does an active tab that is one. */
export function toLayout(state: TabState): Pick<LayoutUpdate, 'tabs' | 'activeTab'> {
  // Any number can be open, but the Workspace keeps the first ones, as main accepts no more.
  const stored = state.tabs.filter(({ draft }) => !draft).slice(0, STORED_TABS_MAX);
  const active = stored.find((tab) => tab.key === state.activeKey);
  return {
    tabs: stored.map(({ kind, id, preview }) =>
      kind === 'history'
        ? { kind, ...(preview ? { preview } : {}) }
        : { kind, id: id ?? '', ...(preview ? { preview } : {}) },
    ),
    activeTab: active?.key ?? null,
  };
}
