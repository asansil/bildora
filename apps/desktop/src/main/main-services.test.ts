import { describe, expect, it, vi } from 'vitest';
import type { RegisteredTool, RunResult, ToolRun } from '@bildora/core';
import {
  categoryMenuSchema,
  createWorkspaceSchema,
  detectPathsSchema,
  editCommandSchema,
  noInputSchema,
  pathVariableSchema,
  preferencesSchema,
  registerToolsSchema,
  runInputSchema,
  runResizeSchema,
  saveProfileSchema,
  startRunSchema,
  toolIdSchema,
  updateToolSchema,
  updateWorkspaceSchema,
} from '../shared/ipc-contract.js';
import { RunService } from './run-service.js';
import { isTrustedSender } from './trusted-sender.js';

const rendererUrl = 'file:///C:/app/out/renderer/index.html';

describe('isTrustedSender', () => {
  it.each([
    ['the shell page', rendererUrl, true],
    ['the shell page with a hash', `${rendererUrl}#tool`, true],
    ['the shell page with its drive in lowercase', 'file:///c:/app/out/renderer/index.html', true],
    ['another local file', 'file:///C:/temp/evil.html', false],
    ['another drive', 'file:///D:/app/out/renderer/index.html', false],
    ['a remote page', 'https://example.com/index.html', false],
    ['a tool panel', 'bildora-panel://acme.tool/index.html', false],
    ['nothing', undefined, false],
    ['something that is not a URL', 'nonsense', false],
  ])('for %s', (_label, url, expected) => {
    expect(isTrustedSender(url, rendererUrl)).toBe(expected);
  });

  describe('with a path two encoders write differently', () => {
    const encoded = 'file:///C:/Users/RUNNER%7E1/app%20(x)/%C3%B1/index.html';

    it.each([
      ['a short name left as it is', 'file:///C:/Users/RUNNER~1/app%20(x)/%C3%B1/index.html', true],
      ['brackets written out', 'file:///C:/Users/RUNNER%7E1/app%20%28x%29/%C3%B1/index.html', true],
      ['the same encoding', encoded, true],
      ['a neighbour of the page', 'file:///C:/Users/RUNNER~1/app%20(x)/%C3%B1/evil.html', false],
      ['a similar folder', 'file:///C:/Users/RUNNER~2/app%20(x)/%C3%B1/index.html', false],
      ['a path that does not decode', 'file:///C:/Users/RUNNER~1/%ZZ/index.html', false],
    ])('for %s', (_label, url, expected) => {
      expect(isTrustedSender(url, encoded)).toBe(expected);
    });
  });

  it('accepts the development server only as the configured page', () => {
    expect(isTrustedSender('http://localhost:5173/', 'http://localhost:5173/')).toBe(true);
    expect(isTrustedSender('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
  });
});

describe('IPC schemas', () => {
  const program = { name: 'Tool', program: 'C:\\Tools\\tool.exe' };

  it.each([
    ['input on a channel that takes none', noInputSchema, { any: 1 }],
    ['an unknown edit command', editCommandSchema, 'delete'],
    ['an empty path list', detectPathsSchema, { paths: [] }],
    ['too many dropped paths', detectPathsSchema, { paths: Array<string>(1001).fill('C:\\a') }],
    [
      'a relative program',
      registerToolsSchema,
      { programs: [{ ...program, program: 'a.exe' }], scope: 'global' },
    ],
    [
      'a nameless program',
      registerToolsSchema,
      { programs: [{ ...program, name: '' }], scope: 'global' },
    ],
    [
      'an extra field',
      registerToolsSchema,
      { programs: [{ ...program, level: 2 }], scope: 'global' },
    ],
    ['a registration with no scope', registerToolsSchema, { programs: [program] }],
    ['a scope naming a Workspace', registerToolsSchema, { programs: [program], scope: 'other' }],
    [
      'an update with an unknown field',
      updateToolSchema,
      { id: 'a', details: { name: 'A', x: 1 } },
    ],
    ['a nameless Workspace', createWorkspaceSchema, { name: '' }],
    ['a panel too wide', updateWorkspaceSchema, { layout: { panelWidth: 5000 } }],
    ['an unknown theme for a Workspace', updateWorkspaceSchema, { theme: 'pink' }],
    ['a relative path variable', pathVariableSchema, { name: 'a', value: 'relative' }],
    ['a launch by path', toolIdSchema, { path: 'C:\\evil.exe' }],
    ['an unknown theme', preferencesSchema, { theme: 'pink' }],
    ['a menu for no category', categoryMenuSchema, { category: '' }],
    ['a logo path sent by the page', categoryMenuSchema, { category: 'A', source: 'C:\\a.png' }],
    ['a run of a path', startRunSchema, { id: 'a', program: 'C:\\evil.exe' }],
    ['a run with a value too long', startRunSchema, { id: 'a', values: { a: 'x'.repeat(70_000) } }],
    ['a run with an object value', startRunSchema, { id: 'a', values: { a: { b: 1 } } }],
    ['a console with no size', runResizeSchema, { runId: 'a', columns: 0, rows: 10 }],
    ['a console far too wide', runResizeSchema, { runId: 'a', columns: 5000, rows: 10 }],
    ['console input too long', runInputSchema, { runId: 'a', data: 'x'.repeat(70_000) }],
    ['a nameless profile', saveProfileSchema, { toolId: 'a', name: '', values: {} }],
    ['a run limit of zero', preferencesSchema, { historyRunLimit: 0 }],
    ['a fractional run limit', preferencesSchema, { historyRunLimit: 1.5 }],
  ])('rejects %s', (_label, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['a drive path', 'C:\\Tools\\tool.exe'],
    ['a network share', '\\\\server\\tools\\tool.exe'],
  ])('accepts %s', (_label, path) => {
    const input = { programs: [{ ...program, program: path }], scope: 'workspace' };
    expect(registerToolsSchema.safeParse(input).success).toBe(true);
  });
});

describe('RunService', () => {
  interface FakeRun {
    readonly run: ToolRun;
    finish(result: RunResult): void;
    readonly cancel: ReturnType<typeof vi.fn>;
    readonly write: ReturnType<typeof vi.fn>;
    readonly resize: ReturnType<typeof vi.fn>;
  }

  function fakeRun(): FakeRun {
    let finish: (result: RunResult) => void = () => undefined;
    const result = new Promise<RunResult>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn();
    const write = vi.fn();
    const resize = vi.fn();
    return { run: { result, cancel, write, resize }, finish, cancel, write, resize };
  }

  /** Lets a run started this tick reach the point where it can be cancelled. */
  const started = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

  const tool = (id: string): RegisteredTool =>
    ({ manifest: { id }, scope: { kind: 'global' }, directory: '' }) as unknown as RegisteredTool;

  function service(runs: FakeRun[]): { service: RunService; onChange: () => void } {
    const onChange = vi.fn();
    let next = 0;
    const created = new RunService(() => {
      const fake = runs[next];
      next += 1;
      if (fake === undefined) {
        throw new Error('No fake run left');
      }
      return fake.run;
    }, onChange);
    return { service: created, onChange };
  }

  it('keeps tools with one id in different Workspaces apart', () => {
    const { service: runs } = service([fakeRun()]);
    const scoped = { ...tool('a'), scope: { kind: 'workspace', workspaceId: 'home' } as const };

    runs.start(scoped, 'home');

    expect(runs.isRunning('workspace/home/a')).toBe(true);
    expect(runs.isRunning('global/a')).toBe(false);
    expect(runs.isWorkspaceBusy('home')).toBe(true);
    expect(runs.isWorkspaceBusy('work')).toBe(false);
  });

  it('counts a Workspace as busy with a global tool it started', () => {
    const { service: runs } = service([fakeRun()]);

    runs.start(tool('a'), 'home');

    expect(runs.isWorkspaceBusy('home')).toBe(true);
    expect(runs.isWorkspaceBusy('work')).toBe(false);
  });

  it('tracks a run from start to its result, and reports each change', async () => {
    const fake = fakeRun();
    const { service: runs, onChange } = service([fake]);

    const view = runs.start(tool('a'), 'work');
    expect(runs.isRunning('global/a')).toBe(true);
    expect(runs.list()).toEqual([view]);

    fake.finish({
      status: 'failed',
      exitCode: 3,
      durationMs: 5,
      failure: { kind: 'exit-code', message: 'x' },
    });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    expect(runs.list()).toEqual([
      {
        runId: view.runId,
        toolId: 'a',
        toolKey: 'global/a',
        status: 'failed',
        durationMs: 5,
        exitCode: 3,
        failure: { kind: 'exit-code', message: 'x' },
      },
    ]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('lets a tool run twice at once', () => {
    const { service: runs } = service([fakeRun(), fakeRun()]);

    runs.start(tool('a'), 'work');
    runs.start(tool('a'), 'work');

    expect(runs.activeCount).toBe(2);
  });

  it('keeps only the latest finished run of a tool', async () => {
    const [first, second] = [fakeRun(), fakeRun()];
    const { service: runs } = service([first, second]);
    runs.start(tool('a'), 'work');
    first.finish({ status: 'completed', exitCode: 0, durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });
    runs.start(tool('a'), 'work');
    second.finish({ status: 'cancelled', durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    expect(runs.list().map((view) => view.status)).toEqual(['cancelled']);
  });

  it('cancels one run by id, ignoring ids it does not know', async () => {
    const fake = fakeRun();
    const { service: runs } = service([fake]);
    const { runId } = runs.start(tool('a'), 'work');
    await started();

    runs.cancel('unknown');
    expect(fake.cancel).not.toHaveBeenCalled();

    runs.cancel(runId);
    expect(fake.cancel).toHaveBeenCalledOnce();
  });

  it('cancels a run asked to stop before it had started', async () => {
    const fake = fakeRun();
    const { service: runs } = service([fake]);
    const { runId } = runs.start(tool('a'), 'work');

    runs.cancel(runId);
    await started();

    expect(fake.cancel).toHaveBeenCalledOnce();
  });

  it('reports a run that could not start at all', async () => {
    const runs = new RunService(() => Promise.reject(new Error('No launcher')), vi.fn());

    runs.start(tool('a'), 'work');
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    expect(runs.list()[0]).toMatchObject({ status: 'failed', failure: { message: 'No launcher' } });
  });

  it('passes typing and size to the run', async () => {
    const fake = fakeRun();
    const { service: runs } = service([fake]);
    const { runId } = runs.start(tool('a'), 'work');
    await started();

    runs.write(runId, 'x');
    runs.resize(runId, 80, 24);

    expect(fake.write).toHaveBeenCalledWith('x');
    expect(fake.resize).toHaveBeenCalledWith(80, 24);
  });

  describe('console output', () => {
    function consoleService(): {
      runs: RunService;
      fake: FakeRun;
      write: (data: string) => void;
      progress: (percent: number) => void;
      sent: { data: string; sequence: number }[];
      onChange: ReturnType<typeof vi.fn>;
    } {
      const fake = fakeRun();
      const sent: { data: string; sequence: number }[] = [];
      const onChange = vi.fn();
      let write: (data: string) => void = () => undefined;
      let progress: (percent: number) => void = () => undefined;
      const runs = new RunService(
        (_tool, context) => {
          write = context.onOutput;
          progress = (percent) => {
            context.onProgress({ percent });
          };
          return fake.run;
        },
        onChange,
        (output) => sent.push(output),
      );
      return {
        runs,
        fake,
        sent,
        onChange,
        write: (data) => {
          write(data);
        },
        progress: (percent) => {
          progress(percent);
        },
      };
    }

    it('groups output before sending it to the shell', async () => {
      const { runs, write, sent } = consoleService();
      runs.start(tool('a'), 'work');
      await started();

      write('a');
      write('b');

      await vi.waitFor(() => {
        expect(sent).toEqual([expect.objectContaining({ data: 'ab', sequence: 1 })]);
      });
    });

    it('replays output for a console that opens late, with nothing counted twice', async () => {
      const { runs, write, sent } = consoleService();
      const { runId } = runs.start(tool('a'), 'work');
      await started();
      write('first');

      const read = runs.readOutput(runId);

      expect(read).toMatchObject({ data: 'first', sequence: 1 });
      expect(sent.at(-1)?.sequence).toBeLessThanOrEqual(read?.sequence ?? 0);
    });

    it('keeps the output of the latest finished run', async () => {
      const { runs, fake, write } = consoleService();
      const { runId } = runs.start(tool('a'), 'work');
      await started();
      write('kept');
      fake.finish({ status: 'completed', exitCode: 0, durationMs: 1 });
      await vi.waitFor(() => {
        expect(runs.activeCount).toBe(0);
      });

      expect(runs.readOutput(runId)?.data).toBe('kept');
      runs.forget('global/a');
      expect(runs.readOutput(runId)).toBeUndefined();
    });

    it('shows the latest progress on the run', async () => {
      const { runs, progress, onChange } = consoleService();
      runs.start(tool('a'), 'work');
      await started();
      const before = onChange.mock.calls.length;

      progress(10);
      progress(60);

      await vi.waitFor(() => {
        expect(onChange.mock.calls.length).toBe(before + 1);
      });
      expect(runs.list()[0]?.progress).toEqual({ percent: 60 });
    });
  });

  it('ends console runs and leaves own-window runs alone', async () => {
    const [own, inConsole] = [fakeRun(), fakeRun()];
    const { service: runs } = service([own, inConsole]);
    const windowTool = {
      ...tool('w'),
      manifest: { id: 'w', level: 0 },
    } as unknown as RegisteredTool;
    const consoleTool = {
      ...tool('c'),
      manifest: { id: 'c', level: 1 },
    } as unknown as RegisteredTool;
    runs.start(windowTool, 'work');
    runs.start(consoleTool, 'work');
    await started();
    expect(runs.consoleCount).toBe(1);

    const ended = runs.cancelConsoleRuns();
    await started();
    inConsole.finish({ status: 'cancelled', durationMs: 1 });
    await ended;

    expect(own.cancel).not.toHaveBeenCalled();
    expect(inConsole.cancel).toHaveBeenCalledOnce();
    expect(runs.isRunning('global/w')).toBe(true);
    expect(runs.isRunning('global/c')).toBe(false);
  });

  it('waits for every run when cancelling all of them', async () => {
    const [first, second] = [fakeRun(), fakeRun()];
    const { service: runs } = service([first, second]);
    runs.start(tool('a'), 'work');
    runs.start(tool('b'), 'work');
    await started();

    const all = runs.cancelAll();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();

    first.finish({ status: 'cancelled', durationMs: 1 });
    second.finish({ status: 'cancelled', durationMs: 1 });
    await all;
    expect(runs.activeCount).toBe(0);
  });

  it('forgets a removed tool', async () => {
    const fake = fakeRun();
    const { service: runs } = service([fake]);
    runs.start(tool('a'), 'work');
    fake.finish({ status: 'completed', exitCode: 0, durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    runs.forget('global/a');

    expect(runs.list()).toEqual([]);
  });
});
