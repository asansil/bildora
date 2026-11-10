import { AUTOMATION_PROBLEM_CODES, automationProblem } from '@bildora/protocol';
import { describe, expect, it } from 'vitest';
import { en } from '../../shared/i18n/en.js';
import { problemText } from './problem-text.js';

describe('problemText', () => {
  it('words every problem core can report, with a way to fix it', () => {
    for (const code of AUTOMATION_PROBLEM_CODES) {
      expect(Object.keys(en)).toContain(`problem.${code}`);
      expect(Object.keys(en)).toContain(`problem.${code}.fix`);
    }
  });

  it('names blocks as the canvas shows them', () => {
    const names: Record<string, string> = { fork: 'Parallel 1', meet: 'Join 1' };
    const text = problemText(
      automationProblem('join-unreached', { block: 'meet', parallel: 'fork' }, 'meet'),
      (id) => names[id] ?? id,
    );
    expect(text).toEqual({
      what: 'No branch of Parallel 1 reaches Join 1.',
      fix: 'Connect the end of each branch to Join 1.',
    });
  });
});
