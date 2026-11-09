import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolManifestSchema } from '@bildora/protocol';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import { endProcess, isAlive, waitUntil } from './process-test-helpers.js';
import { startRun } from './run-tool.js';
import type { RunOptions, ToolRun } from './run-tool.js';

const fixtures = fileURLToPath(new URL('../../../../examples/fixtures/', import.meta.url));
// The test runner's own Node, so these tests need nothing else installed.
const nodeDirectory = dirname(process.execPath);

interface FakeTool {
  readonly args?: readonly string[];
  readonly parameters?: readonly unknown[];
  readonly leftoverProcesses?: 'end' | 'keep';
}

function fakeNodeTool({ args = [], parameters = [], leftoverProcesses }: FakeTool): RegisteredTool {
  return {
    scope: GLOBAL_SCOPE,
    directory: fixtures,
    manifest: toolManifestSchema.parse({
      schemaVersion: 1,
      id: 'fake.tool',
      name: 'Fake',
      version: '1.0.0',
      level: 1,
      interpreter: 'node',
      run: { program: 'fake-tool.mjs', args },
      parameters,
      ...(leftoverProcesses === undefined ? {} : { leftoverProcesses }),
    }),
  };
}

const env = (): Record<string, string | undefined> => ({
  ...process.env,
  PATH: `${nodeDirectory};${process.env['PATH'] ?? ''}`,
});

interface Observed {
  readonly run: ToolRun;
  output(): string;
  waitFor(pattern: RegExp): Promise<RegExpExecArray>;
}

function observe(tool: RegisteredTool, options: RunOptions = {}): Observed {
  let output = '';
  const run = startRun(tool, {
    env: env(),
    ...options,
    onOutput: (data) => {
      output += data;
    },
  });
  return {
    run,
    output: () => output,
    waitFor: async (pattern) => {
      await waitUntil(() => pattern.test(output), 15_000);
      const match = pattern.exec(output);
      if (match === null) {
        throw new Error('The output changed');
      }
      return match;
    },
  };
}

