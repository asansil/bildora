import { useRef } from 'react';
import { MenuList } from './MenuList.js';
import type { MenuCommand, MenuEntry } from './menu-model.js';

/** An item that hands its action to the menu's `onAction`, as the tab and block menus use. */
export type ContextMenuItem<Action extends string> = MenuCommand<Action> & {
  readonly action: Action;
};

interface ContextMenuProps<Action extends string> {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly items: readonly MenuEntry<Action>[];
  /** Called for a chosen item that has an `action` and no `run`. The caller closes the menu. */
  readonly onAction?: (action: Action) => void;
  readonly onClose: () => void;
}

/**
 * A menu drawn in the page at the pointer, so it needs no IPC channel. Arrow keys move through it
 * and its submenus, and Escape on the first level, Tab or a click elsewhere closes it. An item with
 * `run` closes the menu before running.
 */
export function ContextMenu<Action extends string>({
  x,
  y,
  label,
  items,
  onAction,
  onClose,
}: ContextMenuProps<Action>) {
  const root = useRef<HTMLDivElement>(null);

  function choose(entry: MenuCommand<Action>): void {
    if (entry.run !== undefined) {
      onClose();
      entry.run();
    } else if (entry.action !== undefined) {
      onAction?.(entry.action);
    }
  }

  return (
    <div
      ref={root}
      className="context-menu-root"
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      <MenuList
        entries={items}
        label={label}
        className="menu-popup context-menu"
        at={{ x, y }}
        autoFocus="first"
        onChoose={choose}
        onBack={onClose}
        onDismiss={onClose}
      />
    </div>
  );
}
