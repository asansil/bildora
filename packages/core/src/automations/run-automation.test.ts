import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automationV1Schema, automationSchema, toolManifestSchema } from '@bildora/protocol';
import type { Automation, AutomationV1Input } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from '../history/run-history.js';
import { saveProfile } from '../profiles/profile-store.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import type { RunResult } from '../runner/run-tool.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { convertAutomationV1 } from './convert-v1.js';
import { startAutomationRun } from './run-automation.js';
import type { AutomationRunOptions, ManualAnswer, StepStarter } from './run-automation.js';
import { startToolRun } from './tool-starter.js';

const COMPLETED: RunResult = { status: 'completed', exitCode: 0, durationMs: 1 };

function failedResult(code = 1): RunResult {
  return {
    status: 'failed',
    exitCode: code,
    durationMs: 1,
    failure: { kind: 'exit-code', message: `The tool exited with code ${String(code)}` },
  };
}

function tool(id: string, extra: Record<string, unknown> = {}): RegisteredTool {
  return {
    scope: { kind: 'global' },
    directory: 'C:\\tools',
    manifest: toolManifestSchema.parse({
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      level: 1,
      run: { program: 'C:\\tools\\tool.exe' },
      parameters: [
        { name: 'out', type: 'path', label: 'Out', flag: '--out' },
        { name: 'in', type: 'path', label: 'In', flag: '--in' },
        { name: 'note', type: 'string', label: 'Note', flag: '--note' },
      ],
      outputs: [
        { name: 'csv', param: 'out' },
        { name: 'log', path: 'logs/{{paths.name}}.log' },
      ],
      ...extra,
    }),
  };
}

/** An automation as blocks, from the list of steps it used to be written as. */
function automationOf(steps: AutomationV1Input['steps'], id = 'flow', name = 'Flow'): Automation {
  const converted = convertAutomationV1(
    automationV1Schema.parse({ schemaVersion: 1, id, name, steps }),
  );
  if (!converted.ok) {
    throw new Error(converted.problems.join(' '));
  }
  return converted.automation;
}

const run = (id: string, extra: object = {}): AutomationV1Input['steps'][number] => ({
  id,
  type: 'run',
  tool: 'sample',
  ...extra,
});

/** One block of a run, by id, whatever its place in the list. */
function stepOf<T extends { readonly id: string }>(
  steps: readonly T[] | undefined,
  id: string,
): T | undefined {
  return steps?.find((step) => step.id === id);
}

/** A tool run a test ends by hand, with what it was started with. */
interface FakeRun {
  readonly values: Readonly<Record<string, unknown>>;
  finish(result: RunResult): void;
  cancelled: boolean;
}