describe.skipIf(process.platform !== 'win32')('startRun', () => {
  describe('tools that exit', () => {
    it('reports a clean exit', async () => {
      const result = await observe(fakeNodeTool({ args: ['exit', '0'] })).run.result;

      expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it.each([7, 255])('reports exit code %i as a failure', async (code) => {
      const result = await observe(fakeNodeTool({ args: ['exit', String(code)] })).run.result;

      expect(result).toMatchObject({
        status: 'failed',
        exitCode: code,
        failure: { kind: 'exit-code' },
      });
    });

    it('delivers all output before the result', async () => {
      const lines = 3000;
      const observed = observe(fakeNodeTool({ args: ['lines', String(lines)] }));
      await observed.run.result;

      const seen = observed.output().match(/LINE \d+/g) ?? [];
      expect(new Set(seen).size).toBe(lines);
      expect(observed.output()).toContain('END');
    });

    it('passes parameters and fixed arguments, with spaces intact', async () => {
      const tool = fakeNodeTool({
        args: ['args', 'fixed'],
        parameters: [
          { name: 'input', type: 'path', label: 'Input', flag: '--input' },
          { name: 'quote', type: 'string', label: 'Quote' },
        ],
      });
      const observed = observe(tool, { parameters: { input: 'a b.txt', quote: 'say "hi"\\' } });
      await observed.run.result;

      expect(observed.output().replaceAll(/\s+/g, ' ')).toContain(
        String.raw`ARGS ["fixed","--input","a b.txt","say \"hi\"\\"]`,
      );
    });

    it('runs a level 0 tool, which declares only a program', async () => {
      const tool: RegisteredTool = {
        scope: GLOBAL_SCOPE,
        directory: fixtures,
        manifest: toolManifestSchema.parse({
          schemaVersion: 1,
          id: 'fake.level0',
          name: 'Level 0',
          version: '1.0.0',
          level: 0,
          run: { program: process.execPath, args: ['-e', 'process.exitCode = 5'] },
        }),
      };

      expect(await observe(tool).run.result).toMatchObject({ status: 'failed', exitCode: 5 });
    });
  });

  describe('tools that hang', () => {
    it('cancels a hanging tool promptly', async () => {
      const observed = observe(fakeNodeTool({ args: ['hang'] }));
      await observed.waitFor(/READY/);

      const cancelledAt = performance.now();
      observed.run.cancel();
      const result = await observed.run.result;

      expect(result.status).toBe('cancelled');
      expect(performance.now() - cancelledAt).toBeLessThan(5000);
    });

    it('ends a detached child on cancel', async () => {
      const observed = observe(fakeNodeTool({ args: ['tree'] }));
      const child = Number((await observed.waitFor(/CHILD (\d+)/))[1]);
      expect(isAlive(child)).toBe(true);

      try {
        observed.run.cancel();
        await observed.run.result;
        await waitUntil(() => !isAlive(child));
      } finally {
        endProcess(child);
      }
    });

    it('ends a detached child on cancel in keep mode too', async () => {
      const observed = observe(fakeNodeTool({ args: ['tree'], leftoverProcesses: 'keep' }));
      const child = Number((await observed.waitFor(/CHILD (\d+)/))[1]);

      try {
        observed.run.cancel();
        await observed.run.result;
        await waitUntil(() => !isAlive(child));
      } finally {
        endProcess(child);
      }
    });

    it('treats a second cancel, and a cancel after the end, as nothing', async () => {
      const observed = observe(fakeNodeTool({ args: ['hang'] }));
      await observed.waitFor(/READY/);

      observed.run.cancel();
      observed.run.cancel();
      expect((await observed.run.result).status).toBe('cancelled');
      expect(() => {
        observed.run.cancel();
      }).not.toThrow();
    });

    it('never starts a tool cancelled at once', async () => {
      const observed = observe(fakeNodeTool({ args: ['hang'] }));
      observed.run.cancel();

      expect((await observed.run.result).status).toBe('cancelled');
      expect(observed.output()).not.toContain('READY');
    });
  });

  describe('leftover processes', () => {
    it('ends what the tool left behind by default', async () => {
      const observed = observe(fakeNodeTool({ args: ['orphan'] }));
      const child = Number((await observed.waitFor(/CHILD (\d+)/))[1]);

      try {
        await observed.run.result;
        await waitUntil(() => !isAlive(child));
      } finally {
        endProcess(child);
      }
    });

    it('leaves a detached child running in keep mode', async () => {
      const observed = observe(fakeNodeTool({ args: ['orphan'], leftoverProcesses: 'keep' }));
      const child = Number((await observed.waitFor(/CHILD (\d+)/))[1]);

      try {
        expect((await observed.run.result).status).toBe('completed');
        expect(isAlive(child)).toBe(true);
      } finally {
        endProcess(child);
      }
    });
  });

  describe('tools that fail before running', () => {
    it('reports a missing program', async () => {
      const tool = fakeNodeTool({});
      const missing: RegisteredTool = {
        ...tool,
        manifest: { ...tool.manifest, level: 0, run: { program: 'no-such-tool.exe', args: [] } },
      };

      expect(await startRun(missing, { env: env() }).result).toMatchObject({
        status: 'failed',
        failure: { kind: 'program-not-found' },
      });
    });

    it('reports a missing interpreter', async () => {
      const tool = fakeNodeTool({});
      const missing: RegisteredTool = {
        ...tool,
        manifest: { ...tool.manifest, interpreter: 'no-such-runtime' },
      };

      const result = await startRun(missing, { env: env() }).result;
      expect(result).toMatchObject({
        status: 'failed',
        failure: { kind: 'interpreter-not-found' },
      });
      expect(JSON.stringify(result)).toContain('no-such-runtime');
    });

    it('reports invalid parameters without repeating secret values', async () => {
      const tool = fakeNodeTool({ parameters: [{ name: 'a', type: 'integer', label: 'A' }] });
      const parameters = { a: 'hunter2' };

      const result = await startRun(tool, { env: env(), parameters }).result;
      expect(result).toMatchObject({ status: 'failed', failure: { kind: 'invalid-parameters' } });
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('reports a missing launcher', async () => {
      const launcherPath = join(fixtures, 'no-such-launcher.exe');

      expect(
        await startRun(fakeNodeTool({ args: ['exit'] }), { env: env(), launcherPath }).result,
      ).toMatchObject({ status: 'failed', failure: { kind: 'launcher' } });
    });

    it('tells a launcher failure from an exit code', async () => {
      // A file that exists but cannot be executed gets past resolution and fails in the launcher.
      const tool = fakeNodeTool({});
      const broken: RegisteredTool = {
        ...tool,
        manifest: {
          schemaVersion: 1,
          id: 'fake.broken',
          name: 'Broken',
          version: '1.0.0',
          level: 0,
          permissions: [],
          leftoverProcesses: 'end',
          run: { program: join(fixtures, 'fake-tool.mjs'), args: [] },
        },
      };

      expect(await startRun(broken, { env: env() }).result).toMatchObject({
        status: 'failed',
        failure: { kind: 'launcher', message: 'The program could not be started' },
      });
      expect((await startRun(broken, { env: env() }).result) as object).not.toHaveProperty(
        'exitCode',
      );
    });
  });

  describe('batch files', () => {
    let directory: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'bildora-batch-'));
      await copyFile(join(fixtures, 'echo-args.bat'), join(directory, 'echo args.bat'));
    });

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    function batchTool(): RegisteredTool {
      return {
        scope: GLOBAL_SCOPE,
        directory,
        manifest: toolManifestSchema.parse({
          schemaVersion: 1,
          id: 'fake.batch',
          name: 'Batch',
          version: '1.0.0',
          level: 1,
          run: { program: 'echo args.bat' },
          parameters: [
            { name: 'first', type: 'string', label: 'First' },
            { name: 'second', type: 'string', label: 'Second' },
          ],
        }),
      };
    }

    async function runBatch(first: string, second = 'two'): Promise<Observed> {
      const observed = observe(batchTool(), { parameters: { first, second } });
      await observed.run.result;
      return observed;
    }

    it('forwards the exit code and arguments, from a path with spaces', async () => {
      const observed = observe(batchTool(), { parameters: { first: 'a b', second: 'c' } });

      expect(await observed.run.result).toMatchObject({ status: 'failed', exitCode: 4 });
      expect(observed.output()).toContain('ARG1="a b"');
    });

    it.each([
      ['an ampersand', 'a&echo INJECTED>marker1.txt'],
      ['a closing quote', '"&echo INJECTED>marker2.txt&"'],
      ['a pipe', 'a|echo INJECTED>marker3.txt'],
      ['a caret', '^"&echo INJECTED>marker4.txt&^"'],
      ['a redirection', 'a>marker5.txt'],
      ['parentheses', ')&echo INJECTED>marker6.txt&('],
    ])('keeps %s as data', async (_name, value) => {
      await runBatch(value);

      const created = (await readdir(directory)).filter((name) => name.startsWith('marker'));
      expect(created).toEqual([]);
    });

    it.each(['%PATH%', '%USERNAME%', '100%'])('does not expand %s', async (value) => {
      const observed = await runBatch(value);

      expect(observed.output()).toContain(`ARG1="${value}"`);
    });

    it('does not expand delayed variables', async () => {
      const observed = await runBatch('!PATH!');

      expect(observed.output()).toContain('ARG1="!PATH!"');
    });

    it('refuses a line break, which no quoting can contain', async () => {
      const result = await startRun(batchTool(), {
        env: env(),
        parameters: { first: 'a\r\necho INJECTED' },
      }).result;

      expect(result).toMatchObject({ status: 'failed', failure: { kind: 'invalid-parameters' } });
    });
  });

  describe('console scripts', () => {
    const sample = fileURLToPath(
      new URL('../../../../examples/level-1-menu-cli/', import.meta.url),
    );

    async function menuTool(): Promise<RegisteredTool> {
      const text = await readFile(join(sample, 'tool.yaml'), 'utf8');
      return {
        scope: GLOBAL_SCOPE,
        directory: sample,
        manifest: toolManifestSchema.parse(parse(text)),
      };
    }

    function batchMenu(stdin: unknown): RegisteredTool {
      return {
        scope: GLOBAL_SCOPE,
        directory: fixtures,
        manifest: toolManifestSchema.parse({
          schemaVersion: 1,
          id: 'fake.menu',
          name: 'Menu',
          version: '1.0.0',
          level: 1,
          run: { program: 'menu.bat' },
          parameters: [{ name: 'pick', type: 'integer', label: 'Pick', stdin: true }],
          stdin,
        }),
      };
    }

    it('answers Python input() prompts with the script', async () => {
      const observed = observe(await menuTool(), {
        answerWithScript: true,
        parameters: { format: 'json', name: 'Ada', upper: true },
      });

      expect(await observed.run.result).toMatchObject({ status: 'completed' });
      expect(observed.output()).toContain('"greeting": "HELLO, ADA"');
    });

    it('leaves the prompts to the person when the script is off', async () => {
      const observed = observe(await menuTool(), { parameters: {} });

      await observed.waitFor(/Format \[csv\/json\]:/);
      observed.run.write('csv\r');
      await observed.waitFor(/Your name:/);
      observed.run.write('Bob\r');
      await observed.waitFor(/Continue\? \[y\/n\]/);
      observed.run.write('y\r');

      expect(await observed.run.result).toMatchObject({ status: 'completed' });
      expect(observed.output()).toContain('Hello, Bob,Bob');
    });

    it('answers a batch set /p prompt', async () => {
      const tool = batchMenu([{ expect: 'Pick a number:', send: '{{params.pick}}' }]);
      const observed = observe(tool, { answerWithScript: true, parameters: { pick: 42 } });

      expect(await observed.run.result).toMatchObject({ status: 'completed' });
      expect(observed.output()).toContain('PICKED 42');
    });

    it('ends the tool and fails the run when a wait runs out', async () => {
      const tool = batchMenu([{ expect: 'Never shown', send: '{{params.pick}}', timeout: 1 }]);
      const observed = observe(tool, { answerWithScript: true, parameters: { pick: 1 } });

      const result = await observed.run.result;
      expect(result).toMatchObject({ status: 'failed', failure: { kind: 'stdin-timeout' } });
      expect(result.status === 'failed' ? result.failure.message : '').toContain('"Never shown"');
    });

    it('reports a missing required answer before starting', async () => {
      const result = await observe(await menuTool(), {
        answerWithScript: true,
        parameters: { format: 'csv' },
      }).run.result;

      expect(result).toMatchObject({ status: 'failed', failure: { kind: 'invalid-parameters' } });
    });
  });
});
