import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SCHEMA_VERSION, toolManifestSchema } from '@bildora/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from '../history/run-history.js';
import { saveProfile } from '../profiles/profile-store.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { createMemorySecretStore } from '../secrets/secret-store.js';
import { startRecordedRun } from './recorded-run.js';
import type { RecordedRunOptions } from './recorded-run.js';
import type { RunProgress } from './progress-lines.js';

const SECRET = 'hunter2-Sup3r&Secret"%PATH%';

describe.skipIf(process.platform !== 'win32')('startRecordedRun', () => {
  let dataDir: string;
  let scriptFolder: string;
  let script: string;
  let history: RunHistory;
  let registry: ToolRegistry;
  let store: ReturnType<typeof createMemorySecretStore>;

  async function declaredTool(): Promise<RegisteredTool> {
    return registry.register(
      toolManifestSchema.parse({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id: 'sample',
        name: 'Sample',
        version: '1.0.0',
        level: 1,
        interpreter: 'node',
        run: { program: script },
        parameters: [
          { name: 'label', type: 'string', label: 'Label', flag: '--label' },
          { name: 'token', type: 'string', label: 'Token', secret: true, env: 'SAMPLE_TOKEN' },
          { name: 'passed', type: 'string', label: 'Passed', secret: true, flag: '--passed' },
        ],
      }),
    );
  }

  function options(extra: Partial<RecordedRunOptions> = {}): RecordedRunOptions {
    return { history, store, historyRunLimit: 200, ...extra };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-recorded-'));
    scriptFolder = await mkdtemp(join(tmpdir(), 'bildora-recorded-script-'));
    script = join(scriptFolder, 'tool.mjs');
    await writeFile(
      script,
      `const write = (text) => new Promise((resolve) => process.stdout.write(text + '\\n', resolve));
await write('ARGS ' + JSON.stringify(process.argv.slice(2)));
await write('TOKEN ' + process.env.SAMPLE_TOKEN);
await write('::bildora-progress {"percent":50,"message":"Half way"}');
await write('DONE');
if (process.env.HANG_TOOL) { process.stdin.resume(); process.stdin.once('data', async (data) => { await write('TYPED ' + data); process.exit(4); }); }`,
    );
    history = await RunHistory.open(dataDir);
    registry = await ToolRegistry.open({ dataDir });
    store = createMemorySecretStore();
  });

  afterEach(async () => {
    history.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(scriptFolder, { recursive: true, force: true });
  });

  it('records parameters, text and result, with progress out of the text', async () => {
    const tool = await declaredTool();
    const progress: RunProgress[] = [];
    const output: string[] = [];

    const run = await startRecordedRun(
      tool,
      options({
        values: { label: 'first' },
        onProgress: (item) => progress.push(item),
        onOutput: (data) => output.push(data),
      }),
    );
    const result = await run.result;

    expect(result.status).toBe('completed');
    expect(progress).toEqual([{ percent: 50, message: 'Half way' }]);
    expect(output.join('')).toContain('DONE');
    const record = history.get(run.runId);
    expect(record).toMatchObject({
      toolId: 'sample',
      toolName: 'Sample',
      status: 'completed',
      exitCode: 0,
      parameters: [{ name: 'label', value: 'first' }, { name: 'token' }, { name: 'passed' }],
    });
    expect(record?.output).toContain('ARGS ["--label","first"]');
    expect(record?.output).toContain('DONE');
    expect(record?.output).not.toContain('bildora-progress');
  });

  it('hands a secret over through the environment, and records it nowhere', async () => {
    const tool = await declaredTool();

    const shown: string[] = [];
    const run = await startRecordedRun(
      tool,
      options({ values: { token: SECRET }, onOutput: (data) => shown.push(data) }),
    );
    await run.result;

    expect(shown.join('')).toContain('TOKEN ••••••');
    expect(shown.join('')).not.toContain('hunter2');
    const record = history.get(run.runId);
    expect(record?.output).toContain('TOKEN ••••••');
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(record?.parameters).toContainEqual({ name: 'token', label: 'Token', secret: true });
    history.close();
    for (const file of await readdir(dataDir)) {
      if (file.startsWith('history.db')) {
        expect(await readFile(join(dataDir, file), 'latin1')).not.toContain('hunter2');
      }
    }
    history = await RunHistory.open(dataDir);
  });

  it('redacts a secret passed as an argument, as well', async () => {
    const tool = await declaredTool();

    const run = await startRecordedRun(tool, options({ values: { passed: 'plain-secret' } }));
    await run.result;

    expect(history.get(run.runId)?.output).toContain('ARGS ["--passed","••••••"]');
  });

  it('fills a run from a profile, with its secret from the store', async () => {
    const tool = await declaredTool();
    const profile = await saveProfile(
      tool,
      { name: 'Nightly', values: { label: 'saved' }, secrets: { token: SECRET } },
      store,
    );

    const run = await startRecordedRun(tool, options({ profile, values: { label: 'typed' } }));
    await run.result;

    const record = history.get(run.runId);
    expect(record?.output).toContain('ARGS ["--label","typed"]');
    expect(record?.output).toContain('TOKEN ••••••');
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it('fails a run whose secret cannot be read, without showing why in detail', async () => {
    const tool = await declaredTool();
    const profile = await saveProfile(
      tool,
      { name: 'Nightly', values: {}, secrets: { token: SECRET } },
      store,
    );
    const broken = {
      ...store,
      get: () => Promise.reject(new Error(`reading ${SECRET} failed`)),
    };

    const run = await startRecordedRun(tool, options({ profile, store: broken }));

    expect(await run.result).toMatchObject({ status: 'failed', failure: { kind: 'credentials' } });
    expect(JSON.stringify(history.get(run.runId))).not.toContain(SECRET);
  });

  it('records a run that could not start', async () => {
    const tool = await declaredTool();

    const run = await startRecordedRun(tool, options({ values: { unknown: 'x' } }));

    expect(await run.result).toMatchObject({ status: 'failed' });
    expect(history.get(run.runId)).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid-parameters' },
    });
  });

  it('takes typed input, and keeps a cancelled run in the record', async () => {
    const tool = await declaredTool();
    const seen: string[] = [];
    const run = await startRecordedRun(
      tool,
      options({
        env: { ...process.env, HANG_TOOL: '1' },
        onOutput: (data) => seen.push(data),
      }),
    );
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (seen.join('').includes('DONE')) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });

    run.resize(80, 20);
    run.write('hello\r');

    expect(await run.result).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(history.get(run.runId)?.output).toContain('TYPED hello');
  });

  it('keeps only the newest runs of a tool', async () => {
    const tool = await declaredTool();

    for (const label of ['a', 'b', 'c']) {
      const run = await startRecordedRun(tool, options({ historyRunLimit: 2, values: { label } }));
      await run.result;
    }

    expect(history.list('sample')).toHaveLength(2);
  });

  it('records a level 0 tool with no output', async () => {
    const fixture = fileURLToPath(
      new URL('../../../../examples/fixtures/fake-tool.mjs', import.meta.url),
    );
    const tool = await registry.register(
      toolManifestSchema.parse({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id: 'plain',
        name: 'Plain',
        version: '0.0.0',
        level: 0,
        interpreter: 'node',
        run: { program: fixture, args: ['exit', '0'] },
      }),
    );

    const run = await startRecordedRun(tool, options());
    await run.result;

    expect(history.get(run.runId)).toMatchObject({ status: 'completed', level: 0, output: '' });
  });
});
