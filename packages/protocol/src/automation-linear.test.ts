import { describe, expect, it } from 'vitest';
import { automationSchema, fromLinear, linearOf, linearStepSchema } from './index.js';
import type { LinearStep } from './index.js';

const run = (id: string, extra: object = {}): LinearStep => ({
  id,
  type: 'run',
  tool: 'acme.tool',
  ...extra,
});

function automationOf(steps: readonly LinearStep[]) {
  return automationSchema.parse({
    schemaVersion: 2,
    id: 'flow',
    name: 'Flow',
    ...fromLinear(steps),
  });
}

describe('linearStepSchema', () => {
  it('takes the steps of the list editor, and no background step', () => {
    expect(linearStepSchema.safeParse(run('a')).success).toBe(true);
    expect(linearStepSchema.safeParse(run('a', { background: true })).success).toBe(false);
    expect(
      linearStepSchema.safeParse({ id: 'w', type: 'wait-for-completion', step: 'a' }).success,
    ).toBe(false);
    expect(
      linearStepSchema.safeParse(run('a', { onFailure: { retry: { attempts: 3 } } })).success,
    ).toBe(true);
  });
});

describe('fromLinear and linearOf', () => {
  const steps: LinearStep[] = [
    run('first', { profile: 'p', values: { out: 'a' }, onFailure: { retry: { attempts: 2 } } }),
    { id: 'pause', type: 'wait-for-time', seconds: 5 },
    run('second', { onFailure: 'continue' }),
    { id: 'review', type: 'wait-for-manual-action', message: 'Look', onFailure: 'continue' },
    run('third'),
  ];

  it('makes a Start and a chain, with an Error output for each continue', () => {
    const { blocks, connections } = fromLinear(steps);
    expect(blocks.map(({ id }) => id)).toEqual([
      'start',
      'first',
      'pause',
      'second',
      'review',
      'third',
    ]);
    expect(connections).toEqual([
      { from: 'start', to: 'first' },
      { from: 'first', to: 'pause' },
      { from: 'pause', to: 'second' },
      { from: 'second', to: 'review' },
      { from: 'second', output: 'error', to: 'review' },
      { from: 'review', to: 'third' },
      { from: 'review', output: 'error', to: 'third' },
    ]);
    expect(
      automationSchema.safeParse({ schemaVersion: 2, id: 'f', name: 'F', ...fromLinear(steps) })
        .success,
    ).toBe(true);
  });

  it('reads the same list back', () => {
    expect(linearOf(automationOf(steps))).toEqual(steps);
  });

  it('reads an empty list, and names the Start apart from a step', () => {
    expect(linearOf(automationOf([]))).toEqual([]);
    const named = [run('start')];
    expect(fromLinear(named).blocks.map(({ id }) => id)).toEqual(['start-2', 'start']);
    expect(linearOf(automationOf(named))).toEqual(named);
  });

  it('gives nothing for a flow that is more than a straight line', () => {
    const base = automationOf([run('a'), run('b')]);
    const condition = {
      match: 'all' as const,
      rules: [
        {
          block: 'a',
          field: 'result' as const,
          operator: 'is' as const,
          value: 'completed' as const,
        },
      ],
    };
    const withIf = {
      ...base,
      blocks: [...base.blocks, { id: 'check', type: 'if' as const, condition }],
      connections: [...base.connections, { from: 'b', to: 'check' }],
    };
    expect(linearOf(automationSchema.parse(withIf))).toBeUndefined();

    const toElsewhere = {
      ...base,
      blocks: [...base.blocks, run('c') as never],
      connections: [...base.connections, { from: 'a', output: 'error', to: 'c' }],
    };
    expect(linearOf(automationSchema.parse(toElsewhere))).toBeUndefined();

    const orphan = { ...base, blocks: [...base.blocks, run('lonely') as never] };
    expect(linearOf(automationSchema.parse(orphan))).toBeUndefined();
  });

  it('gives nothing for a retry that also leads on after a failure', () => {
    const base = automationOf([run('a', { onFailure: { retry: { attempts: 2 } } }), run('b')]);
    const both = {
      ...base,
      connections: [...base.connections, { from: 'a', output: 'error', to: 'b' }],
    };
    expect(linearOf(automationSchema.parse(both))).toBeUndefined();
  });

  it('gives nothing for parallel branches', () => {
    const parallel = automationSchema.parse({
      schemaVersion: 2,
      id: 'p',
      name: 'P',
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'fork', type: 'parallel' },
        run('a'),
        run('b'),
        { id: 'meet', type: 'join', parallel: 'fork' },
      ],
      connections: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'a' },
        { from: 'fork', to: 'b' },
        { from: 'a', to: 'meet' },
        { from: 'b', to: 'meet' },
      ],
    });
    expect(linearOf(parallel)).toBeUndefined();
  });

  it('loses a continue on the last step, which has nowhere to go on to', () => {
    const last = [run('a'), run('b', { onFailure: 'continue' })];
    expect(linearOf(automationOf(last))).toEqual([run('a'), run('b')]);
  });
});
