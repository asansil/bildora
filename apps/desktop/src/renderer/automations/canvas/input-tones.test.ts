import { describe, expect, it } from 'vitest';
import { inputTones } from './input-tones.js';

describe('inputTones', () => {
  it('leaves an input with plain connections at rest', () => {
    expect(inputTones([{ id: 'a', target: 'b' }], undefined).size).toBe(0);
  });

  it('colors an input by the state of the connection that ends at it', () => {
    const tones = inputTones(
      [
        { id: 'a', target: 'chosen', selected: true },
        { id: 'b', target: 'pointed' },
        { id: 'c', target: 'taken', className: 'edge--taken' },
        { id: 'd', target: 'error', className: 'edge--error' },
        { id: 'e', target: 'spliced', className: 'edge--splice' },
        { id: 'f', target: 'port', className: 'edge--port-hover' },
      ],
      'b',
    );
    expect(Object.fromEntries(tones)).toEqual({
      chosen: 'accent',
      pointed: 'accent',
      taken: 'taken',
      error: 'error',
      spliced: 'accent',
      port: 'accent',
    });
  });

  it('takes the strongest tone among several connections', () => {
    const edges = [
      { id: 'a', target: 'x', className: 'edge--error' },
      { id: 'b', target: 'x', className: 'edge--taken' },
    ];
    expect(inputTones(edges, undefined).get('x')).toBe('taken');
    expect(
      inputTones([...edges, { id: 'c', target: 'x', selected: true }], undefined).get('x'),
    ).toBe('accent');
  });

  it('ignores a connection about to be replaced', () => {
    const tones = inputTones(
      [{ id: 'a', target: 'x', className: 'edge--error edge--replaced' }],
      undefined,
    );
    expect(tones.has('x')).toBe(false);
  });
});
