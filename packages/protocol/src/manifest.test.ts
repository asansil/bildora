import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  buildToolManifestJsonSchema,
  isValidIdentifier,
  toolManifestSchema,
} from './index.js';

const base = { schemaVersion: 1, id: 'acme.tool', name: 'Tool', version: '1.2.0' };
const levelZero = { ...base, level: 0, run: { program: 'C:\\tools\\tool.exe' } };
const levelOne = {
  ...base,
  level: 1,
  interpreter: 'python',
  run: { program: 'tool.py', args: ['--strict'] },
  parameters: [
    { name: 'input', type: 'path', label: 'Input', required: true, flag: '--input' },
    { name: 'token', type: 'string', label: 'Token', secret: true },
    { name: 'mode', type: 'choice', label: 'Mode', choices: ['a', 'b'], default: 'a' },
    { name: 'verbose', type: 'boolean', label: 'Verbose', flag: '-v' },
    { name: 'out', type: 'path', label: 'Output', flag: '/out' },
  ],
  outputs: [
    { name: 'csv', param: 'out' },
    { name: 'report', path: 'out/report.html' },
  ],
  permissions: ['filesystem.read', 'network'],
  leftoverProcesses: 'keep',
};
// The embedded panel level, which no version of Bildora runs any more.
const scripted = {
  ...base,
  level: 1,
  run: { program: 'menu.bat' },
  parameters: [
    { name: 'option', type: 'choice', label: 'Option', choices: ['1', '2'], stdin: true },
    { name: 'password', type: 'string', label: 'Password', secret: true, stdin: true },
    { name: 'out', type: 'path', label: 'Output', flag: '--out' },
  ],
  stdin: [
    { expect: 'Choose an option:', send: '{{params.option}}' },
    { expect: 'Password:', send: '{{params.password}}', timeout: 60 },
    { send: 'y' },
  ],
};
const levelTwo = {
  ...base,
  level: 2,
  entryPoint: { panel: 'panel/index.html', backend: { program: 'backend.py' } },
};

