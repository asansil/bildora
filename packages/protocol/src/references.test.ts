import { describe, expect, it } from 'vitest';
import {
  findStepOutputReferences,
  findUnknownReferences,
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
