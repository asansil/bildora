import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automationSchema, toolManifestSchema } from '@bildora/protocol';
import type { Automation, AutomationInput } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from '../history/run-history.js';
import { saveProfile } from '../profiles/profile-store.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import type { RunResult } from '../runner/run-tool.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
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

function automationOf(steps: AutomationInput['steps']): Automation {
  return automationSchema.parse({ schemaVersion: 1, id: 'flow', name: 'Flow', steps });
}

const run = (id: string, extra: object = {}): AutomationInput['steps'][number] => ({
  id,
  type: 'run',
  tool: 'sample',
  ...extra,
});

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
      ['first', 'completed'],
      ['pause', 'completed'],
      ['second', 'completed'],
    ]);
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
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps[1]?.state).toBe('idle');
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
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps[0]).toMatchObject({
      state: 'completed',
      attempt: 3,
    });
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps[0]?.failure).toBeUndefined();
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
    expect(running.view().steps[0]?.state).toBe('running');
    started[1]?.finish(COMPLETED);
    await until(() => running.view().steps[2]?.state === 'running');
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
    ] satisfies AutomationInput['steps'];
    script = [failedResult(), COMPLETED];
    const result = await start(automationOf(steps)).result;

    expect(result).toMatchObject({ status: 'completed', failedSteps: ['slow', 'meet'] });
    expect(started).toHaveLength(2);
  });

  it('waits at the end for a background step nobody named, and counts its failure', async () => {
    const running = start(automationOf([run('slow', { background: true }), run('quick')]));
    await until(() => started.length === 2);
    started[1]?.finish(COMPLETED);
    await until(() => running.view().steps[1]?.state === 'completed');
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
    expect(running.view().steps[0]?.state).toBe('cancelled');
  });

  it('asks for a manual step, and goes on when confirmed', async () => {
    script = [COMPLETED];
    const asked: string[] = [];
    const steps = [{ id: 'look', type: 'wait-for-manual-action', message: 'Look' }, run('next')];
    const result = await start(automationOf(steps as AutomationInput['steps']), {
      askForAction: ({ message }) => {
        asked.push(message);
        return Promise.resolve('confirmed' satisfies ManualAnswer);
      },
    }).result;

    expect(asked).toEqual(['Look']);
    expect(result.status).toBe('completed');
  });

  it('reaches back to its client only after the client holds the run', async () => {
    const steps: AutomationInput['steps'] = [
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
    const steps: AutomationInput['steps'] = [
      { id: 'look', type: 'wait-for-manual-action', message: 'Look' },
    ];
    expect(await start(automationOf(steps)).result).toMatchObject({
      status: 'failed',
      failure: { stepId: 'look', kind: 'no-user' },
    });
  });

  it('keeps going after nobody answered a step set to continue', async () => {
    script = [COMPLETED];
    const steps: AutomationInput['steps'] = [
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
  ] as [string, AutomationInput['steps']][])('cancels during %s', async (label, steps) => {
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
    await until(() => running.view().steps.at(-1)?.state === 'running');
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
    expect(history.listAutomationRuns('work', 'flow')[0]?.steps[1]?.failure?.kind).toBe(
      'reference',
    );
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
      onChange: ({ status, steps }) => states.push(`${status}/${steps[0]?.state ?? ''}`),
    }).result;

    expect(states[0]).toBe('running/idle');
    expect(states).toContain('running/running');
    expect(states.at(-1)).toBe('completed/completed');
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
        ]),
      ).result;

      expect(result).toMatchObject({ status: 'completed', failedSteps: ['bad'] });
      const folder = join(dataDir, 'automation-runs', 'work', 'flow', result.runId);
      expect(await readFile(join(folder, 'two.txt'), 'utf8')).toBe(`start:${SECRET}:${SECRET}`);

      const [record] = history.listAutomationRuns('work', 'flow');
      expect(JSON.stringify(record)).not.toContain(SECRET);
      const stepRun = history.get('work', record?.steps[1]?.toolRunId ?? '');
      expect(stepRun?.status).toBe('completed');
      expect(JSON.stringify(stepRun)).not.toContain(SECRET);
      expect(history.get('work', record?.steps[2]?.toolRunId ?? '')?.exitCode).toBe(7);
    });
  },
);
