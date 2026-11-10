import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest } from '../manifest/parse-manifest.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import {
  JSON_OUTPUT_BYTE_LIMIT,
  OutputError,
  readToolOutputs,
  secretOutputFields,
} from './tool-outputs.js';

const SAMPLE = fileURLToPath(new URL('../../../../examples/level-1-file-check/', import.meta.url));

/** A finished run with these values, as history records them. */
function runWith(values: Readonly<Record<string, string>>): RecordedToolRun {
  return {
    runId: 'run',
    parameters: Object.entries(values).map(([name, value]) => ({ name, label: name, value })),
    result: Promise.resolve({ status: 'completed', exitCode: 0, durationMs: 1 }),
    cancel: () => undefined,
    write: () => undefined,
    resize: () => undefined,
  };
}

describe('JSON outputs', () => {
  let folder: string;
  let tool: RegisteredTool;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'bildora-outputs-'));
    const manifest = parseManifest(await readFile(join(SAMPLE, 'tool.yaml'), 'utf8'));
    tool = {
      scope: { kind: 'global' },
      directory: SAMPLE,
      manifest: { ...manifest, run: { ...manifest.run, program: join(SAMPLE, 'check.mjs') } },
    };
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reads what the sample tool returns, field by field and by type', async () => {
    const file = join(folder, 'notes.txt');
    await writeFile(file, `short\n${'x'.repeat(30)}\nfine line\n`);
    const out = join(folder, 'out');
    const ran = spawnSync(
      process.execPath,
      [join(SAMPLE, 'check.mjs'), '--file', file, '--out', out, '--max-length', '20'],
      { encoding: 'utf8' },
    );
    expect(ran.status).toBe(0);

    const outputs = await readToolOutputs(tool, runWith({ file, out }), new Map());
    const summary = outputs.get('summary');
    expect(summary?.value).toBe(join(out, 'summary.json'));
    expect(Object.fromEntries(summary?.fields ?? [])).toEqual({
      lines: 3,
      words: 4,
      empty: false,
      longest: 30,
      tooLong: ['2'],
      name: 'notes.txt',
    });
    expect(secretOutputFields(tool)).toEqual(new Set());
  });

  it('refuses a file larger than its limit, before reading it', async () => {
    const out = join(folder, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'summary.json'), ' '.repeat(JSON_OUTPUT_BYTE_LIMIT + 1));
    await expect(readToolOutputs(tool, runWith({ out }), new Map())).rejects.toThrow(
      new OutputError('Output "summary" is larger than 1 MiB'),
    );
  });

  it('refuses a field missing, or of another type, and a list that is not of texts', async () => {
    const out = join(folder, 'out');
    const write = async (summary: object) => {
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'summary.json'), JSON.stringify(summary));
    };
    const base = { lines: 1, words: 1, empty: false, longest: 1, tooLong: [], name: 'a' };
    await write({ ...base, lines: undefined });
    await expect(readToolOutputs(tool, runWith({ out }), new Map())).rejects.toThrow(
      'Output "summary" has no field "lines"',
    );
    await write({ ...base, lines: 1.5 });
    await expect(readToolOutputs(tool, runWith({ out }), new Map())).rejects.toThrow(
      'Field "lines" of output "summary" must be a whole number',
    );
    await write({ ...base, tooLong: [1, 2] });
    await expect(readToolOutputs(tool, runWith({ out }), new Map())).rejects.toThrow(
      'Field "tooLong" of output "summary" must be a list of texts',
    );
    await write([base]);
    await expect(readToolOutputs(tool, runWith({ out }), new Map())).rejects.toThrow(
      'Output "summary" must hold one JSON object',
    );
  });
});
