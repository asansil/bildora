import { RUN_FOLDER_REFERENCE, guarantees, stepOutputReference } from '@bildora/protocol';
import type { AutomationBlock, GraphConnection } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { ToolView } from '../../../shared/ipc-contract.js';

export interface ReferenceOption {
  readonly label: string;
  readonly value: string;
}

/**
 * What a path value of a block can use: the run's folder, and outputs of blocks that finish on
 * every path into it, so the value always exists when the block runs.
 */
export function referenceOptionsFor(
  shape: {
    readonly blocks: readonly AutomationBlock[];
    readonly connections: readonly GraphConnection[];
  },
  blockId: string,
  tools: readonly ToolView[],
  nameOf: (id: string) => string,
): readonly ReferenceOption[] {
  const completed = guarantees(shape).get(blockId)?.completed ?? new Set<string>();
  const outputs = shape.blocks.flatMap((block) => {
    if (block.type !== 'run' || !completed.has(block.id)) return [];
    const declared = tools.find(({ id }) => id === block.tool)?.outputs ?? [];
    return declared.map((output) => ({
      label: `${nameOf(block.id)}: ${output}`,
      value: stepOutputReference({ step: block.id, output }),
    }));
  });
  return [{ label: t('automation.runFolder'), value: `${RUN_FOLDER_REFERENCE}/` }, ...outputs];
}
