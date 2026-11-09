import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RunHistory,
  ToolRegistry,
  createWorkspace,
  createMemorySecretStore,
  workspaceScope,
} from '@bildora/core';
import { automationV1Schema, toolManifestSchema } from '@bildora/protocol';
import type { AutomationV1Input } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, runCli } from './run.js';
import type { CliIo } from './run.js';

const FAKE_TOOL = fileURLToPath(
  new URL('../../../examples/fixtures/fake-tool.mjs', import.meta.url),
);

const MENU_BATCH = fileURLToPath(new URL('../../../examples/fixtures/menu.bat', import.meta.url));

const silentIo: CliIo = {
  env: {},
  out: () => undefined,
  error: () => undefined,
  interactive: false,
  waitForEnter: () => Promise.resolve(false),
  onInterrupt: () => () => undefined,
};

describe('runCli', () => {
  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    expect(await runCli([flag], '1.2.3', silentIo)).toEqual({
      exitCode: 0,
      stdout: 'Bildora 1.2.3',
    });
  });

  it.each([[[]], [['run']], [['run', 'a', 'b']], [['run', 'a', '--nope']], [['other']]])(
    'fails with usage for %j',
    async (args) => {
      const result = await runCli(args, '1.2.3', silentIo);
      expect(result.exitCode).toBe(EXIT_CODES.usage);
      expect(result.stderr).toContain('bildora run <automation>');
    },
  );
});

