import { memo, use } from 'react';
import { BaseEdge, Position, getBezierPath, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { RightAnglesContext } from './canvas-actions.js';

/** How wide a connection is to the pointer, wider than it is drawn. */
const HIT_WIDTH = 16;
/** How long the straight end of a connection is, longer than its arrowhead. */
const STRAIGHT = 12;
/** Which way the straight end leaves the input, by the side the input is on. */
const INTO: Record<Position, readonly [number, number]> = {
  [Position.Left]: [-1, 0],
  [Position.Right]: [1, 0],
  [Position.Top]: [0, -1],
  [Position.Bottom]: [0, 1],
};

/** How round the corners of a right-angle connection are. */
const CORNER = 6;

/** A connection: a curve, or lines at right angles, ending in an arrowhead. Delete or a double-click removes a chosen one. */
export const FlowEdge = memo(function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  // The curve stops short of the input and a straight run finishes it, so the arrowhead lies along
  // the line at any angle. The point is the outer side of the input handle, which the tip touches.
  const rightAngles = use(RightAnglesContext);
  const [dx, dy] = INTO[targetPosition];
  const ends = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX: targetX + dx * STRAIGHT,
    targetY: targetY + dy * STRAIGHT,
    targetPosition,
  };
  const [curve] = rightAngles
    ? getSmoothStepPath({ ...ends, borderRadius: CORNER })
    : getBezierPath(ends);
  const path = `${curve} L ${String(targetX)},${String(targetY)}`;
  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={HIT_WIDTH}
      {...(markerEnd === undefined ? {} : { markerEnd })}
      {...(style === undefined ? {} : { style })}
    />
  );
});

export const edgeTypes = { flow: FlowEdge };
