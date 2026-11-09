import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProfiles, saveProfile } from '../profiles/profile-store.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { detectPrograms } from './detect-program.js';
import { importManifests } from './import-manifest.js';

const LEVEL_ONE = `
schemaVersion: 1
id: acme.report
name: Report
version: 1.0.0
level: 1
interpreter: node
permissions: [filesystem.read]
run:
  program: report.mjs
parameters:
  - name: input
    type: path
    label: Input
`;

describe('manifest import', () => {
  let dataDir: string;
  let folder: string;
  let manifest: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-import-data-'));
    folder = await mkdtemp(join(tmpdir(), 'bildora-import-tool-'));
    manifest = join(folder, 'tool.yaml');
    await writeFile(manifest, LEVEL_ONE);
    await writeFile(join(folder, 'report.mjs'), '// sample');
    registry = await ToolRegistry.open({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  it('proposes a manifest with what the user must see before confirming', async () => {
    const { manifests, proposals, refused } = await detectPrograms([manifest]);

    expect(refused).toEqual([]);
    expect(proposals).toEqual([]);
    expect(manifests).toEqual([
      {
        path: manifest,
        id: 'acme.report',
        name: 'Report',
        level: 1,
        interpreter: 'node',
        permissions: ['filesystem.read'],
        alreadyRegistered: false,
      },
    ]);
  });

  it('treats a folder with a manifest as one tool, not as loose scripts', async () => {
    const { manifests, proposals } = await detectPrograms([folder]);

    expect(manifests.map((item) => item.id)).toEqual(['acme.report']);
    expect(proposals).toEqual([]);
  });

  it('finds a manifest in a subfolder, beside other programs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bildora-import-root-'));
    await mkdir(join(root, 'tool'));
    await writeFile(join(root, 'tool', 'tool.yaml'), LEVEL_ONE);
    await writeFile(join(root, 'loose.bat'), '@echo off');

    const { manifests, proposals } = await detectPrograms([root]);

    expect(manifests).toHaveLength(1);
    expect(proposals.map((item) => item.name)).toEqual(['Loose']);
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['broken YAML', 'a: : b', 'Nested mappings'],
    ['an invalid manifest', 'schemaVersion: 1\nid: x', 'level'],
    ['a newer manifest', 'schemaVersion: 99\nid: x', 'Update Bildora'],
    [
      'a level 2 manifest',
      `schemaVersion: 1
id: panel
name: Panel
version: 1.0.0
level: 2
entryPoint:
  panel: index.html
  backend:
    program: backend.py`,
      'no level 2 tools',
    ],
  ])('refuses %s, with the reason', async (_name, text, reason) => {
    await writeFile(manifest, text);

    const { manifests, refused } = await detectPrograms([manifest]);

    expect(manifests).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toContain(reason);
    const { failures } = await importManifests(registry, [manifest]);
    expect(failures).toHaveLength(1);
  });

  it('stores only the manifest, with the program anchored where it is', async () => {
    const { registered, failures } = await importManifests(registry, [manifest]);

    expect(failures).toEqual([]);
    const [tool] = registered;
    expect(tool?.manifest.level).toBe(1);
    if (tool?.manifest.level === 1) {
      expect(tool.manifest.run.program).toBe(join(folder, 'report.mjs'));
    }
    expect(tool?.directory).not.toContain(folder);
  });

  it('leaves a plain name that is not beside the manifest for PATH', async () => {
    await writeFile(manifest, LEVEL_ONE.replace('report.mjs', 'git'));

    const { registered } = await importManifests(registry, [manifest]);

    const [tool] = registered;
    if (tool?.manifest.level === 1) {
      expect(tool.manifest.run.program).toBe('git');
    }
  });

  it('anchors a relative path even if the file is missing, so the warning names it', async () => {
    await writeFile(manifest, LEVEL_ONE.replace('report.mjs', 'bin/missing.exe'));

    const { registered } = await importManifests(registry, [manifest]);

    const [tool] = registered;
    if (tool?.manifest.level === 1) {
      expect(tool.manifest.run.program).toBe(join(folder, 'bin/missing.exe'));
    }
  });

  it('replaces a manifest on import again, and keeps its profiles', async () => {
    const { registered } = await importManifests(registry, [manifest]);
    const store = createMemorySecretStore();
    const [tool] = registered;
    if (tool === undefined) {
      throw new Error('Nothing was imported');
    }
    await saveProfile(tool, { name: 'Kept', values: {} }, store);
    await writeFile(manifest, LEVEL_ONE.replace('name: Report', 'name: Report Two'));

    const again = await detectPrograms([manifest], { registered });
    expect(again.manifests[0]?.alreadyRegistered).toBe(true);
    await importManifests(registry, [manifest]);

    const updated = await registry.get('acme.report');
    expect(updated?.manifest.name).toBe('Report Two');
    if (updated !== undefined) {
      expect((await listProfiles(updated)).map((profile) => profile.name)).toEqual(['Kept']);
    }
  });

  it('refuses a path that is not a manifest, whatever was asked', async () => {
    const { failures } = await importManifests(registry, [join(folder, 'report.mjs')]);

    expect(failures).toHaveLength(1);
  });
});
