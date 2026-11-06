import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRegisteredManifest } from '../import/register-program.js';
import type { ProgramDetails } from '../import/register-program.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import { checkRuntime, groupByCategory, moveCategory, orderGroups } from './tool-status.js';

function toolOf(details: ProgramDetails, id = 'tool', directory = 'C:\\data'): RegisteredTool {
  return { scope: GLOBAL_SCOPE, directory, manifest: createRegisteredManifest(details, id) };
}

describe('checkRuntime', () => {
  let folder: string;
  let program: string;
  const env = { PATH: '', PATHEXT: '.EXE' };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'bildora-status-'));
    program = join(folder, 'tool.py');
    await writeFile(program, '');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('is ready when everything is there', async () => {
    await writeFile(join(folder, 'python.exe'), '');

    const status = await checkRuntime(toolOf({ program, name: 'T', interpreter: 'python' }), {
      env: { ...env, PATH: folder },
    });

    expect(status).toEqual({ status: 'ready' });
  });

  it('names a missing interpreter', async () => {
    const status = await checkRuntime(toolOf({ program, name: 'T', interpreter: 'python' }), {
      env,
    });

    expect(status).toEqual({ status: 'missing-interpreter', interpreter: 'python' });
  });

  it('names a program that has moved, before looking at the interpreter', async () => {
    const gone = join(folder, 'gone.py');

    const status = await checkRuntime(toolOf({ program: gone, name: 'T', interpreter: 'x' }), {
      env,
    });

    expect(status).toEqual({ status: 'missing-program', program: gone });
  });
});

describe('groupByCategory', () => {
  const tool = (name: string, category?: string): RegisteredTool =>
    toolOf({ program: 'C:\\t.exe', name, category }, name.toLowerCase());

  it('has no categories with no tools', () => {
    expect(groupByCategory([])).toEqual([]);
  });

  it('sorts categories and their tools, with uncategorized tools last', () => {
    const groups = groupByCategory([
      tool('Zed'),
      tool('Beta', 'Utilities'),
      tool('Alpha', 'Utilities'),
      tool('Gamma', 'Analysis'),
    ]);

    expect(
      groups.map((group) => [group.category, group.tools.map((item) => item.manifest.name)]),
    ).toEqual([
      ['Analysis', ['Gamma']],
      ['Utilities', ['Alpha', 'Beta']],
      [undefined, ['Zed']],
    ]);
  });

  it('treats names differing only in case as one category', () => {
    const groups = groupByCategory([tool('A', 'Utilities'), tool('B', 'UTILITIES')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe('Utilities');
    expect(groups[0]?.tools).toHaveLength(2);
  });
});

describe('category order', () => {
  const groups = [{ category: 'Alpha' }, { category: 'Beta' }, { category: 'Gamma' }, {}];

  it('follows the chosen order, then the rest, with no category last', () => {
    const ordered = orderGroups(groups, ['gamma']);
    expect(ordered.map((group) => group.category)).toEqual(['Gamma', 'Alpha', 'Beta', undefined]);
  });

  it('moves a category one place, ignoring case', () => {
    expect(moveCategory(groups, [], 'BETA', -1)).toEqual(['beta', 'alpha', 'gamma']);
    expect(moveCategory(groups, ['gamma', 'alpha', 'beta'], 'gamma', 1)).toEqual([
      'alpha',
      'gamma',
      'beta',
    ]);
  });

  it('stays put at either end', () => {
    expect(moveCategory(groups, [], 'Alpha', -1)).toEqual(['alpha', 'beta', 'gamma']);
    expect(moveCategory(groups, [], 'Gamma', 1)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('keeps the place of a category that is not shown now', () => {
    expect(moveCategory(groups, ['gone', 'beta'], 'Alpha', -1)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'gone',
    ]);
  });
});
