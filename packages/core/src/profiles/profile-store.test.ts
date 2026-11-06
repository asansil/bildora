import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, toolManifestSchema } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry/tool-registry.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { resolveRunValues } from '../runner/resolve-values.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { removeTool } from '../tools/remove-tool.js';
import { getProfile, listProfiles, removeProfile, saveProfile } from './profile-store.js';

const SECRET = 'do-not-write-me';

describe('profiles', () => {
  let dataDir: string;
  let registry: ToolRegistry;
  let tool: RegisteredTool;
  let store: ReturnType<typeof createMemorySecretStore>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-profiles-'));
    registry = await ToolRegistry.open({ dataDir });
    store = createMemorySecretStore();
    tool = await registry.register(
      toolManifestSchema.parse({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id: 'sample',
        name: 'Sample',
        version: '1.0.0',
        level: 1,
        run: { program: 'sample.exe' },
        parameters: [
          { name: 'input', type: 'path', label: 'Input', default: 'a.txt' },
          { name: 'count', type: 'integer', label: 'Count' },
          { name: 'token', type: 'string', label: 'Token', secret: true },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function fileOf(id: string): string {
    return join(tool.directory, 'profiles', `${id}.yaml`);
  }

  it('saves values to a readable file, and the secret only to the store', async () => {
    const profile = await saveProfile(
      tool,
      { name: 'Night Run', values: { input: 'b.txt', count: 3 }, secrets: { token: SECRET } },
      store,
    );

    expect(profile).toMatchObject({ id: 'night-run', secrets: ['token'] });
    const text = await readFile(fileOf(profile.id), 'utf8');
    expect(text).toContain('b.txt');
    expect(text).toContain('formatVersion: 1');
    expect(text).not.toContain(SECRET);
    expect(await listProfiles(tool)).toEqual([profile]);
    expect(await getProfile(tool, profile.id)).toEqual(profile);
  });

  it('keeps a secret out of the file even when sent as a plain value', async () => {
    const profile = await saveProfile(
      tool,
      { name: 'Careless', values: { token: SECRET, unknown: SECRET } },
      store,
    );

    expect(await readFile(fileOf(profile.id), 'utf8')).not.toContain(SECRET);
    expect(profile.secrets).toEqual([]);
  });

  it('gives two profiles with one name different ids', async () => {
    await saveProfile(tool, { name: 'Same', values: {} }, store);
    const second = await saveProfile(tool, { name: 'Same', values: {} }, store);

    expect(second.id).toBe('same-2');
  });

  it('keeps a secret left out of an update, and clears one set to null', async () => {
    const { id } = await saveProfile(
      tool,
      { name: 'P', values: {}, secrets: { token: SECRET } },
      store,
    );

    const kept = await saveProfile(tool, { id, name: 'P', values: { count: 1 } }, store);
    expect(kept.secrets).toEqual(['token']);
    expect(await store.get(`sample/${id}/token`)).toBe(SECRET);

    const cleared = await saveProfile(
      tool,
      { id, name: 'P', values: {}, secrets: { token: null } },
      store,
    );
    expect(cleared.secrets).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('refuses to update a profile that does not exist', async () => {
    await expect(saveProfile(tool, { id: 'nope', name: 'P', values: {} }, store)).rejects.toThrow(
      'does not exist',
    );
  });

  it('refuses an id that could leave the profiles folder', async () => {
    await expect(getProfile(tool, '..\\..\\tool')).rejects.toThrow('not valid');
  });

  it('passes over a damaged file', async () => {
    await saveProfile(tool, { name: 'Good', values: {} }, store);
    await writeFile(fileOf('broken'), ': : not yaml {');

    expect((await listProfiles(tool)).map((profile) => profile.name)).toEqual(['Good']);
  });

  it('removing a profile removes its secrets', async () => {
    const { id } = await saveProfile(
      tool,
      { name: 'P', values: {}, secrets: { token: 'x'.repeat(3000) } },
      store,
    );

    await removeProfile(tool, id, store);

    expect(store.size()).toBe(0);
    expect(await listProfiles(tool)).toEqual([]);
  });

  it('removing a tool removes its profiles and their secrets', async () => {
    await saveProfile(tool, { name: 'P', values: {}, secrets: { token: SECRET } }, store);

    expect(await removeTool(registry, 'sample', store)).toBe(true);

    expect(store.size()).toBe(0);
    expect(await registry.get('sample')).toBeUndefined();
  });

  describe('resolveRunValues', () => {
    it('prefers the form, then the profile, then the default', async () => {
      const profile = await saveProfile(
        tool,
        { name: 'P', values: { count: 5 }, secrets: { token: SECRET } },
        store,
      );

      const resolved = await resolveRunValues(tool, { profile, values: { count: 9 }, store });

      expect(resolved.values).toEqual({ count: 9, token: SECRET });
      expect(resolved.secrets).toEqual([SECRET]);
      expect(resolved.recorded).toEqual([
        { name: 'input', label: 'Input', value: 'a.txt' },
        { name: 'count', label: 'Count', value: 9 },
        { name: 'token', label: 'Token', secret: true },
      ]);
    });

    it('drops profile values a newer manifest no longer declares', async () => {
      const resolved = await resolveRunValues(tool, {
        profile: { id: 'p', name: 'P', values: { removed: 'x', count: 2 }, secrets: [] },
        store,
      });

      expect(resolved.values).toEqual({ count: 2 });
    });
  });
});
