import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  automationSchema,
  buildAutomationJsonSchema,
  guarantees,
  topologicalOrder,
} from './index.js';

const base = { schemaVersion: 2, id: 'nightly-report', name: 'Nightly report' };
const start = { id: 'start', type: 'start' };
const run = (id: string) => ({ id, type: 'run', tool: 'acme.tool' });

/** Start, a run with an Error output, a decision, and a Parallel with its Join. */
const full = {
  ...base,
  description: 'Everything at once',
  blocks: [
    { ...start, mode: 'button' },
    {
      id: 'extract',
      type: 'run',
      tool: 'acme.extractor',
      profile: 'nightly',
      values: { out: '{{run.folder}}/a.csv' },
      onFailure: { retry: { attempts: 3, delaySeconds: 30 } },
    },
    {
      id: 'check',
      type: 'if',
      condition: {
        match: 'all',
        rules: [
          { block: 'extract', field: 'result', operator: 'is', value: 'completed' },
          { block: 'extract', field: 'exit-code', operator: 'equals', value: 0 },
        ],
      },
    },
    { id: 'review', type: 'wait-for-manual-action', message: 'Look at it' },
    { id: 'pause', type: 'wait-for-time', seconds: 5 },
    {
      id: 'route',
      type: 'switch',
      cases: [
        {
          id: 'big',
          condition: {
            match: 'any',
            rules: [{ block: 'extract', field: 'exit-code', operator: 'greater-than', value: 5 }],
          },
        },
      ],
    },
    { id: 'fork', type: 'parallel' },
    run('left'),
    run('right'),
    { id: 'meet', type: 'join', parallel: 'fork', onBranchFailure: 'let-finish' },
    run('notify'),
  ],
  connections: [
    { from: 'start', to: 'extract' },
    { from: 'extract', to: 'check' },
    { from: 'extract', output: 'error', to: 'notify' },
    { from: 'check', output: 'true', to: 'route' },
    { from: 'check', output: 'false', to: 'review' },
    { from: 'review', to: 'pause' },
    { from: 'pause', to: 'route' },
    { from: 'route', output: 'big', to: 'fork' },
    { from: 'route', output: 'default', to: 'notify' },
    { from: 'fork', to: 'left' },
    { from: 'fork', to: 'right' },
    { from: 'left', to: 'meet' },
    { from: 'right', to: 'meet' },
    { from: 'meet', to: 'notify' },
  ],
  positions: { start: { x: 0, y: 0 }, extract: { x: 160, y: 0 } },
};