describe.skipIf(process.platform !== 'win32')('bildora run', () => {
  let dataDir: string;
  let workspaceId: string;
  let lines: string[];
  let errors: string[];

  function io(extra: Partial<CliIo> = {}): CliIo {
    return {
      ...silentIo,
      env: { BILDORA_DATA_DIR: dataDir },
      out: (line) => lines.push(line),
      error: (line) => errors.push(line),
      secrets: createMemorySecretStore(),
      ...extra,
    };
  }

  async function saveFlow(
    steps: AutomationV1Input['steps'],
    workspace = workspaceId,
    name = 'Flow',
  ): Promise<void> {
    // Written as a list of steps, the way files were before blocks, so the command reads those too.
    const parsed = automationV1Schema.parse({ schemaVersion: 1, id: 'flow', name, steps });
    const folder = join(dataDir, 'workspaces', workspace, 'automations');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'flow.yaml'), JSON.stringify(parsed));
  }

  const run = (
    id: string,
    tool: string,
    extra: object = {},
  ): AutomationV1Input['steps'][number] => ({
    id,
    type: 'run',
    tool,
    ...extra,
  });
  const manual: AutomationV1Input['steps'][number] = {
    id: 'look',
    type: 'wait-for-manual-action',
    message: 'Check the result',
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora cli ñ-'));
    lines = [];
    errors = [];
    workspaceId = (await createWorkspace(dataDir, 'Work', 'system')).id;
    const registry = await ToolRegistry.open({ dataDir });
    const fake = (id: string, args: string[]) =>
      registry.register(
        toolManifestSchema.parse({
          schemaVersion: 1,
          id,
          name: id,
          version: '1.0.0',
          level: 1,
          interpreter: 'node',
          run: { program: FAKE_TOOL, args },
        }),
        { scope: workspaceScope(workspaceId) },
      );
    await fake('good', ['exit', '0']);
    await fake('bad', ['exit', '7']);
    await fake('hang', ['hang']);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exits 0 when every step succeeds, and leaves the run in history', async () => {
    await saveFlow([run('one', 'good'), run('two', 'good')]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.completed);

    expect(lines).toContain('[1/2] one: running');
    expect(lines.at(-1)).toMatch(/^Automation completed in /);
    const history = await RunHistory.open(dataDir);
    expect(history.listAutomationRuns(workspaceId, 'flow')).toMatchObject([
      { status: 'completed', trigger: 'cli' },
    ]);
    history.close();
  });

  it('finds an automation by its name, in any case', async () => {
    await saveFlow([run('one', 'good')], workspaceId, 'Nightly Report');
    expect((await runCli(['run', 'nightly report'], '1', io())).exitCode).toBe(0);
  });

  it('always answers a console script, and fails a step whose wait runs out', async () => {
    const registry = await ToolRegistry.open({ dataDir });
    const menu = (id: string, expected: string) =>
      registry.register(
        toolManifestSchema.parse({
          schemaVersion: 1,
          id,
          name: id,
          version: '1.0.0',
          level: 1,
          run: { program: MENU_BATCH },
          parameters: [{ name: 'pick', type: 'integer', label: 'Pick', stdin: true }],
          stdin: [{ expect: expected, send: '{{params.pick}}', timeout: 1 }],
        }),
        { scope: workspaceScope(workspaceId) },
      );
    await menu('menu', 'Pick a number:');
    await menu('stuck', 'Never shown');

    await saveFlow([run('ask', 'menu', { values: { pick: 7 } })]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.completed);

    await saveFlow([run('ask', 'stuck', { values: { pick: 7 } })]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.stopped);
    expect(lines.join('\n')).toContain('"Never shown"');
  });

  it('exits 1 when a failed step stops the automation', async () => {
    await saveFlow([run('one', 'bad'), run('two', 'good')]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.stopped);
    expect(errors).toEqual(['Stopped at "one": The tool exited with code 7']);
    expect(lines.join('\n')).not.toContain('two');
  });

  it('exits 3 when it finished past a step set to continue', async () => {
    await saveFlow([run('one', 'bad', { onFailure: 'continue' }), run('two', 'good')]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(
      EXIT_CODES.continuedPastFailure,
    );
  });

  it('runs blocks and connections, and exits 3 when an Error output handled a failure', async () => {
    const folder = join(dataDir, 'workspaces', workspaceId, 'automations');
    await mkdir(folder, { recursive: true });
    const block = (id: string, tool: string) => ({ id, type: 'run', tool });
    await writeFile(
      join(folder, 'flow.yaml'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [
          { id: 'start', type: 'start' },
          block('one', 'bad'),
          block('notify', 'good'),
          block('skipped-one', 'good'),
        ],
        connections: [
          { from: 'start', to: 'one' },
          { from: 'one', output: 'error', to: 'notify' },
          { from: 'one', to: 'skipped-one' },
        ],
      }),
    );
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(
      EXIT_CODES.continuedPastFailure,
    );
    expect(lines).toContain('[1/3] one: failed: The tool exited with code 7');
    expect(lines.some((line) => line.startsWith('[2/3] notify: completed'))).toBe(true);
    expect(lines).toContain('[3/3] skipped-one: skipped');
  });

  it('exits 4 at once at a manual step with no terminal', async () => {
    await saveFlow([run('one', 'good'), manual, run('two', 'good')]);
    const started = Date.now();
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.nobodyToAnswer);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(lines.join('\n')).not.toContain('two');
  });

  it('asks at a manual step in a terminal', async () => {
    await saveFlow([manual, run('two', 'good')]);
    const terminal = io({ interactive: true, waitForEnter: () => Promise.resolve(true) });
    expect((await runCli(['run', 'flow'], '1', terminal)).exitCode).toBe(EXIT_CODES.completed);
    expect(lines).toContain('Check the result\nPress Enter to continue.');
  });

  it('treats the end of input at a prompt as nobody being there', async () => {
    await saveFlow([manual]);
    const terminal = io({ interactive: true });
    expect((await runCli(['run', 'flow'], '1', terminal)).exitCode).toBe(EXIT_CODES.nobodyToAnswer);
  });

  it('exits 130 when interrupted, ending the tool', async () => {
    await saveFlow([run('one', 'hang')]);
    let interrupt = (): void => undefined;
    const running = runCli(
      ['run', 'flow'],
      '1',
      io({
        onInterrupt: (listener) => {
          interrupt = listener;
          return () => undefined;
        },
        out: (line) => {
          lines.push(line);
          if (line.endsWith('running')) {
            setTimeout(() => {
              interrupt();
            }, 300);
          }
        },
      }),
    );
    expect((await running).exitCode).toBe(EXIT_CODES.cancelled);
  });

  it('exits 5 for an unknown automation', async () => {
    const result = await runCli(['run', 'missing'], '1', io());
    expect(result).toEqual({
      exitCode: EXIT_CODES.cannotStart,
      stderr: 'No automation "missing".',
    });
  });

  it('exits 5 for an automation in several Workspaces, and --workspace chooses', async () => {
    const home = await createWorkspace(dataDir, 'Home', 'system');
    await saveFlow([{ id: 'pause', type: 'wait-for-time', seconds: 1 }], home.id);
    await saveFlow([run('one', 'good')]);

    const result = await runCli(['run', 'flow'], '1', io());
    expect(result.exitCode).toBe(EXIT_CODES.cannotStart);
    expect(result.stderr).toContain('Home, Work');
    expect((await runCli(['run', 'flow', '--workspace', 'WORK'], '1', io())).exitCode).toBe(0);
    expect(lines).toContain('Running "Flow" in Workspace "Work".');
    expect((await runCli(['run', 'flow', '-w', 'nowhere'], '1', io())).exitCode).toBe(
      EXIT_CODES.cannotStart,
    );
  });

  it('exits 5 for an automation with a broken step, running nothing', async () => {
    await saveFlow([run('one', 'good'), run('two', 'gone')]);
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.cannotStart);
    expect(errors).toEqual([
      '"Flow" cannot run:',
      '  two: Tool "gone" is not installed, or cannot be read',
    ]);
    const history = await RunHistory.open(dataDir);
    expect(history.listAutomationRuns(workspaceId, 'flow')).toEqual([]);
    history.close();
  });

  it('keeps going, with a warning, when history cannot be opened', async () => {
    await saveFlow([run('one', 'good')]);
    await mkdir(join(dataDir, 'history.db'));
    await writeFile(join(dataDir, 'history.db', 'in-the-way'), '');
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(0);
    expect(errors[0]).toMatch(/^Warning: this run will not be kept in history/);
  });
});
