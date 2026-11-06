import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, toolManifestSchema } from '@bildora/protocol';
import type { ToolManifest } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPrograms } from '../import/register-program.js';
import { profileSecretKey, removeProfile, saveProfile } from '../profiles/profile-store.js';
import { ToolRegistry, toolKey } from '../registry/tool-registry.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import { writePreferences } from '../storage/preferences.js';
import { moveTool } from '../tools/move-tool.js';
import { findVisibleTool, listVisibleTools, workspaceScope } from './visible-tools.js';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  openWorkspaces,
  updateWorkspace,
} from './workspace-store.js';

function manifest(id: string, name = id): ToolManifest {
  return toolManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    name,
    version: '1.0.0',
    level: 1,
    run: { program: 'C:\\tool.exe' },
    parameters: [{ name: 'token', label: 'Token', type: 'string', secret: true, flag: '--token' }],
  });
}

const WORK = workspaceScope('work');
const HOME = workspaceScope('home');

describe('Workspaces', () => {
  let dataDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-workspaces-'));
    registry = await ToolRegistry.open({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('store', () => {
    it('starts with a Default Workspace that takes the theme chosen before', async () => {
      await writePreferences(dataDir, { theme: 'dark' });
      const { workspaces } = await openWorkspaces(dataDir);
      expect(workspaces).toMatchObject([{ id: 'default', name: 'Default', theme: 'dark' }]);
      expect((await openWorkspaces(dataDir)).workspaces).toHaveLength(1);
    });

    it('creates, renames and updates, with sorted names', async () => {
      await createWorkspace(dataDir, 'Work', 'light');
      const lab = await createWorkspace(dataDir, ' Lab ', 'dark');
      expect(lab).toMatchObject({ id: 'lab', name: 'Lab', theme: 'dark', favorites: [] });

      await updateWorkspace(dataDir, 'lab', { name: 'Zoo', favorites: ['a'] });
      const { workspaces } = await listWorkspaces(dataDir);
      expect(workspaces.map(({ name }) => name)).toEqual(['Work', 'Zoo']);
      expect(await getWorkspace(dataDir, 'lab')).toMatchObject({ favorites: ['a'] });
    });

    it('refuses an empty or repeated name, ignoring case', async () => {
      await createWorkspace(dataDir, 'Work', 'light');
      await expect(createWorkspace(dataDir, '  ', 'light')).rejects.toThrow();
      await expect(createWorkspace(dataDir, 'WORK', 'light')).rejects.toThrow('already exists');
      const other = await createWorkspace(dataDir, 'Other', 'light');
      await expect(updateWorkspace(dataDir, other.id, { name: 'work' })).rejects.toThrow();
      await expect(updateWorkspace(dataDir, 'work', { name: 'WORK' })).resolves.toMatchObject({
        name: 'WORK',
      });
    });

    it('merges layout changes, and null clears a field', async () => {
      await createWorkspace(dataDir, 'Work', 'light');
      await updateWorkspace(dataDir, 'work', {
        layout: { selectedTool: 'a', openCategory: 'x', panelWidth: 300 },
      });
      const updated = await updateWorkspace(dataDir, 'work', {
        layout: { selectedTool: null, categoryOrder: ['x'] },
      });
      expect(updated.layout).toEqual({ categoryOrder: ['x'], panelWidth: 300, openCategory: 'x' });
    });

    it('drops a stored panel width out of limits', async () => {
      await createWorkspace(dataDir, 'Work', 'light');
      const file = join(dataDir, 'workspaces', 'work', 'workspace.yaml');
      await writeFile(file, 'formatVersion: 1\nname: Work\nlayout:\n  panelWidth: 9000\n');
      expect((await getWorkspace(dataDir, 'work'))?.layout).toEqual({ categoryOrder: [] });
    });

    it('reports a damaged Workspace, hides nothing and never takes its folder', async () => {
      const file = join(dataDir, 'workspaces', 'default', 'workspace.yaml');
      await mkdir(join(dataDir, 'workspaces', 'default'), { recursive: true });
      await writeFile(file, ': : :\n- x');

      const { workspaces, problems } = await openWorkspaces(dataDir);
      expect(workspaces).toMatchObject([{ id: 'default-2', name: 'Default' }]);
      expect(problems).toMatchObject([{ folder: 'default' }]);
      expect(await readFile(file, 'utf8')).toBe(': : :\n- x');
    });

    it('refuses to rewrite a Workspace from a newer build', async () => {
      await createWorkspace(dataDir, 'Work', 'light');
      const file = join(dataDir, 'workspaces', 'work', 'workspace.yaml');
      await writeFile(file, 'formatVersion: 99\nname: Work\n');
      await expect(updateWorkspace(dataDir, 'work', { theme: 'dark' })).rejects.toThrow('99');
      expect(await readFile(file, 'utf8')).toBe('formatVersion: 99\nname: Work\n');
      expect((await listWorkspaces(dataDir)).problems).toHaveLength(1);
    });
  });

  describe('visibility', () => {
    it('shows global tools everywhere, and a Workspace tool only in its Workspace', async () => {
      await registry.register(manifest('shared'));
      await registry.register(manifest('mine'), { scope: WORK });

      const work = await listVisibleTools(registry, 'work');
      const home = await listVisibleTools(registry, 'home');
      expect(work.tools.map((tool) => tool.manifest.id).sort()).toEqual(['mine', 'shared']);
      expect(home.tools.map((tool) => tool.manifest.id)).toEqual(['shared']);
      expect(await findVisibleTool(registry, 'home', 'mine')).toBeUndefined();
    });

    it('lets a Workspace tool hide a global one with its id', async () => {
      await registry.register(manifest('tool', 'Global'));
      await registry.register(manifest('tool', 'Own'), { scope: WORK });

      const { tools } = await listVisibleTools(registry, 'work');
      expect(tools.map((tool) => tool.manifest.name)).toEqual(['Own']);
      expect((await findVisibleTool(registry, 'work', 'tool'))?.manifest.name).toBe('Own');
      expect((await findVisibleTool(registry, 'home', 'tool'))?.manifest.name).toBe('Global');
    });

    it('agrees with a lookup when the Workspace tool is damaged', async () => {
      await registry.register(manifest('tool'));
      const { directory } = await registry.register(manifest('tool'), { scope: WORK });
      await writeFile(join(directory, 'tool.yaml'), 'nonsense');

      const { tools, problems } = await listVisibleTools(registry, 'work');
      expect(tools).toEqual([]);
      expect(problems).toMatchObject([{ folder: 'tool', scope: WORK }]);
      await expect(findVisibleTool(registry, 'work', 'tool')).rejects.toThrow();
    });

    it('gives tools with one id different keys in each scope', async () => {
      const global = await registry.register(manifest('tool'));
      const own = await registry.register(manifest('tool'), { scope: WORK });
      expect(toolKey(global)).not.toBe(toolKey(own));
    });

    it('avoids the ids a Workspace can see when registering', async () => {
      await registry.register(manifest('tool'));
      const { registered } = await registerPrograms(
        registry,
        [{ name: 'Tool', program: 'C:\\tool.exe' }],
        WORK,
      );
      expect(registered[0]).toMatchObject({ manifest: { id: 'tool-2' }, scope: WORK });
    });
  });

  describe('secrets', () => {
    it('keeps the keys of global tools, which already hold secrets', async () => {
      const tool = await registry.register(manifest('tool'));
      expect(profileSecretKey(tool, 'main', 'token')).toBe('tool/main/token');
    });

    it('keeps the secrets of two Workspaces apart when a tool has one id', async () => {
      const store = createMemorySecretStore();
      const work = await registry.register(manifest('tool'), { scope: WORK });
      const home = await registry.register(manifest('tool'), { scope: HOME });
      const input = { name: 'Main', values: {} };
      await saveProfile(work, { ...input, secrets: { token: 'for-work' } }, store);
      await saveProfile(home, { ...input, secrets: { token: 'for-home' } }, store);

      expect(await store.get(profileSecretKey(work, 'main', 'token'))).toBe('for-work');
      expect(await store.get(profileSecretKey(home, 'main', 'token'))).toBe('for-home');

      await removeProfile(work, 'main', store);
      expect(await store.get(profileSecretKey(home, 'main', 'token'))).toBe('for-home');
    });
  });

  describe('moving a tool', () => {
    it('takes its profiles and secrets along', async () => {
      const store = createMemorySecretStore();
      const tool = await registry.register(manifest('tool'));
      await saveProfile(tool, { name: 'Main', values: {}, secrets: { token: 'value' } }, store);

      const moved = await moveTool(registry, 'tool', GLOBAL_SCOPE, WORK, store);

      expect(moved.scope).toEqual(WORK);
      expect(await registry.get('tool')).toBeUndefined();
      expect(await stat(join(moved.directory, 'profiles', 'main.yaml'))).toBeDefined();
      expect(await store.get(profileSecretKey(moved, 'main', 'token'))).toBe('value');
      expect(await store.get(profileSecretKey(tool, 'main', 'token'))).toBeUndefined();
    });

    it('refuses when the target already holds that id', async () => {
      const store = createMemorySecretStore();
      await registry.register(manifest('tool'));
      await registry.register(manifest('tool'), { scope: WORK });
      await expect(moveTool(registry, 'tool', GLOBAL_SCOPE, WORK, store)).rejects.toThrow(
        'already installed',
      );
      expect(await registry.get('tool')).toBeDefined();
    });

    it('leaves everything in place when a secret cannot be copied', async () => {
      const memory = createMemorySecretStore();
      const tool = await registry.register(manifest('tool'));
      await saveProfile(tool, { name: 'A', values: {}, secrets: { token: 'one' } }, memory);
      await saveProfile(tool, { name: 'B', values: {}, secrets: { token: 'two' } }, memory);
      const failing: SecretStore = {
        ...memory,
        set: (key, value) =>
          key.includes('/b/') ? Promise.reject(new Error('locked')) : memory.set(key, value),
      };

      await expect(moveTool(registry, 'tool', GLOBAL_SCOPE, WORK, failing)).rejects.toThrow(
        'locked',
      );

      expect(await registry.get('tool')).toBeDefined();
      expect(await registry.get('tool', WORK)).toBeUndefined();
      expect(await memory.get(profileSecretKey(tool, 'a', 'token'))).toBe('one');
      const copy = { ...tool, scope: WORK };
      expect(await memory.get(profileSecretKey(copy, 'a', 'token'))).toBeUndefined();
    });
  });
});
