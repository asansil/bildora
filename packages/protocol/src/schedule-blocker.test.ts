import { describe, expect, it } from 'vitest';
import type { StartBlock } from './index.js';
import { startBlocker } from './index.js';

const now = new Date(2026, 10, 28, 12, 0);
const daily = { repeat: 'daily', time: '08:00' } as const;
const once = (time: string) => ({ repeat: 'once', date: '2026-11-28', time }) as const;
const start = (fields: Partial<StartBlock>): StartBlock => ({
  id: 'start',
  type: 'start',
  ...fields,
});

describe('startBlocker', () => {
  it('needs a block that starts on a schedule', () => {
    expect(startBlocker(undefined, now)).toBe('not-scheduled');
    expect(startBlocker(start({}), now)).toBe('not-scheduled');
    expect(startBlocker(start({ schedule: daily }), now)).toBe('not-scheduled');
    expect(startBlocker(start({ mode: 'scheduled', schedule: daily }), now)).toBeUndefined();
  });

  it('refuses a required input with no default', () => {
    const inputs = [{ name: 'file', type: 'string', required: true }] as const;
    expect(
      startBlocker(start({ mode: 'scheduled', schedule: daily, inputs: [...inputs] }), now),
    ).toBe('input-without-default');
    const withDefault = [{ ...inputs[0], default: 'a.csv' }];
    expect(
      startBlocker(start({ mode: 'scheduled', schedule: daily, inputs: withDefault }), now),
    ).toBeUndefined();
  });

  it('refuses a single run whose time has gone', () => {
    expect(startBlocker(start({ mode: 'scheduled', schedule: once('12:00') }), now)).toBe('past');
    expect(
      startBlocker(start({ mode: 'scheduled', schedule: once('12:01') }), now),
    ).toBeUndefined();
  });
});
