import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry/tool-registry.js';
import {
  createRegisteredManifest,
  identifierFromName,
  registerPrograms,
  updateToolDetails,
} from './register-program.js';

const program = 'C:\\Tools\\tool.exe';

describe('identifierFromName', () => {
  it.each([
    ['Log Parser', 'log-parser'],
    ['  Café  Tools! ', 'cafe-tools'],
    ['日本語', 'tool'],
    ['---', 'tool'],
    ['con', 'tool-con'],
    ['COM1', 'tool-com1'],
  ])('makes an id from %s', (name, expected) => {
    expect(identifierFromName(name)).toBe(expected);
  });

  it('stays within the id length with a very long name', () => {
    expect(identifierFromName('x'.repeat(500)).length).toBeLessThanOrEqual(100);
  });
});

describe('createRegisteredManifest', () => {
  it('builds a level 0 manifest that keeps what the program leaves running', () => {
    expect(
      createRegisteredManifest({ program, name: ' Tool ', category: ' Utilities ' }, 'tool'),
    ).toMatchObject({
      schemaVersion: 1,
      id: 'tool',
      name: 'Tool',
      version: '0.0.0',
      level: 0,
      category: 'Utilities',
      leftoverProcesses: 'keep',
      run: { program, args: [] },
    });
  });

  it('treats empty text as a field that is not set', () => {
    const manifest = createRegisteredManifest(
      { program, name: 'Tool', category: '  ', description: '', interpreter: '' },
      'tool',
    );

    expect(manifest).not.toHaveProperty('category');
    expect(manifest).not.toHaveProperty('description');
    expect(manifest).not.toHaveProperty('interpreter');
  });
});

describe('registerPrograms', () => {
  let dataDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-register-'));
    registry = await ToolRegistry.open({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('gives programs with the same name different ids', async () => {
    const { registered } = await registerPrograms(registry, [
      { program, name: 'Tool' },
      { program: 'C:\\Other\\tool.exe', name: 'Tool' },
    ]);
    const { registered: later } = await registerPrograms(registry, [{ program, name: 'tool' }]);

    expect(registered.map((tool) => tool.manifest.id)).toEqual(['tool', 'tool-2']);
    expect(later[0]?.manifest.id).toBe('tool-3');
  });

  it('does not reuse the folder of a broken tool', async () => {
    await mkdir(join(dataDir, 'tools', 'tool'), { recursive: true });
    await writeFile(join(dataDir, 'tools', 'tool', 'tool.yaml'), 'not: [valid');

    const { registered } = await registerPrograms(registry, [{ program, name: 'Tool' }]);

    expect(registered[0]?.manifest.id).toBe('tool-2');
  });

  it('reports a bad entry and registers the rest', async () => {
    const { registered, failures } = await registerPrograms(registry, [
      { program, name: '   ' },
      { program, name: 'Good' },
    ]);

    expect(registered.map((tool) => tool.manifest.name)).toEqual(['Good']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.program).toBe(program);
  });
});

describe('updateToolDetails', () => {
  let dataDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-update-'));
    registry = await ToolRegistry.open({ dataDir });
    await registerPrograms(registry, [
      { program, name: 'Tool', category: 'Old', interpreter: 'python' },
    ]);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('changes details, clears emptied fields, and keeps the id and program', async () => {
    await updateToolDetails(registry, 'tool', { name: 'Renamed', category: '' });

    const stored = await registry.get('tool');
    expect(stored?.manifest).toMatchObject({
      id: 'tool',
      name: 'Renamed',
      run: { program },
      leftoverProcesses: 'keep',
    });
    expect(stored?.manifest).not.toHaveProperty('category');
    expect(stored?.manifest).not.toHaveProperty('interpreter');
  });

  it('returns nothing for a tool that is not there', async () => {
    expect(await updateToolDetails(registry, 'missing', { name: 'X' })).toBeUndefined();
  });

  it('refuses an empty name and leaves the tool as it was', async () => {
    await expect(updateToolDetails(registry, 'tool', { name: ' ' })).rejects.toThrow();
    expect((await registry.get('tool'))?.manifest.name).toBe('Tool');
  });
});
