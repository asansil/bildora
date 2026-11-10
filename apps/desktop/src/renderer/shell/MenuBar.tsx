import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { MenuList } from './MenuList.js';
import type { MenuCommand, MenuEntry } from './menu-model.js';

export interface Menu {
  readonly label: string;
  readonly items: readonly MenuEntry[];
}

interface MenuBarProps {
  readonly menus: readonly Menu[];
}

function wrap(index: number, length: number): number {
  return (index + length) % length;
}

/** The app's main menus, following the WAI-ARIA menu bar keyboard pattern, with Alt to enter. */
export function MenuBar({ menus }: MenuBarProps) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [focusLast, setFocusLast] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);

  function focusTrigger(index: number): void {
    bar.current?.querySelectorAll<HTMLElement>('[data-trigger]')[index]?.focus();
  }

  function close(): void {
    setOpen(undefined);
    if (lastFocus.current instanceof HTMLElement) {
      lastFocus.current.focus();
    }
  }

  function openMenu(index: number, last = false): void {
    setOpen(index);
    setFocusLast(last);
  }

  useEffect(() => {
    // Only Alt pressed and released by itself: Alt+Tab and other shortcuts must not enter the menus.
    let altAlone = false;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      altAlone = event.key === 'Alt' && !event.ctrlKey && !event.shiftKey;
    }
    function onKeyUp(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Alt' && altAlone) {
        event.preventDefault();
        lastFocus.current = document.activeElement;
        focusTrigger(0);
      }
      altAlone = false;
    }
    function onBlur(): void {
      altAlone = false;
    }
    function onPointer(event: PointerEvent): void {
      if (!(event.target instanceof Node && bar.current?.contains(event.target) === true)) {
        setOpen(undefined);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  function onTriggerKey(event: KeyboardEvent, index: number): void {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTrigger(wrap(index + 1, menus.length));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTrigger(wrap(index - 1, menus.length));
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        openMenu(index);
        break;
      case 'ArrowUp':
        event.preventDefault();
        openMenu(index, true);
        break;
      case 'Escape':
        close();
        break;
    }
  }

  function moveToMenu(index: number): void {
    setOpen(wrap(index, menus.length));
    setFocusLast(false);
  }

  function runItem(item: MenuCommand): void {
    close();
    item.run?.();
  }

  return (
    <div className="menu-bar" role="menubar" ref={bar}>
      {menus.map((menu, menuIndex) => (
        <div className="menu" key={menu.label}>
          <button
            type="button"
            role="menuitem"
            className="menu-trigger"
            data-trigger
            aria-haspopup="menu"
            aria-expanded={open === menuIndex}
            tabIndex={menuIndex === 0 ? 0 : -1}
            onPointerDown={() => {
              lastFocus.current = document.activeElement;
            }}
            onClick={() => {
              if (open === menuIndex) {
                setOpen(undefined);
              } else {
                openMenu(menuIndex);
              }
            }}
            onPointerEnter={() => {
              if (open !== undefined && open !== menuIndex) {
                openMenu(menuIndex);
              }
            }}
            onKeyDown={(event) => {
              onTriggerKey(event, menuIndex);
            }}
          >
            {menu.label}
          </button>
          {open === menuIndex ? (
            <MenuList
              entries={menu.items}
              label={menu.label}
              className="menu-popup"
              autoFocus={focusLast ? 'last' : 'first'}
              onChoose={runItem}
              onBack={() => {
                setOpen(undefined);
                focusTrigger(menuIndex);
              }}
              onLeave={(direction) => {
                moveToMenu(menuIndex + direction);
              }}
              onDismiss={close}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
