import { describe, expect, it } from 'vitest';
import { layoutKey, layoutPorts, sideFacing } from './port-sides.js';
import type { PortRect } from './port-sides.js';

const block = (id: string, x: number, y: number, outputs: string[] = ['next']): PortRect => ({
  id,
  x,
  y,
  width: 160,
  height: 32,
  hasInput: id !== 'start',
  outputs,
});

describe('sideFacing', () => {
  const a = block('a', 0, 0);
  it('faces right and left along a row', () => {
    expect(sideFacing(a, block('b', 300, 10))).toBe('right');
    expect(sideFacing(a, block('b', -300, -10))).toBe('left');
  });

  it('faces down or up when the other block is mostly below or above', () => {
    expect(sideFacing(a, block('b', 40, 120))).toBe('bottom');
    expect(sideFacing(a, block('b', -40, -120))).toBe('top');
  });

  it('picks the axis with the larger free gap', () => {
    // 200 to the right leaves a 40px gap across; 80 down leaves a 48px gap.
    expect(sideFacing(a, block('b', 200, 80))).toBe('bottom');
    expect(sideFacing(a, block('b', 260, 80))).toBe('right');
  });
});

describe('layoutPorts', () => {
  it('keeps unconnected ports at rest: input left, outputs right, Error below', () => {
    const layout = layoutPorts([block('run', 0, 0, ['next', 'error'])], []).get('run');
    expect(layout?.get('in')).toEqual({ side: 'left', offset: 0.5 });
    expect(layout?.get('next')).toEqual({ side: 'right', offset: 0.5 });
    expect(layout?.get('error')).toEqual({ side: 'bottom', offset: 0.5 });
  });

  it('turns ports toward the blocks they connect to', () => {
    const layout = layoutPorts(
      [block('run', 0, 0, ['next', 'error']), block('below', 0, 200), block('left', -400, 0)],
      [
        { source: 'run', sourceHandle: 'next', target: 'below' },
        { source: 'left', sourceHandle: 'next', target: 'run' },
      ],
    ).get('run');
    expect(layout?.get('next')?.side).toBe('bottom');
    expect(layout?.get('in')?.side).toBe('left');
  });

  it('orders outputs that share a side by where they lead, so they do not cross', () => {
    const layout = layoutPorts(
      [block('if', 0, 0, ['true', 'false']), block('up', 400, -100), block('down', 400, 100)],
      [
        // Connected the other way round on purpose: the upper target still gets the upper port.
        { source: 'if', sourceHandle: 'true', target: 'down' },
        { source: 'if', sourceHandle: 'false', target: 'up' },
      ],
    ).get('if');
    expect(layout?.get('false')).toEqual({ side: 'right', offset: 1 / 3 });
    expect(layout?.get('true')).toEqual({ side: 'right', offset: 2 / 3 });
  });

  it('aims a port with many connections at the middle of its targets', () => {
    const layout = layoutPorts(
      [block('parallel', 0, 0), block('a', 400, -200), block('b', 400, 200)],
      [
        { source: 'parallel', target: 'a' },
        { source: 'parallel', target: 'b' },
      ],
    ).get('parallel');
    expect(layout?.get('next')?.side).toBe('right');
  });

  it('places connected ports before unconnected ones on a shared side', () => {
    const layout = layoutPorts(
      [block('switch', 0, 0, ['a', 'b', 'default']), block('t', 400, 0)],
      [{ source: 'switch', sourceHandle: 'b', target: 't' }],
    ).get('switch');
    expect(layout?.get('b')?.offset).toBe(0.25);
    expect(layout?.get('a')?.offset).toBe(0.5);
    expect(layout?.get('default')?.offset).toBe(0.75);
  });

  it('gives a key that changes only when a port moves', () => {
    const rects = [block('run', 0, 0), block('t', 400, 0)];
    const links = [{ source: 'run', target: 't' }];
    const first = layoutKey(layoutPorts(rects, links).get('run'));
    expect(layoutKey(layoutPorts(rects, links).get('run'))).toBe(first);
    const moved = [block('run', 0, 0), block('t', 0, 300)];
    expect(layoutKey(layoutPorts(moved, links).get('run'))).not.toBe(first);
  });
});
