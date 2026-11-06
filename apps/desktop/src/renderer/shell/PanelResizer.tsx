import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
} from '../../shared/ipc-contract.js';

const KEY_STEP = 16;

function clamped(width: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(width)));
}

interface PanelResizerProps {
  readonly width: number;
  readonly onResize: (width: number) => void;
  /** Called once a change is finished, so that it is stored only then. */
  readonly onCommit: (width: number) => void;
}

/** The handle between the panel and the work area, for the pointer and for the arrow keys. */
export function PanelResizer({ width, onResize, onCommit }: PanelResizerProps) {
  const drag = useRef<{ readonly startX: number; readonly startWidth: number } | undefined>(
    undefined,
  );

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag.current !== undefined) {
      onResize(clamped(drag.current.startWidth + event.clientX - drag.current.startX));
    }
  }

  function onPointerUp(): void {
    if (drag.current !== undefined) {
      drag.current = undefined;
      onCommit(width);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    const targets: Record<string, number> = {
      ArrowLeft: width - KEY_STEP,
      ArrowRight: width + KEY_STEP,
      Home: PANEL_WIDTH_MIN,
      End: PANEL_WIDTH_MAX,
    };
    const target = targets[event.key];
    if (target !== undefined) {
      event.preventDefault();
      const next = clamped(target);
      onResize(next);
      onCommit(next);
    }
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('nav.resizePanel')}
      aria-valuemin={PANEL_WIDTH_MIN}
      aria-valuemax={PANEL_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onResize(PANEL_WIDTH_DEFAULT);
        onCommit(PANEL_WIDTH_DEFAULT);
      }}
    />
  );
}
