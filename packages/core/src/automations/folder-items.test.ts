import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TooManyItemsError, filePattern, folderItems } from './folder-items.js';

describe('filePattern', () => {
  it('matches * and ? on the whole name, whatever the case', () => {
    const pdf = filePattern('*.pdf');
    expect(pdf('Report.PDF')).toBe(true);
    expect(pdf('report.pdf.txt')).toBe(false);
    expect(filePattern('a?.csv')('a1.csv')).toBe(true);
    expect(filePattern('a?.csv')('a12.csv')).toBe(false);
    expect(filePattern('a+b (1).txt')('a+b (1).txt')).toBe(true);
    expect(filePattern(undefined)('anything')).toBe(true);
  });
});

describe('folderItems', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'bildora-items-'));
    await mkdir(join(folder, 'sub'));
    for (const name of ['b.pdf', 'a.pdf', 'c.txt', join('sub', 'd.pdf')]) {
      await writeFile(join(folder, name), '');
    }
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('lists matching files sorted by name, with subfolders only when asked', async () => {
    expect(await folderItems(folder, { pattern: '*.pdf' }, 10)).toEqual([
      join(folder, 'a.pdf'),
      join(folder, 'b.pdf'),
    ]);
    expect(await folderItems(folder, { pattern: '*.pdf', subfolders: true }, 10)).toEqual([
      join(folder, 'a.pdf'),
      join(folder, 'b.pdf'),
      join(folder, 'sub', 'd.pdf'),
    ]);
  });

  it('stops once there are more files than the limit', async () => {
    await expect(folderItems(folder, {}, 2)).rejects.toBeInstanceOf(TooManyItemsError);
  });
});
