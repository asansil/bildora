import { createContext } from 'react';

/** What blocks and notes can ask of the canvas they sit on. Absent in the run view, where nothing changes. */
export interface CanvasActions {
  /** The note being written on the canvas, if any. */
  readonly editingNote: string | undefined;
  /** Ends writing a note: its new text, or undefined to leave it as it was. */
  readonly finishNote: (id: string, text: string | undefined) => void;
}

/** True when connections are drawn at right angles. The run view draws them the same way. */
export const RightAnglesContext = createContext(false);

export const CanvasActionsContext = createContext<CanvasActions | undefined>(undefined);
