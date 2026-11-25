import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    await registry.register(
      toolManifestSchema.parse({
        schemaVersion: 1,
        id: 'writer',
        name: 'Writer',
        version: '1.0.0',
        level: 1,
        interpreter: 'node',
        run: { program: FAKE_TOOL, args: ['write'] },
        parameters: [
          { name: 'file', type: 'path', label: 'File', required: true },
          { name: 'text', type: 'string', label: 'Text' },
        ],
      }),
      { scope: workspaceScope(workspaceId) },
    );
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('shows the rounds of a loop and the steps of a called automation', async () => {
    const folder = join(dataDir, 'workspaces', workspaceId, 'automations');
    await mkdir(folder, { recursive: true });
    const save = (automation: object) =>
      writeFile(
        join(folder, `${(automation as { id: string }).id}.yaml`),
        JSON.stringify({ schemaVersion: 2, ...automation }),
      );
    await save({
      id: 'child',
      name: 'Child',
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'inner', type: 'run', tool: 'good' },
      ],
      connections: [{ from: 'start', to: 'inner' }],
    });
    await save({
      id: 'flow',
      name: 'Flow',
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'For1', type: 'for', items: { kind: 'count', count: 2 } },
        { id: 'one', type: 'run', tool: 'good', loop: 'For1' },
        { id: 'Child1', type: 'run-automation', automation: 'child' },
      ],
      connections: [
        { from: 'start', to: 'For1' },
        { from: 'For1', output: 'body', to: 'one' },
        { from: 'For1', to: 'Child1' },
      ],
    });
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.completed);
    expect(lines).toContain('  one (round For1:2): running');
    expect(lines.some((line) => /^\[1\/2\] For1: completed \(.*, 2 rounds\)$/.test(line))).toBe(
      true,
    );
    expect(lines).toContain('Calling "Child" from Child1.');
    expect(lines).toContain('Child › [1/1] inner: running');
  });

  it('refuses a call of an automation that is not there', async () => {
    const folder = join(dataDir, 'workspaces', workspaceId, 'automations');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'flow.yaml'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [
          { id: 'start', type: 'start' },
          { id: 'Gone1', type: 'run-automation', automation: 'gone' },
        ],
        connections: [{ from: 'start', to: 'Gone1' }],
      }),
    );
    expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.cannotStart);
    expect(errors).toContain(
      '  Gone1: Automation "gone" does not exist in this Workspace, or cannot be read',
    );
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

  describe('with a disabled block', () => {
    /** Start, a disabled block that would fail if it ran, and an If on it leading to yes or no. */
    async function saveDisabled(rule: object): Promise<void> {
      const folder = join(dataDir, 'workspaces', workspaceId, 'automations');
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, 'flow.yaml'),
        JSON.stringify({
          schemaVersion: 2,
          id: 'flow',
          name: 'Flow',
          blocks: [
            { id: 'start', type: 'start' },
            { id: 'one', type: 'run', tool: 'bad', disabled: true },
            { id: 'check', type: 'if', condition: { match: 'all', rules: [rule] } },
            { id: 'yes', type: 'run', tool: 'good' },
            { id: 'no', type: 'run', tool: 'good' },
          ],
          connections: [
            { from: 'start', to: 'one' },
            { from: 'one', to: 'check' },
            { from: 'check', output: 'true', to: 'yes' },
            { from: 'check', output: 'false', to: 'no' },
          ],
        }),
      );
    }

    it('passes through it without running its tool, and a result rule reads Skipped', async () => {
      await saveDisabled({ block: 'one', field: 'result', operator: 'is', value: 'skipped' });
      expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.completed);

      expect(errors).toEqual([]);
      expect(lines).toContain('[1/3] one: disabled');
      expect(lines.some((line) => /^\[\d\/3\] yes: completed/.test(line))).toBe(true);
      expect(lines.some((line) => /^\[\d\/3\] no: skipped$/.test(line))).toBe(true);
      const history = await RunHistory.open(dataDir);
      expect(history.listAutomationRuns(workspaceId, 'flow')).toMatchObject([
        { status: 'completed', trigger: 'cli' },
      ]);
      history.close();
    });

    it('warns about a rule on its exit code but runs, and stops at that rule', async () => {
      await saveDisabled({ block: 'one', field: 'exit-code', operator: 'equals', value: 7 });
      expect((await runCli(['run', 'flow'], '1', io())).exitCode).toBe(EXIT_CODES.stopped);

      expect(errors).toEqual([
        'Warnings for "Flow":',
        '  check: "Rule 1" checks the exit code of "one", which is disabled and will not run',
        'Stopped at "check": Block "one" is disabled, so it left no exit code to read',
      ]);
      expect(lines).toContain('[1/3] one: disabled');
    });
  });

  it('takes inputs with --input, which blocks read through links', async () => {
    const folder = join(dataDir, 'workspaces', workspaceId, 'automations');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'flow.yaml'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [
          {
            id: 'start',
            type: 'start',
            inputs: [
              { name: 'target', type: 'path', required: true },
              { name: 'times', type: 'integer', default: 2 },
            ],
          },
          {
            id: 'write',
            type: 'run',
            tool: 'writer',
            values: {
              file: { expression: 'inputs.target' },
              text: { expression: 'name(write.file) + " x" + inputs.times * 10' },
            },
          },
        ],
        connections: [{ from: 'start', to: 'write' }],
      }),
    );
    const target = join(dataDir, 'out.txt');
    const result = await runCli(['run', 'flow', '--input', `target=${target}`], '1', io());
    expect(result.exitCode).toBe(EXIT_CODES.completed);
    expect(await readFile(target, 'utf8')).toBe('out.txt x20');

    const wrong = await runCli(
      ['run', 'flow', '-i', 'times=two', '-i', 'nope=1', '-i', 'bare'],
      '1',
      io(),
    );
    expect(wrong).toEqual({
      exitCode: EXIT_CODES.usage,
      stderr: [
        '"Flow" cannot take these inputs:',
        '  Input "times" must be a number',
        '  This automation has no input "nope"',
        '  "bare" should read <name>=<value>',
      ].join('\n'),
    });
    const missing = await runCli(['run', 'flow'], '1', io());
    expect(missing.exitCode).toBe(EXIT_CODES.usage);
    expect(missing.stderr).toContain('Input "target" needs a value');
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
