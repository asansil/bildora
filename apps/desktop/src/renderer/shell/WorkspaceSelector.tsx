import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { Check, Layers } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { WorkspaceView } from '../../shared/ipc-contract.js';

interface WorkspaceSelectorProps {
  readonly workspaces: readonly WorkspaceView[];
  readonly activeId: string | undefined;
  readonly current: boolean;
  readonly onSwitch: (id: string) => void;
  readonly onCreate: () => void;
  readonly onManage: () => void;
}

const POPUP_GAP = 8;

function wrap(index: number, length: number): number {
  return (index + length) % length;
}

/** The rail item that changes context quickly, following the WAI-ARIA menu button pattern. */
export function WorkspaceSelector({
  workspaces,
  activeId,
  current,
  onSwitch,
  onCreate,
  onManage,
}: WorkspaceSelectorProps) {
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const open = position !== undefined;

  function items(): HTMLElement[] {
    return [...(popup.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  }

  useEffect(() => {
    if (open) {
      const active = popup.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      (active ?? items()[0])?.focus();
    }
  }, [open]);

  function close(): void {
    setPosition(undefined);
    trigger.current?.focus();
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    // The rail clips what overflows it, so the popup sits on the window instead.
    const box = trigger.current?.getBoundingClientRect();
    if (box !== undefined) {
      setPosition({
        left: box.right + POPUP_GAP,
        bottom: window.innerHeight - box.bottom,
      });
    }
  }

  function choose(action: () => void): void {
    close();
    action();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const targets: Record<string, number> = {
      ArrowDown: wrap(index + 1, list.length),
      ArrowUp: wrap(index - 1, list.length),
      Home: 0,
      End: list.length - 1,
    };
    const target = targets[event.key];
    if (target !== undefined) {
      event.preventDefault();
      list[target]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="rail-button"
        title={t('nav.workspaces')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={current ? 'true' : undefined}
        onClick={toggle}
      >
        <Layers className="icon" aria-hidden="true" />
        <span className="visually-hidden">{t('nav.workspaces')}</span>
      </button>
      {position === undefined ? null : (
        <div
          ref={popup}
          className="menu-popup workspace-popup"
          role="menu"
          aria-label={t('workspace.switch')}
          style={position}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (
              !popup.current?.contains(event.relatedTarget) &&
              event.relatedTarget !== trigger.current
            ) {
              setPosition(undefined);
            }
          }}
        >
          <span className="menu-heading">{t('workspace.switch')}</span>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === activeId}
              className="menu-item"
              tabIndex={-1}
              title={workspace.name}
              onClick={() => {
                choose(() => {
                  onSwitch(workspace.id);
                });
              }}
            >
              <span className="truncate">{workspace.name}</span>
              {workspace.id === activeId ? <Check className="icon" aria-hidden="true" /> : null}
            </button>
          ))}
          <hr className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            tabIndex={-1}
            onClick={() => {
              choose(onCreate);
            }}
          >
            {t('workspace.create')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            tabIndex={-1}
            onClick={() => {
              choose(onManage);
            }}
          >
            {t('workspace.manage')}
          </button>
        </div>
      )}
    </>
  );
}
