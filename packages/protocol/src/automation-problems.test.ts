import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_PROBLEM_CODES,
  automationSchema,
  describeProblem,
  problemsOfIssues,
  validTargets,
} from './index.js';

const base = { schemaVersion: 2, id: 'flow', name: 'Flow' };
const start = { id: 'start', type: 'start' };
const run = (id: string) => ({ id, type: 'run', tool: 'acme.tool' });

function problems(input: unknown) {
  const result = automationSchema.safeParse(input);
  return result.success ? [] : problemsOfIssues(result.error.issues, input);
}

describe('automation problems', () => {
  it('words every code in English', () => {
    for (const code of AUTOMATION_PROBLEM_CODES) {
      expect(describeProblem(code, { detail: 'x' }).length).toBeGreaterThan(0);
    }
  });

  it('keeps the code and the block of a rule broken in the graph', () => {
    const input = {
      ...base,
      blocks: [start, { id: 'fork', type: 'parallel' }, run('a')],
      connections: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'a' },
      ],
    };
    expect(problems(input)).toEqual([
      expect.objectContaining({ code: 'parallel-branches', blockId: 'fork' }),
      expect.objectContaining({
        code: 'parallel-joins',
        blockId: 'fork',
        params: { block: 'fork', count: '0' },
      }),
    ]);
  });

  it('reports a malformed field as invalid, on its block', () => {
    const input = {
      ...base,
      blocks: [start, { id: 'wait', type: 'wait-for-time', seconds: 0 }],
      connections: [],
    };
    expect(problems(input)).toEqual([
      expect.objectContaining({ code: 'invalid', blockId: 'wait' }),
    ]);
  });
});

describe('notes and groups', () => {
  const flow = {
    ...base,
    blocks: [start, run('a'), run('b')],
    connections: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'b' },
    ],
  };

  it('accepts notes and groups, which change nothing that runs', () => {
    const input = {
      ...flow,
      notes: [{ id: 'note-1', text: 'Runs at night', x: 10, y: 20, width: 200 }],
      groups: [{ id: 'group-1', name: 'Prepare', blocks: ['a', 'b'] }],
    };
    expect(problems(input)).toEqual([]);
    expect(automationSchema.parse(input)).toEqual(input);
  });

  it('refuses a group with an unknown block, a block in two groups and a shared id', () => {
    const input = {
      ...flow,
      notes: [{ id: 'a', text: '', x: 0, y: 0 }],
      groups: [
        { id: 'one', name: 'One', blocks: ['a', 'gone'] },
        { id: 'two', name: 'Two', blocks: ['a'] },
      ],
    };
    expect(problems(input).map(({ code }) => code)).toEqual([
      'duplicate-id',
      'group-block-missing',
      'group-block-twice',
    ]);
  });
});

describe('validTargets', () => {
  it('offers blocks ahead, never Start, itself or a block that leads back', () => {
    const shape = {
      blocks: [start, run('a'), run('b'), run('c')],
      connections: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    };
    expect(validTargets(shape, 'b', 'next')).toEqual(['c']);
    // Connecting replaces the output's current connection, so `b` stays on offer.
    expect(validTargets(shape, 'a', 'next')).toEqual(['b', 'c']);
    expect(validTargets(shape, 'a', 'error')).toEqual(['b', 'c']);
    expect(validTargets(shape, 'a', 'nothing')).toEqual([]);
  });

  it('keeps the branches of a Parallel inside it', () => {
    const shape = {
      blocks: [
        start,
        { id: 'fork', type: 'parallel' },
        run('left'),
        run('right'),
        { id: 'meet', type: 'join', parallel: 'fork' },
        run('after'),
      ],
      connections: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'left' },
        { from: 'fork', to: 'right' },
        { from: 'left', to: 'meet' },
        { from: 'meet', to: 'after' },
      ],
    };
    expect(validTargets(shape, 'right', 'next')).toEqual(['left', 'meet']);
    expect(validTargets(shape, 'fork', 'next')).toEqual(['meet']);
  });
});
