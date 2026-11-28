import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronRight, Minus } from 'lucide-react';
import { isEnabled, nextEnabled } from './menu-model.js';
import type { MenuCommand, MenuEntry } from './menu-model.js';

/** How long the pointer rests on an item before its submenu opens, or the open one closes. */
const HOVER_DELAY = 200;
/** The gap kept between a menu and the window's edges. */
const EDGE = 4;

interface OpenSubmenu {
  readonly index: number;
  readonly anchor: DOMRect;
  /** Opened from the keyboard, so its first item takes the focus. */
  readonly focus: boolean;
}

interface MenuListProps<Action extends string> {
  readonly entries: readonly MenuEntry<Action>[];
  readonly label: string;
  readonly className: string;
  /** A menu at the pointer, kept inside the window. */
  readonly at?: { readonly x: number; readonly y: number };
  /** A submenu, beside its item, flipped left or up when it would leave the window. */
  readonly anchor?: DOMRect;
  readonly autoFocus: 'first' | 'last' | 'none';
  /** An item without a submenu was chosen. */
  readonly onChoose: (entry: MenuCommand<Action>) => void;
  /** Escape, and ArrowLeft in a submenu: go back one level. */
  readonly onBack: () => void;
  /** ArrowLeft or ArrowRight that leave the menu, for a menu bar to move to its neighbour. */
  readonly onLeave?: ((direction: 1 | -1) => void) | undefined;
  /** Tab closes every level. */
  readonly onDismiss: () => void;
  readonly onPointerEnter?: () => void;
}

/**
 * One level of a menu, following the WAI-ARIA menu pattern: the arrow keys skip separators and
 * disabled items, and a submenu opens on hover after a short delay, on click, on ArrowRight and on
 * Enter. Submenus are drawn by the same component, nested inside their item.
 */
