import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefinitionError } from '../storage/definition-error.js';
import { RunHistory } from './run-history.js';
import type { RunStart } from './run-history.js';

function run(number: number, toolId = 'tool'): RunStart {
  return {
    runId: `run-${String(number)}`,
    toolId,
    toolName: 'Tool',
    level: 1,
    startedAt: 1000 + number,
    parameters: [{ name: 'input', label: 'Input', value: 'a.txt' }],
  };
}

describe('RunHistory', () => {
  let dataDir: string;
  let history: RunHistory;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-history-'));
    history = await RunHistory.open(dataDir);
  });

  afterEach(async () => {
    history.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records a run from start to finish', () => {
    history.start(run(1));
    expect(history.get('run-1')).toMatchObject({ status: 'running', output: '' });

    history.finish('run-1', {
      status: 'failed',
      exitCode: 3,
      durationMs: 25,
      failure: { kind: 'exit-code', message: 'code 3' },
      output: 'text',
      outputTruncated: true,
    });

    expect(history.get('run-1')).toMatchObject({
      toolName: 'Tool',
      status: 'failed',
      exitCode: 3,
      durationMs: 25,
      failure: { kind: 'exit-code', message: 'code 3' },
      parameters: [{ name: 'input', value: 'a.txt' }],
      output: 'text',
      outputTruncated: true,
    });
  });

  it('survives closing and opening again', async () => {
    history.start(run(1));
    history.close();
    history = await RunHistory.open(dataDir);

    expect(history.list()).toHaveLength(1);
  });

  it('lists newest first and by tool, without the output', () => {
    history.start(run(1, 'a'));
    history.start(run(2, 'b'));

    expect(history.list().map((item) => item.runId)).toEqual(['run-2', 'run-1']);
    expect(history.list('a').map((item) => item.runId)).toEqual(['run-1']);
    expect(history.list()[0]).not.toHaveProperty('output');
  });

  it('marks what was left running as interrupted', () => {
    history.start(run(1));
    history.start(run(2));
    history.finish('run-2', { status: 'completed', exitCode: 0, durationMs: 1 });

    expect(history.recoverInterrupted()).toBe(1);

    expect(history.get('run-1')?.status).toBe('interrupted');
    expect(history.get('run-2')?.status).toBe('completed');
  });

  it('prunes the oldest finished runs of one tool, and never a running one', () => {
    for (const number of [1, 2, 3, 4]) {
      history.start(run(number));
      if (number !== 1) {
        history.finish(`run-${String(number)}`, { status: 'completed', durationMs: 1 });
      }
    }
    history.start(run(5, 'other'));
    history.finish('run-5', { status: 'completed', durationMs: 1 });

    expect(history.prune('tool', 2)).toBe(1);

    expect(
      history
        .list()
        .map((item) => item.runId)
        .sort(),
    ).toEqual(['run-1', 'run-3', 'run-4', 'run-5']);
  });

  it('names the tools run most recently', () => {
    history.start(run(1, 'a'));
    history.start(run(2, 'b'));
    history.start(run(3, 'a'));

    expect(history.recentToolIds(5)).toEqual(['a', 'b']);
    expect(history.recentToolIds(1)).toEqual(['a']);
  });

  it('clears finished runs only', () => {
    history.start(run(1));
    history.start(run(2));
    history.finish('run-2', { status: 'completed', durationMs: 1 });

    history.clear();

    expect(history.list().map((item) => item.runId)).toEqual(['run-1']);
  });

  it('refuses a file from a newer build, and leaves it alone', async () => {
    history.close();
    const { default: Connection } = await import('better-sqlite3');
    const file = join(dataDir, 'history.db');
    const newer = new Connection(file);
    newer.pragma('user_version = 99');
    newer.close();

    await expect(RunHistory.open(dataDir)).rejects.toBeInstanceOf(DefinitionError);

    const untouched = new Connection(file);
    expect(untouched.pragma('user_version', { simple: true })).toBe(99);
    untouched.pragma('user_version = 1');
    untouched.close();
    history = await RunHistory.open(dataDir);
  });
});
