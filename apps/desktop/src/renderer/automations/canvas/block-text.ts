import { DEFAULT_CASE, DEFAULT_OUTPUT, ERROR_OUTPUT } from '@bildora/protocol';
import type { AutomationBlock, AutomationCondition, AutomationRule } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MessageKey } from '../../../shared/i18n/translate.js';
import type { ToolView } from '../../../shared/ipc-contract.js';
import type { BlockKind } from './flow-document.js';

const KIND_KEYS: Readonly<Record<BlockKind, MessageKey>> = {
  start: 'canvas.kindStart',
  run: 'canvas.kindRun',
  'wait-for-time': 'canvas.kindTime',
  'wait-for-manual-action': 'canvas.kindManual',
  if: 'canvas.kindIf',
  switch: 'canvas.kindSwitch',
  parallel: 'canvas.kindParallel',
  join: 'canvas.kindJoin',
};

export function kindLabel(kind: BlockKind): string {
  return t(KIND_KEYS[kind]);
}

/** An output in words, as the canvas labels it. A Switch case is called by its name. */
export function outputLabel(output: string): string {
  switch (output) {
    case DEFAULT_OUTPUT:
      return t('canvas.outputNext');
    case ERROR_OUTPUT:
      return t('canvas.outputError');
    case 'true':
      return t('canvas.outputTrue');
    case 'false':
      return t('canvas.outputFalse');
    case DEFAULT_CASE:
      return t('canvas.outputDefault');
    default:
      return output;
  }
}

function ruleSentence(rule: AutomationRule, nameOf: (id: string) => string): string {
  const block = nameOf(rule.block);
  if (rule.field === 'result') {
    return t(`canvas.rule.${rule.operator}`, { block, value: t(`canvas.result.${rule.value}`) });
  }
  return t(`canvas.rule.${rule.operator}`, { block, value: rule.value });
}

/** A condition read back as a sentence, such as "Extract is completed and Report is failed". */
export function conditionSentence(
  condition: AutomationCondition,
  nameOf: (id: string) => string,
): string {
  const joiner = t(condition.match === 'all' ? 'canvas.and' : 'canvas.or');
  return condition.rules.map((rule) => ruleSentence(rule, nameOf)).join(` ${joiner} `);
}

/** What a block is called on the canvas and in problems, by what it does. */
export function blockName(
  block: AutomationBlock,
  tools: readonly ToolView[],
  nameOf?: (id: string) => string,
): string {
  switch (block.type) {
    case 'start':
      return t('canvas.kindStart');
    case 'run':
      return tools.find(({ id }) => id === block.tool)?.name ?? block.tool;
    case 'wait-for-time':
      return t('automation.labelTime', { count: block.seconds });
    case 'wait-for-manual-action':
      return block.message;
    case 'if':
      return nameOf === undefined
        ? kindLabel('if')
        : t('canvas.ifName', { rule: conditionSentence(block.condition, nameOf) });
    case 'switch':
      return kindLabel('switch');
    case 'parallel':
      return kindLabel('parallel');
    case 'join':
      return kindLabel('join');
  }
}

/**
 * Names for every block of a flow. A decision reads its rule back, which names other blocks, so
 * those are named first.
 */
export function blockNames(
  blocks: readonly AutomationBlock[],
  tools: readonly ToolView[],
): ReadonlyMap<string, string> {
  const plain = new Map(blocks.map((block) => [block.id, blockName(block, tools)]));
  const nameOf = (id: string): string => plain.get(id) ?? id;
  return new Map(blocks.map((block) => [block.id, blockName(block, tools, nameOf)]));
}
