import { describe, expect, it } from 'vitest';
import type { StepRunView } from '../../../shared/ipc-contract.js';
import { isShownPath, shownRounds } from './run-rounds.js';

const step = (id: string, state: StepRunView['state'], round?: string): StepRunView => ({
  id,
  state,
  ...(round === undefined ? {} : { round }),
});

describe('shown rounds', () => {
  const blocks = [{ id: 'start' }, { id: 'Loop' }, { id: 'A', loop: 'Loop' }];
  const steps = [
    step('start', 'completed'),
    step('Loop', 'running'),
    step('A', 'completed', 'Loop:1'),
    step('A', 'failed', 'Loop:2'),
    step('A', 'running', 'Loop:3'),
  ];

  it('follows the latest round until one is chosen', () => {
    const shown = shownRounds(blocks, steps, new Map());
    expect(shown.rounds.get('Loop')).toEqual({
      index: 3,
      count: 3,
      results: ['completed', 'failed', 'running'],
    });
    expect(shown.steps.get('A')?.state).toBe('running');
    expect(shown.steps.get('Loop')?.state).toBe('running');
  });

  it('shows the chosen round', () => {
    const shown = shownRounds(blocks, steps, new Map([['Loop', 2]]));
    expect(shown.steps.get('A')?.state).toBe('failed');
    expect(shown.keys.get('Loop')).toBe('Loop:2');
  });

  it('counts an inner loop within the round its outer loop shows', () => {
    const nested = [{ id: 'Outer' }, { id: 'Inner', loop: 'Outer' }, { id: 'B', loop: 'Inner' }];
    const ran = [
      step('Outer', 'completed'),
      step('Inner', 'completed', 'Outer:1'),
      step('B', 'completed', 'Outer:1/Inner:1'),
      step('Inner', 'completed', 'Outer:2'),
      step('B', 'completed', 'Outer:2/Inner:1'),
      step('B', 'failed', 'Outer:2/Inner:2'),
    ];
    const latest = shownRounds(nested, ran, new Map());
    expect(latest.rounds.get('Inner')?.count).toBe(2);
    expect(latest.steps.get('B')?.state).toBe('failed');
    const first = shownRounds(nested, ran, new Map([['Outer', 1]]));
    expect(first.rounds.get('Inner')?.count).toBe(1);
    expect(first.steps.get('B')?.round).toBe('Outer:1/Inner:1');
  });

  it('shows nothing inside a loop that has not run a round', () => {
    const shown = shownRounds(blocks, [step('start', 'completed')], new Map());
    expect(shown.steps.has('A')).toBe(false);
    expect(shown.rounds.has('Loop')).toBe(false);
  });

  it('draws a connection inside a loop as taken only in the round shown', () => {
    const keys = new Map([['Loop', 'Loop:2']]);
    expect(isShownPath({ from: 'A', output: 'next', to: 'B', round: 'Loop:2' }, 'Loop', keys)).toBe(
      true,
    );
    expect(isShownPath({ from: 'A', output: 'next', to: 'B', round: 'Loop:1' }, 'Loop', keys)).toBe(
      false,
    );
    expect(isShownPath({ from: 'start', output: 'next', to: 'Loop' }, undefined, keys)).toBe(true);
  });
});
