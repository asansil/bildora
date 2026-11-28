import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSchema, toolManifestSchema } from '@bildora/protocol';
import type { Automation } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from '../history/run-history.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import type { RunResult } from '../runner/run-tool.js';
import { startAutomationRun } from './run-automation.js';
import type { AutomationRunOptions, StepStarter } from './run-automation.js';
import { latestBaseRun, planTest, readBaseRun } from './test-run.js';

const COMPLETED: RunResult = { status: 'completed', exitCode: 0, durationMs: 1 };

const sample: RegisteredTool = {
  scope: { kind: 'global' },
  directory: 'C:\\tools',
  manifest: toolManifestSchema.parse({
    schemaVersion: 1,
    id: 'sample',
    name: 'sample',
    version: '1.0.0',
    level: 1,
    run: { program: 'C:\\tools\\tool.exe' },
    parameters: [
      { name: 'out', type: 'path', label: 'Out', flag: '--out' },
      { name: 'in', type: 'path', label: 'In', flag: '--in' },
    ],
    outputs: [{ name: 'csv', param: 'out' }],
  }),
};

/** start → A → B → C, where each block reads the file the one before it wrote. */
function chain(extra: Partial<Automation> = {}): Automation {
  return automationSchema.parse({
    schemaVersion: 2,
    id: 'flow',
    name: 'Flow',
    blocks: [
      { id: 'start', type: 'start', inputs: [{ name: 'day', type: 'string', default: 'mon' }] },
      { id: 'A', type: 'run', tool: 'sample', values: { out: { expression: 'inputs.day' } } },
      {
        id: 'B',
        type: 'run',
        tool: 'sample',
        values: { in: { expression: 'steps.A.outputs.csv' }, out: 'b.csv' },
      },
      {
        id: 'C',
        type: 'run',
        tool: 'sample',
        values: { in: { expression: 'steps.B.outputs.csv' }, out: 'c.csv' },
      },
    ],
    connections: [
      { from: 'start', to: 'A' },
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ],
    ...extra,
  });
}

describe('testing a block', () => {
  let dataDir: string;
  let history: RunHistory;
  let started: { tool: string; values: Readonly<Record<string, unknown>> }[];

  const startStep: StepStarter = (tool, { values }) => {
    started.push({ tool: tool.manifest.id, values });
    const toolRun: RecordedToolRun = {
      runId: `tool-run-${String(started.length)}`,
      parameters: Object.entries(values).map(([name, value]) => ({
        name,
        label: name,
        value: value as string,
      })),
      result: Promise.resolve(COMPLETED),
      cancel: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    };
    return Promise.resolve(toolRun);
  };

  function start(automation: Automation, extra: Partial<AutomationRunOptions> = {}) {
    return startAutomationRun({
      automation,
      workspaceId: 'work',
      trigger: 'app',
      dataDir,
      history,
      startStep,
      findTool: () => Promise.resolve(sample),
      delay: () => Promise.resolve(),
      ...extra,
    });
  }

  async function base(automation: Automation) {
    const latest = latestBaseRun(history.listAutomationRuns('work', automation.id));
    if (latest === undefined) throw new Error('No run to reuse');
    return readBaseRun(history, automation, latest);
  }

  const environment = {
    tools: new Map([
      ['A', sample],
      ['B', sample],
      ['C', sample],
    ]),
    profiles: new Map(),
    pathVariables: new Map<string, string>(),
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-test-run-'));
    history = await RunHistory.open(dataDir);
    started = [];
  });

  afterEach(async () => {
    history.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('runs from a block onward, reusing what the blocks before it left', async () => {
    const automation = chain();
    const first = await start(automation, { inputs: { day: 'fri' } }).result;
    started = [];

    const result = await start(automation, {
      test: { kind: 'from', blockId: 'B', base: await base(automation) },
    }).result;

    expect(result.failure).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(started.map(({ values }) => values)).toEqual([
      { in: 'fri', out: 'b.csv' },
      { in: 'b.csv', out: 'c.csv' },
    ]);
    const [test] = history.listAutomationRuns('work', 'flow');
    expect(test).toMatchObject({
      test: { kind: 'from', blockId: 'B', baseRunId: first.runId },
      folderRunId: first.runId,
    });
    expect(test?.steps.map(({ id, state, reused }) => [id, state, reused])).toEqual([
      ['start', 'completed', true],
      ['A', 'completed', true],
      ['B', 'completed', undefined],
      ['C', 'completed', undefined],
    ]);
  });

  it('tests one block with typed values, and goes no further', async () => {
    const automation = chain();
    await start(automation).result;
    started = [];

    const result = await start(automation, {
      test: { kind: 'block', blockId: 'B', base: await base(automation), values: { out: 'x.csv' } },
    }).result;

    expect(result.status).toBe('completed');
    expect(started.map(({ values }) => values)).toEqual([{ in: 'mon', out: 'x.csv' }]);
    const [test] = history.listAutomationRuns('work', 'flow');
    expect(test?.paths).toContainEqual({ from: 'B', output: 'next', to: 'C' });
    expect(test?.steps.find(({ id }) => id === 'C')).toMatchObject({ reused: true });
  });

  it('starts the next test from what the previous test left', async () => {
    const automation = chain();
    await start(automation).result;
    await start(automation, {
      test: { kind: 'block', blockId: 'B', base: await base(automation), values: { out: 'x.csv' } },
    }).result;
    started = [];

    await start(automation, {
      test: { kind: 'from', blockId: 'C', base: await base(automation) },
    }).result;

    expect(started.map(({ values }) => values)).toEqual([{ in: 'x.csv', out: 'c.csv' }]);
  });

  it('plans Test block fields from the base run, and from typing with no run', async () => {
    const automation = chain();
    const request = { kind: 'block', blockId: 'B', dataDir, workspaceId: 'work' } as const;

    expect(planTest(automation, undefined, request, environment)).toEqual({
      fields: [
        { name: 'out', value: 'b.csv' },
        { name: 'in', missing: 'In: Step "A" did not produce output "csv"' },
      ],
    });

    await start(automation).result;
    expect(planTest(automation, await base(automation), request, environment).fields).toEqual([
      { name: 'out', value: 'b.csv' },
      { name: 'in', value: 'mon' },
    ]);
  });

  it('says why Run from here cannot start', async () => {
    const automation = chain();
    const plan = (blockId: string, withBase: Awaited<ReturnType<typeof base>> | undefined) =>
      planTest(
        automation,
        withBase,
        { kind: 'from', blockId, dataDir, workspaceId: 'work' },
        environment,
      ).blocker;

    expect(plan('start', undefined)).toEqual({ code: 'start' });
    expect(plan('B', undefined)).toEqual({ code: 'no-run' });

    // A run that stopped at A leaves B nothing to read.
    await startAutomationRun({
      automation,
      workspaceId: 'work',
      trigger: 'app',
      dataDir,
      history,
      startStep: (tool, request) =>
        startStep(tool, request).then((run) => ({
          ...run,
          result: Promise.resolve<RunResult>({
            status: 'failed',
            exitCode: 2,
            durationMs: 1,
            failure: { kind: 'exit-code', message: 'The tool exited with code 2' },
          }),
        })),
      findTool: () => Promise.resolve(sample),
    }).result;
    expect(plan('B', await base(automation))).toEqual({
      code: 'value-missing',
      block: 'A',
      why: 'failed',
    });
    expect(plan('C', await base(automation))).toEqual({
      code: 'value-missing',
      block: 'B',
      why: 'not-run',
    });
  });
});
