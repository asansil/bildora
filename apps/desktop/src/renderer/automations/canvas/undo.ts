/** Steps Undo can go back. Older ones are dropped. */
export const UNDO_LIMIT = 100;
/** Edits of one field this close together undo as one, so typing a word is a single step. */
export const COALESCE_MS = 500;

export interface UndoHistory<Value> {
  readonly past: readonly Value[];
  readonly present: Value;
  readonly future: readonly Value[];
  /** The last edit that can still absorb the next one with the same key. */
  readonly last?: { readonly key: string; readonly at: number };
}

export function startHistory<Value>(present: Value): UndoHistory<Value> {
  return { past: [], present, future: [] };
}

/**
 * Records an edit. One with the same key as the edit before it, soon after, replaces it rather
 * than adding a step. An edit that changes nothing is not recorded.
 */
export function record<Value>(
  history: UndoHistory<Value>,
  next: Value,
  key: string | undefined,
  now: number,
): UndoHistory<Value> {
  if (next === history.present) return history;
  const last = key === undefined ? undefined : { key, at: now };
  if (
    key !== undefined &&
    history.last?.key === key &&
    now - history.last.at < COALESCE_MS &&
    history.future.length === 0
  ) {
    return { ...history, present: next, ...(last === undefined ? {} : { last }) };
  }
  return {
    past: [...history.past, history.present].slice(-UNDO_LIMIT),
    present: next,
    future: [],
    ...(last === undefined ? {} : { last }),
  };
}

/** Changes the present without a step to undo, for what is not an edit, such as a layout on opening. */
export function replace<Value>(history: UndoHistory<Value>, next: Value): UndoHistory<Value> {
  return next === history.present
    ? history
    : { past: history.past, present: next, future: history.future };
}

export function undo<Value>(history: UndoHistory<Value>): UndoHistory<Value> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<Value>(history: UndoHistory<Value>): UndoHistory<Value> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}
