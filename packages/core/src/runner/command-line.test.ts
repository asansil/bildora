import { toolManifestSchema } from '@bildora/protocol';
import type { ToolParameter } from '@bildora/protocol';
import { describe, expect, it } from 'vitest';
import {
  ParameterError,
  batchCommandLine,
  isBatchFile,
  programCommandLine,
  quoteForCmd,
  quoteForProgram,
  renderArguments,
  renderEnvironment,
  renderScript,
} from './command-line.js';

function parametersOf(parameters: unknown[]): ToolParameter[] {
  const manifest = toolManifestSchema.parse({
    schemaVersion: 1,
    id: 'a.tool',
    name: 'Tool',
    version: '1.0.0',
    level: 1,
    run: { program: 'a' },
    parameters,
  });
  return manifest.level === 1 ? manifest.parameters : [];
}

describe('renderArguments', () => {
  const parameters = parametersOf([
    { name: 'input', type: 'path', label: 'I', required: true },
    { name: 'output', type: 'path', label: 'O', flag: '--out' },
    { name: 'count', type: 'integer', label: 'C', flag: '-n', default: 3 },
    { name: 'ratio', type: 'number', label: 'R', flag: '-r' },
    { name: 'verbose', type: 'boolean', label: 'V', flag: '-v' },
    { name: 'mode', type: 'choice', label: 'M', flag: '--mode', choices: ['fast', 'full'] },
  ]);

  it('renders flags, positionals and defaults in declared order', () => {
    expect(
      renderArguments(parameters, { input: 'a.txt', output: 'b.txt', verbose: true, ratio: 0.5 }),
    ).toEqual(['a.txt', '--out', 'b.txt', '-n', '3', '-r', '0.5', '-v']);
  });

  it('drops an unset optional and a false boolean, with their flags', () => {
    expect(renderArguments(parameters, { input: 'a', verbose: false, count: 1 })).toEqual([
      'a',
      '-n',
      '1',
    ]);
  });

  it('lets an explicit value override the default', () => {
    expect(renderArguments(parameters, { input: 'a', count: 9 })).toContain('9');
  });

  it('keeps an empty string as a value', () => {
    expect(renderArguments(parameters, { input: '' })[0]).toBe('');
  });

  it.each([
    ['a missing required parameter', {}, /"input" is required/],
    ['an unknown parameter', { input: 'a', extra: 1 }, /Unknown parameter "extra"/],
    ['text for a whole number', { input: 'a', count: '3' }, /"count" must be a whole number/],
    ['a fraction for a whole number', { input: 'a', count: 1.5 }, /"count" must be a whole/],
    ['infinity for a number', { input: 'a', ratio: Infinity }, /"ratio" must be a number/],
    ['a number for a boolean', { input: 'a', verbose: 1 }, /"verbose" must be true or false/],
    ['a value outside the choices', { input: 'a', mode: 'x' }, /"mode" must be one of/],
    ['a number for a path', { input: 1 }, /"input" must be text/],
  ])('rejects %s', (_name, values, message) => {
    expect(() => renderArguments(parameters, values)).toThrow(message);
  });

  it('does not read inherited object properties as values', () => {
    const named = parametersOf([{ name: 'toString', type: 'string', label: 'T' }]);
    expect(renderArguments(named, {})).toEqual([]);
  });

  it('never repeats a rejected value in its error', () => {
    const secret = parametersOf([{ name: 'token', type: 'integer', label: 'T' }]);
    let message = '';
    try {
      renderArguments(secret, { token: 'hunter2' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });
});

describe('console scripts', () => {
  const manifest = toolManifestSchema.parse({
    schemaVersion: 1,
    id: 'a.tool',
    name: 'Tool',
    version: '1.0.0',
    level: 1,
    run: { program: 'a' },
    parameters: [
      { name: 'option', type: 'choice', label: 'O', choices: ['1', '2'], stdin: true },
      { name: 'count', type: 'integer', label: 'C', stdin: true, required: true },
      { name: 'note', type: 'string', label: 'N', stdin: true },
      { name: 'out', type: 'path', label: 'Out', flag: '--out' },
    ],
    stdin: [
      { expect: 'Option:', send: '{{params.option}}' },
      { expect: 'Count:', send: '{{params.count}} x{{params.count}}', timeout: 5 },
      { send: '{{params.note}}' },
    ],
  });
  const parameters = manifest.level === 1 ? manifest.parameters : [];
  const script = manifest.level === 1 ? (manifest.stdin ?? []) : [];

  it('keeps stdin parameters out of the arguments and the environment', () => {
    const values = { option: '2', count: 3, note: 'n', out: 'x' };
    expect(renderArguments(parameters, values)).toEqual(['--out', 'x']);
    expect(renderEnvironment(parameters, values)).toEqual({});
  });

  it('does not ask for a required stdin parameter when building arguments', () => {
    expect(renderArguments(parameters, {})).toEqual([]);
  });

  it('fills the answers, with an empty line for an unset optional', () => {
    expect(renderScript(parameters, script, { option: '1', count: 7 })).toEqual([
      { expect: 'Option:', send: '1', timeout: undefined },
      { expect: 'Count:', send: '7 x7', timeout: 5 },
      { expect: undefined, send: '', timeout: undefined },
    ]);
  });

  it.each([
    ['a missing required answer', { option: '1' }, /"count" is required/],
    ['a value outside the choices', { option: '3', count: 1 }, /"option" must be one of/],
  ])('rejects %s', (_name, values, message) => {
    expect(() => renderScript(parameters, script, values)).toThrow(message);
  });
});

describe('quoteForProgram', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['a b', '"a b"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', 'a\\b'],
    ['a b\\', '"a b\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['C:\\Program Files\\x', '"C:\\Program Files\\x"'],
  ])('quotes %j', (value, expected) => {
    expect(quoteForProgram(value)).toBe(expected);
  });

  it('refuses a NUL', () => {
    expect(() => quoteForProgram('a\0b')).toThrow(ParameterError);
  });
});

describe('quoteForCmd', () => {
  it.each([
    ['plain', '"plain"'],
    ['', '""'],
    ['a&b|c^d<e>f(g)', '"a&b|c^d<e>f(g)"'],
    ['a"b', '"a""b"'],
    ['"&calc&"', '"""&calc&"""'],
    ['%PATH%', '"%%cd:~,%PATH%%cd:~,%"'],
    ['!VAR!', '"!VAR!"'],
  ])('quotes %j', (value, expected) => {
    expect(quoteForCmd(value)).toBe(expected);
  });

  it.each(['a\nb', 'a\rb', 'a\0b'])('refuses %j', (value) => {
    expect(() => quoteForCmd(value)).toThrow(ParameterError);
  });
});

describe('command lines', () => {
  it('builds one for an ordinary program', () => {
    expect(programCommandLine('C:\\a b\\t.exe', ['x', 'y z'])).toBe('"C:\\a b\\t.exe" x "y z"');
  });

  it('builds one for a batch file', () => {
    expect(batchCommandLine('C:\\Windows\\cmd.exe', 'C:\\a b\\t.bat', ['x&y'])).toBe(
      'C:\\Windows\\cmd.exe /d /s /e:on /v:off /c ""C:\\a b\\t.bat" "x&y""',
    );
  });

  it.each([
    ['a.bat', true],
    ['A.CMD', true],
    ['a.exe', false],
    ['bat', false],
  ])('recognizes %s as batch: %s', (path, batch) => {
    expect(isBatchFile(path)).toBe(batch);
  });
});
