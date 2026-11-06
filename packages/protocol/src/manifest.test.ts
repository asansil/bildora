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
  it.each([
    ['level 0', levelZero],
    ['level 1', levelOne],
    ['level 2', levelTwo],
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
    ['level 2 without an entry point', { ...base, level: 2 }],
    [
      'a panel outside the tool folder',
      { ...levelTwo, entryPoint: { ...levelTwo.entryPoint, panel: '../panel.html' } },
    ],
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

  it.each([
    ['nested/panel.html', true],
    ['a..b/panel.html', true],
    ['..\\panel.html', false],
    ['a/../../panel.html', false],
    ['/panel.html', false],
    ['C:\\panel.html', false],
  ])('treats panel path %s as contained: %s', (panel, contained) => {
    const manifest = { ...levelTwo, entryPoint: { ...levelTwo.entryPoint, panel } };
    expect(issues(manifest).length === 0).toBe(contained);
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
    ['level 2', levelTwo],
  ])('accepts a %s manifest', (_name, manifest) => {
    expect(validate(manifest)).toBe(true);
  });

  it.each([
    ['level 2 without an entry point', { ...base, level: 2 }],
    ['parameters at level 0', { ...levelZero, parameters: [] }],
    ['an unknown permission', { ...levelZero, permissions: ['everything'] }],
    ['an unknown field', { ...levelZero, permisions: [] }],
    ['a reserved id', { ...levelZero, id: 'con' }],
  ])('rejects %s', (_name, manifest) => {
    expect(validate(manifest)).toBe(false);
  });
});
