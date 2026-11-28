import type { ReactNode } from 'react';

/**
 * One item of a menu, shared by the menu bar and the right-click menus. An item with `checked` is a
 * check item, and an item with `items` opens a submenu instead of running.
 */
export interface MenuCommand<Action extends string = string> {
  readonly label: string;
  readonly shortcut?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  /** Drawn as a dangerous action, such as a delete. */
  readonly danger?: boolean;
  /** A check item: ticked, clear, or 'mixed' when it stands for several things that differ. */
  readonly checked?: boolean | 'mixed';
  readonly run?: () => void;
  /** Handed to the menu's `onAction` when the item has no `run`, for callers that switch on it. */
  readonly action?: Action;
  readonly items?: readonly MenuEntry<Action>[];
}

export type MenuEntry<Action extends string = string> = MenuCommand<Action> | 'separator';

export function isEnabled<Action extends string>(
  entry: MenuEntry<Action> | undefined,
): entry is MenuCommand<Action> {
  return entry !== undefined && entry !== 'separator' && entry.disabled !== true;
}

/**
 * The index of the next item the arrow keys can reach from `from`, wrapping round and skipping
 * separators and disabled items, or -1 when there is none. `from` may be -1 to start at an end.
 */
export function nextEnabled(entries: readonly MenuEntry[], from: number, step: 1 | -1): number {
  const count = entries.length;
  let index = from < 0 || from >= count ? (step === 1 ? -1 : count) : from;
  for (let tried = 0; tried < count; tried++) {
    index = (index + step + count) % count;
    if (isEnabled(entries[index])) {
      return index;
    }
  }
  return -1;
}
