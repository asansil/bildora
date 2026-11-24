import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import { expressionSentence, loopHeader, portText } from './block-text.js';

describe('loop headers', () => {
  const nameOf = (id: string) => id;
  const header = (block: AutomationBlock) =>
    loopHeader(block, nameOf)
      ?.map(({ text, chip }) => (chip === true ? `[${text}]` : text))
      .join('');

  it('says what a For goes through, with what was set as chips', () => {
    const items = (value: object): AutomationBlock =>
      ({ id: 'For1', type: 'for', items: value }) as AutomationBlock;
    expect(header(items({ kind: 'count', count: 3 }))).toBe('Repeat [3] times');
    expect(header(items({ kind: 'count', count: 1 }))).toBe('Repeat [1] time');
    expect(header(items({ kind: 'folder', folder: 'C:\\in', pattern: '*.pdf' }))).toBe(
      'For each file in [C:\\in] matching [*.pdf]',
    );
    expect(
      header(items({ kind: 'list', list: { expression: 'steps.Extract1.outputs.rows' } })),
    ).toBe('For each item in [Extract1 › rows]');
  });

  it('reads the condition of a While back as a sentence', () => {
    const block: AutomationBlock = {
      id: 'While1',
      type: 'while',
      maxRounds: 10,
      condition: { expression: 'steps.Check1.result != "completed"' },
    };
    expect(header(block)).toBe('While [Check1 is not completed], at most [10]');
    expect(expressionSentence('not exists(inputs.file) and loop.index < 5', nameOf, true)).toBe(
      'Input › file does not exist and rounds done is less than 5',
    );
  });
});

describe('portText', () => {
  it('names the input and says the flow comes in', () => {
    expect(portText('run', { input: true })).toEqual({
      name: 'Input',
      purpose: 'The flow comes in here',
    });
  });

  it('says what each output leads to', () => {
    const purpose = (kind: Parameters<typeof portText>[0], output: string) =>
      portText(kind, { input: false, output }).purpose;
    expect(purpose('run', 'next')).toBe('Continues here when this step ends');
    expect(purpose('run', 'error')).toBe('Continues here if this step fails');
    expect(purpose('if', 'true')).toBe('Continues here when the condition is true');
    expect(purpose('if', 'false')).toBe('Continues here when the condition is false');
    expect(purpose('switch', 'big')).toBe('Continues here when the value matches this case');
    expect(purpose('switch', 'default')).toBe('Continues here when no case matches');
  });

  it('reads a Switch case named like another output as a case', () => {
    expect(portText('switch', { input: false, output: 'error' }).purpose).toBe(
      'Continues here when the value matches this case',
    );
    expect(portText('switch', { input: false, output: 'true' }).purpose).toBe(
      'Continues here when the value matches this case',
    );
  });

  it('names an output as the canvas labels it', () => {
    expect(portText('run', { input: false, output: 'error' }).name).toBe('Error');
    expect(portText('switch', { input: false, output: 'big' }).name).toBe('big');
  });
});
