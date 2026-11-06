import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefinitionError } from './definition-error.js';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from './preferences.js';

describe('preferences', () => {
  let dataDir: string;
  let file: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-preferences-'));
    file = join(dataDir, 'preferences.json');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('starts from the defaults', async () => {
    expect(await readPreferences(dataDir)).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads back what was written, with a format version on disk', async () => {
    await writePreferences(dataDir, { theme: 'dark' });

    expect(await readPreferences(dataDir)).toEqual({ ...DEFAULT_PREFERENCES, theme: 'dark' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ formatVersion: 1 });
  });

  it.each([
    ['damaged JSON', '{ nope'],
    ['a value that is not an object', '[]'],
    ['no format version', '{"theme":"dark"}'],
    ['an unknown theme', '{"formatVersion":1,"theme":"pink"}'],
  ])('falls back to the defaults with %s', async (_label, text) => {
    await writeFile(file, text);

    expect(await readPreferences(dataDir)).toEqual(DEFAULT_PREFERENCES);
  });

  it('refuses a file from a newer build, and leaves it untouched', async () => {
    const newer = '{"formatVersion":99,"theme":"dark"}';
    await writeFile(file, newer);

    await expect(readPreferences(dataDir)).rejects.toThrow(DefinitionError);
    await expect(writePreferences(dataDir, { theme: 'light' })).rejects.toThrow(DefinitionError);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
