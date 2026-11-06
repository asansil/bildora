import { describe, expect, it } from 'vitest';
import { en } from '../shared/i18n/en.js';
import { t } from '../shared/i18n/translate.js';
import type { RunView } from '../shared/ipc-contract.js';
import { matchCommands } from './palette/match-commands.js';
import { categoryInitial, toggleCategory } from './tools/category-rail.js';
import { countRunning, summarizeRuns } from './tools/run-state.js';

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
