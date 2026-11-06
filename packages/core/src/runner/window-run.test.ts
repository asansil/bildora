import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolManifestSchema } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRegisteredManifest } from '../import/register-program.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import { endProcess, isAlive, waitUntil } from './process-test-helpers.js';
import { scriptInterpreterArguments, startWindowRun } from './run-tool.js';

const fixtures = fileURLToPath(new URL('../../../../examples/fixtures/', import.meta.url));
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)};${process.env['PATH'] ?? ''}`,
};

interface Report {
  readonly pid: number;
  readonly child?: number;
  readonly tty?: boolean;
}

function nodeTool(args: readonly string[], leftoverProcesses: 'end' | 'keep'): RegisteredTool {
  return {
    scope: GLOBAL_SCOPE,
    directory: fixtures,
    manifest: toolManifestSchema.parse({
      schemaVersion: 1,
      id: 'fake.window',
      name: 'Fake',
      version: '1.0.0',
      level: 0,
      interpreter: 'node',
      leftoverProcesses,
      run: { program: 'fake-tool.mjs', args },
    }),
  };
}

describe.skipIf(process.platform !== 'win32')('startWindowRun', () => {
  let folder: string;
  let reportFile: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'bildora-window-'));
    reportFile = join(folder, 'report.json');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  async function readReport(): Promise<Report> {
    await waitUntil(() => existsSync(reportFile), 15_000);
    await waitUntil(() => readFileSync(reportFile, 'utf8').endsWith('}'));
    return JSON.parse(readFileSync(reportFile, 'utf8')) as Report;
  }

  it('gives a console program a console of its own', async () => {
    const run = startWindowRun(nodeTool(['report', reportFile], 'end'), { env });

    expect(await run.result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect((await readReport()).tty).toBe(true);
  });

  it('reports the exit code of a failing program', async () => {
    const result = await startWindowRun(nodeTool(['exit', '3'], 'end'), { env }).result;

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 3,
      failure: { kind: 'exit-code' },
    });
  });

  it('reports a program that does not exist', async () => {
    const tool = nodeTool([], 'end');
    const missing: RegisteredTool = {
      ...tool,
      manifest: createRegisteredManifest({ program: 'C:\\no\\such\\tool.exe', name: 'Gone' }, 'g'),
    };

    expect(await startWindowRun(missing, { env }).result).toMatchObject({
      status: 'failed',
      failure: { kind: 'program-not-found' },
    });
  });

  it('reports a launcher that cannot start', async () => {
    const result = await startWindowRun(nodeTool(['exit'], 'end'), {
      env,
      launcherPath: join(folder, 'missing-launcher.exe'),
    }).result;

    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'launcher' } });
  });

  it('ends the whole tree on cancel, even with leftovers kept', async () => {
    const run = startWindowRun(nodeTool(['report', reportFile, 'tree'], 'keep'), { env });
    const { pid, child } = await readReport();
    if (child === undefined) {
      throw new Error('The tool started no child');
    }
    try {
      run.cancel();

      expect(await run.result).toMatchObject({ status: 'cancelled' });
      await waitUntil(() => !isAlive(pid) && !isAlive(child));
    } finally {
      endProcess(pid);
      endProcess(child);
    }
  });

  it('leaves a program running after its starter exits, with leftovers kept', async () => {
    const run = startWindowRun(nodeTool(['report', reportFile, 'orphan'], 'keep'), { env });

    expect(await run.result).toMatchObject({ status: 'completed' });
    const { child } = await readReport();
    if (child === undefined) {
      throw new Error('The tool started no child');
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isAlive(child)).toBe(true);
    } finally {
      endProcess(child);
    }
  });

  it('runs a batch file in a console of its own', async () => {
    const batch = join(folder, 'tool with spaces.bat');
    await writeFile(batch, '@echo off\r\nexit /b 5\r\n');
    const tool: RegisteredTool = {
      scope: GLOBAL_SCOPE,
      directory: folder,
      manifest: createRegisteredManifest({ program: batch, name: 'Batch' }, 'batch'),
    };

    expect(await startWindowRun(tool, { env }).result).toMatchObject({
      status: 'failed',
      exitCode: 5,
    });
  });

  it('keeps a tool alive when the process that started it ends', async () => {
    const core = new URL('../../dist/index.js', import.meta.url).href;
    const tool = nodeTool(['report', reportFile, 'hang'], 'keep');
    const starter = join(folder, 'starter.mjs');
    await writeFile(
      starter,
      [
        `import { startWindowRun } from ${JSON.stringify(core)};`,
        `startWindowRun(${JSON.stringify(tool)}, { env: ${JSON.stringify(env)} });`,
        `setTimeout(() => process.exit(0), 1000);`,
      ].join('\n'),
    );
    const starterProcess = spawn(process.execPath, [starter], { stdio: 'ignore' });
    await new Promise((resolve) => starterProcess.once('exit', resolve));

    const { pid } = await readReport();
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isAlive(pid)).toBe(true);
    } finally {
      endProcess(pid);
    }
  });
});

describe('scriptInterpreterArguments', () => {
  it.each([
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-File']],
    ['C:\\Program Files\\PowerShell\\7\\PWSH.EXE', ['-File']],
    ['C:\\Python312\\python.exe', []],
  ])('for %s', (interpreter, expected) => {
    expect(scriptInterpreterArguments(interpreter)).toEqual(expected);
  });
});
