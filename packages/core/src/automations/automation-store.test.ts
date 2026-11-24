import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  automationFileSchema,
  automationSchema,
  blockingProblems,
  isWarning,
  automationV1Schema,
  toolManifestSchema,
} from '@bildora/protocol';
import type { Automation, AutomationV1Input } from '@bildora/protocol';
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
import { convertAutomationV1 } from './convert-v1.js';
import { checkAutomation } from './check-automation.js';
import { readCallTree } from './call-tree.js';
import type { CallTree } from './call-tree.js';

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

const quickStep: AutomationV1Input['steps'][number] = {
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

  it('stores a flow being built, which breaks the rules of a runnable one', async () => {
    const halfBuilt = automationFileSchema.parse({
      schemaVersion: 2,
      id: 'half',
      name: 'Half built',
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'fork', type: 'parallel' },
      ],
      connections: [{ from: 'start', to: 'fork' }],
      notes: [{ id: 'note', text: 'Two branches go here', x: 0, y: 90 }],
    });
    await saveAutomation(dataDir, 'work', halfBuilt);
    expect(await getAutomation(dataDir, 'work', 'half')).toEqual(halfBuilt);
    const registry = await ToolRegistry.open({ dataDir });
    const found = await checkAutomation(halfBuilt, registry, 'work');
    expect(found.map(({ code, blockId }) => [code, blockId])).toEqual([
      ['parallel-branches', 'fork'],
      ['parallel-joins', 'fork'],
    ]);
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

  describe('files written as a list of steps', () => {
    const folderOf = (dir: string) => join(dir, 'workspaces', 'work', 'automations');
    const listOfSteps = [
      'schemaVersion: 1',
      'id: flow',
      'name: Old flow',
      'steps:',
      '  - { id: first, type: run, tool: sample, onFailure: continue }',
      '  - { id: second, type: run, tool: sample }',
      '',
    ].join('\n');
    const overlapping = [
      'schemaVersion: 1',
      'id: flow',
      'name: Overlapping',
      'steps:',
      '  - { id: one, type: run, tool: sample, background: true }',
      '  - { id: two, type: run, tool: sample, background: true }',
      '  - { id: w1, type: wait-for-completion, step: one }',
      '  - { id: w2, type: wait-for-completion, step: two }',
      '',
    ].join('\n');

    it('are read as blocks, and the file changes only on the next save', async () => {
      const folder = folderOf(dataDir);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'flow.yaml'), listOfSteps);

      const automation = await getAutomation(dataDir, 'work', 'flow');
      expect(automation).toMatchObject({ schemaVersion: 2, name: 'Old flow' });
      expect(automation?.blocks.map(({ id }) => id)).toEqual(['start', 'first', 'second']);
      expect(await readFile(join(folder, 'flow.yaml'), 'utf8')).toBe(listOfSteps);

      if (automation === undefined) throw new Error('Not read');
      await saveAutomation(dataDir, 'work', automation);
      const saved = await readFile(join(folder, 'flow.yaml'), 'utf8');
      expect(saved).toContain('schemaVersion: 2');
      expect(await getAutomation(dataDir, 'work', 'flow')).toEqual(automation);
    });

    it('that cannot convert show as a problem, and are never replaced', async () => {
      const folder = folderOf(dataDir);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'flow.yaml'), overlapping);

      const { automations, problems } = await listAutomations(dataDir, 'work');
      expect(automations).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.message).toContain('cannot be converted');
      expect(problems[0]?.message).toContain('overlaps another one');

      await expect(saveAutomation(dataDir, 'work', automationOf([quickStep]))).rejects.toThrow(
        /cannot be converted/,
      );
      expect(await readFile(join(folder, 'flow.yaml'), 'utf8')).toBe(overlapping);
    });
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
    outputs: [
      { name: 'csv', param: 'out' },
      {
        name: 'result',
        json: 'result.json',
        fields: [
          { name: 'count', type: 'integer' },
          { name: 'files', type: 'list' },
          { name: 'token', type: 'string', secret: true },
        ],
      },
    ],
  };

  async function problems(steps: AutomationV1Input['steps']): Promise<readonly string[]> {
    const found = await checkAutomation(automationOf(steps), registry, 'work');
    return found.map(({ blockId, message }) => `${blockId ?? ''}: ${message}`);
  }

  const run = (
    id: string,
    values: object,
    extra: object = {},
  ): AutomationV1Input['steps'][number] => ({
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

  it('reports a missing tool as broken', async () => {
    expect(await problems([{ id: 'gone', type: 'run', tool: 'nothing' }])).toEqual([
      'gone: Tool "nothing" is not installed, or cannot be read',
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
      'a: Step "a" does not finish on every path that reaches this block, so its output may not exist',
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
      const automation = automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [{ id: 'start', type: 'start' }, ...blocks],
        connections,
      });
      const found = await checkAutomation(automation, registry, 'work');
      return found.map(({ blockId, message }) => `${blockId ?? ''}: ${message}`);
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
  });

  describe('links and expressions', () => {
    const chain = (...ids: string[]) =>
      ['start', ...ids].slice(1).map((to, index) => ({ from: ['start', ...ids][index], to }));
    const step = (id: string, values: object = {}) => ({
      id,
      type: 'run',
      tool: 'declared',
      values: { in: 'C:\\in', ...values },
    });
    const link = (expression: string) => ({ expression });
    async function blockProblems(blocks: object[], connections: object[], start: object = {}) {
      const automation = automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [{ id: 'start', type: 'start', ...start }, ...blocks],
        connections,
      });
      const found = await checkAutomation(automation, registry, 'work');
      return found.map(({ blockId, message }) => `${blockId ?? ''}: ${message}`);
    }

    it('accepts links to any block, before or after, and to inputs', async () => {
      const inputs = [{ name: 'size', type: 'integer' }];
      expect(
        await blockProblems(
          [
            step('a', { out: link('b.out'), count: link('inputs.size * 2') }),
            step('b', { out: 'C:\\b.csv', note: link('name(a.out) + "_" + a.count') }),
          ],
          chain('a', 'b'),
          { inputs },
        ),
      ).toEqual([]);
    });

    it('warns about reading what a disabled block leaves, and lets it run', async () => {
      const automation = automationSchema.parse({
        schemaVersion: 2,
        id: 'flow',
        name: 'Flow',
        blocks: [
          { id: 'start', type: 'start' },
          { ...step('a', { out: 'C:\\a.csv' }), disabled: true },
          step('b', {
            in: link('steps.a.outputs.csv'),
            note: '{{steps.a.outputs.csv}}',
            // A link reads what the block is set to, which a disabled block still is.
            out: link('a.out'),
          }),
          {
            id: 'check',
            type: 'if',
            condition: {
              match: 'all',
              rules: [{ block: 'a', field: 'exit-code', operator: 'equals', value: 0 }],
            },
          },
        ],
        connections: [...chain('a', 'b', 'check')],
      });
      const found = await checkAutomation(automation, registry, 'work');
      expect(found.map(({ blockId, message }) => `${blockId ?? ''}: ${message}`)).toEqual([
        'b: "Input" reads an output of "a", which is disabled and will not run',
        'b: "Note" reads an output of "a", which is disabled and will not run',
        'check: "Rule 1" checks the exit code of "a", which is disabled and will not run',
      ]);
      expect(found.every(isWarning)).toBe(true);
      expect(blockingProblems(found)).toEqual([]);
    });

    it('reports missing blocks, parameters, inputs and secrets', async () => {
      expect(
        await blockProblems(
          [
            step('a', {
              out: link('gone.out'),
              note: link('b.nothing'),
              count: link('inputs.size'),
              mode: link('b.token'),
            }),
            step('b'),
          ],
          chain('a', 'b'),
        ),
      ).toEqual([
        'a: "Output" links to block "gone", which does not exist',
        'a: "Note" links to "b.nothing", and that tool has no such parameter',
        'a: "Count" reads input "size", which does not exist',
        'a: "Mode" links to "b.token", which is secret and cannot be linked',
      ]);
    });

    it('reports a link to a block with no tool values, and expressions that do not fit', async () => {
      expect(
        await blockProblems(
          [
            step('a', {
              out: link('start.x'),
              note: link('1 +'),
              count: link('a.note'),
              mode: link('upper(1)'),
            }),
          ],
          chain('a'),
        ),
      ).toEqual([
        'a: "Output" links to "start", which runs no tool and so has no values',
        'a: The value of "Note" cannot be read: The expression ends too early',
        'a: The value of "Count" does not fit: it gives text, and needs a whole number',
        'a: The value of "Mode" does not fit: Needs text or a path here, and this is a whole number',
      ]);
    });

    it('reports links that go in a circle once', async () => {
      expect(
        await blockProblems(
          [step('a', { note: link('b.note') }), step('b', { note: link('a.note') })],
          chain('a', 'b'),
        ),
      ).toEqual(['a: "Note" links in a circle, back to itself: a.note → b.note → a.note']);
    });

    it('reads outputs and JSON fields only where they are certain', async () => {
      expect(
        await blockProblems(
          [
            step('a', { out: 'C:\\a.csv' }),
            step('b', {
              count: link('steps.a.outputs.result.count + 1'),
              in: link('steps.a.outputs.csv'),
              note: '{{steps.a.outputs.result.count}} rows',
            }),
            step('c', { note: link('text(steps.d.outputs.result.count)') }),
            step('d'),
          ],
          chain('a', 'b', 'c', 'd'),
        ),
      ).toEqual([
        'c: Step "d" does not finish on every path that reaches this block, so its output may not exist',
      ]);
      expect(
        await blockProblems(
          [
            step('a'),
            step('b', {
              note: link('steps.a.outputs.result.token'),
              out: link('steps.a.outputs.result.nope'),
              mode: '{{steps.a.outputs.csv.x}}',
            }),
          ],
          chain('a', 'b'),
        ),
      ).toEqual([
        'b: "Note" reads field "token" of output "result" of "a", which is secret',
        'b: "Output" reads field "nope" of output "result" of "a", which it does not declare',
        'b: "mode" does not fit a choice parameter',
      ]);
    });

    it('checks rules on values by type', async () => {
      const condition = (rules: object[]) => ({ match: 'all', rules });
      const rule = (read: string, operator: string, value?: unknown) => ({
        field: 'value',
        read: link(read),
        operator,
        ...(value === undefined ? {} : { value }),
      });
      expect(
        await blockProblems(
          [
            step('a'),
            {
              id: 'check',
              type: 'if',
              condition: condition([
                rule('steps.a.outputs.result.count', 'greater-than', 3),
                rule('steps.a.outputs.result.files', 'contains', 'x.txt'),
                rule('a.in', 'exists'),
                rule('inputs.mode', 'equals', link('a.mode')),
              ]),
            },
          ],
          chain('a', 'check'),
          { inputs: [{ name: 'mode', type: 'choice', choices: ['a', 'b'] }] },
        ),
      ).toEqual([]);
      expect(
        await blockProblems(
          [
            step('a'),
            {
              id: 'route',
              type: 'switch',
              cases: [
                {
                  id: 'big',
                  condition: condition([
                    rule('steps.a.outputs.result.count', 'contains', 'x'),
                    rule('a.count', 'greater-than', 'many'),
                    rule('a.note', 'equals', link('gone.x')),
                  ]),
                },
              ],
            },
          ],
          chain('a', 'route'),
        ),
      ).toEqual([
        'route: The value of "Rule 1 of case "big"" does not fit: "contains" does not work on a whole number',
        'route: The value of "Rule 2 of case "big"" does not fit: it compares a whole number with text',
        'route: "Rule 3 of case "big"" links to block "gone", which does not exist',
      ]);
    });
  });

  it('never changes an automation', async () => {
    await saveAutomation(dataDir, 'work', automationOf([{ id: 'a', type: 'run', tool: 'gone' }]));
    const before = await getAutomation(dataDir, 'work', 'flow');
    await checkAutomation(automationOf([{ id: 'a', type: 'run', tool: 'gone' }]), registry, 'work');
    expect(await getAutomation(dataDir, 'work', 'flow')).toEqual(before);
  });

  describe('loops and calls', () => {
    const graph = (blocks: object[], connections: object[], id = 'flow'): Automation =>
      automationSchema.parse({
        schemaVersion: 2,
        id,
        name: id,
        blocks: [
          { id: 'start', type: 'start', inputs: [{ name: 'files', type: 'string' }] },
          ...blocks,
        ],
        connections,
      });
    const loop = { id: 'For1', type: 'for', items: { kind: 'count', count: 2 } };
    const inBody = (id: string, values: object) => ({
      id,
      type: 'run',
      tool: 'declared',
      loop: 'For1',
      values: { in: 'C:\\in', ...values },
    });
    const after = (values: object) => ({
      id: 'after',
      type: 'run',
      tool: 'declared',
      values: { in: 'C:\\in', ...values },
    });
    const wiring = [
      { from: 'start', to: 'For1' },
      { from: 'For1', output: 'body', to: 'a' },
      { from: 'For1', to: 'after' },
    ];
    const messages = async (automation: Automation, calls?: CallTree) =>
      (await checkAutomation(automation, registry, 'work', calls)).map(
        ({ blockId, message }) => `${blockId ?? ''}: ${message}`,
      );

    it('reads the round inside the loop, and lists after it', async () => {
      const sound = graph(
        [
          loop,
          inBody('a', {
            in: { expression: 'join(inputs.files, text(loop.item))' },
            count: { expression: 'For1.index' },
          }),
          after({
            note: { expression: 'text(length(compact(steps.a.outputs.csv)))' },
            count: { expression: 'steps.For1.outputs.rounds' },
          }),
        ],
        wiring,
      );
      expect(await messages(sound)).toEqual([]);
    });

    it('refuses a list where one value goes, and loop names outside their loop', async () => {
      const wrong = graph(
        [
          loop,
          inBody('a', {}),
          after({
            out: { expression: 'steps.a.outputs.csv' },
            note: { expression: 'text(loop.index)' },
            count: { expression: 'For1.index' },
          }),
        ],
        wiring,
      );
      expect(await messages(wrong)).toEqual([
        'after: The value of "Output" does not fit: it gives a list, and needs a path',
        'after: "Note" reads loop, and this block is not inside a loop',
        'after: "Count" reads loop "For1", which is not around this block',
      ]);
    });

    it('checks the items of a For, and the condition of a While', async () => {
      const items = graph(
        [
          { ...loop, items: { kind: 'list', list: { expression: 'inputs.files' } } },
          inBody('a', {}),
          after({}),
        ],
        wiring,
      );
      expect(await messages(items)).toEqual([
        'For1: The items of "For1" do not fit: they need a list, and this is text',
      ]);
      const repeat = graph(
        [
          {
            id: 'For1',
            type: 'while',
            maxRounds: 5,
            condition: { expression: 'steps.a.outputs.result.count < 3 and loop.index < 4' },
          },
          inBody('a', {}),
          after({}),
        ],
        wiring,
      );
      expect(await messages(repeat)).toEqual([]);
      const notYesNo = graph(
        [
          { id: 'For1', type: 'while', maxRounds: 5, condition: { expression: 'loop.index' } },
          inBody('a', {}),
          after({}),
        ],
        wiring,
      );
      expect(await messages(notYesNo)).toEqual([
        'For1: The condition of "For1" is not yes or no: it gives a whole number',
      ]);
    });

    it('checks the inputs of a call and what the caller reads from it', async () => {
      const child = graph(
        [
          {
            id: 'c',
            type: 'run',
            tool: 'declared',
            values: { in: { expression: 'inputs.files' } },
          },
        ],
        [{ from: 'start', to: 'c' }],
        'child',
      );
      const parent = graph(
        [
          {
            id: 'Child1',
            type: 'run-automation',
            automation: 'child',
            inputs: { files: 'a', nope: 1 },
          },
          after({
            out: { expression: 'steps.Child1.c.outputs.csv' },
            note: { expression: 'text(steps.Child1.gone.outputs.csv)' },
          }),
        ],
        [
          { from: 'start', to: 'Child1' },
          { from: 'Child1', to: 'after' },
        ],
      );
      const tree = await readCallTree(parent, (id) =>
        Promise.resolve(id === 'child' ? child : undefined),
      );
      expect(await messages(parent, tree)).toEqual([
        'Child1: Automation "child" has no input "nope"',
        'after: "Note" reads block "gone" of the automation "Child1" calls, which has no such block',
      ]);
    });
  });

  describe('readCallTree', () => {
    const calling = (id: string, ...targets: string[]): Automation =>
      automationSchema.parse({
        schemaVersion: 2,
        id,
        name: id,
        blocks: [
          { id: 'start', type: 'start' },
          ...targets.map((target, index) => ({
            id: `Call${String(index + 1)}`,
            type: 'run-automation',
            automation: target,
          })),
        ],
        connections: targets
          .map((_, index) => ({ from: 'start', to: `Call${String(index + 1)}` }))
          .slice(0, 1),
      });

    it('refuses circles of calls, calls too deep, and missing automations', async () => {
      const files = new Map<string, Automation>([
        ['a', calling('a', 'b', 'gone')],
        ['b', calling('b', 'a')],
        ['c1', calling('c1', 'c2')],
        ['c2', calling('c2', 'c3')],
        ['c3', calling('c3', 'c4')],
        ['c4', calling('c4', 'c5')],
        ['c5', calling('c5', 'c6')],
        ['c6', calling('c6')],
      ]);
      const load = (id: string) => Promise.resolve(files.get(id));
      const tree = await readCallTree(files.get('a') as Automation, load);
      expect(tree.problems.map(({ blockId, message }) => `${blockId ?? ''}: ${message}`)).toEqual([
        'Call1: These automations end up calling themselves: a → b → a',
        'Call2: Automation "gone" does not exist in this Workspace, or cannot be read',
      ]);
      const deep = await readCallTree(files.get('c1') as Automation, load);
      expect(deep.problems.map(({ message }) => message)).toEqual([
        'Calls go more than 5 automations deep: c1 → c2 → c3 → c4 → c5 → c6',
      ]);
    });
  });
});
