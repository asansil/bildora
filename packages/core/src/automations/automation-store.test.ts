import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSchema, automationV2Schema, toolManifestSchema } from '@bildora/protocol';
import type { Automation, AutomationInput } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from '../history/run-history.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { saveProfile } from '../profiles/profile-store.js';
import { workspaceScope } from '../workspaces/visible-tools.js';
import { createWorkspace } from '../workspaces/workspace-store.js';
import {
  findAutomations,
  getAutomation,
  listAutomations,
  newAutomationId,
  removeAutomation,
  saveAutomation,
} from './automation-store.js';
import { checkAutomation } from './check-automation.js';

function automationOf(steps: AutomationInput['steps'], id = 'flow', name = 'Flow'): Automation {
  return automationSchema.parse({ schemaVersion: 1, id, name, steps });
}

const quickStep: AutomationInput['steps'][number] = {
  id: 'pause',
  type: 'wait-for-time',
  seconds: 1,
};

describe('automation files', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-automations-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores readable files and lists them by name', async () => {
    await saveAutomation(dataDir, 'work', automationOf([quickStep], 'b-flow', 'Beta'));
    await saveAutomation(dataDir, 'work', automationOf([quickStep], 'a-flow', 'Alpha'));

    const { automations, problems } = await listAutomations(dataDir, 'work');
    expect(automations.map(({ name }) => name)).toEqual(['Alpha', 'Beta']);
    expect(problems).toEqual([]);
    const text = await readFile(
      join(dataDir, 'workspaces', 'work', 'automations', 'a-flow.yaml'),
      'utf8',
    );
    expect(text).toContain('name: Alpha');
  });

  it('keeps Workspaces apart', async () => {
    await saveAutomation(dataDir, 'work', automationOf([quickStep]));
    expect((await listAutomations(dataDir, 'home')).automations).toEqual([]);
    expect(await getAutomation(dataDir, 'home', 'flow')).toBeUndefined();
  });

  it('reports a damaged file without hiding the others', async () => {
    await saveAutomation(dataDir, 'work', automationOf([quickStep]));
    const folder = join(dataDir, 'workspaces', 'work', 'automations');
    await writeFile(join(folder, 'broken.yaml'), 'schemaVersion: 1\nid: [');
    await writeFile(
      join(folder, 'renamed.yaml'),
      'schemaVersion: 1\nid: other\nname: x\nsteps: []',
    );

    const { automations, problems } = await listAutomations(dataDir, 'work');
    expect(automations).toHaveLength(1);
    expect(problems.map(({ file }) => file)).toEqual(['broken.yaml', 'renamed.yaml']);
  });

  it('refuses a file from a newer build, and never replaces it', async () => {
    const folder = join(dataDir, 'workspaces', 'work', 'automations');
    await mkdir(folder, { recursive: true });
    const newer = 'schemaVersion: 99\nid: flow\nname: From the future\n';
    await writeFile(join(folder, 'flow.yaml'), newer);

    await expect(getAutomation(dataDir, 'work', 'flow')).rejects.toThrow(/Update Bildora/);
    await expect(saveAutomation(dataDir, 'work', automationOf([quickStep]))).rejects.toThrow(
      /Update Bildora/,
    );
    expect(await readFile(join(folder, 'flow.yaml'), 'utf8')).toBe(newer);
  });

  it('refuses an id that could leave the folder', async () => {
    await expect(getAutomation(dataDir, 'work', '../evil')).rejects.toThrow(/not valid/);
  });

  it('makes ids from names, and keeps them apart', () => {
    expect(newAutomationId('Nightly Report', [])).toBe('nightly-report');
    expect(newAutomationId('Nightly Report', ['nightly-report'])).toBe('nightly-report-2');
    expect(newAutomationId('¿?', [])).toBe('automation-tool');
  });

  it('deletes an automation with its past runs and folders', async () => {
    const history = await RunHistory.open(dataDir);
    await saveAutomation(dataDir, 'work', automationOf([quickStep]));
    history.startAutomationRun({
      runId: 'one',
      workspaceId: 'work',
      automationId: 'flow',
      automationName: 'Flow',
      trigger: 'app',
      startedAt: 1,
      steps: [],
    });
    const folder = join(dataDir, 'automation-runs', 'work', 'flow', 'one');
    await mkdir(folder, { recursive: true });

    await removeAutomation(dataDir, 'work', 'flow', history);
    expect(await getAutomation(dataDir, 'work', 'flow')).toBeUndefined();
    expect(history.listAutomationRuns('work', 'flow')).toEqual([]);
    await expect(readFile(join(folder, 'x'))).rejects.toThrow();
    history.close();
  });

  it('finds an automation by id or name, in one Workspace or across all', async () => {
    const work = await createWorkspace(dataDir, 'Work', 'system');
    const home = await createWorkspace(dataDir, 'Home', 'system');
    await saveAutomation(dataDir, work.id, automationOf([quickStep], 'flow', 'Nightly Run'));
    await saveAutomation(dataDir, home.id, automationOf([quickStep], 'flow', 'Nightly Run'));
    await saveAutomation(dataDir, home.id, automationOf([quickStep], 'only', 'Only Here'));

    expect(await findAutomations(dataDir, 'missing')).toEqual([]);
    expect(await findAutomations(dataDir, 'flow')).toHaveLength(2);
    expect(await findAutomations(dataDir, 'nightly run')).toHaveLength(2);
    expect(await findAutomations(dataDir, 'only')).toMatchObject([
      { workspaceId: home.id, workspaceName: 'Home' },
    ]);
    expect(await findAutomations(dataDir, 'flow', 'work')).toMatchObject([
      { workspaceId: work.id },
    ]);
    expect(await findAutomations(dataDir, 'flow', 'HOME')).toMatchObject([
      { workspaceId: home.id },
    ]);
  });
});

