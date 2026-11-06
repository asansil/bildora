import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, toolManifestSchema } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPrograms } from '../import/detect-program.js';
import { importManifests } from '../import/import-manifest.js';
import { updateToolDetails } from '../import/register-program.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import {
  readPathVariables,
  removePathVariable,
  setPathVariable,
} from '../storage/path-variables.js';
import { checkRuntime } from '../tools/tool-status.js';
import { expandPath, expandToolCommand } from './expand-paths.js';
import { resolveRunValues } from './resolve-values.js';

const VARIABLES = new Map([['data', 'D:\\data']]);

function toolOf(program: string, args: readonly string[] = []): RegisteredTool {
  return {
    scope: GLOBAL_SCOPE,
    directory: 'C:\\unused',
    manifest: toolManifestSchema.parse({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id: 'tool',
      name: 'Tool',
      version: '1.0.0',
      level: 1,
      run: { program, args },
      parameters: [
        { name: 'input', label: 'In', type: 'path', flag: '--in' },
        { name: 'fallback', label: 'F', type: 'path', flag: '--f', default: '{{paths.data}}\\f' },
        { name: 'note', label: 'Note', type: 'string', flag: '--note' },
      ],
    }),
  };
}

describe('path variables', () => {
  it('expands every reference and leaves other text', () => {
    expect(expandPath('{{paths.data}}\\a\\{{paths.data}}', VARIABLES)).toBe(
      'D:\\data\\a\\D:\\data',
    );
    expect(expandPath('C:\\plain {{other}}', VARIABLES)).toBe('C:\\plain {{other}}');
  });

  it('names the variable that has no value', () => {
    expect(() => expandPath('{{paths.nope}}\\a', VARIABLES)).toThrow('"nope"');
  });

  it('does not read a value as another reference', () => {
    const variables = new Map([
      ['a', '{{paths.b}}'],
      ['b', 'x'],
    ]);
    expect(expandPath('{{paths.a}}', variables)).toBe('{{paths.b}}');
  });

  it('expands the command and leaves the stored manifest alone', () => {
    const tool = toolOf('{{paths.data}}\\t.exe', ['--root', '{{paths.data}}']);
    const expanded = expandToolCommand(tool, VARIABLES);
    expect(expanded.manifest).toMatchObject({
      run: { program: 'D:\\data\\t.exe', args: ['--root', 'D:\\data'] },
    });
    expect(tool.manifest).toMatchObject({ run: { program: '{{paths.data}}\\t.exe' } });
  });

  it('expands typed values and defaults of path parameters, and nothing else', async () => {
    const { values, recorded } = await resolveRunValues(toolOf('C:\\t.exe'), {
      store: createMemorySecretStore(),
      pathVariables: VARIABLES,
      values: { input: '{{paths.data}}\\in', note: '{{paths.data}}' },
    });
    expect(values).toEqual({
      input: 'D:\\data\\in',
      fallback: 'D:\\data\\f',
      note: '{{paths.data}}',
    });
    expect(recorded).toContainEqual({ name: 'input', label: 'In', value: 'D:\\data\\in' });
  });

  it('reports a tool that needs a missing variable as such', async () => {
    const status = await checkRuntime(toolOf('{{paths.nope}}\\t.exe'), { env: {} });
    expect(status).toEqual({ status: 'missing-variable', variable: 'nope' });
  });

  describe('on disk', () => {
    let dataDir: string;

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'bildora-paths-'));
    });

    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    it('stores, changes and removes values, with no inherited names', async () => {
      await setPathVariable(dataDir, 'data', 'D:\\data');
      await setPathVariable(dataDir, 'data', 'E:\\data');
      expect(await readPathVariables(dataDir)).toEqual(new Map([['data', 'E:\\data']]));
      expect((await readPathVariables(dataDir)).get('constructor')).toBeUndefined();
      await removePathVariable(dataDir, 'data');
      expect((await readPathVariables(dataDir)).size).toBe(0);
    });

    it('refuses a bad name or a relative value', async () => {
      await expect(setPathVariable(dataDir, '1 bad', 'D:\\x')).rejects.toThrow();
      await expect(setPathVariable(dataDir, 'ok', 'relative\\x')).rejects.toThrow('absolute');
    });

    it('survives a damaged file, and refuses to replace a newer one', async () => {
      const file = join(dataDir, 'path-variables.json');
      await writeFile(file, 'not json');
      expect((await readPathVariables(dataDir)).size).toBe(0);
      await writeFile(file, '{"formatVersion":99,"variables":{}}');
      await expect(setPathVariable(dataDir, 'ok', 'D:\\x')).rejects.toThrow('99');
      expect(await readFile(file, 'utf8')).toContain('99');
    });

    it('imports a manifest that starts from a variable as it is written', async () => {
      const registry = await ToolRegistry.open({ dataDir: join(dataDir, 'data') });
      const manifest = join(dataDir, 'tool.yaml');
      await writeFile(
        manifest,
        [
          'schemaVersion: 1',
          'id: sample',
          'name: Sample',
          'version: 1.0.0',
          'level: 1',
          'run:',
          '  program: "{{paths.data}}\\\\t.exe"',
        ].join('\n'),
      );
      const { registered } = await importManifests(registry, [manifest]);
      expect(registered[0]?.manifest).toMatchObject({
        run: { program: '{{paths.data}}\\t.exe' },
      });
    });

    it('lets a program point through a variable, and refuses a relative path', async () => {
      const registry = await ToolRegistry.open({ dataDir: join(dataDir, 'data') });
      await registry.register(toolOf('C:\\t.exe').manifest);
      const details = { name: 'Tool' };

      await expect(
        updateToolDetails(registry, 'tool', { ...details, program: 'relative\\t.exe' }),
      ).rejects.toThrow('absolute');
      const updated = await updateToolDetails(registry, 'tool', {
        ...details,
        program: '{{paths.data}}\\t.exe',
      });
      expect(updated?.manifest).toMatchObject({ run: { program: '{{paths.data}}\\t.exe' } });
    });

    it('recognizes a program registered through a variable', async () => {
      const program = join(dataDir, 'run.bat');
      await writeFile(program, '@echo off');
      const detection = await detectPrograms([program], {
        env: {},
        registered: [toolOf('{{paths.root}}\\run.bat')],
        pathVariables: new Map([['root', dataDir]]),
      });
      expect(detection.proposals[0]?.alreadyRegistered).toBe(true);
    });
  });
});