export function MenuList<Action extends string>({
  entries,
  label,
  className,
  at,
  anchor,
  autoFocus,
  onChoose,
  onBack,
  onLeave,
  onDismiss,
  onPointerEnter,
}: MenuListProps<Action>) {
  const list = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const [submenu, setSubmenu] = useState<OpenSubmenu | undefined>(undefined);

  // Placed before paint, so a menu that would leave the window never shows there.
  useLayoutEffect(() => {
    const element = list.current;
    if (element === null || (at === undefined && anchor === undefined)) return;
    const { width, height } = element.getBoundingClientRect();
    const right = window.innerWidth - EDGE;
    const bottom = window.innerHeight - EDGE;
    let left: number;
    let top: number;
    if (anchor !== undefined) {
      left = anchor.right + 2;
      if (left + width > right) left = anchor.left - width - 2;
      top = anchor.top - EDGE - 1;
    } else {
      left = at?.x ?? 0;
      top = at?.y ?? 0;
      if (left + width > right) left -= width;
      if (top + height > bottom) top -= height;
    }
    if (top + height > bottom) top = bottom - height;
    element.style.left = `${String(Math.max(EDGE, left))}px`;
    element.style.top = `${String(Math.max(EDGE, top))}px`;
  });

  useEffect(() => {
    if (autoFocus === 'none') return;
    const index = nextEnabled(entries, -1, autoFocus === 'first' ? 1 : -1);
    (index < 0 ? list.current : items.current[index])?.focus();
    // Only when the menu opens: later changes to its items keep the focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  function openSubmenu(index: number, focus: boolean): void {
    const item = items.current[index];
    if (item === null || item === undefined) return;
    setSubmenu({ index, anchor: item.getBoundingClientRect(), focus });
  }

  function activate(index: number, fromKeyboard: boolean): void {
    window.clearTimeout(timer.current);
    const entry = entries[index];
    if (!isEnabled(entry)) return;
    if (entry.items === undefined) {
      onChoose(entry);
    } else if (submenu?.index !== index || fromKeyboard) {
      openSubmenu(index, fromKeyboard);
    }
  }

  function hover(index: number): void {
    window.clearTimeout(timer.current);
    const entry = entries[index];
    const enabled = isEnabled(entry);
    if (enabled) {
      items.current[index]?.focus({ preventScroll: true });
    }
    if (submenu?.index === index) return;
    timer.current = window.setTimeout(() => {
      if (enabled && entry.items !== undefined) {
        openSubmenu(index, false);
      } else {
        setSubmenu(undefined);
      }
    }, HOVER_DELAY);
  }

  function back(index: number): void {
    setSubmenu(undefined);
    items.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Keys used in a menu never reach the levels above it, nor the canvas or tab behind it.
    event.stopPropagation();
    const current = items.current.indexOf(document.activeElement as HTMLButtonElement);
    const entry = entries[current];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const index = nextEnabled(entries, current, event.key === 'ArrowDown' ? 1 : -1);
        items.current[index]?.focus();
        break;
      }
      case 'Home':
      case 'End': {
        event.preventDefault();
        const index = nextEnabled(entries, -1, event.key === 'Home' ? 1 : -1);
        items.current[index]?.focus();
        break;
      }
      case 'ArrowRight':
        event.preventDefault();
        if (isEnabled(entry) && entry.items !== undefined) {
          activate(current, true);
        } else {
          onLeave?.(1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (anchor !== undefined) {
          onBack();
        } else {
          onLeave?.(-1);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current >= 0) activate(current, true);
        break;
      case 'Escape':
        event.preventDefault();
        // A submenu opened by the pointer leaves the focus here, and closes first.
        if (submenu === undefined) {
          onBack();
        } else {
          window.clearTimeout(timer.current);
          setSubmenu(undefined);
        }
        break;
      case 'Tab':
        event.preventDefault();
        onDismiss();
        break;
    }
  }

  return (
    <div
      ref={list}
      className={className}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
    >
      {entries.map((entry, index) => {
        if (entry === 'separator') {
          return <hr key={`separator-${String(index)}`} className="menu-separator" />;
        }
        const open = submenu?.index === index;
        const button = (
          <button
            ref={(element) => {
              items.current[index] = element;
            }}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            className={[
              'menu-item',
              entry.danger === true ? 'danger' : '',
              open ? 'is-open' : '',
            ].join(' ')}
            tabIndex={-1}
            aria-checked={entry.checked}
            aria-disabled={entry.disabled === true ? true : undefined}
            aria-haspopup={entry.items === undefined ? undefined : 'menu'}
            aria-expanded={entry.items === undefined ? undefined : open}
            onClick={() => {
              activate(index, false);
            }}
            onPointerEnter={() => {
              hover(index);
            }}
          >
            <span className="menu-lead" aria-hidden="true">
              {entry.checked === true ? (
                <Check className="icon" />
              ) : entry.checked === 'mixed' ? (
                <Minus className="icon" />
              ) : (
                entry.icon
              )}
            </span>
            <span className="menu-label">{entry.label}</span>
            {entry.shortcut === undefined ? (
              <span />
            ) : (
              <kbd className="menu-shortcut">{entry.shortcut}</kbd>
            )}
            <span className="menu-arrow" aria-hidden="true">
              {entry.items === undefined ? null : <ChevronRight className="icon" />}
            </span>
          </button>
        );
        return (
          <div key={`${entry.label}-${String(index)}`} role="none">
            {button}
            {open && entry.items !== undefined ? (
              <MenuList
                // Opened by the pointer, then by a key: drawn afresh, so its first item is focused.
                key={submenu.focus ? 'keyboard' : 'pointer'}
                entries={entry.items}
                label={entry.label}
                className="menu-popup submenu"
                anchor={submenu.anchor}
                autoFocus={submenu.focus ? 'first' : 'none'}
                onChoose={onChoose}
                onBack={() => {
                  back(index);
                }}
                onLeave={onLeave}
                onDismiss={onDismiss}
                onPointerEnter={() => {
                  window.clearTimeout(timer.current);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