describe('checkAutomation', () => {
  let dataDir: string;
  let registry: ToolRegistry;

  const declared = {
    schemaVersion: 1,
    version: '1.0.0',
    level: 1,
    run: { program: 'C:\\tools\\tool.exe' },
    parameters: [
      { name: 'in', type: 'path', label: 'Input', required: true, flag: '--in' },
      { name: 'out', type: 'path', label: 'Output', flag: '--out' },
      { name: 'note', type: 'string', label: 'Note', flag: '--note' },
      { name: 'count', type: 'integer', label: 'Count', flag: '--count' },
      { name: 'mode', type: 'choice', label: 'Mode', choices: ['a', 'b'], flag: '--mode' },
      { name: 'token', type: 'string', label: 'Token', secret: true, flag: '--token' },
    ],
    outputs: [{ name: 'csv', param: 'out' }],
  };

  async function problems(steps: AutomationInput['steps']): Promise<readonly string[]> {
    const found = await checkAutomation(automationOf(steps), registry, 'work');
    return found.map(({ stepId, message }) => `${stepId}: ${message}`);
  }

  const run = (
    id: string,
    values: object,
    extra: object = {},
  ): AutomationInput['steps'][number] => ({
    id,
    type: 'run',
    tool: 'declared',
    values: { in: 'C:\\in', ...values },
    ...extra,
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-check-'));
    registry = await ToolRegistry.open({ dataDir });
    await registry.register(
      toolManifestSchema.parse({ ...declared, id: 'declared', name: 'Declared' }),
    );
    await registry.register(
      toolManifestSchema.parse({
        schemaVersion: 1,
        id: 'plain',
        name: 'Plain',
        version: '1.0.0',
        level: 0,
        run: { program: 'C:\\plain.exe' },
      }),
    );
    await registry.register(
      toolManifestSchema.parse({
        schemaVersion: 1,
        id: 'panel',
        name: 'Panel',
        version: '1.0.0',
        level: 2,
        entryPoint: { panel: 'index.html', backend: { program: 'b.exe' } },
      }),
    );
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('passes a sound automation', async () => {
    expect(
      await problems([
        run('first', { out: '{{run.folder}}/a.csv', count: 3, mode: 'a' }),
        { id: 'plain', type: 'run', tool: 'plain' },
        run('second', { in: '{{paths.base}}/{{steps.first.outputs.csv}}' }),
      ]),
    ).toEqual([]);
  });

  it('sees tools of the Workspace as well as global ones', async () => {
    await registry.register(
      toolManifestSchema.parse({
        schemaVersion: 1,
        id: 'own',
        name: 'Own',
        version: '1.0.0',
        level: 0,
        run: { program: 'C:\\own.exe' },
      }),
      { scope: workspaceScope('work') },
    );
    expect(await problems([{ id: 'a', type: 'run', tool: 'own' }])).toEqual([]);
  });

  it('reports a missing tool as broken, and a level 2 tool as not ready', async () => {
    expect(
      await problems([
        { id: 'gone', type: 'run', tool: 'nothing' },
        { id: 'rich', type: 'run', tool: 'panel' },
      ]),
    ).toEqual([
      'gone: Tool "nothing" is not installed, or cannot be read',
      'rich: Level 2 tools cannot run in an automation yet',
    ]);
  });

  it('reports what does not fit the tool', async () => {
    expect(
      await problems([
        run('a', { nope: 1, count: 'x', mode: 'c', note: '{{steps.a.outputs.csv}}' }),
      ]),
    ).toEqual([
      'a: The tool has no parameter "nope"',
      'a: "count" does not fit a integer parameter',
      'a: "mode" does not fit a choice parameter',
      'a: "note" is not a path parameter, so it cannot hold a reference',
    ]);
  });

  it('never lets a secret into the file, and does not repeat it', async () => {
    const found = await problems([run('a', { token: 'hunter2' })]);
    expect(found).toEqual(['a: "token" is secret, so it can only come from a profile']);
    expect(found.join()).not.toContain('hunter2');
  });

  it('needs required values, which a profile can provide', async () => {
    const tool = await registry.get('declared');
    if (tool === undefined) {
      throw new Error('The tool should be there');
    }
    await saveProfile(
      tool,
      { name: 'Filled', values: { in: 'C:\\in' } },
      createMemorySecretStore(),
    );
    expect(await problems([{ id: 'a', type: 'run', tool: 'declared' }])).toEqual([
      'a: Needs a value for "Input"',
    ]);
    expect(await problems([{ id: 'a', type: 'run', tool: 'declared', profile: 'filled' }])).toEqual(
      [],
    );
    expect(await problems([run('a', {}, { profile: 'gone' })])).toEqual([
      'a: Profile "gone" no longer exists',
    ]);
  });

  it('checks references to other steps', async () => {
    expect(
      await problems([
        run('a', { in: '{{steps.later.outputs.csv}}' }),
        run('later', { in: '{{steps.a.outputs.nothing}}' }),
        { id: 'plain', type: 'run', tool: 'plain' },
        run('b', { in: '{{steps.plain.outputs.x}}' }),
        run('c', { in: '{{run.foldr}}/x' }),
      ]),
    ).toEqual([
      'a: Step "later" does not finish on every path that reaches this block, so its output may not exist',
      'later: Step "a" declares no output "nothing"',
      'b: Step "plain" runs a registered program, which declares no outputs',
      'c: Unknown reference {{run.foldr}}',
    ]);
  });

  it('needs a background step waited for before its output is used', async () => {
    const slow = run('slow', { out: 'C:\\a.csv' }, { background: true });
    const use = run('use', { in: '{{steps.slow.outputs.csv}}' });
    expect(await problems([slow, use])).toEqual([
      'use: Step "slow" does not finish on every path that reaches this block, so its output may not exist',
    ]);
    expect(
      await problems([slow, { id: 'meet', type: 'wait-for-completion', step: 'slow' }, use]),
    ).toEqual([]);
  });

  describe('on blocks and connections', () => {
    const lookup = '{{steps.a.outputs.csv}}';
    const step = (id: string, values: object = {}) => ({
      id,
      type: 'run',
      tool: 'declared',
      values: { in: 'C:\\in', ...values },
    });
    async function blockProblems(blocks: object[], connections: object[]) {
      const automation = automationV2Schema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [{ id: 'start', type: 'start' }, ...blocks],
        connections,
      });
      const found = await checkAutomation(automation, registry, 'work');
      return found.map(({ stepId, message }) => `${stepId}: ${message}`);
    }
    const sourceA = step('a', { out: 'C:\\a.csv' });
    const cannotFinish = (id: string) =>
      `Step "${id}" does not finish on every path that reaches this block, so its output may not exist`;

    it('accepts a reference to a block that finished before', async () => {
      expect(
        await blockProblems(
          [sourceA, step('b', { in: lookup })],
          [
            { from: 'start', to: 'a' },
            { from: 'a', to: 'b' },
          ],
        ),
      ).toEqual([]);
    });

    it('refuses a reference to a block that ran on only one side of a decision', async () => {
      const condition = {
        match: 'all',
        rules: [{ block: 'a', field: 'result', operator: 'is', value: 'completed' }],
      };
      const blocks = [
        sourceA,
        { id: 'check', type: 'if', condition },
        step('x', { out: 'C:\\x.csv' }),
        step('y'),
        step('use', { in: '{{steps.x.outputs.csv}}' }),
      ];
      expect(
        await blockProblems(blocks, [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'check' },
          { from: 'check', output: 'true', to: 'x' },
          { from: 'check', output: 'false', to: 'y' },
          { from: 'x', to: 'use' },
          { from: 'y', to: 'use' },
        ]),
      ).toEqual([`use: ${cannotFinish('x')}`]);
    });

    it('refuses a reference to the output of a block that failed and took its Error output', async () => {
      expect(
        await blockProblems(
          [sourceA, step('notify', { in: lookup })],
          [
            { from: 'start', to: 'a' },
            { from: 'a', output: 'error', to: 'notify' },
          ],
        ),
      ).toEqual([`notify: ${cannotFinish('a')}`]);
    });

    it('keeps branches apart, and allows a reference after the Join', async () => {
      const blocks = [
        { id: 'fork', type: 'parallel' },
        sourceA,
        step('b', { in: lookup }),
        { id: 'meet', type: 'join', parallel: 'fork' },
        step('after', { in: lookup }),
      ];
      expect(
        await blockProblems(blocks, [
          { from: 'start', to: 'fork' },
          { from: 'fork', to: 'a' },
          { from: 'fork', to: 'b' },
          { from: 'a', to: 'meet' },
          { from: 'b', to: 'meet' },
          { from: 'meet', to: 'after' },
        ]),
      ).toEqual([`b: ${cannotFinish('a')}`]);
    });

    it('checks that a rule reads the exit code of a tool that ran on every path', async () => {
      const exitCode = (block: string) => ({
        match: 'all',
        rules: [{ block, field: 'exit-code', operator: 'equals', value: 0 }],
      });
      const blocks = [
        sourceA,
        { id: 'pause', type: 'wait-for-time', seconds: 1 },
        { id: 'check', type: 'if', condition: exitCode('pause') },
        { id: 'late', type: 'if', condition: exitCode('after') },
        step('after'),
      ];
      expect(
        await blockProblems(blocks, [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'pause' },
          { from: 'pause', to: 'check' },
          { from: 'check', output: 'true', to: 'late' },
          { from: 'late', output: 'true', to: 'after' },
        ]),
      ).toEqual([
        'check: Reads the exit code of "pause", which is not a run block',
        'late: Reads the exit code of "after", which does not run on every path that reaches "late"',
      ]);
    });

    it('allows reading the exit code of a block that failed into its Error output', async () => {
      const condition = {
        match: 'all',
        rules: [{ block: 'a', field: 'exit-code', operator: 'equals', value: 3 }],
      };
      expect(
        await blockProblems(
          [sourceA, { id: 'check', type: 'if', condition }],
          [
            { from: 'start', to: 'a' },
            { from: 'a', output: 'error', to: 'check' },
          ],
        ),
      ).toEqual([]);
    });

    it('reports a list of steps that cannot become blocks, without a block', async () => {
      const overlapping = automationOf([
        { ...run('one', {}), background: true },
        { ...run('two', {}), background: true },
        { id: 'w1', type: 'wait-for-completion', step: 'one' },
        { id: 'w2', type: 'wait-for-completion', step: 'two' },
      ] as AutomationInput['steps']);
      const found = await checkAutomation(overlapping, registry, 'work');
      expect(found).toHaveLength(1);
      expect(found[0]?.stepId).toBe('');
      expect(found[0]?.message).toContain('overlaps another one');
    });
  });

  it('never changes an automation', async () => {
    await saveAutomation(dataDir, 'work', automationOf([{ id: 'a', type: 'run', tool: 'gone' }]));
    const before = await getAutomation(dataDir, 'work', 'flow');
    await checkAutomation(automationOf([{ id: 'a', type: 'run', tool: 'gone' }]), registry, 'work');
    expect(await getAutomation(dataDir, 'work', 'flow')).toEqual(before);
  });
});
