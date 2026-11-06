import { describe, expect, it, vi } from 'vitest';
import type { RegisteredTool, RunResult, ToolRun } from '@bildora/core';
import {
  detectPathsSchema,
  editCommandSchema,
  noInputSchema,
  preferencesSchema,
  registerToolsSchema,
  toolIdSchema,
  updateToolSchema,
} from '../shared/ipc-contract.js';
import { RunService } from './run-service.js';
import { isTrustedSender } from './trusted-sender.js';

const rendererUrl = 'file:///C:/app/out/renderer/index.html';

describe('isTrustedSender', () => {
  it.each([
    ['the shell page', rendererUrl, true],
    ['the shell page with a hash', `${rendererUrl}#tool`, true],
    ['another local file', 'file:///C:/temp/evil.html', false],
    ['a remote page', 'https://example.com/index.html', false],
    ['a tool panel', 'bildora-panel://acme.tool/index.html', false],
    ['nothing', undefined, false],
    ['something that is not a URL', 'nonsense', false],
  ])('for %s', (_label, url, expected) => {
    expect(isTrustedSender(url, rendererUrl)).toBe(expected);
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
    ['a relative program', registerToolsSchema, { programs: [{ ...program, program: 'a.exe' }] }],
    ['a nameless program', registerToolsSchema, { programs: [{ ...program, name: '' }] }],
    ['an extra field', registerToolsSchema, { programs: [{ ...program, level: 2 }] }],
    ['an update that moves the program', updateToolSchema, { id: 'a', details: program }],
    ['a launch by path', toolIdSchema, { path: 'C:\\evil.exe' }],
    ['an unknown theme', preferencesSchema, { theme: 'pink' }],
  ])('rejects %s', (_label, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['a drive path', 'C:\\Tools\\tool.exe'],
    ['a network share', '\\\\server\\tools\\tool.exe'],
  ])('accepts %s', (_label, path) => {
    const input = { programs: [{ ...program, program: path }] };
    expect(registerToolsSchema.safeParse(input).success).toBe(true);
  });
});

describe('RunService', () => {
  interface FakeRun {
    readonly run: ToolRun;
    finish(result: RunResult): void;
    readonly cancel: ReturnType<typeof vi.fn>;
  }

  function fakeRun(): FakeRun {
    let finish: (result: RunResult) => void = () => undefined;
    const result = new Promise<RunResult>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn();
    return { run: { result, cancel }, finish, cancel };
  }

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

  it('tracks a run from start to its result, and reports each change', async () => {
    const fake = fakeRun();
    const { service: runs, onChange } = service([fake]);

    const view = runs.start(tool('a'));
    expect(runs.isRunning('a')).toBe(true);
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

    runs.start(tool('a'));
    runs.start(tool('a'));

    expect(runs.activeCount).toBe(2);
  });

  it('keeps only the latest finished run of a tool', async () => {
    const [first, second] = [fakeRun(), fakeRun()];
    const { service: runs } = service([first, second]);
    runs.start(tool('a'));
    first.finish({ status: 'completed', exitCode: 0, durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });
    runs.start(tool('a'));
    second.finish({ status: 'cancelled', durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    expect(runs.list().map((view) => view.status)).toEqual(['cancelled']);
  });

  it('cancels one run by id, ignoring ids it does not know', () => {
    const fake = fakeRun();
    const { service: runs } = service([fake]);
    const { runId } = runs.start(tool('a'));

    runs.cancel('unknown');
    expect(fake.cancel).not.toHaveBeenCalled();

    runs.cancel(runId);
    expect(fake.cancel).toHaveBeenCalledOnce();
  });

  it('waits for every run when cancelling all of them', async () => {
    const [first, second] = [fakeRun(), fakeRun()];
    const { service: runs } = service([first, second]);
    runs.start(tool('a'));
    runs.start(tool('b'));

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
    runs.start(tool('a'));
    fake.finish({ status: 'completed', exitCode: 0, durationMs: 1 });
    await vi.waitFor(() => {
      expect(runs.activeCount).toBe(0);
    });

    runs.forget('a');

    expect(runs.list()).toEqual([]);
  });
});
