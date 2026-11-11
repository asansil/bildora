import { expressionsOfBlock } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import type { ToolView } from '../../../shared/ipc-contract.js';

/**
 * The blocks a canvas find matches, in the flow's order: by name, tool or id, or by what their
 * values and rules read, such as `convert.file` or `inputs.size`.
 */
export function matchingBlocks(
  blocks: readonly AutomationBlock[],
  query: string,
  names: ReadonlyMap<string, string>,
  tools: ReadonlyMap<string, ToolView>,
): readonly string[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return [];
  return blocks
    .filter((block) => {
      const tool = block.type === 'run' ? tools.get(block.tool) : undefined;
      const texts = [
        block.id,
        names.get(block.id) ?? '',
        ...(tool === undefined ? [] : [tool.name, tool.id]),
        ...expressionsOfBlock(block).map(({ expression }) => expression),
        ...(block.type === 'run'
          ? Object.values(block.values ?? {}).filter(
              (value): value is string => typeof value === 'string',
            )
          : []),
      ];
      return texts.some((text) => text.toLowerCase().includes(wanted));
    })
    .map(({ id }) => id);
}
