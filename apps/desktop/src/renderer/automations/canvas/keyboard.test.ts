import { describe, expect, it } from 'vitest';
import { addAfter, addBlocks, createBlocks, emptyDocument, removeItems } from './flow-document.js';
import { describeBlock, nearestInDirection, neighbourOf } from './keyboard.js';

function flow() {
  let doc = emptyDocument();
  doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'run', tool: 'a' }, '')).document;
  doc = addAfter(doc, 'A1', createBlocks(doc, { kind: 'run', tool: 'b' }, '')).document;
  doc = addBlocks(doc, createBlocks(doc, { kind: 'run', tool: 'below' }, ''), { x: 300, y: 600 });
  return doc;
}

describe('canvas keyboard', () => {
  it('moves to the nearest block in the direction of an arrow', () => {
    const doc = flow();
    expect(nearestInDirection(doc, 'start', 'ArrowRight')).toBe('A1');
    expect(nearestInDirection(doc, 'A1', 'ArrowRight')).toBe('B1');
    expect(nearestInDirection(doc, 'A1', 'ArrowLeft')).toBe('start');
    expect(nearestInDirection(doc, 'A1', 'ArrowDown')).toBe('Below1');
    expect(nearestInDirection(doc, 'start', 'ArrowUp')).toBeUndefined();
  });

  it('keeps focus on a neighbour after a delete', () => {
    const doc = flow();
    const after = removeItems(doc, new Set(['A1']));
    expect(['start', 'B1']).toContain(neighbourOf(doc, after, 'A1'));
  });

  it('describes a block with where its outputs lead', () => {
    const doc = flow();
    expect(describeBlock(doc, 'A1', (id) => id.toUpperCase())).toBe(
      'A1, Run a tool. Next goes to B1; Error is not connected',
    );
  });
});
