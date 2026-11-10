import { describe, expect, it } from 'vitest';
import type { AutomationBlock, AutomationConnection } from '@bildora/protocol';
import type {
  HistoryAutomationRunView,
  HistorySummaryView,
  StepRunView,
} from '../../shared/ipc-contract.js';
import { timelineOf } from './run-timeline.js';

const T = 1_000_000;

const blocks: AutomationBlock[] = [
  { id: 'start', type: 'start' },
  { id: 'fork', type: 'parallel' },
  { id: 'x', type: 'run', tool: 'extract' },
  { id: 'y', type: 'wait-for-time', seconds: 5 },
  { id: 'meet', type: 'join', parallel: 'fork' },
  { id: 'check', type: 'if', condition: { match: 'all', rules: [] } as never },
  { id: 'never', type: 'run', tool: 'report' },
];

const connections: AutomationConnection[] = [
  { from: 'start', to: 'fork' },
  { from: 'fork', to: 'x' },
  { from: 'fork', to: 'y' },
  { from: 'x', to: 'meet' },
  { from: 'y', to: 'meet' },
  { from: 'meet', to: 'check' },
  { from: 'check', output: 'false', to: 'never' },
];

const paths = [
  { from: 'start', output: 'next', to: 'fork' },
  { from: 'fork', output: 'next', to: 'x' },
  { from: 'fork', output: 'next', to: 'y' },
  { from: 'x', output: 'next', to: 'meet' },
  { from: 'y', output: 'next', to: 'meet' },
  { from: 'meet', output: 'next', to: 'check' },
];

function toolRun(runId: string, startedAt: number, durationMs: number, failed = false) {
  return {
    runId,
    toolId: 'extract',
    toolName: 'Extract',
    level: 1,
    startedAt,
    durationMs,
    status: failed ? 'failed' : 'completed',
  } satisfies HistorySummaryView;
}

function view(
  steps: StepRunView[],
  toolRuns: HistorySummaryView[] = [],
  running = false,
): HistoryAutomationRunView {
  return {
    run: {
      kind: 'automation',
      runId: 'r',
      automationId: 'flow',
      automationName: 'Flow',
      trigger: 'app',
      startedAt: T,
      ...(running
        ? { status: 'running' as const }
        : { durationMs: 9000, status: 'completed' as const }),
      format: 'blocks',
      steps,
      paths,
    },
    toolRuns,
  };
}

const steps: StepRunView[] = [
  { id: 'start', state: 'completed', startedAt: T },
  { id: 'fork', state: 'completed', startedAt: T + 1 },
  {
    id: 'x',
    state: 'completed',
    startedAt: T + 2,
    durationMs: 4000,
    toolRunId: 'b',
    toolRunIds: ['a', 'b'],
  },
  { id: 'y', state: 'completed', startedAt: T + 2, durationMs: 5000 },
  { id: 'meet', state: 'completed', startedAt: T + 5002 },
  { id: 'check', state: 'completed', startedAt: T + 5003 },
  { id: 'never', state: 'skipped' },
];

describe('timelineOf', () => {
  const tries = [toolRun('a', T + 2, 1000, true), toolRun('b', T + 2000, 2002)];

  it('orders blocks as reached, nests branches and puts skipped ones last', () => {
    const timeline = timelineOf(view(steps, tries), blocks, connections, T + 60_000);
    expect(timeline.rows.map(({ id, depth }) => `${id}:${String(depth)}`)).toEqual([
      'start:0',
      'fork:0',
      'x:1',
      'y:1',
      'meet:0',
      'check:0',
      'never:0',
    ]);
    expect(timeline.start).toBe(T);
    expect(timeline.end).toBe(T + 9000);
  });

  it('gives a retried block one segment per try, and a skipped block none', () => {
    const { rows } = timelineOf(view(steps, tries), blocks, connections, T);
    const x = rows.find(({ id }) => id === 'x');
    expect(x?.tries.map(({ runId }) => runId)).toEqual(['a', 'b']);
    expect(x?.segments).toEqual([
      { from: 2, to: 1002, state: 'failed' },
      { from: 2000, to: 4002, state: 'completed' },
    ]);
    expect(x?.toolName).toBe('Extract');
    expect(rows.find(({ id }) => id === 'never')?.segments).toEqual([]);
    expect(rows.find(({ id }) => id === 'meet')?.segments).toEqual([
      { from: 5002, to: 5002, state: 'completed' },
    ]);
    expect(rows.find(({ id }) => id === 'start')?.taken).toEqual(['next']);
  });

  it('places an older run by its tool runs, and other blocks by the path', () => {
    const old = steps.map(({ id, state, toolRunId, durationMs }) => ({
      id,
      state,
      ...(toolRunId === undefined ? {} : { toolRunId }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }));
    const { rows } = timelineOf(view(old, tries), blocks, connections, T);
    expect(rows.map(({ id }) => id)).toEqual(['start', 'fork', 'x', 'y', 'meet', 'check', 'never']);
    expect(rows.find(({ id }) => id === 'x')?.segments).toEqual([
      { from: 2000, to: 6000, state: 'completed' },
    ]);
    expect(rows.find(({ id }) => id === 'y')?.segments).toEqual([]);
  });

  it('runs a bar on to now while a block is still going', () => {
    const live = view(
      [
        { id: 'start', state: 'completed', startedAt: T },
        { id: 'fork', state: 'running', startedAt: T + 10 },
      ],
      [],
      true,
    );
    const timeline = timelineOf(live, blocks, connections, T + 3000);
    expect(timeline.end).toBe(T + 3000);
    expect(timeline.rows.find(({ id }) => id === 'fork')?.segments).toEqual([
      { from: 10, to: 3000, state: 'running' },
    ]);
  });

  it('keeps a block no longer in the file, by its id', () => {
    const { rows } = timelineOf(view(steps, tries), [], [], T);
    expect(rows.find(({ id }) => id === 'x')).toMatchObject({ toolName: 'Extract', depth: 0 });
    expect(rows.find(({ id }) => id === 'x')?.block).toBeUndefined();
  });
});
