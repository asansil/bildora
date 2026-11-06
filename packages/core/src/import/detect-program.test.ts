import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import { detectPrograms, displayName } from './detect-program.js';
import { createRegisteredManifest } from './register-program.js';

describe('displayName', () => {
  it.each([
    ['log_parser', 'Log Parser'],
    ['build-all', 'Build All'],
    ['CSVTool', 'CSVTool'],
    ['  spaced   out ', 'Spaced Out'],
    ['___', '___'],
    ['año_nuevo', 'Año Nuevo'],
  ])('labels %s', (name, expected) => {
    expect(displayName(name)).toBe(expected);
  });
});

describe('detectPrograms', () => {
  let folder: string;
  const noInterpreters = { env: { PATH: '' } };

  async function touch(...segments: string[]): Promise<string> {
    const path = join(folder, ...segments);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '');
    return path;
  }

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'bildora-detect-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('proposes a name, category and interpreter from the path alone', async () => {
    const path = await touch('report_tools', 'make_report.py');

    const { proposals } = await detectPrograms([path], noInterpreters);

    expect(proposals).toEqual([
      {
        path,
        name: 'Make Report',
        category: 'Report Tools',
        interpreter: 'python',
        alreadyRegistered: false,
      },
    ]);
  });

  it('never runs what it detects', async () => {
    const marker = join(folder, 'ran.txt');
    const script = await touch('evil.bat');
    await writeFile(script, `@echo off\r\necho x > "${marker}"\r\n`);

    await detectPrograms([script], noInterpreters);

    await expect(writeFile(marker, '', { flag: 'wx' })).resolves.toBeUndefined();
  });

  it.each([
    ['tool.exe', undefined],
    ['tool.COM', undefined],
    ['tool.BAT', undefined],
    ['tool.cmd', undefined],
    ['tool.pyw', 'pythonw'],
    ['tool.mjs', 'node'],
    ['tool.ps1', 'powershell'],
  ])('reads the type of %s', async (file, interpreter) => {
    const { proposals } = await detectPrograms([await touch(file)], noInterpreters);

    expect(proposals[0]?.interpreter).toBe(interpreter);
  });

  it('falls back to the Python launcher when only that is installed', async () => {
    const launcher = await touch('bin', 'py.exe');
    const script = await touch('tool.py');

    const { proposals } = await detectPrograms([script], {
      env: { PATH: join(launcher, '..'), PATHEXT: '.EXE' },
    });

    expect(proposals[0]?.interpreter).toBe('py');
  });

  it('reports what it does not recognize, and what is not there', async () => {
    const text = await touch('notes.txt');
    const gone = join(folder, 'gone.exe');

    const detection = await detectPrograms([text, gone], noInterpreters);

    expect(detection.proposals).toEqual([]);
    expect(detection.skipped).toEqual([text, gone]);
  });

  it('searches below a folder, passing over dependencies and hidden folders', async () => {
    const wanted = [await touch('top.exe'), await touch('sub', 'deep.bat')];
    await touch('sub', 'notes.txt');
    await touch('node_modules', 'dep', 'cli.js');
    await touch('.git', 'hooks', 'pre-commit.py');
    await touch('.venv', 'Scripts', 'activate.bat');
    await touch('__pycache__', 'cached.py');

    const { proposals } = await detectPrograms([folder], noInterpreters);

    expect(proposals.map((proposal) => proposal.path).sort()).toEqual(wanted.sort());
  });

  it('stays on the first level when asked to', async () => {
    const top = await touch('top.exe');
    await touch('sub', 'deep.exe');

    const { proposals } = await detectPrograms([folder], {
      ...noInterpreters,
      recursive: false,
    });

    expect(proposals.map((proposal) => proposal.path)).toEqual([top]);
  });

  it('stops at the limit and says so', async () => {
    await Promise.all(['a.exe', 'b.exe', 'c.exe'].map((name) => touch(name)));

    const detection = await detectPrograms([folder], { ...noInterpreters, limit: 2 });

    expect(detection.proposals).toHaveLength(2);
    expect(detection.truncated).toBe(true);
  });

  it('does not repeat a program reached twice', async () => {
    const path = await touch('tool.exe');

    const { proposals } = await detectPrograms([path, folder], noInterpreters);

    expect(proposals).toHaveLength(1);
  });

  it('marks a program that is already registered, whatever its case', async () => {
    const path = await touch('tool.exe');
    const registered: RegisteredTool[] = [
      {
        scope: GLOBAL_SCOPE,
        directory: folder,
        manifest: createRegisteredManifest({ program: path.toUpperCase(), name: 'Tool' }, 'tool'),
      },
    ];

    const { proposals } = await detectPrograms([path], { ...noInterpreters, registered });

    expect(proposals[0]?.alreadyRegistered).toBe(process.platform === 'win32');
  });
});
