import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnv, resolveExecutable } from './resolve-executable.js';

describe('readEnv', () => {
  it('ignores case, as Windows does', () => {
    expect(readEnv({ Path: 'a' }, 'PATH')).toBe('a');
    expect(readEnv({}, 'PATH')).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'win32')('resolveExecutable', () => {
  let root: string;
  let bin: string;
  let tool: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bildora-resolve-'));
    bin = join(root, 'bin');
    tool = join(root, 'tool');
    await mkdir(bin);
    await mkdir(tool);
    await writeFile(join(bin, 'python.exe'), '');
    await writeFile(join(bin, 'build.cmd'), '');
    await writeFile(join(tool, 'parse.py'), '');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = (): Record<string, string> => ({ Path: bin, PATHEXT: '.exe;.cmd' });

  it('finds a name without its extension', async () => {
    expect(await resolveExecutable('python', { env: env() })).toBe(join(bin, 'python.exe'));
    expect(await resolveExecutable('build', { env: env() })).toBe(join(bin, 'build.cmd'));
  });

  it('prefers the runnable file over a bare script of the same name', async () => {
    await writeFile(join(bin, 'build'), '#!/bin/sh');
    expect(await resolveExecutable('build', { env: env() })).toBe(join(bin, 'build.cmd'));
  });

  it('finds a name with its extension', async () => {
    expect(await resolveExecutable('python.exe', { env: env() })).toBe(join(bin, 'python.exe'));
  });

  it('reports a missing program as undefined', async () => {
    expect(await resolveExecutable('ruby', { env: env() })).toBeUndefined();
  });

  it('accepts an absolute path that exists, and only then', async () => {
    const path = join(bin, 'python.exe');
    expect(await resolveExecutable(path, { env: {} })).toBe(path);
    expect(await resolveExecutable(join(bin, 'python'), { env: env() })).toBe(path);
    expect(await resolveExecutable(join(bin, 'nope.exe'), { env: {} })).toBeUndefined();
  });

  it('searches the given folders before PATH', async () => {
    await writeFile(join(tool, 'python.exe'), '');
    const options = { env: env(), searchFirst: [tool] };
    expect(await resolveExecutable('python', options)).toBe(join(tool, 'python.exe'));
  });

  it('finds a file with any extension in the tool folder', async () => {
    const options = { env: env(), searchFirst: [tool] };
    expect(await resolveExecutable('parse.py', options)).toBe(join(tool, 'parse.py'));
  });

  it('resolves a relative path only inside the first search folders', async () => {
    await mkdir(join(tool, 'nested'));
    await writeFile(join(tool, 'nested', 'run.exe'), '');
    const nested = join('nested', 'run.exe');
    expect(await resolveExecutable(nested, { env: env(), searchFirst: [tool] })).toBe(
      join(tool, nested),
    );
    expect(await resolveExecutable(nested, { env: { Path: tool } })).toBeUndefined();
  });

  it('ignores relative PATH entries', async () => {
    const relative = { Path: `.${delimiter}bin`, PATHEXT: '.EXE' };
    expect(await resolveExecutable('python', { env: relative })).toBeUndefined();
  });

  it('does not take a folder for a program', async () => {
    await mkdir(join(bin, 'folder.exe'));
    expect(await resolveExecutable('folder', { env: env() })).toBeUndefined();
  });
});
