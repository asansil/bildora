import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const KEY_STEP = 16;

interface PanelResizerProps {
  /** The panel's width, or its height when `orientation` is horizontal. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** What a double-click puts back. */
  readonly initial: number;
  /** `vertical` splits columns and changes a width; `horizontal` splits rows and changes a height. */
  readonly orientation?: 'vertical' | 'horizontal';
  /** For a panel to the right of the handle or below it, which grows as the handle moves away. */
  readonly invert?: boolean;
  readonly label: string;
  readonly onResize: (value: number) => void;
  /** Called once a change is finished, so that it is stored only then. */
  readonly onCommit: (value: number) => void;
}

/** The handle beside a panel, for the pointer and for the arrow keys. */
export function PanelResizer({
  value,
  min,
  max,
  initial,
  orientation = 'vertical',
  invert = false,
  label,
  onResize,
  onCommit,
}: PanelResizerProps) {
  // The end of a drag can arrive before the last move is drawn, so `value` may be behind it.
  const drag = useRef<
    { readonly start: number; readonly startValue: number; latest: number } | undefined
  >(undefined);
  const vertical = orientation === 'vertical';
  const sign = invert ? -1 : 1;

  function clamped(size: number): number {
    return Math.min(max, Math.max(min, Math.round(size)));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = vertical ? event.clientX : event.clientY;
    drag.current = { start, startValue: value, latest: value };
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag.current !== undefined) {
      const moved = (vertical ? event.clientX : event.clientY) - drag.current.start;
      drag.current.latest = clamped(drag.current.startValue + sign * moved);
      onResize(drag.current.latest);
    }
  }

  function onPointerUp(): void {
    if (drag.current !== undefined) {
      const { latest } = drag.current;
      drag.current = undefined;
      onCommit(latest);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    // The arrows move the handle, so a panel on the far side grows as it moves towards it.
    const steps: Record<string, number> = vertical
      ? { ArrowLeft: -1, ArrowRight: 1 }
      : { ArrowUp: -1, ArrowDown: 1 };
    const step = steps[event.key];
    const target =
      step === undefined
        ? event.key === 'Home'
          ? min
          : event.key === 'End'
            ? max
            : undefined
        : value + sign * step * KEY_STEP;
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
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onResize(initial);
        onCommit(initial);
      }}
    />
  );
}
