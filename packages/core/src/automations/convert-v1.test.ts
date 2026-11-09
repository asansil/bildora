import { automationSchema } from '@bildora/protocol';
import { describe, expect, it } from 'vitest';
import { convertAutomationV1 } from './convert-v1.js';

const run = (id: string, extra: object = {}) => ({ id, type: 'run', tool: 'acme.tool', ...extra });
const wait = (id: string, step: string, onFailure?: string) => ({
  id,
  type: 'wait-for-completion',
  step,
  ...(onFailure === undefined ? {} : { onFailure }),
});

function convert(steps: object[]) {
  const automation = automationSchema.parse({ schemaVersion: 1, id: 'flow', name: 'Flow', steps });
  const result = convertAutomationV1(automation);
  if (!result.ok) return { problems: result.problems };
  const { blocks, connections } = result.automation;
  return {
    blocks: blocks.map(({ id, type }) => `${id}:${type}`),
    connections: connections.map(
      ({ from, output, to }) => `${from}${output === undefined ? '' : `.${output}`}>${to}`,
    ),
    result: result.automation,
  };
}

describe('convertAutomationV1', () => {
  it('chains the steps after a Start block in Button mode', () => {
    const converted = convert([
      run('a'),
      { id: 'pause', type: 'wait-for-time', seconds: 5 },
      { id: 'review', type: 'wait-for-manual-action', message: 'Look' },
    ]);
    expect(converted.blocks).toEqual([
      'start:start',
      'a:run',
      'pause:wait-for-time',
      'review:wait-for-manual-action',
    ]);
    expect(converted.connections).toEqual(['start>a', 'a>pause', 'pause>review']);
    expect(converted.result?.blocks[0]).toEqual({ id: 'start', type: 'start', mode: 'button' });
    expect(converted.result).toMatchObject({ schemaVersion: 2, id: 'flow', name: 'Flow' });
  });

  it('keeps tool, profile, values and retry, and names the start block apart from a step', () => {
    const onFailure = { retry: { attempts: 3, delaySeconds: 1 } };
    const converted = convert([
      run('start', { profile: 'p', values: { out: '{{run.folder}}/a' }, onFailure }),
    ]);
    expect(converted.blocks).toEqual(['start-2:start', 'start:run']);
    expect(converted.result?.blocks[1]).toEqual(
      run('start', { profile: 'p', values: { out: '{{run.folder}}/a' }, onFailure }),
    );
  });

  it('turns continue into an Error output leading to the next block', () => {
    const converted = convert([
      run('a', { onFailure: 'continue' }),
      { id: 'review', type: 'wait-for-manual-action', message: 'Look', onFailure: 'continue' },
      run('b'),
    ]);
    expect(converted.connections).toEqual([
      'start>a',
      'a>review',
      'a.error>review',
      'review>b',
      'review.error>b',
    ]);
  });

  it('leaves the Error output of a last step with nothing to lead to', () => {
    expect(convert([run('a', { onFailure: 'continue' })]).connections).toEqual(['start>a']);
  });

  it('turns a background step and its wait into a Parallel and a Join', () => {
    const converted = convert([
      run('slow', { background: true }),
      run('quick'),
      run('quicker'),
      wait('done', 'slow'),
      run('after'),
    ]);
    expect(converted.blocks).toEqual([
      'start:start',
      'slow-parallel:parallel',
      'slow:run',
      'quick:run',
      'quicker:run',
      'slow-join:join',
      'after:run',
    ]);
    expect(converted.connections).toEqual([
      'start>slow-parallel',
      'quick>quicker',
      'slow-parallel>slow',
      'slow-parallel>quick',
      'slow>slow-join',
      'quicker>slow-join',
      'slow-join>after',
    ]);
    expect(converted.result?.blocks.find(({ id }) => id === 'slow-join')).toEqual({
      id: 'slow-join',
      type: 'join',
      parallel: 'slow-parallel',
    });
  });

  it('gives a continue on the wait to the background step as an Error output into the Join', () => {
    const converted = convert([
      run('slow', { background: true }),
      run('quick'),
      wait('done', 'slow', 'continue'),
    ]);
    expect(converted.connections).toContain('slow.error>slow-join');
  });

  it('makes a background step waited for at once a plain step with the wait policy', () => {
    const converted = convert([
      run('slow', { background: true }),
      wait('done', 'slow', 'continue'),
      run('b'),
    ]);
    expect(converted.blocks).toEqual(['start:start', 'slow:run', 'b:run']);
    expect(converted.connections).toEqual(['start>slow', 'slow>b', 'slow.error>b']);
  });

  it('joins a background step nobody waits for at the end', () => {
    const converted = convert([run('slow', { background: true }), run('quick')]);
    expect(converted.blocks).toEqual([
      'start:start',
      'slow-parallel:parallel',
      'slow:run',
      'quick:run',
      'slow-join:join',
    ]);
    expect(converted.connections).toContain('quick>slow-join');
  });

  it('treats a last background step as a plain step', () => {
    expect(convert([run('a'), run('slow', { background: true })]).blocks).toEqual([
      'start:start',
      'a:run',
      'slow:run',
    ]);
  });

  it('nests background steps that nest', () => {
    const converted = convert([
      run('outer', { background: true }),
      run('inner', { background: true }),
      run('mid'),
      wait('w-inner', 'inner'),
      run('tail'),
      wait('w-outer', 'outer'),
    ]);
    expect(converted.problems).toBeUndefined();
    expect(converted.blocks).toEqual([
      'start:start',
      'outer-parallel:parallel',
      'outer:run',
      'inner-parallel:parallel',
      'inner:run',
      'mid:run',
      'inner-join:join',
      'tail:run',
      'outer-join:join',
    ]);
  });

  it('reports background steps that overlap without nesting', () => {
    const converted = convert([
      run('one', { background: true }),
      run('two', { background: true }),
      wait('w-one', 'one'),
      wait('w-two', 'two'),
    ]);
    expect(converted.problems).toHaveLength(1);
    expect(converted.problems?.[0]).toContain('Background step "two" overlaps');
  });

  it('reports a background step waited for beyond the end of its neighbour', () => {
    const converted = convert([
      run('one', { background: true }),
      run('two', { background: true }),
      wait('w-one', 'one'),
      run('x'),
    ]);
    expect(converted.problems?.[0]).toContain('"two"');
  });
});
