import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildAutomationV1JsonSchema } from './automation-v1.js';
import { automationV1Schema, toolManifestSchema } from './index.js';

const base = { schemaVersion: 1, id: 'nightly-report', name: 'Nightly report' };
const run = { id: 'extract', type: 'run', tool: 'acme.extractor' };
const full = {
  ...base,
  description: 'Everything at once',
  steps: [
    { ...run, profile: 'nightly', values: { out: '{{run.folder}}/a.csv' }, background: true },
    { id: 'done', type: 'wait-for-completion', step: 'extract', onFailure: 'continue' },
    { id: 'pause', type: 'wait-for-time', seconds: 5 },
    { id: 'review', type: 'wait-for-manual-action', message: 'Look at it' },
    {
      id: 'report',
      type: 'run',
      tool: 'acme.report',
      onFailure: { retry: { attempts: 3, delaySeconds: 30 } },
    },
  ],
};

function issues(input: unknown): string[] {
  const result = automationV1Schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('automationV1Schema', () => {
  it('accepts every kind of step, and keeps left-out fields left out', () => {
    expect(automationV1Schema.parse(full)).toEqual(full);
  });

  it('refuses unknown fields and an empty automation', () => {
    expect(issues({ ...full, extra: 1 })).not.toEqual([]);
    expect(issues({ ...base, steps: [] })).not.toEqual([]);
  });

  it('refuses a step id used twice', () => {
    expect(issues({ ...base, steps: [run, run] })).toEqual([
      'Step "extract" is declared more than once',
    ]);
  });

  it('refuses a failure policy on a background step', () => {
    const steps = [{ ...run, background: true, onFailure: 'continue' }];
    expect(issues({ ...base, steps })).toEqual([
      'A background step fails where it is waited for, so that step sets the policy',
    ]);
  });

  it.each([
    ['a later step', [{ id: 'w', type: 'wait-for-completion', step: 'extract' }, run]],
    ['a blocking step', [run, { id: 'w', type: 'wait-for-completion', step: 'extract' }]],
    ['no step', [run, { id: 'w', type: 'wait-for-completion', step: 'gone' }]],
  ])('refuses waiting for %s', (_label, steps) => {
    expect(issues({ ...base, steps })).toEqual([
      'Step "w" must wait for an earlier background step',
    ]);
  });

  it('allows a retry only where a step can run again', () => {
    const onFailure = { retry: { attempts: 2 } };
    const steps = [{ id: 'm', type: 'wait-for-manual-action', message: 'x', onFailure }];
    expect(issues({ ...base, steps })).not.toEqual([]);
    expect(issues({ ...base, steps: [{ ...run, onFailure }] })).toEqual([]);
    expect(
      issues({ ...base, steps: [{ ...run, onFailure: { retry: { attempts: 1 } } }] }),
    ).not.toEqual([]);
  });

  it('agrees with the published JSON Schema', () => {
    const validate = new Ajv2020({ strict: false }).compile(buildAutomationV1JsonSchema());
    expect(validate(full)).toBe(true);
    expect(validate({ ...full, extra: 1 })).toBe(false);
  });
});

describe('tool outputs', () => {
  it('cannot come from a secret parameter', () => {
    const result = toolManifestSchema.safeParse({
      schemaVersion: 1,
      id: 'acme.tool',
      name: 'Tool',
      version: '1.0.0',
      level: 1,
      run: { program: 'tool.exe' },
      parameters: [{ name: 'token', type: 'string', label: 'Token', secret: true, flag: '--t' }],
      outputs: [{ name: 'leak', param: 'token' }],
    });
    expect(result.success).toBe(false);
  });
});