function issues(input: unknown): string[] {
  const result = toolManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('toolManifestSchema', () => {
  describe('env', () => {
    const withParameters = (...parameters: unknown[]): unknown => ({
      ...levelOne,
      parameters,
      outputs: [],
    });
    const token = { name: 'token', type: 'string', label: 'Token', secret: true };

    it('accepts a value handed over in a variable', () => {
      expect(issues(withParameters({ ...token, env: 'TOOL_TOKEN' }))).toEqual([]);
    });

    it('lets a required variable follow an optional positional', () => {
      const optional = { name: 'first', type: 'string', label: 'First' };

      expect(
        issues(withParameters(optional, { ...token, required: true, env: 'TOOL_TOKEN' })),
      ).toEqual([]);
    });

    it.each([
      ['a flag as well', withParameters({ ...token, env: 'TOOL_TOKEN', flag: '--token' })],
      [
        'a boolean',
        withParameters({ name: 'on', type: 'boolean', label: 'On', flag: '-o', env: 'ON' }),
      ],
      ['a bad name', withParameters({ ...token, env: '1 BAD' })],
      [
        'a name used twice, whatever its case',
        withParameters(
          { ...token, env: 'TOOL_TOKEN' },
          { ...token, name: 'other', env: 'tool_token' },
        ),
      ],
    ])('refuses %s', (_name, manifest) => {
      expect(issues(manifest)).not.toEqual([]);
    });
  });

  it.each([
    ['level 0', levelZero],
    ['level 1', levelOne],
    ['scripted level 1', scripted],
  ])('accepts a %s manifest', (_name, manifest) => {
    expect(issues(manifest)).toEqual([]);
  });

  it('fills in the defaults', () => {
    expect(toolManifestSchema.parse(levelZero)).toMatchObject({
      permissions: [],
      leftoverProcesses: 'end',
      run: { args: [] },
    });
  });

  it.each([
    ['a missing id', { ...levelZero, id: undefined }],
    ['an unknown level', { ...levelZero, level: 3 }],
    ['a newer format', { ...levelZero, schemaVersion: 2 }],
    ['a version that is not semver', { ...levelZero, version: '1.2' }],
    ['an unknown field', { ...levelZero, permisions: [] }],
    ['an unknown permission', { ...levelZero, permissions: ['everything'] }],
    ['an unknown leftover policy', { ...levelZero, leftoverProcesses: 'maybe' }],
    ['parameters at level 0', { ...levelZero, parameters: [] }],
    ['level 1 without a command', { ...base, level: 1 }],
    ['a level 2 manifest', levelTwo],
    [
      'a boolean without a flag',
      {
        ...base,
        level: 1,
        run: { program: 'a' },
        parameters: [{ name: 'v', type: 'boolean', label: 'V' }],
      },
    ],
  ])('rejects %s', (_name, manifest) => {
    expect(issues(manifest)).not.toEqual([]);
  });

  it('says why a level 2 manifest is refused', () => {
    expect(issues(levelTwo)).toEqual([
      'Level must be 0 or 1: this version of Bildora runs no level 2 tools',
    ]);
  });

  describe('rules beyond the published schema', () => {
    const withParameters = (parameters: unknown[], outputs: unknown[] = []): unknown => ({
      ...base,
      level: 1,
      run: { program: 'a' },
      parameters,
      outputs,
    });
    const text = { type: 'string', label: 'Text' };

    it('rejects duplicate parameter names', () => {
      expect(
        issues(
          withParameters([
            { ...text, name: 'a' },
            { ...text, name: 'a' },
          ]),
        ),
      ).toContainEqual(expect.stringContaining('more than once'));
    });

    it('rejects duplicate output names', () => {
      const outputs = [
        { name: 'a', path: 'x' },
        { name: 'a', path: 'y' },
      ];
      expect(issues(withParameters([], outputs))).toContainEqual(
        expect.stringContaining('more than once'),
      );
    });

    it('accepts a JSON output with typed fields, and checks its fields', () => {
      const json = (fields: unknown[]) => [{ name: 'result', json: 'out/result.json', fields }];
      const fields = [
        { name: 'count', type: 'integer' },
        { name: 'files', type: 'list' },
        { name: 'token', type: 'string', secret: true },
      ];
      expect(issues(withParameters([], json(fields)))).toEqual([]);
      expect(toolManifestSchema.parse(withParameters([], json(fields)))).toMatchObject({
        outputs: [{ fields: [{ secret: false }, { secret: false }, { secret: true }] }],
      });
      expect(issues(withParameters([], json([fields[0], fields[0]])))).toContainEqual(
        expect.stringContaining('more than once'),
      );
      expect(
        issues(withParameters([], json([{ name: 'n', type: 'number', secret: true }]))),
      ).toContainEqual(expect.stringContaining('only text fields'));
      expect(issues(withParameters([], json([])))).not.toEqual([]);
      expect(issues(withParameters([], json([{ name: 'd', type: 'date' }])))).not.toEqual([]);
    });

    it('rejects a default on a secret', () => {
      const parameter = { ...text, name: 'a', secret: true, default: 'hunter2' };
      expect(issues(withParameters([parameter]))).toContainEqual(expect.stringContaining('secret'));
    });

    it('rejects a default outside the choices', () => {
      const parameter = { name: 'a', type: 'choice', label: 'A', choices: ['x'], default: 'y' };
      expect(issues(withParameters([parameter]))).toContainEqual(
        expect.stringContaining('choices'),
      );
    });

    it('rejects a required positional after an optional one', () => {
      const parameters = [
        { ...text, name: 'a' },
        { ...text, name: 'b', required: true },
      ];
      expect(issues(withParameters(parameters))).toContainEqual(
        expect.stringContaining('positional'),
      );
    });

    describe('console scripts', () => {
      const withScript = (changes: object): unknown => ({ ...scripted, ...changes });
      const [option, password, out] = scripted.parameters;

      it('accepts a script with stdin parameters, and keeps them out of the positionals', () => {
        expect(issues(scripted)).toEqual([]);
        const required = { ...option, required: true };
        const optional = { ...text, name: 'later' };
        expect(issues(withScript({ parameters: [optional, required, password, out] }))).toEqual([]);
      });

      it.each([
        ['a stdin parameter with a flag', { parameters: [{ ...option, flag: '-o' }, password] }],
        ['a stdin parameter with a variable', { parameters: [{ ...option, env: 'O' }, password] }],
        [
          'a stdin parameter no answer refers to',
          { parameters: [option, password, { ...text, name: 'extra', stdin: true }] },
        ],
        ['a stdin parameter with no script', { stdin: undefined }],
        ['an answer naming an unknown parameter', { stdin: [{ send: '{{params.nope}}' }] }],
        [
          'an answer with another kind of reference',
          { stdin: [...scripted.stdin, { send: '{{steps.a.outputs.b}}' }] },
        ],
        ['a time limit with nothing to wait for', { stdin: [{ send: 'x', timeout: 5 }] }],
      ])('rejects %s', (_name, changes) => {
        expect(issues(withScript(changes))).not.toEqual([]);
      });

      it.each([
        [
          'a boolean marked stdin',
          { name: 'v', type: 'boolean', label: 'V', flag: '-v', stdin: true },
        ],
      ])('rejects %s', (_name, parameter) => {
        expect(issues(withScript({ parameters: [option, password, parameter] }))).not.toEqual([]);
      });

      it.each([
        ['an empty script', []],
        ['a script that is too long', Array.from({ length: 101 }, () => ({ send: 'x' }))],
        ['an empty expect', [{ expect: '', send: 'x' }]],
        ['a time limit of zero', [{ expect: 'a', send: 'x', timeout: 0 }]],
        ['an unknown field', [{ expect: 'a', send: 'x', regex: true }]],
      ])('rejects %s', (_name, stdin) => {
        expect(issues({ ...base, level: 1, run: { program: 'a' }, stdin })).not.toEqual([]);
      });

      it('names the parameter a script misses', () => {
        expect(issues(withScript({ stdin: [{ send: '{{params.option}}' }] }))).toEqual([
          'Parameter "password" is marked stdin, but no answer refers to it',
        ]);
      });

      it('rejects a script at level 0', () => {
        expect(issues({ ...levelZero, stdin: [{ send: 'x' }] })).not.toEqual([]);
      });
    });

    it('rejects an output bound to an unknown parameter', () => {
      expect(issues(withParameters([], [{ name: 'a', param: 'missing' }]))).toContainEqual(
        expect.stringContaining('unknown parameter'),
      );
    });
  });
});

describe('isValidIdentifier', () => {
  it.each(['acme.log-parser', 'a', 'tool2', 'console'])('accepts %s', (value) => {
    expect(isValidIdentifier(value)).toBe(true);
  });

  it.each([
    '',
    '..',
    '../evil',
    'a/b',
    'a\\b',
    'A',
    'a.',
    '.a',
    'con',
    'nul.tool',
    'com1',
    'x'.repeat(129),
  ])('rejects %s', (value) => {
    expect(isValidIdentifier(value)).toBe(false);
  });
});

describe('PERMISSIONS', () => {
  it('holds the agreed list', () => {
    expect(PERMISSIONS).toEqual([
      'filesystem.read',
      'filesystem.write',
      'network',
      'process.spawn',
      'system.modify',
      'credentials',
      'hardware',
    ]);
  });
});

describe('published JSON Schema', () => {
  const validate = new Ajv2020({ strict: false }).compile(buildToolManifestJsonSchema());

  it.each([
    ['level 0', levelZero],
    ['level 1', levelOne],
  ])('accepts a %s manifest', (_name, manifest) => {
    expect(validate(manifest)).toBe(true);
  });

  it.each([
    ['a level 2 manifest', levelTwo],
    ['parameters at level 0', { ...levelZero, parameters: [] }],
    ['an unknown permission', { ...levelZero, permissions: ['everything'] }],
    ['an unknown field', { ...levelZero, permisions: [] }],
    ['a reserved id', { ...levelZero, id: 'con' }],
  ])('rejects %s', (_name, manifest) => {
    expect(validate(manifest)).toBe(false);
  });
});