function issues(input: unknown): string[] {
  const result = automationSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const chain = (...blocks: ({ id: string; type: string } & Record<string, unknown>)[]) => ({
  ...base,
  blocks: [start, ...blocks],
  connections: [],
});

describe('automationSchema', () => {
  it('accepts every kind of block, and keeps left-out fields left out', () => {
    expect(issues(full)).toEqual([]);
    expect(automationSchema.parse(full)).toEqual(full);
  });

  it('accepts a Start block alone', () => {
    expect(issues(chain())).toEqual([]);
  });

  it('refuses unknown fields and an automation with no blocks', () => {
    expect(issues({ ...full, extra: 1 })).not.toEqual([]);
    expect(issues({ ...full, blocks: [] })).not.toEqual([]);
  });

  it('needs exactly one Start block', () => {
    const none = { ...base, blocks: [run('a')], connections: [] };
    expect(issues(none)).toEqual([
      'An automation needs exactly one Start block, and this one has 0',
    ]);
    expect(issues({ ...base, blocks: [start, { ...start, id: 's2' }], connections: [] })).toEqual([
      'An automation needs exactly one Start block, and this one has 2',
    ]);
  });

  it('refuses a block id used twice', () => {
    expect(issues(chain(run('a'), run('a')))).toEqual(['Block "a" is declared more than once']);
  });

  it('refuses connections to blocks that do not exist, and into Start', () => {
    const wrong = (connection: object) => ({ ...chain(run('a')), connections: [connection] });
    expect(issues(wrong({ from: 'start', to: 'gone' }))).toEqual([
      'Connection 1 ends at "gone", which does not exist',
    ]);
    expect(issues(wrong({ from: 'gone', to: 'a' }))).toEqual([
      'Connection 1 starts at "gone", which does not exist',
    ]);
    expect(issues(wrong({ from: 'a', to: 'start' }))).toEqual([
      'Nothing can lead into the Start block',
    ]);
  });

  it('refuses an output the block does not have, or one used twice', () => {
    const wrong = (...connections: object[]) => ({
      ...chain(run('a'), run('b'), run('c')),
      connections,
    });
    expect(issues(wrong({ from: 'start', output: 'error', to: 'a' }))).toEqual([
      'Block "start" has no output "error"',
    ]);
    expect(issues(wrong({ from: 'start', to: 'a' }, { from: 'start', to: 'b' }))).toEqual([
      'The "next" output of "start" leads to more than one block, and only Parallel starts several paths',
    ]);
    expect(issues(wrong({ from: 'a', output: 'error', to: 'b' }, { from: 'a', to: 'c' }))).toEqual(
      [],
    );
  });

  it('refuses a cycle', () => {
    const cycle = {
      ...chain(run('a'), run('b')),
      connections: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', output: 'error', to: 'a' },
      ],
    };
    expect(issues(cycle)).toEqual([
      'The connections go in a circle, and only a loop block may repeat work',
    ]);
    expect(topologicalOrder(cycle)).toBeUndefined();
    expect(topologicalOrder(full)?.[0]).toBe('start');
  });

  it('refuses rules that read a block that does not exist, and bad cases', () => {
    const rule = { block: 'gone', field: 'result', operator: 'is', value: 'failed' };
    const condition = { match: 'all', rules: [rule] };
    expect(issues(chain({ id: 'c', type: 'if', condition }))).toEqual([
      'A rule reads block "gone", which does not exist',
    ]);
    const cases = [
      { id: 'default', condition },
      { id: 'x', condition },
      { id: 'x', condition },
    ];
    expect(
      issues(chain({ id: 's', type: 'switch', cases })).filter((m) => !m.startsWith('A rule')),
    ).toEqual([
      '"default" cannot name a case, because it is the name of another output',
      'Case "x" is declared more than once',
    ]);
  });

  it('refuses a position for a block that does not exist', () => {
    expect(issues({ ...chain(), positions: { gone: { x: 1, y: 2 } } })).toEqual([
      'A position is given for block "gone", which does not exist',
    ]);
  });

  it('allows a retry only on a Run block', () => {
    const onFailure = { retry: { attempts: 2 } };
    expect(issues(chain({ ...run('a'), onFailure }))).toEqual([]);
    expect(
      issues(chain({ id: 'm', type: 'wait-for-manual-action', message: 'x', onFailure })),
    ).not.toEqual([]);
    expect(issues(chain({ ...run('a'), onFailure: { retry: { attempts: 1 } } }))).not.toEqual([]);
    expect(issues(chain({ ...run('a'), onFailure: 'continue' }))).not.toEqual([]);
  });
});

