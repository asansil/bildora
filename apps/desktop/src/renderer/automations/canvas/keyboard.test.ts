import { describe, expect, it } from 'vitest';
import { addAfter, addBlocks, createBlocks, emptyDocument, removeItems } from './flow-document.js';
import { describeBlock, nearestInDirection, neighbourOf } from './keyboard.js';

function flow() {
  let doc = emptyDocument();
  doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'run', tool: 'a' }, '')).document;
  doc = addAfter(doc, 'a', createBlocks(doc, { kind: 'run', tool: 'b' }, '')).document;
  doc = addBlocks(doc, createBlocks(doc, { kind: 'run', tool: 'below' }, ''), { x: 300, y: 600 });
  return doc;
}

describe('canvas keyboard', () => {
  it('moves to the nearest block in the direction of an arrow', () => {
    const doc = flow();
    expect(nearestInDirection(doc, 'start', 'ArrowRight')).toBe('a');
    expect(nearestInDirection(doc, 'a', 'ArrowRight')).toBe('b');
    expect(nearestInDirection(doc, 'a', 'ArrowLeft')).toBe('start');
    expect(nearestInDirection(doc, 'a', 'ArrowDown')).toBe('below');
    expect(nearestInDirection(doc, 'start', 'ArrowUp')).toBeUndefined();
  });

  it('keeps focus on a neighbour after a delete', () => {
    const doc = flow();
    const after = removeItems(doc, new Set(['a']));
    expect(['start', 'b']).toContain(neighbourOf(doc, after, 'a'));
  });

  it('describes a block with where its outputs lead', () => {
    const doc = flow();
    expect(describeBlock(doc, 'a', (id) => id.toUpperCase())).toBe(
      'A, Run a tool. Next goes to B; Error is not connected',
    );
  });
});