describe('startAutomationRun', () => {
  let dataDir: string;
  let history: RunHistory;
  let started: FakeRun[];
  /** Results for the next tool runs. With none left, a run stays open until a test ends it. */
  let script: RunResult[];

  const startStep: StepStarter = (_tool, { values }) => {
    let finish: (result: RunResult) => void = () => undefined;
    const result = new Promise<RunResult>((resolve) => {
      finish = resolve;
    });
    const fake: FakeRun = { values, finish, cancelled: false };
    started.push(fake);
    const planned = script.shift();
    if (planned !== undefined) {
      finish(planned);
    }
    const toolRun: RecordedToolRun = {
      runId: `tool-run-${String(started.length)}`,
      parameters: Object.entries(values).map(([name, value]) => ({
        name,
        label: name,
        value: value as string,
      })),
      result,
      cancel: () => {
        fake.cancelled = true;
        finish({ status: 'cancelled', durationMs: 1 });
      },
      write: () => undefined,
      resize: () => undefined,
    };
    return Promise.resolve(toolRun);
  };

  function start(automation: Automation, extra: Partial<AutomationRunOptions> = {}) {
    return startAutomationRun({
      automation,
      workspaceId: 'work',
      trigger: 'cli',
      dataDir,
      history,
      startStep,
      findTool: (id) => Promise.resolve(tool(id)),
      delay: () => Promise.resolve(),
      ...extra,
    });
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !condition(); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-automation-'));
    history = await RunHistory.open(dataDir);
    started = [];
    script = [];
  });

  afterEach(async () => {
    history.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a flow saved half built, before anything runs', () => {
    const halfBuilt: Automation = {
      schemaVersion: 2,
      id: 'half',
      name: 'Half',
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'fork', type: 'parallel' },
      ],
      connections: [{ from: 'start', to: 'fork' }],
    };
    expect(() => start(halfBuilt)).toThrow('Parallel "fork" needs at least two branches');
    expect(started).toEqual([]);
  });

  it('runs steps in order and records the run', async () => {
    script = [COMPLETED, COMPLETED];
    const automation = automationOf([
      run('first'),
      { id: 'pause', type: 'wait-for-time', seconds: 5 },
      run('second'),
    ]);
    const result = await start(automation).result;

    expect(result).toMatchObject({ status: 'completed', failedSteps: [] });
    expect(result.failure).toBeUndefined();
    expect(started).toHaveLength(2);
    const [recorded] = history.listAutomationRuns('work', 'flow');
    expect(recorded).toMatchObject({ status: 'completed', trigger: 'cli', automationName: 'Flow' });
    expect(recorded?.steps.map(({ id, state }) => [id, state])).toEqual([
      ['start', 'completed'],
      ['first', 'completed'],
      ['pause', 'completed'],
      ['second', 'completed'],
    ]);
    const times = recorded?.steps.map(({ startedAt }) => startedAt ?? -1) ?? [];
    expect(times.every((time) => time >= (recorded?.startedAt ?? Infinity))).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('stops at a failed step by default, leaving later steps idle', async () => {
    script = [failedResult(3)];
    const result = await start(automationOf([run('first'), run('second')])).result;

    expect(result).toMatchObject({
      status: 'failed',
      failedSteps: ['first'],
      failure: { stepId: 'first', kind: 'exit-code' },
    });
    expect(started).toHaveLength(1);
    expect(stepOf(history.listAutomationRuns('work', 'flow')[0]?.steps, 'second')?.state).toBe(
      'idle',
    );
  });

  it('goes on past a step set to continue, and still reports it', async () => {
    script = [failedResult(), COMPLETED];
    const steps = [run('first', { onFailure: 'continue' }), run('second')];
    const result = await start(automationOf(steps)).result;

    expect(result).toMatchObject({ status: 'completed', failedSteps: ['first'] });
    expect(result.failure).toBeUndefined();
  });

  it('retries up to its attempts, waiting between them', async () => {
    script = [failedResult(), failedResult(), COMPLETED];
    const waits: number[] = [];
    const steps = [run('flaky', { onFailure: { retry: { attempts: 3, delaySeconds: 2 } } })];
    const result = await start(automationOf(steps), {
      delay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    }).result;

    expect(result.status).toBe('completed');
    expect(started).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
    const flaky = stepOf(history.listAutomationRuns('work', 'flow')[0]?.steps, 'flaky');
    expect(flaky).toMatchObject({ state: 'completed', attempt: 3 });
    expect(flaky?.failure).toBeUndefined();
    expect(flaky?.toolRunIds).toHaveLength(3);
    expect(new Set(flaky?.toolRunIds).size).toBe(3);
    expect(flaky?.toolRunIds?.at(-1)).toBe(flaky?.toolRunId);
  });

  it('stops once retries run out', async () => {
    script = [failedResult(), failedResult()];
    const steps = [run('flaky', { onFailure: { retry: { attempts: 2 } } }), run('next')];
    const result = await start(automationOf(steps)).result;

    expect(result).toMatchObject({ status: 'failed', failedSteps: ['flaky'] });
    expect(started).toHaveLength(2);
  });

  it('moves past a background step and meets it at its wait', async () => {
    const automation = automationOf([
      run('slow', { background: true }),
      run('quick'),
      { id: 'meet', type: 'wait-for-completion', step: 'slow' },
      run('after'),
    ]);
    const running = start(automation);
    await until(() => started.length === 2);
    expect(stepOf(running.view().steps, 'slow')?.state).toBe('running');
    started[1]?.finish(COMPLETED);
    await until(() => stepOf(running.view().steps, 'quick')?.state === 'completed');
    expect(stepOf(running.view().steps, 'after')?.state).toBe('idle');
    expect(started).toHaveLength(2);

    started[0]?.finish(COMPLETED);
    await until(() => started.length === 3);
    started[2]?.finish(COMPLETED);
    expect((await running.result).status).toBe('completed');
  });

  it('applies the policy of the step that waits for a failed background step', async () => {
    const steps = [
      run('slow', { background: true }),
      { id: 'meet', type: 'wait-for-completion', step: 'slow', onFailure: 'continue' },
      run('after'),
    ] satisfies AutomationV1Input['steps'];
    script = [failedResult(), COMPLETED];
    const result = await start(automationOf(steps)).result;

    expect(result).toMatchObject({ status: 'completed', failedSteps: ['slow'] });
    expect(started).toHaveLength(2);
  });

  it('waits at the end for a background step nobody named, and counts its failure', async () => {
    const running = start(automationOf([run('slow', { background: true }), run('quick')]));
    await until(() => started.length === 2);
    started[1]?.finish(COMPLETED);
    await until(() => stepOf(running.view().steps, 'quick')?.state === 'completed');
    expect(running.view().status).toBe('running');

    started[0]?.finish(failedResult());
    expect(await running.result).toMatchObject({
      status: 'failed',
      failure: { stepId: 'slow', kind: 'exit-code' },
    });
  });

  it('ends what runs in the background when a later step stops the automation', async () => {
    const running = start(automationOf([run('slow', { background: true }), run('bad')]));
    await until(() => started.length === 2);
    started[1]?.finish(failedResult());

    expect(await running.result).toMatchObject({ status: 'failed', failure: { stepId: 'bad' } });
    expect(started[0]?.cancelled).toBe(true);
    expect(stepOf(running.view().steps, 'slow')?.state).toBe('cancelled');
  });

  it('asks for a manual step, and goes on when confirmed', async () => {
    script = [COMPLETED];
    const asked: string[] = [];
    const steps = [{ id: 'look', type: 'wait-for-manual-action', message: 'Look' }, run('next')];
    const result = await start(automationOf(steps as AutomationV1Input['steps']), {
      askForAction: ({ message }) => {
        asked.push(message);
        return Promise.resolve('confirmed' satisfies ManualAnswer);
      },
    }).result;

    expect(asked).toEqual(['Look']);
    expect(result.status).toBe('completed');
  });

  it('reaches back to its client only after the client holds the run', async () => {
    const steps: AutomationV1Input['steps'] = [
      { id: 'look', type: 'wait-for-manual-action', message: 'Look' },
    ];
    let returned = false;
    let heldTheRun = false;
    const running = start(automationOf(steps), {
      askForAction: () => {
        heldTheRun = returned;
        return Promise.resolve('confirmed');
      },
    });
    returned = true;
    await running.result;
    expect(heldTheRun).toBe(true);
  });

  it('fails a manual step at once when nobody can answer', async () => {
    const steps: AutomationV1Input['steps'] = [
      { id: 'look', type: 'wait-for-manual-action', message: 'Look' },
    ];
    expect(await start(automationOf(steps)).result).toMatchObject({
      status: 'failed',
      failure: { stepId: 'look', kind: 'no-user' },
    });
  });

  it('keeps going after nobody answered a step set to continue', async () => {
    script = [COMPLETED];
    const steps: AutomationV1Input['steps'] = [
      { id: 'look', type: 'wait-for-manual-action', message: 'Look', onFailure: 'continue' },
      run('next'),
    ];
    expect(await start(automationOf(steps)).result).toMatchObject({
      status: 'completed',
      failedSteps: ['look'],
    });
  });

  it.each([
    ['a tool', [run('hang')]],
    ['a timed wait', [{ id: 'pause', type: 'wait-for-time', seconds: 600 }]],
    ['a manual step', [{ id: 'look', type: 'wait-for-manual-action', message: 'Look' }]],
    ['a background step', [run('hang', { background: true }), run('hang2')]],
    ['a retry', [run('hang', { onFailure: { retry: { attempts: 5, delaySeconds: 600 } } })]],
  ] as [string, AutomationV1Input['steps']][])('cancels during %s', async (label, steps) => {
    if (label === 'a retry') {
      script = [failedResult()];
    }
    const running = start(automationOf(steps), {
      delay: (_milliseconds, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve();
          });
        }),
      askForAction: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve('cancelled');
          });
        }),
    });
    await until(() => running.view().steps.some(({ state }) => state === 'running'));
    await new Promise((resolve) => setImmediate(resolve));
    running.cancel();

    const result = await running.result;
    expect(result.status).toBe('cancelled');
    expect(result.failure).toBeUndefined();
    expect(history.listAutomationRuns('work', 'flow')[0]?.status).toBe('cancelled');
    expect(started.every(({ cancelled }) => cancelled) || label === 'a retry').toBe(true);
  });

  it('passes outputs to later steps, whichever step made them', async () => {
    script = [COMPLETED, COMPLETED, COMPLETED];
    const steps = [
      run('extract', { values: { out: 'C:\\data\\a.csv' } }),
      run('other', { values: { note: 'unrelated' } }),
      run('report', { values: { in: '{{paths.base}}/{{steps.extract.outputs.csv}}' } }),
    ];
    const result = await start(automationOf(steps)).result;

    expect(result.status).toBe('completed');
    expect(String(started[2]?.values['in'])).toContain('C:\\data\\a.csv');
    expect(String(started[2]?.values['in'])).toContain('{{paths.base}}');
  });

  it('resolves a declared path output from the program folder, with path variables', async () => {
    script = [COMPLETED, COMPLETED];
    const steps = [
      run('extract'),
      run('report', { values: { in: '{{steps.extract.outputs.log}}' } }),
    ];
    await start(automationOf(steps), { pathVariables: new Map([['name', 'today']]) }).result;

    expect(started[1]?.values['in']).toBe(join('C:\\tools', 'logs', 'today.log'));
  });

  it('fails the step that refers to an output nothing produced, under its own policy', async () => {
    script = [failedResult(), COMPLETED];
    const steps = [
      run('extract', { values: { out: 'C:\\a.csv' }, onFailure: 'continue' }),
      run('report', { values: { in: '{{steps.extract.outputs.csv}}' }, onFailure: 'continue' }),
      run('last'),
    ];
    const result = await start(automationOf(steps)).result;

    expect(result).toMatchObject({ status: 'completed', failedSteps: ['extract', 'report'] });
    expect(
      stepOf(history.listAutomationRuns('work', 'flow')[0]?.steps, 'report')?.failure?.kind,
    ).toBe('reference');
    expect(started).toHaveLength(2);
  });

  it('gives each run its own folder, only when asked for', async () => {
    script = [COMPLETED];
    await start(automationOf([run('quiet')])).result;
    await expect(access(join(dataDir, 'automation-runs'))).rejects.toThrow();

    script = [COMPLETED, COMPLETED];
    const steps = [run('first', { values: { out: '{{run.folder}}/a.csv' } })];
    const one = await start(automationOf(steps)).result;
    const two = await start(automationOf(steps)).result;

    const folder = join(dataDir, 'automation-runs', 'work', 'flow');
    expect(started[1]?.values['out']).toBe(join(folder, one.runId, 'a.csv'));
    expect(started[2]?.values['out']).toBe(join(folder, two.runId, 'a.csv'));
    await access(join(folder, one.runId));
  });

  it('removes the folder of a run that history no longer keeps', async () => {
    await writeFile(
      join(dataDir, 'preferences.json'),
      JSON.stringify({ formatVersion: 1, historyRunLimit: 1 }),
    );
    script = [COMPLETED, COMPLETED];
    const steps = [run('first', { values: { out: '{{run.folder}}/a.csv' } })];
    const one = await start(automationOf(steps)).result;
    const two = await start(automationOf(steps)).result;

    const folder = join(dataDir, 'automation-runs', 'work', 'flow');
    await expect(access(join(folder, one.runId))).rejects.toThrow();
    await access(join(folder, two.runId));
    expect(history.listAutomationRuns('work', 'flow')).toHaveLength(1);
  });

  it('fails a step whose tool has gone, or cannot start, without throwing', async () => {
    const steps = [run('first')];
    expect(
      await start(automationOf(steps), { findTool: () => Promise.resolve(undefined) }).result,
    ).toMatchObject({ status: 'failed', failure: { kind: 'tool-missing' } });
    expect(
      await start(automationOf(steps), { startStep: () => Promise.reject(new Error('No profile')) })
        .result,
    ).toMatchObject({ failure: { kind: 'not-started', message: 'No profile' } });
  });

  it('reports each change to its client', async () => {
    script = [COMPLETED];
    const states: string[] = [];
    await start(automationOf([run('first')]), {
      onChange: ({ status, steps }) =>
        states.push(`${status}/${stepOf(steps, 'first')?.state ?? ''}`),
    }).result;

    expect(states[0]).toBe('running/idle');
    expect(states).toContain('running/running');
    expect(states.at(-1)).toBe('completed/completed');
  });

  describe('blocks and connections', () => {
    const block = (id: string, extra: object = {}) => ({
      id,
      type: 'run',
      tool: 'sample',
      ...extra,
    });
    const flow = (blocks: object[], connections: object[]): Automation =>
      automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [{ id: 'start', type: 'start' }, ...blocks],
        connections,
      });
    const exitCodeIs = (of: string, value: number) => ({
      match: 'all',
      rules: [{ block: of, field: 'exit-code', operator: 'equals', value }],
    });
    const stateOf = (
      run: { view(): { steps: readonly { id: string; state: string }[] } },
      id: string,
    ) => stepOf(run.view().steps, id)?.state;

    /** Start, a Parallel with branches x and y, their Join, and a block after it. */
    const forked = (join: object = {}): Automation =>
      flow(
        [
          { id: 'fork', type: 'parallel' },
          block('x'),
          block('y'),
          { id: 'meet', type: 'join', parallel: 'fork', ...join },
          block('after'),
        ],
        [
          { from: 'start', to: 'fork' },
          { from: 'fork', to: 'x' },
          { from: 'fork', to: 'y' },
          { from: 'x', to: 'meet' },
          { from: 'y', to: 'meet' },
          { from: 'meet', to: 'after' },
        ],
      );

    it('takes one side of an If and skips the other', async () => {
      script = [COMPLETED, COMPLETED];
      const automation = flow(
        [
          block('a'),
          {
            id: 'check',
            type: 'if',
            condition: {
              match: 'all',
              rules: [{ block: 'a', field: 'result', operator: 'is', value: 'completed' }],
            },
          },
          block('yes'),
          block('no'),
        ],
        [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'check' },
          { from: 'check', output: 'true', to: 'yes' },
          { from: 'check', output: 'false', to: 'no' },
        ],
      );
      const running = start(automation);
      const result = await running.result;

      expect(result).toMatchObject({ status: 'completed', failedSteps: [] });
      expect(started).toHaveLength(2);
      expect(stateOf(running, 'yes')).toBe('completed');
      expect(stateOf(running, 'no')).toBe('skipped');
      const recorded = history.listAutomationRuns('work', 'flow')[0]?.steps;
      expect(stepOf(recorded, 'no')?.state).toBe('skipped');
      expect(history.listAutomationRuns('work', 'flow')[0]?.paths).toEqual([
        { from: 'start', output: 'next', to: 'a' },
        { from: 'a', output: 'next', to: 'check' },
        { from: 'check', output: 'true', to: 'yes' },
      ]);
      expect(running.view().paths).toHaveLength(3);
    });

    it('reads the exit code of a failed block that an Error output handled', async () => {
      script = [failedResult(3), COMPLETED];
      const automation = flow(
        [
          block('a'),
          { id: 'check', type: 'if', condition: exitCodeIs('a', 3) },
          block('three'),
          block('other'),
        ],
        [
          { from: 'start', to: 'a' },
          { from: 'a', output: 'error', to: 'check' },
          { from: 'check', output: 'true', to: 'three' },
          { from: 'check', output: 'false', to: 'other' },
        ],
      );
      const running = start(automation);
      const result = await running.result;

      expect(result).toMatchObject({ status: 'completed', failedSteps: ['a'] });
      expect(result.failure).toBeUndefined();
      expect(stateOf(running, 'three')).toBe('completed');
      expect(stateOf(running, 'other')).toBe('skipped');
    });

    const routed = (): Automation =>
      flow(
        [
          block('a'),
          {
            id: 'route',
            type: 'switch',
            cases: [
              { id: 'seven', condition: exitCodeIs('a', 7) },
              { id: 'zero', condition: exitCodeIs('a', 0) },
            ],
          },
          block('on-seven'),
          block('on-zero'),
          block('fallback'),
        ],
        [
          { from: 'start', to: 'a' },
          { from: 'a', output: 'next', to: 'route' },
          { from: 'a', output: 'error', to: 'route' },
          { from: 'route', output: 'seven', to: 'on-seven' },
          { from: 'route', output: 'zero', to: 'on-zero' },
          { from: 'route', output: 'default', to: 'fallback' },
        ],
      );

    it('takes the first Switch case that holds', async () => {
      script = [COMPLETED, COMPLETED];
      const running = start(routed());
      await running.result;
      expect([
        stateOf(running, 'on-seven'),
        stateOf(running, 'on-zero'),
        stateOf(running, 'fallback'),
      ]).toEqual(['skipped', 'completed', 'skipped']);
    });

    it('takes Default when no case holds', async () => {
      script = [failedResult(2), COMPLETED];
      const running = start(routed());
      await running.result;
      expect([
        stateOf(running, 'on-seven'),
        stateOf(running, 'on-zero'),
        stateOf(running, 'fallback'),
      ]).toEqual(['skipped', 'skipped', 'completed']);
    });

    it('fails an If whose rule reads an exit code that was never left', async () => {
      const automation = flow(
        [
          { id: 'pause', type: 'wait-for-time', seconds: 1 },
          { id: 'check', type: 'if', condition: exitCodeIs('pause', 0) },
          block('yes'),
        ],
        [
          { from: 'start', to: 'pause' },
          { from: 'pause', to: 'check' },
          { from: 'check', output: 'true', to: 'yes' },
        ],
      );
      expect(await start(automation).result).toMatchObject({
        status: 'failed',
        failure: { stepId: 'check', kind: 'condition' },
      });
      expect(started).toHaveLength(0);
    });

    it('stops when a block fails with nothing on its Error output', async () => {
      script = [failedResult()];
      const automation = flow(
        [block('a'), block('b')],
        [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'b' },
        ],
      );
      expect(await start(automation).result).toMatchObject({
        status: 'failed',
        failure: { stepId: 'a' },
      });
    });

    it('starts every branch of a Parallel, and goes on only when all have ended', async () => {
      const running = start(forked());
      await until(() => started.length === 2);
      expect(stateOf(running, 'x')).toBe('running');
      expect(stateOf(running, 'y')).toBe('running');

      started[0]?.finish(COMPLETED);
      await until(() => stateOf(running, 'x') === 'completed');
      expect(started).toHaveLength(2);
      expect(stateOf(running, 'meet')).toBe('idle');

      started[1]?.finish(COMPLETED);
      await until(() => started.length === 3);
      started[2]?.finish(COMPLETED);
      expect(await running.result).toMatchObject({ status: 'completed', failedSteps: [] });
      expect(stateOf(running, 'meet')).toBe('completed');
      const steps = running.view().steps;
      expect(steps.every(({ startedAt }) => startedAt !== undefined)).toBe(true);
    });

    it('ends the other branches when one fails, by default', async () => {
      const running = start(forked());
      await until(() => started.length === 2);
      started[0]?.finish(failedResult(4));

      expect(await running.result).toMatchObject({
        status: 'failed',
        failure: { stepId: 'x', kind: 'exit-code' },
      });
      expect(started[1]?.cancelled).toBe(true);
      expect(stateOf(running, 'y')).toBe('cancelled');
      expect(stateOf(running, 'meet')).toBe('failed');
      expect(stateOf(running, 'after')).toBe('idle');
      expect(started).toHaveLength(2);
    });

    it('lets the other branches finish when the Join says so, and then fails', async () => {
      const running = start(forked({ onBranchFailure: 'let-finish' }));
      await until(() => started.length === 2);
      started[0]?.finish(failedResult());
      await until(() => stateOf(running, 'x') === 'failed');
      expect(started[1]?.cancelled).toBe(false);
      expect(stateOf(running, 'y')).toBe('running');

      started[1]?.finish(COMPLETED);
      expect(await running.result).toMatchObject({
        status: 'failed',
        failure: { stepId: 'x' },
        failedSteps: ['x', 'meet'],
      });
      expect(stateOf(running, 'y')).toBe('completed');
      expect(stateOf(running, 'after')).toBe('idle');
    });

    it('does not fail the Join for a branch failure an Error output handled', async () => {
      const automation = flow(
        [
          { id: 'fork', type: 'parallel' },
          block('x'),
          block('y'),
          block('notify'),
          { id: 'meet', type: 'join', parallel: 'fork' },
        ],
        [
          { from: 'start', to: 'fork' },
          { from: 'fork', to: 'x' },
          { from: 'fork', to: 'y' },
          { from: 'x', output: 'error', to: 'notify' },
          { from: 'notify', to: 'meet' },
          { from: 'y', to: 'meet' },
        ],
      );
      script = [failedResult(), COMPLETED, COMPLETED];
      const result = await start(automation).result;
      expect(result).toMatchObject({ status: 'completed', failedSteps: ['x'] });
      expect(started).toHaveLength(3);
    });

    it('ends every branch when a failure reaches the outer Parallel', async () => {
      const automation = flow(
        [
          { id: 'outer', type: 'parallel' },
          { id: 'inner', type: 'parallel' },
          block('a'),
          block('b'),
          block('c'),
          { id: 'inner-join', type: 'join', parallel: 'inner' },
          { id: 'outer-join', type: 'join', parallel: 'outer' },
        ],
        [
          { from: 'start', to: 'outer' },
          { from: 'outer', to: 'inner' },
          { from: 'outer', to: 'c' },
          { from: 'inner', to: 'a' },
          { from: 'inner', to: 'b' },
          { from: 'a', to: 'inner-join' },
          { from: 'b', to: 'inner-join' },
          { from: 'inner-join', to: 'outer-join' },
          { from: 'c', to: 'outer-join' },
        ],
      );
      const running = start(automation);
      await until(() => started.length === 3);
      started[0]?.finish(failedResult());

      expect(await running.result).toMatchObject({ status: 'failed', failure: { stepId: 'a' } });
      expect(started[1]?.cancelled).toBe(true);
      expect(started[2]?.cancelled).toBe(true);
    });

    it('asks about manual blocks on different branches at the same time', async () => {
      const automation = flow(
        [
          { id: 'fork', type: 'parallel' },
          { id: 'one', type: 'wait-for-manual-action', message: 'First' },
          { id: 'two', type: 'wait-for-manual-action', message: 'Second' },
          { id: 'meet', type: 'join', parallel: 'fork' },
        ],
        [
          { from: 'start', to: 'fork' },
          { from: 'fork', to: 'one' },
          { from: 'fork', to: 'two' },
          { from: 'one', to: 'meet' },
          { from: 'two', to: 'meet' },
        ],
      );
      const answers = new Map<string, (answer: ManualAnswer) => void>();
      const running = start(automation, {
        askForAction: ({ stepId }) =>
          new Promise((resolve) => {
            answers.set(stepId, resolve);
          }),
      });
      await until(() => answers.size === 2);
      answers.get('two')?.('confirmed');
      await until(() => stateOf(running, 'two') === 'completed');
      expect(stateOf(running, 'one')).toBe('running');
      answers.get('one')?.('confirmed');
      expect((await running.result).status).toBe('completed');
    });

    it('cancels every branch of a Parallel', async () => {
      const running = start(forked());
      await until(() => started.length === 2);
      running.cancel();

      const result = await running.result;
      expect(result.status).toBe('cancelled');
      expect(result.failure).toBeUndefined();
      expect(started.every(({ cancelled }) => cancelled)).toBe(true);
      expect(stateOf(running, 'after')).toBe('idle');
    });

    it('runs a block reached from two outputs of one block only once', async () => {
      script = [COMPLETED, COMPLETED];
      const automation = flow(
        [block('a'), block('b')],
        [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'b' },
          { from: 'a', output: 'error', to: 'b' },
        ],
      );
      await start(automation).result;
      expect(started).toHaveLength(2);
    });
  });

  describe('values worked out from others', () => {
    const flow = (blocks: object[], start: object = {}): Automation => {
      const ids = ['start', ...blocks.map((block) => (block as { id: string }).id)];
      return automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [{ id: 'start', type: 'start', ...start }, ...blocks],
        connections: ids.slice(1).map((to, index) => ({ from: ids[index], to })),
      });
    };
    const block = (id: string, values: object = {}) => ({
      id,
      type: 'run',
      tool: 'sample',
      values,
    });
    const link = (expression: string) => ({ expression });
    const resultFile = () => join(dataDir, 'result.json');
    const withJson = (id: string) =>
      tool(id, {
        outputs: [
          { name: 'csv', param: 'out' },
          {
            name: 'result',
            json: resultFile(),
            fields: [
              { name: 'count', type: 'integer' },
              { name: 'files', type: 'list' },
              { name: 'token', type: 'string', secret: true },
            ],
          },
        ],
      });

    it('follows links, inputs and expressions into the values a tool receives', async () => {
      script = [COMPLETED, COMPLETED];
      const automation = flow(
        [
          block('a', { out: 'C:\\pics\\photo.png' }),
          block('b', {
            in: link('a.out'),
            note: link('stem(a.out) + "_" + inputs.size + "_" + b.out'),
            out: '{{run.folder}}/x.png',
          }),
        ],
        { inputs: [{ name: 'size', type: 'string', default: 'big' }] },
      );
      const running = start(automation, { inputs: { size: 'small' } });
      await running.result;
      const runFolder = String(started[1]?.values['out']).replace(/[\\/]x\.png$/, '');
      expect(started[1]?.values).toEqual({
        in: 'C:\\pics\\photo.png',
        note: `photo_small_${join(runFolder, 'x.png')}`,
        out: join(runFolder, 'x.png'),
      });
      await access(runFolder);
      expect(stepOf(running.view().steps, 'b')?.values).toContainEqual({
        name: 'in',
        label: 'in',
        value: 'C:\\pics\\photo.png',
        from: 'a.out',
      });
    });

    it('uses input defaults, and refuses inputs that do not fit before anything runs', async () => {
      script = [COMPLETED];
      const automation = flow([block('a', { note: link('inputs.size') })], {
        inputs: [
          { name: 'size', type: 'string', default: 'big' },
          { name: 'count', type: 'integer' },
        ],
      });
      await start(automation).result;
      expect(started[0]?.values).toEqual({ note: 'big' });
      expect(() => start(automation, { inputs: { nope: 'x', count: 1.5 } })).toThrow(
        'This automation has no input "nope"\nInput "count" must be a whole number',
      );
      const required = flow([block('a')], {
        inputs: [{ name: 'file', type: 'path', required: true }],
      });
      expect(() => start(required)).toThrow('Input "file" needs a value');
      expect(started).toHaveLength(1);
    });

    it('fails a block whose input has no value, under its own policy', async () => {
      const automation = flow([block('a', { note: link('inputs.size') })], {
        inputs: [{ name: 'size', type: 'string' }],
      });
      const result = await start(automation).result;
      expect(result.failure).toMatchObject({ stepId: 'a', kind: 'value' });
      expect(started).toEqual([]);
    });

    it('reads a JSON output, decides on its fields, and keeps secret fields out of the record', async () => {
      script = [COMPLETED, COMPLETED];
      await writeFile(
        resultFile(),
        JSON.stringify({ count: 5, files: ['a', 'b'], token: 'hunter2', extra: 1 }),
      );
      const automation = automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [
          { id: 'start', type: 'start' },
          block('a'),
          {
            id: 'check',
            type: 'if',
            condition: {
              match: 'all',
              rules: [
                {
                  field: 'value',
                  read: link('steps.a.outputs.result.count'),
                  operator: 'greater-than',
                  value: 3,
                },
                {
                  field: 'value',
                  read: link('steps.a.outputs.result.files'),
                  operator: 'contains',
                  value: 'b',
                },
                { field: 'value', read: link('steps.a.outputs.result'), operator: 'exists' },
              ],
            },
          },
          block('yes', { note: link('"rows: " + steps.a.outputs.result.count') }),
          block('no'),
        ],
        connections: [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'check' },
          { from: 'check', output: 'true', to: 'yes' },
          { from: 'check', output: 'false', to: 'no' },
        ],
      });
      const running = start(automation, { findTool: (id) => Promise.resolve(withJson(id)) });
      const result = await running.result;
      expect(result.status).toBe('completed');
      expect(started.map(({ values }) => values)).toEqual([{}, { note: 'rows: 5' }]);
      const outputs = stepOf(running.view().steps, 'a')?.outputs;
      expect(outputs).toEqual([
        { name: 'result', value: resultFile() },
        { name: 'result.count', value: 5 },
        { name: 'result.files', value: ['a', 'b'] },
        { name: 'result.token', secret: true },
      ]);
      const record = history.getAutomationRun('work', result.runId);
      expect(JSON.stringify(record)).not.toContain('hunter2');
      expect(stepOf(record?.steps, 'a')?.outputs).toEqual(outputs);
    });

    it('fails the block when its JSON output is missing or does not fit', async () => {
      const automation = flow([block('a')]);
      script = [COMPLETED];
      const missing = await start(automation, { findTool: (id) => Promise.resolve(withJson(id)) })
        .result;
      expect(missing.failure).toMatchObject({ stepId: 'a', kind: 'output' });
      expect(missing.failure?.message).toMatch(/did not write output "result"/);

      script = [COMPLETED];
      await writeFile(resultFile(), JSON.stringify({ count: 'many', files: [], token: '' }));
      const wrong = await start(automation, { findTool: (id) => Promise.resolve(withJson(id)) })
        .result;
      expect(wrong.failure?.message).toBe(
        'Field "count" of output "result" must be a whole number',
      );

      script = [COMPLETED];
      await writeFile(resultFile(), 'not json');
      const broken = await start(automation, { findTool: (id) => Promise.resolve(withJson(id)) })
        .result;
      expect(broken.failure?.message).toBe('Output "result" is not valid JSON');
    });
  });

  it('runs even if its record cannot be written', async () => {
    script = [COMPLETED];
    history.close();
    const result = await start(automationOf([run('first')])).result;
    history = await RunHistory.open(dataDir);
    expect(result.status).toBe('completed');
  });
});

