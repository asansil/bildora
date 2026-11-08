import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import { RunStateIcon, runStateLabel } from '../shell/RunStateBadge.js';
import type { ToolState } from '../tools/run-state.js';

const DRAG_TYPE = 'application/x-bildora-tab';

export type TabAction = 'close' | 'others' | 'right' | 'all' | 'pin';

export interface TabView {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly state: ToolState;
  readonly preview: boolean;
}

/** The id of the region a tab shows, so the tab can say what it controls. */
export function tabPanelId(key: string): string {
  return `tab-panel-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function tabId(key: string): string {
  return `tab-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

interface TabMenuProps {
  readonly x: number;
  readonly y: number;
  readonly preview: boolean;
  readonly onAction: (action: TabAction) => void;
  readonly onClose: () => void;
}

const MENU_ITEMS: readonly { readonly action: TabAction; readonly label: MessageKey }[] = [
  { action: 'pin', label: 'tabs.pin' },
  { action: 'close', label: 'tabs.close' },
  { action: 'others', label: 'tabs.closeOthers' },
  { action: 'right', label: 'tabs.closeRight' },
  { action: 'all', label: 'tabs.closeAll' },
];

/** A menu drawn in the page, so a tab needs no IPC channel for its context menu. */
function TabMenu({ x, y, preview, onAction, onClose }: TabMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const items = MENU_ITEMS.filter(({ action }) => action !== 'pin' || preview);

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
  }

  return (
    <div
      ref={menu}
      className="menu-popup tab-menu"
      role="menu"
      aria-label={t('tabs.menu')}
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!menu.current?.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      {items.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          className="menu-item"
          tabIndex={-1}
          onClick={() => {
            onAction(action);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

interface TabBarProps {
  readonly tabs: readonly TabView[];
  readonly activeKey: string | undefined;
  readonly onActivate: (key: string) => void;
  readonly onPin: (key: string) => void;
  readonly onMove: (fromKey: string, toKey: string) => void;
  readonly onAction: (action: TabAction, key: string) => void;
}

interface OpenMenu {
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

/** The open programs, automations and History, as tabs. */
export function TabBar({ tabs, activeKey, onActivate, onPin, onMove, onAction }: TabBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);

  useEffect(() => {
    if (activeKey !== undefined) {
      document.getElementById(tabId(activeKey))?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeKey, tabs.length]);

  function focusTab(key: string | undefined): void {
    if (key !== undefined) {
      document.getElementById(tabId(key))?.focus();
    }
  }

  function closeMenu(): void {
    const key = menu?.key;
    setMenu(undefined);
    focusTab(key);
  }

  function onKeyDown(event: KeyboardEvent, key: string): void {
    const index = tabs.findIndex((tab) => tab.key === key);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      if (next !== undefined) {
        onActivate(next.key);
        focusTab(next.key);
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? tabs[0] : tabs.at(-1);
      if (next !== undefined) {
        onActivate(next.key);
        focusTab(next.key);
      }
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onAction('close', key);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      setMenu({ key, x: box.left, y: box.bottom });
    }
  }

  return (
    <div
      ref={bar}
      className="tab-bar"
      role="tablist"
      aria-label={t('tabs.label')}
      onWheel={(event) => {
        // A plain wheel scrolls sideways here, since the bar never scrolls up or down.
        if (bar.current !== null && event.deltaX === 0) {
          bar.current.scrollLeft += event.deltaY;
        }
      }}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <div
            key={tab.key}
            id={tabId(tab.key)}
            role="tab"
            className="tab"
            data-key={tab.key}
            data-preview={tab.preview ? 'true' : undefined}
            aria-selected={active}
            aria-controls={tabPanelId(tab.key)}
            // Named by its label alone, so the close button and the state stay out of the name.
            aria-labelledby={`${tabId(tab.key)}-label`}
            aria-describedby={tab.state === 'idle' ? undefined : `${tabId(tab.key)}-state`}
            tabIndex={active ? 0 : -1}
            title={tab.label}
            draggable
            onClick={() => {
              onActivate(tab.key);
            }}
            onDoubleClick={() => {
              onPin(tab.key);
            }}
            onMouseDown={(event) => {
              // Keeps the middle button from starting the page's own scrolling.
              if (event.button === 1) {
                event.preventDefault();
              }
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onAction('close', tab.key);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ key: tab.key, x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              onKeyDown(event, tab.key);
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, tab.key);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(DRAG_TYPE)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(event) => {
              const dragged = event.dataTransfer.getData(DRAG_TYPE);
              if (dragged !== '') {
                event.preventDefault();
                event.stopPropagation();
                onMove(dragged, tab.key);
              }
            }}
          >
            {tab.icon}
            <span id={`${tabId(tab.key)}-label`} className="tab-label truncate">
              {tab.label}
            </span>
            {tab.state === 'idle' ? null : (
              <span className="tab-state" title={runStateLabel(tab.state)}>
                <RunStateIcon state={tab.state} />
                <span id={`${tabId(tab.key)}-state`} className="visually-hidden">
                  {runStateLabel(tab.state)}
                </span>
              </span>
            )}
            <button
              type="button"
              className="icon-button tab-close"
              tabIndex={-1}
              aria-label={t('tabs.closeTab', { name: tab.label })}
              onClick={(event) => {
                event.stopPropagation();
                onAction('close', tab.key);
              }}
            >
              <X className="icon" aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {menu === undefined ? null : (
        <TabMenu
          x={menu.x}
          y={menu.y}
          preview={tabs.find((tab) => tab.key === menu.key)?.preview === true}
          onAction={(action) => {
            const { key } = menu;
            setMenu(undefined);
            if (action === 'pin') {
              onPin(key);
              focusTab(key);
            } else {
              onAction(action, key);
            }
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
