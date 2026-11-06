import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_FORMAT_VERSION,
  GLOBAL_SCOPE,
  openDataDirectory,
  resolveDataDir,
  toolDirectory,
  writeFileAtomic,
} from './data-directory.js';
import { DefinitionError } from './definition-error.js';

describe('resolveDataDir', () => {
  it('prefers an explicit directory', () => {
    const env = { BILDORA_DATA_DIR: 'from-env' };
    expect(resolveDataDir({ dataDir: 'explicit', env })).toBe(resolve('explicit'));
  });

  it('then uses BILDORA_DATA_DIR', () => {
    const env = { BILDORA_DATA_DIR: 'from-env', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' };
    expect(resolveDataDir({ env, platform: 'win32' })).toBe(resolve('from-env'));
  });

  it('defaults to APPDATA on Windows', () => {
    const env = { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' };
    expect(resolveDataDir({ env, platform: 'win32' })).toBe(join(env.APPDATA, 'Bildora'));
  });

  it('defaults to XDG_DATA_HOME, then HOME, elsewhere', () => {
    expect(resolveDataDir({ env: { XDG_DATA_HOME: 'x', HOME: 'h' }, platform: 'linux' })).toBe(
      join('x', 'bildora'),
    );
    expect(resolveDataDir({ env: { HOME: 'h' }, platform: 'linux' })).toBe(
      join('h', '.local', 'share', 'bildora'),
    );
  });

  it('fails clearly when no location can be derived', () => {
    expect(() => resolveDataDir({ env: {}, platform: 'win32' })).toThrow(/APPDATA/);
    expect(() => resolveDataDir({ env: {}, platform: 'linux' })).toThrow(/HOME/);
  });
});

describe('toolDirectory', () => {
  it.each(['..', '../evil', 'a\\b', 'con'])('refuses tool id %s', (id) => {
    expect(() => toolDirectory('data', GLOBAL_SCOPE, id)).toThrow(DefinitionError);
  });

  it('refuses a Workspace id that would leave the data directory', () => {
    const scope = { kind: 'workspace', workspaceId: '../..' } as const;
    expect(() => toolDirectory('data', scope, 'tool')).toThrow(DefinitionError);
  });

  it('keeps scopes in separate folders', () => {
    const scope = { kind: 'workspace', workspaceId: 'lab' } as const;
    expect(toolDirectory('data', GLOBAL_SCOPE, 'tool')).toBe(join('data', 'tools', 'tool'));
    expect(toolDirectory('data', scope, 'tool')).toBe(
      join('data', 'workspaces', 'lab', 'tools', 'tool'),
    );
  });
});

describe('on disk', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bildora-data-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('openDataDirectory', () => {
    const formatFile = (): string => join(directory, 'format.json');

    it('creates the directory and records its format', async () => {
      const dataDir = join(directory, 'nested', 'data');
      await openDataDirectory(dataDir);
      const content: unknown = JSON.parse(await readFile(join(dataDir, 'format.json'), 'utf8'));
      expect(content).toEqual({ formatVersion: DATA_FORMAT_VERSION });
    });

    it('opens an existing directory', async () => {
      await openDataDirectory(directory);
      await expect(openDataDirectory(directory)).resolves.toBeUndefined();
    });

    it('refuses a directory from a newer build and leaves it alone', async () => {
      const newer = JSON.stringify({ formatVersion: DATA_FORMAT_VERSION + 1 });
      await writeFile(formatFile(), newer);
      await expect(openDataDirectory(directory)).rejects.toThrow(/Update Bildora/);
      expect(await readFile(formatFile(), 'utf8')).toBe(newer);
    });

    it('refuses a damaged format file', async () => {
      await writeFile(formatFile(), '{');
      await expect(openDataDirectory(directory)).rejects.toThrow(DefinitionError);
    });
  });

  describe('writeFileAtomic', () => {
    it('replaces the content and leaves no temporary file', async () => {
      const file = join(directory, 'a.txt');
      await writeFile(file, 'old');
      await writeFileAtomic(file, 'new');
      expect(await readFile(file, 'utf8')).toBe('new');
      expect(await readdir(directory)).toEqual(['a.txt']);
    });

    it('keeps the old content and cleans up when the write cannot finish', async () => {
      const target = join(directory, 'folder');
      await writeFileAtomic(join(directory, 'keep.txt'), 'kept');
      await expect(writeFileAtomic(join(target, 'a.txt'), 'new')).rejects.toThrow();
      expect(await readdir(directory)).toEqual(['keep.txt']);
    });
  });
});
