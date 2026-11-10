import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface ContextMenuItem<Action extends string> {
  readonly action: Action;
  readonly label: string;
  /** Drawn as a dangerous action, such as a delete. */
  readonly danger?: boolean;
}

interface ContextMenuProps<Action extends string> {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly items: readonly ContextMenuItem<Action>[];
  readonly onAction: (action: Action) => void;
  readonly onClose: () => void;
}

/**
 * A menu drawn in the page at the pointer, so it needs no IPC channel. Arrow keys move through it,
 * and Escape, Tab or a click elsewhere closes it.
 */
export function ContextMenu<Action extends string>({
  x,
  y,
  label,
  items,
  onAction,
  onClose,
}: ContextMenuProps<Action>) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent): void {
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? entries[0] : entries.at(-1))?.focus();
    }
    // Keys used here never reach the canvas or the tab behind the menu.
    event.stopPropagation();
  }

  return (
    <div
      ref={menu}
      className="menu-popup context-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!menu.current?.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={item.danger === true ? 'menu-item danger' : 'menu-item'}
          tabIndex={-1}
          onClick={() => {
            onAction(item.action);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
