import { describe, expect, it } from 'vitest';
import { COALESCE_MS, UNDO_LIMIT, record, redo, replace, startHistory, undo } from './undo.js';

describe('undo history', () => {
  it('goes back and forth, and a new edit drops what could be redone', () => {
    let history = startHistory('a');
    history = record(history, 'b', undefined, 0);
    history = record(history, 'c', undefined, 0);
    history = undo(history);
    expect(history.present).toBe('b');
    history = redo(history);
    expect(history.present).toBe('c');
    history = undo(undo(history));
    expect(history.present).toBe('a');
    expect(undo(history)).toBe(history);
    history = record(history, 'd', undefined, 0);
    expect(history.future).toEqual([]);
    expect(redo(history)).toBe(history);
  });

  it('undoes typing in one field as one step, but not edits far apart', () => {
    let history = startHistory('');
    history = record(history, 'H', 'name', 0);
    history = record(history, 'Hi', 'name', 100);
    expect(undo(history).present).toBe('');
    history = record(history, 'Hi!', 'name', 100 + COALESCE_MS);
    expect(undo(history).present).toBe('Hi');
    history = record(history, 'other', 'description', 100 + COALESCE_MS);
    expect(undo(history).present).toBe('Hi!');
  });

  it('keeps a limited past, and changes made for the person are no step', () => {
    let history = startHistory(0);
    for (let value = 1; value <= UNDO_LIMIT + 10; value += 1) {
      history = record(history, value, undefined, 0);
    }
    expect(history.past).toHaveLength(UNDO_LIMIT);
    const placed = replace(history, -1);
    expect(placed.past).toBe(history.past);
    expect(undo(placed).present).toBe(UNDO_LIMIT + 9);
  });
});
