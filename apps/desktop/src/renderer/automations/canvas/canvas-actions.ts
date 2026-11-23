import { createContext } from 'react';
import type { InputTone } from './input-tones.js';
import type { PortLayout } from './port-sides.js';

/** What blocks and notes can ask of the canvas they sit on. Absent in the run view, where nothing changes. */
export interface CanvasActions {
  /** The note being written on the canvas, if any. */
  readonly editingNote: string | undefined;
  /** Ends writing a note: its new text, or undefined to leave it as it was. */
  readonly finishNote: (id: string, text: string | undefined) => void;
  /** Finds the blocks that use a block's values, as its "used by" mark offers. */
  readonly showUses: (id: string) => void;
}

/** True when connections are drawn at right angles. The run view draws them the same way. */
export const RightAnglesContext = createContext(false);

export const CanvasActionsContext = createContext<CanvasActions | undefined>(undefined);

/** Where each block's ports sit, by block id, worked out from where the blocks are now. */
export const PortLayoutsContext = createContext<ReadonlyMap<string, PortLayout>>(new Map());

/** The color of each block's input, by block id, which follows the connections ending at it. */
export const InputTonesContext = createContext<ReadonlyMap<string, InputTone>>(new Map());

/** The port under the pointer: the block it belongs to, and the blocks at its other end. */
export interface PortHover {
  readonly owner: string | undefined;
  readonly peers: ReadonlySet<string>;
}

export const NO_PORT_HOVER: PortHover = { owner: undefined, peers: new Set() };

export const PortHoverContext = createContext<PortHover>(NO_PORT_HOVER);
