import type { CSSProperties } from 'react';
import type { PortText } from './block-text.js';
import type { Side } from './port-sides.js';

/** Where a port is, in pixels from the canvas's corner. */
export interface PortBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Room between a port and its tooltip. */
const GAP = 8;

/** The tooltip goes beyond the port, on the side it faces out of, clear of the block. */
function placement(box: PortBox, side: Side): CSSProperties {
  const middleX = (box.left + box.right) / 2;
  const middleY = (box.top + box.bottom) / 2;
  switch (side) {
    case 'left':
      return { left: box.left - GAP, top: middleY, transform: 'translate(-100%, -50%)' };
    case 'right':
      return { left: box.right + GAP, top: middleY, transform: 'translate(0, -50%)' };
    case 'top':
      return { left: middleX, top: box.top - GAP, transform: 'translate(-50%, -100%)' };
    case 'bottom':
      return { left: middleX, top: box.bottom + GAP, transform: 'translate(-50%, 0)' };
  }
}

export interface PortTooltipProps {
  readonly text: PortText;
  readonly box: PortBox;
  readonly side: Side;
}

/** A port's name and what it is for, beside it, the same size at any zoom. */
export function PortTooltip({ text, box, side }: PortTooltipProps) {
  return (
    <div
      className="port-tooltip"
      role="tooltip"
      data-testid="port-tooltip"
      style={placement(box, side)}
    >
      <strong className="port-tooltip-name">{text.name}</strong>
      <span className="port-tooltip-purpose">{text.purpose}</span>
    </div>
  );
}