describe('values worked out from others', () => {
  it('keeps expressions apart from plain values, in any parameter', () => {
    const values = {
      file: { expression: 'convert.file' },
      width: { expression: 'convert.width * 2' },
      fast: true,
      title: '= not an expression, just text',
    };
    expect(issues(chain({ ...run('a'), values }))).toEqual([]);
    expect(issues(chain({ ...run('a'), values: { file: { expression: '  ' } } }))).not.toEqual([]);
    expect(issues(chain({ ...run('a'), values: { file: { expression: 'a', x: 1 } } }))).not.toEqual(
      [],
    );
  });

  it('keeps names that expressions use for other values from naming a block', () => {
    for (const id of ['inputs', 'steps', 'run', 'paths', 'loop']) {
      expect(issues(chain(run(id)))).toEqual([
        `"${id}" cannot name a block, because expressions use it for other values`,
      ]);
    }
  });

  it('accepts inputs on Start, with unique names and a default among the choices', () => {
    const inputs = [
      { name: 'file', type: 'path', label: 'File', required: true },
      { name: 'size', type: 'integer', default: 100 },
      { name: 'mode', type: 'choice', choices: ['a', 'b'], default: 'b' },
    ];
    expect(issues({ ...base, blocks: [{ ...start, inputs }], connections: [] })).toEqual([]);
    const twice = [inputs[0], { name: 'file', type: 'string' }];
    expect(issues({ ...base, blocks: [{ ...start, inputs: twice }], connections: [] })).toEqual([
      'Input "file" is declared more than once',
    ]);
    const choice = [{ name: 'mode', type: 'choice', choices: ['a'], default: 'z' }];
    expect(issues({ ...base, blocks: [{ ...start, inputs: choice }], connections: [] })).toEqual([
      'The default of input "mode" is not one of its choices',
    ]);
    const secret = [{ name: 'key', type: 'string', secret: true }];
    expect(
      issues({ ...base, blocks: [{ ...start, inputs: secret }], connections: [] }),
    ).not.toEqual([]);
  });

  it('accepts rules on values, with a value only when the operator compares', () => {
    const rule = (changes: object) =>
      chain(run('a'), {
        id: 'check',
        type: 'if',
        condition: {
          match: 'all',
          rules: [{ field: 'value', read: { expression: 'inputs.size' }, ...changes }],
        },
      });
    expect(issues(rule({ operator: 'greater-than', value: 100 }))).toEqual([]);
    expect(issues(rule({ operator: 'equals', value: { expression: 'a.size' } }))).toEqual([]);
    expect(issues(rule({ operator: 'exists' }))).toEqual([]);
    expect(issues(rule({ operator: 'equals' }))).toEqual(['A rule compares a value with nothing']);
    expect(issues(rule({ operator: 'is-true', value: true }))).toEqual([
      'A rule that compares with nothing is given a value',
    ]);
    expect(issues(rule({ operator: 'between', value: 1 }))).not.toEqual([]);
  });
});

