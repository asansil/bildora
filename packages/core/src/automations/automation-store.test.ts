import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSchema, toolManifestSchema } from '@bildora/protocol';
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
      'a: Refers to "later", which is not an earlier run step',
      'later: Step "a" declares no output "nothing"',
      'b: Step "plain" runs a registered program, which declares no outputs',
      'c: Unknown reference {{run.foldr}}',
    ]);
  });

  it('needs a background step waited for before its output is used', async () => {
    const slow = run('slow', { out: 'C:\\a.csv' }, { background: true });
    const use = run('use', { in: '{{steps.slow.outputs.csv}}' });
    expect(await problems([slow, use])).toEqual([
      'use: Step "slow" runs in the background, so it must be waited for first',
    ]);
    expect(
      await problems([slow, { id: 'meet', type: 'wait-for-completion', step: 'slow' }, use]),
    ).toEqual([]);
  });

  it('never changes an automation', async () => {
    await saveAutomation(dataDir, 'work', automationOf([{ id: 'a', type: 'run', tool: 'gone' }]));
    const before = await getAutomation(dataDir, 'work', 'flow');
    await checkAutomation(automationOf([{ id: 'a', type: 'run', tool: 'gone' }]), registry, 'work');
    expect(await getAutomation(dataDir, 'work', 'flow')).toEqual(before);
  });
});
