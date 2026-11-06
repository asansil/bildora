import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly shortcut?: string;
  readonly run: () => void;
}

export interface Menu {
  readonly label: string;
  readonly items: readonly MenuItem[];
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
  const [activeItem, setActiveItem] = useState(0);
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

  function openMenu(index: number): void {
    setOpen(index);
    setActiveItem(0);
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

  useEffect(() => {
    if (open !== undefined) {
      bar.current?.querySelector<HTMLElement>(`[data-item="${String(activeItem)}"]`)?.focus();
    }
  }, [open, activeItem]);

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
      case 'Escape':
        close();
        break;
    }
  }

  function moveToMenu(index: number): void {
    setOpen(wrap(index, menus.length));
    setActiveItem(0);
  }

  function runItem(item: MenuItem): void {
    close();
    item.run();
  }

  function onItemKey(event: KeyboardEvent, menuIndex: number, item: MenuItem): void {
    const count = menus[menuIndex]?.items.length ?? 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveItem((current) => wrap(current + 1, count));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveItem((current) => wrap(current - 1, count));
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveToMenu(menuIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveToMenu(menuIndex - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        runItem(item);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(undefined);
        focusTrigger(menuIndex);
        break;
      case 'Tab':
        setOpen(undefined);
        break;
    }
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
            <div className="menu-popup" role="menu" aria-label={menu.label}>
              {menu.items.map((item, itemIndex) => (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  key={item.label}
                  data-item={itemIndex}
                  tabIndex={-1}
                  onClick={() => {
                    runItem(item);
                  }}
                  onKeyDown={(event) => {
                    onItemKey(event, menuIndex, item);
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut === undefined ? null : <kbd>{item.shortcut}</kbd>}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
