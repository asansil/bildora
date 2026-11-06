import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, parseManifest, startRun } from './index.js';
import { endProcess, isAlive, waitUntil } from './runner/process-test-helpers.js';

const fakeTool = fileURLToPath(
  new URL('../../../examples/fixtures/fake-tool.mjs', import.meta.url),
);

const manifestText = `
schemaVersion: 1
id: acme.fake
name: Fake
version: 1.0.0
level: 1
interpreter: node
run:
  program: fake-tool.mjs
parameters:
  - name: mode
    type: choice
    label: Mode
    required: true
    choices: [exit, tree]
  - name: code
    type: integer
    label: Exit code
`;

describe.skipIf(process.platform !== 'win32')('core without a UI', () => {
  let dataDir: string;
  const env = { ...process.env, PATH: `${dirname(process.execPath)};${process.env['PATH'] ?? ''}` };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-core-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers a tool, finds it after a restart, runs it and cancels it', async () => {
    const registered = await (
      await ToolRegistry.open({ dataDir })
    ).register(parseManifest(manifestText));
    await copyFile(fakeTool, join(registered.directory, 'fake-tool.mjs'));

    const registry = await ToolRegistry.open({ dataDir });
    const { tools, problems } = await registry.list();
    expect(problems).toEqual([]);
    const [tool] = tools;
    if (tool === undefined) {
      throw new Error('The tool did not survive a restart');
    }

    const finished = await startRun(tool, { env, parameters: { mode: 'exit', code: 3 } }).result;
    expect(finished).toMatchObject({ status: 'failed', exitCode: 3 });

    let output = '';
    const run = startRun(tool, {
      env,
      parameters: { mode: 'tree' },
      onOutput: (data) => {
        output += data;
      },
    });
    await waitUntil(() => /CHILD \d+/.test(output), 15_000);
    const child = Number(/CHILD (\d+)/.exec(output)?.[1]);

    try {
      run.cancel();
      expect((await run.result).status).toBe('cancelled');
      await waitUntil(() => !isAlive(child));
    } finally {
      endProcess(child);
    }
  });
});
