import { describe, expect, it } from 'vitest';
import {
  blockLabel,
  failureChoice,
  moveStep,
  newStep,
  newStepId,
  referenceOptions,
  stepLabel,
  withFailureChoice,
  without,
} from './automations/automation-draft.js';
import type { RunStep } from './automations/automation-draft.js';
import { formatDuration, historyState } from './history/history-format.js';
import {
  formProblems,
  initialValues,
  parameterProblem,
  shownParameters,
  submittedValues,
} from './tools/parameter-form.js';
import type { ParameterView, ToolView } from '../shared/ipc-contract.js';
import type { AutomationStep } from './automations/automation-draft.js';
import { en } from '../shared/i18n/en.js';
import { t } from '../shared/i18n/translate.js';
import type { RunView } from '../shared/ipc-contract.js';
import { matchCommands } from './palette/match-commands.js';
import { categoryInitial, placeCategory, toggleCategory } from './tools/category-rail.js';
import { countRunning, summarizeRuns } from './tools/run-state.js';

describe('automation drafts', () => {
  const tool = (id: string, level: 0 | 1, outputs?: readonly string[]): ToolView => ({
    key: `global/${id}`,
    id,
    scope: 'global',
    name: id.toUpperCase(),
    level,
    program: `C:\tools\${id}.exe`,
    permissions: [],
    runtime: { status: 'ready' },
    ...(outputs === undefined ? {} : { outputs }),
  });
  const tools = [tool('acme.report', 1, ['csv']), tool('plain', 0)];
  const run: RunStep = { id: 'report', type: 'run', tool: 'acme.report' };
  const pause: AutomationStep = { id: 'pause', type: 'wait-for-time', seconds: 5 };
  const look: AutomationStep = { id: 'look', type: 'wait-for-manual-action', message: 'Look' };

  it('makes ids a reference can hold, and never the same twice', () => {
    expect(newStepId('acme.report', [])).toBe('report');
    expect(newStepId('acme.report', [run])).toBe('report-2');
    expect(newStepId('1-2-3', [])).toBe('step');
  });

  it('starts a step only when there is something for it to work with', () => {
    expect(newStep('run', [], [])).toBeUndefined();
    expect(newStep('run', [], tools)).toEqual(run);
    expect(newStep('wait-for-time', [], tools)).toMatchObject({ seconds: 60 });
    expect(newStep('wait-for-manual-action', [], tools)?.id).toBe('review');
  });

  it('moves steps, and does nothing past either end', () => {
    const steps = [run, pause, look];
    expect(moveStep(steps, 2, -1).map(({ id }) => id)).toEqual(['report', 'look', 'pause']);
    expect(moveStep(steps, 0, 1).map(({ id }) => id)).toEqual(['pause', 'report', 'look']);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 1)).toBe(steps);
  });

  it('offers only what came before', () => {
    expect(referenceOptions([run, pause], 0, tools).map(({ value }) => value)).toEqual([
      '{{run.folder}}/',
    ]);
    expect(referenceOptions([run, pause], 2, tools)[1]).toEqual({
      label: 'report: csv',
      value: '{{steps.report.outputs.csv}}',
    });
  });

  it('keeps stop out of the file, because it is the default', () => {
    const retrying = withFailureChoice(run, 'retry');
    expect(failureChoice(retrying)).toBe('retry');
    expect(failureChoice(withFailureChoice(run, 'continue'))).toBe('continue');
    expect(withFailureChoice(retrying, 'stop')).toEqual(run);
    expect(failureChoice(pause)).toBe('stop');
  });

  it('removes fields altogether', () => {
    expect(Object.keys(without({ a: 1, b: 2 }, 'a'))).toEqual(['b']);
  });

  it('describes each kind of step', () => {
    expect(stepLabel(run, tools)).toBe('Run ACME.REPORT');
    expect(stepLabel({ ...run, tool: 'gone' }, tools)).toBe('Run gone');
    expect(stepLabel({ ...pause, seconds: 1 }, tools)).toBe('Wait 1 second');
    expect(stepLabel(look, tools)).toBe('Look');
  });

  it('describes the blocks that only a file can hold', () => {
    expect(blockLabel({ id: 'start', type: 'start' }, tools)).toBe('Start');
    expect(blockLabel({ id: 'fork', type: 'parallel' }, tools)).toBe(
      'Start parallel branches (fork)',
    );
    expect(blockLabel({ id: 'meet', type: 'join', parallel: 'fork' }, tools)).toBe(
      'Join the branches (meet)',
    );
    expect(blockLabel({ id: 'report', type: 'run', tool: 'acme.report' }, tools)).toBe(
      'Run ACME.REPORT',
    );
  });
});

