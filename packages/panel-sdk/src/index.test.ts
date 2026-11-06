import { describe, expect, it } from 'vitest';
import { themeTokenProperty } from './index.js';

describe('themeTokenProperty', () => {
  it('prefixes a valid token name', () => {
    expect(themeTokenProperty('color-accent')).toBe('--bildora-color-accent');
  });

  it.each(['', 'Color', '-color', 'color-', 'color accent', 'a;b'])('rejects "%s"', (token) => {
    expect(() => themeTokenProperty(token)).toThrow(RangeError);
  });
});
