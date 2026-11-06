import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolManifestSchema } from '@bildora/protocol';
import type { ToolManifest } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { ToolRegistry } from './tool-registry.js';

const lab: InstallScope = { kind: 'workspace', workspaceId: 'lab' };

function manifest(id: string, name = 'Tool'): ToolManifest {
  return toolManifestSchema.parse({
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    level: 0,
    run: { program: 'C:\\tools\\tool.exe' },
  });
}

describe('ToolRegistry', () => {
  let dataDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-registry-'));
    registry = await ToolRegistry.open({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeBroken(folder: string, content: string): Promise<void> {
    const directory = join(dataDir, 'tools', folder);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'tool.yaml'), content);
  }

  it('registers a tool and stores readable YAML in its folder', async () => {
    const tool = await registry.register(manifest('acme.tool'));

    expect(tool.directory).toBe(join(dataDir, 'tools', 'acme.tool'));
    expect(tool.scope).toEqual(GLOBAL_SCOPE);
    expect(await readFile(join(tool.directory, 'tool.yaml'), 'utf8')).toContain('id: acme.tool');
  });

  it('finds a tool from a registry opened later', async () => {
    await registry.register(manifest('acme.tool'));

    const reopened = await ToolRegistry.open({ dataDir });
    expect((await reopened.get('acme.tool'))?.manifest).toEqual(manifest('acme.tool'));
  });

  it('returns nothing for an unknown tool', async () => {
    expect(await registry.get('acme.missing')).toBeUndefined();
  });

  it('lists an empty registry', async () => {
    expect(await registry.list()).toEqual({ tools: [], problems: [] });
  });

  it('lists tools sorted by id', async () => {
    await registry.register(manifest('b.tool'));
    await registry.register(manifest('a.tool'));

    const { tools } = await registry.list();
    expect(tools.map((tool) => tool.manifest.id)).toEqual(['a.tool', 'b.tool']);
  });

  it('refuses to overwrite a tool unless asked to', async () => {
    await registry.register(manifest('acme.tool', 'First'));

    await expect(registry.register(manifest('acme.tool', 'Second'))).rejects.toThrow(
      /already registered/,
    );
    await registry.register(manifest('acme.tool', 'Second'), { replace: true });
    expect((await registry.get('acme.tool'))?.manifest.name).toBe('Second');
  });

  it('refuses an invalid manifest and writes nothing', async () => {
    const invalid = { ...manifest('acme.tool'), version: 'one' };

    await expect(registry.register(invalid)).rejects.toThrow(DefinitionError);
    expect(await registry.list()).toEqual({ tools: [], problems: [] });
  });

  it.each(['../evil', '..', 'a\\b'])('refuses id %s before touching the disk', async (id) => {
    await expect(registry.get(id)).rejects.toThrow(DefinitionError);
    await expect(registry.remove(id)).rejects.toThrow(DefinitionError);
    await expect(registry.register({ ...manifest('acme.tool'), id })).rejects.toThrow(
      DefinitionError,
    );
  });

  describe('install scope', () => {
    it('keeps the same id separately per scope', async () => {
      await registry.register(manifest('acme.tool', 'Global'));
      await registry.register(manifest('acme.tool', 'Lab'), { scope: lab });

      expect((await registry.get('acme.tool'))?.manifest.name).toBe('Global');
      expect((await registry.get('acme.tool', lab))?.manifest.name).toBe('Lab');
    });

    it('lists only the requested scope', async () => {
      await registry.register(manifest('global.tool'));
      await registry.register(manifest('lab.tool'), { scope: lab });

      const { tools } = await registry.list(lab);
      expect(tools.map((tool) => tool.manifest.id)).toEqual(['lab.tool']);
      expect(tools[0]?.scope).toEqual(lab);
    });

    it('removes from one scope only', async () => {
      await registry.register(manifest('acme.tool'));
      await registry.register(manifest('acme.tool'), { scope: lab });

      await registry.remove('acme.tool', lab);
      expect(await registry.get('acme.tool')).toBeDefined();
      expect(await registry.get('acme.tool', lab)).toBeUndefined();
    });
  });

  it('removes a tool and reports whether it existed', async () => {
    await registry.register(manifest('acme.tool'));

    expect(await registry.remove('acme.tool')).toBe(true);
    expect(await registry.remove('acme.tool')).toBe(false);
    expect((await registry.list()).tools).toEqual([]);
  });

  describe('broken content', () => {
    it('reports a broken manifest without hiding healthy tools', async () => {
      await registry.register(manifest('good.tool'));
      await writeBroken('bad.tool', 'id: [');

      const { tools, problems } = await registry.list();
      expect(tools.map((tool) => tool.manifest.id)).toEqual(['good.tool']);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ folder: 'bad.tool', scope: GLOBAL_SCOPE });
      expect(problems[0]?.message).toContain('YAML');
    });

    it('reports a manifest from a newer build', async () => {
      await writeBroken('new.tool', 'schemaVersion: 99\nid: new.tool\n');

      const { problems } = await registry.list();
      expect(problems[0]?.message).toMatch(/Update Bildora/);
    });

    it('reports a folder with no manifest', async () => {
      await mkdir(join(dataDir, 'tools', 'empty.tool'), { recursive: true });

      expect((await registry.list()).problems[0]?.folder).toBe('empty.tool');
    });

    it('reports a folder whose name cannot be an id', async () => {
      await mkdir(join(dataDir, 'tools', 'Bad Name'), { recursive: true });

      expect((await registry.list()).problems[0]?.folder).toBe('Bad Name');
    });

    it('reports a manifest stored under another id', async () => {
      await registry.register(manifest('real.tool'));
      await writeBroken(
        'other.tool',
        await readFile(join(dataDir, 'tools', 'real.tool', 'tool.yaml'), 'utf8'),
      );

      expect((await registry.list()).problems[0]?.message).toMatch(/real\.tool/);
    });

    it('throws the reason from get', async () => {
      await writeBroken('bad.tool', 'id: [');

      await expect(registry.get('bad.tool')).rejects.toThrow(DefinitionError);
    });

    it('can remove a broken tool', async () => {
      await writeBroken('bad.tool', 'id: [');

      expect(await registry.remove('bad.tool')).toBe(true);
      expect((await registry.list()).problems).toEqual([]);
    });
  });
});
