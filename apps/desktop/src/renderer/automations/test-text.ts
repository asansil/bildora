/** Words for testing a block: why it cannot start, and what a test run was. */
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { RunTestView, TestBlockerView } from '../../shared/ipc-contract.js';

type MissingWhy = Extract<TestBlockerView, { code: 'value-missing' }>['why'];

const MISSING: Readonly<Record<MissingWhy, MessageKey>> = {
  'not-run': 'test.missing.not-run',
  failed: 'test.missing.failed',
  absent: 'test.missing.absent',
  secret: 'test.missing.secret',
  shortened: 'test.missing.shortened',
  'no-output': 'test.missing.no-output',
};

/** Why a test cannot start, in a sentence, naming blocks as the canvas does. */
export function testBlockerText(blocker: TestBlockerView, nameOf: (id: string) => string): string {
  switch (blocker.code) {
    case 'not-testable':
      return t('test.blocked.not-testable');
    case 'start':
      return t('test.blocked.start');
    case 'inside-loop':
      return t('test.blocked.inside-loop');
    case 'inside-branch':
      return t('test.blocked.inside-branch');
    case 'no-run':
      return t('test.blocked.no-run');
    case 'round-gone':
      return t('test.blocked.round-gone');
    case 'value-missing':
      return t(MISSING[blocker.why], { block: nameOf(blocker.block) });
  }
}

/** What a test run was, as a run's title and its history row say it. */
export function testLabel(test: RunTestView, nameOf: (id: string) => string): string {
  return t(test.kind === 'block' ? 'test.labelBlock' : 'test.labelFrom', {
    block: nameOf(test.blockId),
  });
}
