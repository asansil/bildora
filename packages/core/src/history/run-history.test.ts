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
    untouched.pragma('user_version = 4');
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

describe('RunHistory with several processes', () => {
  let dataDir: string;
  let history: RunHistory;

  const run = {
    workspaceId: 'work',
    toolId: 'sample',
    toolName: 'Sample',
    level: 1,
    startedAt: 1,
    parameters: [],
  };
  const automationRun = {
    workspaceId: 'work',
    automationId: 'flow',
    automationName: 'Flow',
    trigger: 'cli' as const,
    startedAt: 1,
    steps: [{ id: 'first', state: 'running' as const }],
  };

  async function setOwner(table: string, pid: number | null): Promise<void> {
    const { default: Connection } = await import('better-sqlite3');
    const other = new Connection(join(dataDir, 'history.db'));
    other.prepare(`UPDATE ${table} SET owner_pid = ?`).run(pid);
    other.close();
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-owners-'));
    history = await RunHistory.open(dataDir);
  });

  afterEach(async () => {
    history.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('leaves alone what a live process is still running', async () => {
    history.start({ ...run, runId: 'a' });
    history.startAutomationRun({ ...automationRun, runId: 'b' });
    await setOwner('runs', 4242);
    await setOwner('automation_runs', 4242);

    expect(history.recoverInterrupted((pid) => pid === 4242)).toBe(0);
    expect(history.get('work', 'a')?.status).toBe('running');
    expect(history.listAutomationRuns('work', 'flow')[0]?.status).toBe('running');
  });

  it('marks what a process left behind when it went', async () => {
    history.start({ ...run, runId: 'a' });
    history.start({ ...run, runId: 'b' });
    history.startAutomationRun({ ...automationRun, runId: 'c' });
    await setOwner('runs', 4242);
    await setOwner('automation_runs', 4242);

    expect(history.recoverInterrupted(() => false)).toBe(3);
    expect(history.get('work', 'a')?.status).toBe('interrupted');
    expect(history.listAutomationRuns('work', 'flow')[0]?.status).toBe('interrupted');
  });

  it('marks rows from before owners were kept, and rows with a reused id', async () => {
    history.start({ ...run, runId: 'a' });
    await setOwner('runs', null);
    expect(history.recoverInterrupted(() => true)).toBe(1);

    history.start({ ...run, runId: 'b' });
    expect(history.recoverInterrupted(() => true)).toBe(1);
  });

  it('upgrades a file from version 2, keeping its runs', async () => {
    history.start({ ...run, runId: 'a' });
    history.finish('a', { status: 'completed', exitCode: 0, durationMs: 5 });
    history.close();
    const { default: Connection } = await import('better-sqlite3');
    const old = new Connection(join(dataDir, 'history.db'));
    old.exec(
      'DROP TABLE automation_runs; ALTER TABLE runs DROP COLUMN automation_run_id; ALTER TABLE runs DROP COLUMN owner_pid;',
    );
    old.pragma('user_version = 2');
    old.close();

    history = await RunHistory.open(dataDir);
    expect(history.get('work', 'a')?.status).toBe('completed');
    history.startAutomationRun({ ...automationRun, runId: 'b' });
    expect(history.listAutomationRuns('work', 'flow')).toHaveLength(1);
  });

  it('stores a run and its failure, and reads them back', () => {
    history.startAutomationRun({ ...automationRun, runId: 'a' });
    history.updateAutomationSteps('a', [{ id: 'first', state: 'completed' }], []);
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps).toEqual([
      { id: 'first', state: 'completed' },
    ]);
    const failure = { stepId: 'first', kind: 'exit-code', message: 'Exited with 3' };
    history.finishAutomationRun('a', {
      status: 'failed',
      durationMs: 9,
      failure,
      steps: [{ id: 'first', state: 'failed' }],
      paths: [{ from: 'start', output: 'next', to: 'first' }],
    });
    expect(history.listAutomationRuns('work', 'flow')[0]).toMatchObject({
      status: 'failed',
      durationMs: 9,
      failure,
      trigger: 'cli',
      format: 'blocks',
      paths: [{ from: 'start', output: 'next', to: 'first' }],
    });
  });

  it('upgrades a file from version 3, showing the runs it holds as the steps they were', async () => {
    history.startAutomationRun({ ...automationRun, runId: 'old' });
    history.close();
    const { default: Connection } = await import('better-sqlite3');
    const old = new Connection(join(dataDir, 'history.db'));
    old.exec(
      'ALTER TABLE automation_runs DROP COLUMN format; ALTER TABLE automation_runs DROP COLUMN paths;',
    );
    old.pragma('user_version = 3');
    old.close();

    history = await RunHistory.open(dataDir);
    expect(history.listAutomationRuns('work', 'flow')[0]).toMatchObject({
      runId: 'old',
      format: 'steps',
      paths: [],
    });
    history.startAutomationRun({ ...automationRun, runId: 'new' });
    expect(
      history.listAutomationRuns('work', 'flow').map(({ runId, format }) => [runId, format]),
    ).toEqual(
      expect.arrayContaining([
        ['old', 'steps'],
        ['new', 'blocks'],
      ]),
    );
  });

  it('keeps a skipped block and treats damaged paths as none', async () => {
    history.startAutomationRun({ ...automationRun, runId: 'a' });
    history.updateAutomationSteps('a', [{ id: 'later', state: 'skipped' }], []);
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps).toEqual([
      { id: 'later', state: 'skipped' },
    ]);
    history.close();
    const { default: Connection } = await import('better-sqlite3');
    const raw = new Connection(join(dataDir, 'history.db'));
    raw.exec("UPDATE automation_runs SET paths = 'not json'");
    raw.close();
    history = await RunHistory.open(dataDir);
    expect(history.listAutomationRuns('work', 'flow')[0]?.paths).toEqual([]);
  });

  it('keeps the newest runs of an automation, never one still going', () => {
    for (const runId of ['a', 'b', 'c']) {
      history.startAutomationRun({ ...automationRun, runId });
      if (runId !== 'a') {
        history.finishAutomationRun(runId, {
          status: 'completed',
          durationMs: 1,
          steps: [],
          paths: [],
        });
      }
    }
    expect(history.pruneAutomationRuns('work', 'flow', 1)).toEqual([
      { workspaceId: 'work', automationId: 'flow', runId: 'b' },
    ]);
    expect(history.listAutomationRuns('work', 'flow').map(({ runId }) => runId)).toEqual([
      'c',
      'a',
    ]);
  });

  it('applies a lower limit, clears and forgets automation runs too', () => {
    for (const runId of ['a', 'b']) {
      history.startAutomationRun({ ...automationRun, runId });
      history.finishAutomationRun(runId, {
        status: 'completed',
        durationMs: 1,
        steps: [],
        paths: [],
      });
    }
    expect(history.pruneAll(1).map(({ runId }) => runId)).toEqual(['a']);
    expect(history.clear('work').map(({ runId }) => runId)).toEqual(['b']);
    history.startAutomationRun({ ...automationRun, runId: 'c' });
    history.removeWorkspace('work');
    expect(history.listAutomationRuns('work', 'flow')).toEqual([]);
  });

  it('names the automation a run was a step of, while its record lasts', () => {
    history.startAutomationRun({ ...automationRun, runId: 'a' });
    history.start({ ...run, runId: 'step', automationRunId: 'a' });
    history.start({ ...run, runId: 'alone', startedAt: 0 });
    const origin = { runId: 'a', id: 'flow', name: 'Flow' };
    expect(history.list('work').map(({ runId, automation }) => ({ runId, automation }))).toEqual([
      { runId: 'step', automation: origin },
      { runId: 'alone', automation: undefined },
    ]);
    expect(history.get('work', 'step')?.automation).toEqual(origin);
    expect(history.get('work', 'step')?.parameters).toEqual([]);
    history.removeAutomation('work', 'flow');
    expect(history.get('work', 'step')?.automation).toEqual({ runId: 'a' });
    expect(history.list('work', 'sample')[0]?.automation).toEqual({ runId: 'a' });
  });

  it('lists an automation run in place of its steps, and keeps a step whose run is gone', () => {
    history.startAutomationRun({ ...automationRun, runId: 'a', startedAt: 10 });
    history.start({ ...run, runId: 'try-1', automationRunId: 'a', startedAt: 11 });
    history.start({ ...run, runId: 'try-2', automationRunId: 'a', startedAt: 12 });
    history.start({ ...run, runId: 'by-hand', toolId: 'other', startedAt: 20 });
    history.startAutomationRun({
      ...automationRun,
      runId: 'b',
      automationId: 'other-flow',
      startedAt: 5,
    });
    history.start({ ...run, runId: 'orphan', automationRunId: 'gone', startedAt: 1 });
    const summary = (entries: ReturnType<RunHistory['entries']>): string[] =>
      entries.map((entry) => `${entry.kind}:${entry.runId}`);

    expect(summary(history.entries('work'))).toEqual([
      'tool:by-hand',
      'automation:a',
      'automation:b',
      'tool:orphan',
    ]);
    expect(summary(history.entries('work', { toolId: 'sample' }))).toEqual([
      'automation:a',
      'tool:orphan',
    ]);
    expect(summary(history.entries('work', { automationId: 'flow' }))).toEqual(['automation:a']);
    expect(history.entries('elsewhere')).toEqual([]);
    expect(history.stepRuns('work', 'a').map(({ runId }) => runId)).toEqual(['try-1', 'try-2']);
    expect(history.getAutomationRun('work', 'a')).toMatchObject({ automationName: 'Flow' });
    expect(history.getAutomationRun('elsewhere', 'a')).toBeUndefined();
  });
});
