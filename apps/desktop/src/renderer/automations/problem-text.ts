import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { AutomationProblemView } from '../../shared/ipc-contract.js';

/** Parameters that hold a block id, which a person knows by the block's name instead. */
const BLOCK_PARAMETERS = ['block', 'source', 'parallel', 'from', 'to', 'loop'] as const;

export interface ProblemText {
  /** What is wrong. */
  readonly what: string;
  /** How to put it right. */
  readonly fix: string;
}

/**
 * Words a problem for someone who did not build the flow. Blocks are named as the canvas shows
 * them, and a problem of a block names that block as its owner.
 */
export function problemText(
  problem: AutomationProblemView,
  nameOf: (blockId: string) => string,
): ProblemText {
  const parameters: Record<string, string> = { ...problem.params };
  for (const name of BLOCK_PARAMETERS) {
    const id = parameters[name];
    if (id !== undefined) parameters[name] = nameOf(id);
  }
  if (problem.blockId !== undefined) parameters['owner'] = nameOf(problem.blockId);
  const key = `problem.${problem.code}` as MessageKey;
  return { what: t(key, parameters), fix: t(`${key}.fix` as MessageKey, parameters) };
}
