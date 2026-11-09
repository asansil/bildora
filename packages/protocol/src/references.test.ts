import { describe, expect, it } from 'vitest';
import {
  findParameterReferences,
  findStepOutputReferences,
  findUnknownParameterReferences,
  findUnknownReferences,
  replaceParameterReferences,
  replaceRunReferences,
  stepOutputReference,
  usesRunFolder,
} from './index.js';

describe('run references', () => {
  it('finds step outputs in order, among other text', () => {
    expect(
      findStepOutputReferences('{{paths.x}}/{{steps.a.outputs.csv}}-{{steps.b_2.outputs.log}}'),
    ).toEqual([
      { step: 'a', output: 'csv' },
      { step: 'b_2', output: 'log' },
    ]);
  });

  it('writes what it reads', () => {
    const reference = { step: 'extract', output: 'csv' };
    expect(findStepOutputReferences(stepOutputReference(reference))).toEqual([reference]);
  });

  it('tells whether a text uses the run folder', () => {
    expect(usesRunFolder('{{run.folder}}/a.csv')).toBe(true);
    expect(usesRunFolder('D:/out')).toBe(false);
  });

  it('replaces both kinds, leaves path variables, and does not read replacements again', () => {
    const replaced = replaceRunReferences('{{paths.base}}/{{run.folder}}/{{steps.a.outputs.csv}}', {
      runFolder: () => '{{steps.a.outputs.csv}}',
      stepOutput: ({ step }) => `<${step}>`,
    });
    expect(replaced).toBe('{{paths.base}}/{{steps.a.outputs.csv}}/<a>');
  });

  it('reports only what it does not know', () => {
    expect(
      findUnknownReferences(
        '{{paths.a}} {{run.folder}} {{steps.a.outputs.b}} {{run.foldr}} {{steps.a}}',
      ),
    ).toEqual(['{{run.foldr}}', '{{steps.a}}']);
  });
});

describe('parameter references', () => {
  it('finds parameters in order, among other text', () => {
    expect(findParameterReferences('{{params.a}} and {{params.b_2}} {{params.}}')).toEqual([
      'a',
      'b_2',
    ]);
  });

  it('reports every other double-brace text', () => {
    expect(
      findUnknownParameterReferences('{{params.a}} {{run.folder}} {{params.a.b}} {{ params.a }}'),
    ).toEqual(['{{run.folder}}', '{{params.a.b}}', '{{ params.a }}']);
  });

  it('replaces them, and does not read replacements again', () => {
    expect(
      replaceParameterReferences('{{params.a}}-{{params.b}}', (name) =>
        name === 'a' ? '{{params.b}}' : 'B',
      ),
    ).toBe('{{params.b}}-B');
  });
});
