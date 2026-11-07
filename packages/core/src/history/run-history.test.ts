import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefinitionError } from '../storage/definition-error.js';
import { RunHistory } from './run-history.js';
import type { RunStart } from './run-history.js';

const W = 'work';

function run(number: number, toolId = 'tool'): RunStart {
  return {
    workspaceId: W,
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
    expect(history.get(W, 'run-1')).toMatchObject({ status: 'running', output: '' });

    history.finish('run-1', {
      status: 'failed',
      exitCode: 3,
      durationMs: 25,
      failure: { kind: 'exit-code', message: 'code 3' },
      output: 'text',
      outputTruncated: true,
    });

    expect(history.get(W, 'run-1')).toMatchObject({
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

    expect(history.list(W)).toHaveLength(1);
  });

  it('lists newest first and by tool, without the output', () => {
    history.start(run(1, 'a'));
    history.start(run(2, 'b'));

    expect(history.list(W).map((item) => item.runId)).toEqual(['run-2', 'run-1']);
    expect(history.list(W, 'a').map((item) => item.runId)).toEqual(['run-1']);
    expect(history.list(W)[0]).not.toHaveProperty('output');
  });

  it('marks what was left running as interrupted', () => {
    history.start(run(1));
    history.start(run(2));
    history.finish('run-2', { status: 'completed', exitCode: 0, durationMs: 1 });

    expect(history.recoverInterrupted()).toBe(1);

    expect(history.get(W, 'run-1')?.status).toBe('interrupted');
    expect(history.get(W, 'run-2')?.status).toBe('completed');
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

    expect(history.prune(W, 'tool', 2)).toBe(1);

    expect(
      history
        .list(W)
        .map((item) => item.runId)
        .sort(),
    ).toEqual(['run-1', 'run-3', 'run-4', 'run-5']);
  });

  it('names the tools run most recently', () => {
    history.start(run(1, 'a'));
    history.start(run(2, 'b'));
    history.start(run(3, 'a'));

    expect(history.recentToolIds(W, 5)).toEqual(['a', 'b']);
    expect(history.recentToolIds(W, 1)).toEqual(['a']);
  });

  it('clears finished runs only', () => {
    history.start(run(1));
    history.start(run(2));
    history.finish('run-2', { status: 'completed', durationMs: 1 });

    history.clear(W);

    expect(history.list(W).map((item) => item.runId)).toEqual(['run-1']);
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
    untouched.pragma('user_version = 2');
    untouched.close();
    history = await RunHistory.open(dataDir);
  });
});

describe('RunHistory across Workspaces', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-history-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps each Workspace apart, even for one tool', async () => {
    const history = await RunHistory.open(dataDir);
    history.start(run(1));
    history.start({ ...run(2), workspaceId: 'home' });
    history.finish('run-1', { status: 'completed', exitCode: 0, durationMs: 1 });
    history.finish('run-2', { status: 'completed', exitCode: 0, durationMs: 1 });

    expect(history.list(W).map((item) => item.runId)).toEqual(['run-1']);
    expect(history.list('home', 'tool').map((item) => item.runId)).toEqual(['run-2']);
    expect(history.get(W, 'run-2')).toBeUndefined();
    expect(history.recentToolIds('other', 5)).toEqual([]);

    expect(history.prune(W, 'tool', 0)).toBe(1);
    expect(history.list('home')).toHaveLength(1);
    history.clear('home');
    expect(history.list('home')).toEqual([]);
    history.close();
  });

  it('applies a lower limit per Workspace and forgets a deleted one', async () => {
    const history = await RunHistory.open(dataDir);
    for (const number of [1, 2]) {
      history.start(run(number));
      history.finish(`run-${String(number)}`, { status: 'failed', durationMs: 1 });
    }
    history.start({ ...run(3), workspaceId: 'home' });
    history.finish('run-3', { status: 'failed', durationMs: 1 });

    history.pruneAll(1);
    expect(history.list(W)).toHaveLength(1);
    expect(history.list('home')).toHaveLength(1);

    history.removeWorkspace('home');
    expect(history.list('home')).toEqual([]);
    expect(history.list(W)).toHaveLength(1);
    history.close();
  });

  it('upgrades a file from before Workspaces, moving its runs to the default one', async () => {
    const { default: Connection } = await import('better-sqlite3');
    const old = new Connection(join(dataDir, 'history.db'));
    old.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        level INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms REAL,
        failure_kind TEXT,
        failure_message TEXT,
        parameters TEXT NOT NULL,
        output TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX runs_by_tool ON runs (tool_id, started_at DESC);
      CREATE INDEX runs_by_time ON runs (started_at DESC);
      INSERT INTO runs (id, tool_id, tool_name, level, started_at, status, parameters)
      VALUES ('old', 'tool', 'Tool', 1, 5, 'completed', '[]');
    `);
    old.pragma('user_version = 1');
    old.close();

    const history = await RunHistory.open(dataDir);
    expect(history.get('default', 'old')).toMatchObject({ toolId: 'tool', status: 'completed' });
    history.start(run(1));
    expect(history.list(W)).toHaveLength(1);
    history.close();

    const again = await RunHistory.open(dataDir);
    expect(again.list('default')).toHaveLength(1);
    again.close();
  });
});