describe.skipIf(process.platform !== 'win32')(
  'startAutomationRun with real tools',
  { timeout: 60_000 },
  () => {
    const FAKE_TOOL = fileURLToPath(
      new URL('../../../../examples/fixtures/fake-tool.mjs', import.meta.url),
    );
    const SECRET = 'automation-Secret-Value-77';
    let dataDir: string;
    let history: RunHistory;
    let registry: ToolRegistry;
    let store: ReturnType<typeof createMemorySecretStore>;

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'bildora-automation-real-'));
      history = await RunHistory.open(dataDir);
      registry = await ToolRegistry.open({ dataDir });
      store = createMemorySecretStore();
    });

    afterEach(async () => {
      history.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    function start(automation: Automation) {
      return startAutomationRun({
        automation,
        workspaceId: 'work',
        trigger: 'cli',
        dataDir,
        history,
        findTool: (id) => registry.get(id),
        startStep: (found, { automationRunId, profileId, values }) =>
          startToolRun(
            found,
            { workspaceId: 'work', automationRunId, profileId, values },
            { dataDir, history, store },
          ),
      });
    }

    it('runs tools for real, hands a file on, and keeps secrets out of what it records', async () => {
      const script = join(dataDir, 'write.mjs');
      await writeFile(
        script,
        `import { readFileSync, writeFileSync } from 'node:fs';
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const from = value('--from');
const to = value('--to');
writeFileSync(to, (from === '-' ? 'start' : readFileSync(from, 'utf8')) + ':' + process.env.TOOL_TOKEN);`,
      );
      const manifest = toolManifestSchema.parse({
        schemaVersion: 1,
        id: 'writer',
        name: 'Writer',
        version: '1.0.0',
        level: 1,
        interpreter: 'node',
        run: { program: script },
        parameters: [
          { name: 'from', type: 'path', label: 'From', default: '-', flag: '--from' },
          { name: 'to', type: 'path', label: 'To', required: true, flag: '--to' },
          { name: 'token', type: 'string', label: 'Token', secret: true, env: 'TOOL_TOKEN' },
        ],
        outputs: [{ name: 'file', param: 'to' }],
      });
      const writer = await registry.register(manifest);
      await saveProfile(writer, { name: 'Signed', values: {}, secrets: { token: SECRET } }, store);

      const failing = await registry.register(
        toolManifestSchema.parse({
          schemaVersion: 1,
          id: 'failing',
          name: 'Failing',
          version: '1.0.0',
          level: 1,
          interpreter: 'node',
          run: { program: FAKE_TOOL, args: ['exit', '7'] },
        }),
      );

      const result = await start(
        automationOf([
          {
            id: 'one',
            type: 'run',
            tool: 'writer',
            profile: 'signed',
            values: { to: '{{run.folder}}/one.txt' },
          },
          {
            id: 'two',
            type: 'run',
            tool: 'writer',
            profile: 'signed',
            values: { from: '{{steps.one.outputs.file}}', to: '{{run.folder}}/two.txt' },
          },
          { id: 'bad', type: 'run', tool: failing.manifest.id, onFailure: 'continue' },
          { id: 'pause', type: 'wait-for-time', seconds: 1 },
        ]),
      ).result;

      expect(result).toMatchObject({ status: 'completed', failedSteps: ['bad'] });
      const folder = join(dataDir, 'automation-runs', 'work', 'flow', result.runId);
      expect(await readFile(join(folder, 'two.txt'), 'utf8')).toBe(`start:${SECRET}:${SECRET}`);

      const [record] = history.listAutomationRuns('work', 'flow');
      expect(JSON.stringify(record)).not.toContain(SECRET);
      const stepRun = history.get('work', stepOf(record?.steps, 'two')?.toolRunId ?? '');
      expect(stepRun?.status).toBe('completed');
      expect(JSON.stringify(stepRun)).not.toContain(SECRET);
      expect(history.get('work', stepOf(record?.steps, 'bad')?.toolRunId ?? '')?.exitCode).toBe(7);
    });
  },
);