describe('categoryInitial', () => {
  it.each([
    ['Analysis', 'A'],
    ['regression', 'R'],
    ['  spaced', 'S'],
    ['ñandú', 'Ñ'],
    ['études', 'É'],
    ['📊 Charts', '📊'],
    ['👩‍💻 Dev', '👩‍💻'],
    ['3D tools', '3'],
    ['', ''],
  ])('for %s', (label, expected) => {
    expect(categoryInitial(label)).toBe(expected);
  });
});

describe('placeCategory', () => {
  const tool = { tools: [] };
  const groups = [
    { ...tool, category: 'Alpha' },
    { ...tool, category: 'Beta' },
    { ...tool, category: 'Gamma' },
    tool,
  ];

  it('puts a dragged category in the place of the target', () => {
    expect(placeCategory(groups, [], 'Gamma', 'Alpha')).toEqual(['gamma', 'alpha', 'beta']);
    expect(placeCategory(groups, [], 'Alpha', 'Gamma')).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('keeps the place of a category that is not shown now', () => {
    expect(placeCategory(groups, ['gone'], 'Beta', 'Alpha')).toEqual([
      'beta',
      'alpha',
      'gamma',
      'gone',
    ]);
  });

  it('changes nothing for a drop on itself', () => {
    expect(placeCategory(groups, ['beta'], 'Beta', 'Beta')).toEqual(['beta']);
  });
});

describe('toggleCategory', () => {
  it('opens a category when the panel is closed', () => {
    expect(toggleCategory(undefined, 'a')).toBe('a');
  });

  it('closes the category that is open', () => {
    expect(toggleCategory('a', 'a')).toBeUndefined();
  });

  it('switches to another category', () => {
    expect(toggleCategory('a', 'b')).toBe('b');
  });

  it('treats Uncategorized, whose key is empty, like any other', () => {
    expect(toggleCategory(undefined, '')).toBe('');
    expect(toggleCategory('', '')).toBeUndefined();
  });
});

describe('t', () => {
  it('fills in parameters', () => {
    expect(t('status.version', { version: '1.2.3' })).toBe('v1.2.3');
  });

  it('picks the plural form from the count', () => {
    expect(t('status.tasksRunning', { count: 1 })).toBe('1 task running');
    expect(t('status.tasksRunning', { count: 3 })).toBe('3 tasks running');
  });

  it('leaves a value inserted by the user alone', () => {
    expect(t('remove.title', { name: '{count}' })).toBe('Remove {count}?');
  });

  it('has every placeholder written the same way', () => {
    const texts = Object.values(en).flatMap((message) =>
      typeof message === 'string' ? [message] : [message.one, message.other],
    );
    expect(texts.filter((text) => /\{[^a-zA-Z}]|\{\}/.test(text))).toEqual([]);
  });
});

describe('summarizeRuns', () => {
  const run = (runId: string, toolId: string, status: RunView['status']): RunView => ({
    runId,
    toolId,
    toolKey: toolId,
    status,
  });

  it('is idle before any run', () => {
    expect(summarizeRuns([run('1', 'other', 'running')], 'tool')).toEqual({
      state: 'idle',
      running: [],
    });
  });

  it('shows the finished state', () => {
    expect(summarizeRuns([run('1', 'tool', 'failed')], 'tool').state).toBe('failed');
  });

  it('prefers a running instance, and keeps the last result beside it', () => {
    const summary = summarizeRuns(
      [run('2', 'tool', 'running'), run('1', 'tool', 'completed')],
      'tool',
    );

    expect(summary.state).toBe('running');
    expect(summary.running).toHaveLength(1);
    expect(summary.last?.runId).toBe('1');
  });

  it('counts running tasks across tools', () => {
    expect(
      countRunning([run('1', 'a', 'running'), run('2', 'b', 'running'), run('3', 'c', 'failed')]),
    ).toBe(2);
  });
});

describe('matchCommands', () => {
  const items = ['Log Parser', 'CSV Viewer', 'Trace Analyzer', 'Parse Logs'].map((label) => ({
    label,
  }));
  const labels = (query: string): string[] => matchCommands(items, query).map((item) => item.label);

  it('shows everything for an empty query', () => {
    expect(labels('  ')).toHaveLength(4);
  });

  it('puts the start of a name first, then the start of a word', () => {
    expect(labels('par')).toEqual(['Parse Logs', 'Log Parser']);
  });

  it('ignores case', () => {
    expect(labels('CSV')).toEqual(['CSV Viewer']);
  });

  it('finds letters in order', () => {
    expect(labels('tan')).toEqual(['Trace Analyzer']);
  });

  it('finds nothing when the letters are not there', () => {
    expect(labels('zzz')).toEqual([]);
  });
});

describe('parameter form', () => {
  const text = (name: string, extra: Partial<ParameterView> = {}): ParameterView => ({
    name,
    label: name,
    type: 'string',
    required: false,
    delivery: 'argument',
    ...extra,
  });
  const parameters: readonly ParameterView[] = [
    text('input', { type: 'path', required: true }),
    text('count', { type: 'integer', default: 3 }),
    text('ratio', { type: 'number' }),
    text('verbose', { type: 'boolean', default: true }),
    text('mode', { type: 'choice', choices: ['a', 'b'], default: 'a' }),
    text('token', { secret: true, required: true }),
  ];

  it('shows the parameters of the console script only when the script answers', () => {
    const answered = text('choice', { delivery: 'script', required: true });
    const all = [parameters[0], answered].filter((item) => item !== undefined);

    expect(shownParameters(all, false).map(({ name }) => name)).toEqual(['input']);
    expect(shownParameters(all, true).map(({ name }) => name)).toEqual(['input', 'choice']);
    expect(formProblems(shownParameters(all, false), {}, [])).toEqual({
      input: 'runner.required',
    });
  });

  it('starts from the defaults, with text for everything but checkboxes', () => {
    expect(initialValues(parameters)).toEqual({
      input: '',
      count: '3',
      ratio: '',
      verbose: true,
      mode: 'a',
      token: '',
    });
  });

  it('lets a profile replace defaults, and never fills a secret', () => {
    const profile = {
      id: 'p',
      name: 'P',
      values: { count: 9, verbose: false, token: 'leaked' },
      secrets: ['token'],
    };

    expect(initialValues(parameters, profile)).toMatchObject({
      count: '9',
      verbose: false,
      token: '',
    });
  });

  it('asks for required fields, unless a saved secret fills one', () => {
    const values = initialValues(parameters);

    expect(formProblems(parameters, values, [])).toEqual({
      input: 'runner.required',
      token: 'runner.required',
    });
    expect(formProblems(parameters, values, ['token'])).toEqual({ input: 'runner.required' });
  });

  it.each([
    ['integer', '12', undefined],
    ['integer', '-3', undefined],
    ['integer', '1.5', 'runner.notWholeNumber'],
    ['integer', 'abc', 'runner.notWholeNumber'],
    ['integer', '99999999999999999999', 'runner.notWholeNumber'],
    ['number', '1.5', undefined],
    ['number', '1e3', undefined],
    ['number', 'abc', 'runner.notNumber'],
    ['number', 'Infinity', 'runner.notNumber'],
  ] as const)('checks %s value %s', (type, value, problem) => {
    expect(parameterProblem(text('field', { type }), value, false)).toBe(problem);
  });

  it('types values, keeps secrets apart and leaves empty fields out', () => {
    const { plain, secrets } = submittedValues(parameters, {
      input: 'a.txt',
      count: '4',
      ratio: '',
      verbose: false,
      mode: 'b',
      token: 'typed',
    });

    expect(plain).toEqual({ input: 'a.txt', count: 4, verbose: false, mode: 'b' });
    expect(secrets).toEqual({ token: 'typed' });
  });
});

describe('history format', () => {
  it.each([
    [undefined, '—'],
    [1234, '1.2 s'],
    [65_000, '1 min 5 s'],
    [3_780_000, '1 h 3 min'],
  ])('shows %s ms', (durationMs, shown) => {
    expect(formatDuration(durationMs)).toBe(shown);
  });

  it('reads an interrupted run as cancelled', () => {
    expect(historyState('interrupted')).toBe('cancelled');
    expect(historyState('failed')).toBe('failed');
  });
});