describe('Parallel and Join', () => {
  const pair = (extra: object[], connections: object[], join: object = {}) => ({
    ...base,
    blocks: [
      start,
      { id: 'p', type: 'parallel' },
      run('a'),
      run('b'),
      { id: 'j', type: 'join', parallel: 'p', ...join },
      ...extra,
    ],
    connections: [
      { from: 'start', to: 'p' },
      { from: 'p', to: 'a' },
      { from: 'p', to: 'b' },
      { from: 'a', to: 'j' },
      { from: 'b', to: 'j' },
      ...connections,
    ],
  });

  it('accepts a pair, and pairs that nest', () => {
    expect(issues(pair([], []))).toEqual([]);
    const nested = {
      ...base,
      blocks: [
        start,
        { id: 'p1', type: 'parallel' },
        { id: 'p2', type: 'parallel' },
        run('a'),
        run('b'),
        run('c'),
        { id: 'j2', type: 'join', parallel: 'p2' },
        { id: 'j1', type: 'join', parallel: 'p1' },
      ],
      connections: [
        { from: 'start', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p1', to: 'c' },
        { from: 'p2', to: 'a' },
        { from: 'p2', to: 'b' },
        { from: 'a', to: 'j2' },
        { from: 'b', to: 'j2' },
        { from: 'j2', to: 'j1' },
        { from: 'c', to: 'j1' },
      ],
    };
    expect(issues(nested)).toEqual([]);
  });

  it('needs a Join, two branches, and a Join that names a Parallel', () => {
    const noJoin = {
      ...base,
      blocks: [start, { id: 'p', type: 'parallel' }, run('a')],
      connections: [
        { from: 'start', to: 'p' },
        { from: 'p', to: 'a' },
      ],
    };
    expect(issues(noJoin)).toEqual([
      'Parallel "p" needs at least two branches',
      'Parallel "p" needs exactly one Join, and has 0',
    ]);
    expect(issues(chain({ id: 'j', type: 'join', parallel: 'a' }))).toEqual([
      'Join "j" must end a Parallel block',
    ]);
  });

  const mustMeet =
    'The branches of Parallel "p" must meet only at Join "j", and nothing may lead into them from outside';

  it('refuses a branch that reaches what follows the Join without passing it', () => {
    const wrong = pair(
      [run('after')],
      [
        { from: 'j', to: 'after' },
        { from: 'a', output: 'error', to: 'after' },
      ],
    );
    expect(issues(wrong)).toEqual([mustMeet]);
  });

  it('refuses a block outside that leads into a branch', () => {
    const entering = pair(
      [{ id: 'w', type: 'wait-for-time', seconds: 1 }],
      [{ from: 'w', to: 'b' }],
    );
    expect(issues(entering)).toEqual([mustMeet]);
  });

  it('lets a branch end before the Join, and a decision merge inside a branch', () => {
    const open = {
      ...base,
      blocks: [
        start,
        { id: 'p', type: 'parallel' },
        run('a'),
        run('b'),
        { id: 'j', type: 'join', parallel: 'p' },
      ],
      connections: [
        { from: 'start', to: 'p' },
        { from: 'p', to: 'a' },
        { from: 'p', to: 'b' },
        { from: 'b', to: 'j' },
      ],
    };
    expect(issues(open)).toEqual([]);
  });
});

describe('published JSON Schema', () => {
  it('agrees with the schema on the rules it can state', () => {
    const validate = new Ajv2020({ strict: false }).compile(buildAutomationJsonSchema());
    expect(validate(full)).toBe(true);
    expect(validate({ ...full, extra: 1 })).toBe(false);
    expect(validate({ ...full, schemaVersion: 1 })).toBe(false);
    expect(validate({ ...full, blocks: [{ id: 'x', type: 'nope' }] })).toBe(false);
  });
});

describe('guarantees', () => {
  const blocks = (...ids: string[]) =>
    ids.map((id) => ({ id, type: id === 'start' ? 'start' : 'run' }));
  const sorted = (ids: ReadonlySet<string> | undefined) => [...(ids ?? [])].sort();

  it('knows what ran before a block on a straight path', () => {
    const known = guarantees({
      blocks: blocks('start', 'a', 'b'),
      connections: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    });
    expect(sorted(known.get('start')?.completed)).toEqual([]);
    expect(sorted(known.get('b')?.completed)).toEqual(['a', 'start']);
  });

  it('drops what only one side of a decision ran', () => {
    const known = guarantees({
      blocks: [...blocks('start', 'a', 'x', 'y', 'm'), { id: 'check', type: 'if' }],
      connections: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'check' },
        { from: 'check', output: 'true', to: 'x' },
        { from: 'check', output: 'false', to: 'y' },
        { from: 'x', to: 'm' },
        { from: 'y', to: 'm' },
      ],
    });
    expect(sorted(known.get('m')?.completed)).toEqual(['a', 'check', 'start']);
    expect(sorted(known.get('x')?.completed)).toEqual(['a', 'check', 'start']);
  });

  it('counts a block that failed as having run, but not as having left outputs', () => {
    const known = guarantees({
      blocks: blocks('start', 'a', 'notify'),
      connections: [
        { from: 'start', to: 'a' },
        { from: 'a', output: 'error', to: 'notify' },
      ],
    });
    expect(sorted(known.get('notify')?.completed)).toEqual(['start']);
    expect(sorted(known.get('notify')?.ran)).toEqual(['a', 'start']);
  });

  it('keeps branches apart, and brings what each left together after the Join', () => {
    const known = guarantees({
      blocks: [
        ...blocks('start', 'x', 'y', 'after'),
        { id: 'fork', type: 'parallel' },
        { id: 'meet', type: 'join', parallel: 'fork' },
      ],
      connections: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'x' },
        { from: 'fork', to: 'y' },
        { from: 'x', to: 'meet' },
        { from: 'y', to: 'meet' },
        { from: 'meet', to: 'after' },
      ],
    });
    expect(sorted(known.get('y')?.completed)).toEqual(['fork', 'start']);
    expect(sorted(known.get('after')?.completed)).toEqual(['fork', 'meet', 'start', 'x', 'y']);
  });

  it('leaves out of a branch what only some of its paths ran', () => {
    const known = guarantees({
      blocks: [
        ...blocks('start', 'x', 'only', 'after'),
        { id: 'fork', type: 'parallel' },
        { id: 'other', type: 'wait-for-time' },
        { id: 'check', type: 'if' },
        { id: 'meet', type: 'join', parallel: 'fork' },
      ],
      connections: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'x' },
        { from: 'fork', to: 'other' },
        { from: 'x', to: 'check' },
        { from: 'check', output: 'true', to: 'only' },
        { from: 'check', output: 'false', to: 'meet' },
        { from: 'only', to: 'meet' },
        { from: 'other', to: 'meet' },
        { from: 'meet', to: 'after' },
      ],
    });
    expect(sorted(known.get('after')?.completed)).toEqual([
      'check',
      'fork',
      'meet',
      'other',
      'start',
      'x',
    ]);
  });
});
