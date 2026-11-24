import {
  DEFAULT_CASE,
  DEFAULT_OUTPUT,
  ERROR_OUTPUT,
  ExpressionError,
  isExpressionValue,
  parseCached,
  targetOf,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  AutomationRule,
  BlockValue,
} from '@bildora/protocol';
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

/** A port in words, as its tooltip shows it: its name and what it is for. */
export interface PortText {
  readonly name: string;
  readonly purpose: string;
}

/** A block's input, or one of its outputs. A Switch case can share the input's id, so this says which. */
export type PortRef = { readonly input: true } | { readonly input: false; readonly output: string };

export function portText(kind: BlockKind, port: PortRef): PortText {
  if (port.input) {
    return { name: t('canvas.portInput'), purpose: t('canvas.portInputPurpose') };
  }
  const name = outputLabel(port.output);
  switch (port.output) {
    case ERROR_OUTPUT:
      if (kind !== 'switch') return { name, purpose: t('canvas.portErrorPurpose') };
      break;
    case 'true':
      if (kind === 'if') return { name, purpose: t('canvas.portTruePurpose') };
      break;
    case 'false':
      if (kind === 'if') return { name, purpose: t('canvas.portFalsePurpose') };
      break;
    case DEFAULT_CASE:
      if (kind === 'switch') return { name, purpose: t('canvas.portDefaultPurpose') };
      break;
    default:
      break;
  }
  return {
    name,
    purpose: t(kind === 'switch' ? 'canvas.portCasePurpose' : 'canvas.portNextPurpose'),
  };
}

/** A value as a rule shows it: text in quotes, and a worked-out value after `=`. */
export function ruleValueText(value: BlockValue | undefined): string {
  if (value === undefined) return '';
  if (isExpressionValue(value)) return `= ${value.expression}`;
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * A value as a sentence names it: a link as "Convert › file", an output as "Extract › result ›
 * count", an input as "Input › size". Anything more is shown as written, after `=`.
 */
export function readableValue(expression: string, nameOf: (id: string) => string): string {
  const tree = parseCached(expression);
  if (tree instanceof ExpressionError || tree.kind !== 'name') return `= ${expression}`;
  try {
    const target = targetOf(tree);
    switch (target.kind) {
      case 'link':
        return `${nameOf(target.block)} › ${target.parameter}`;
      case 'input':
        return t('canvas.choiceInput', { label: target.name });
      case 'output':
        return [
          nameOf(target.block),
          target.output,
          ...(target.field === undefined ? [] : [target.field]),
        ].join(' › ');
      case 'run-folder':
        return t('automation.runFolder');
      case 'path-variable':
        return target.name;
    }
  } catch {
    return `= ${expression}`;
  }
}

/** Names a value a rule reads, such as "Extract › result › count". */
type ValueName = (expression: string) => string;

function ruleSentence(
  rule: AutomationRule,
  nameOf: (id: string) => string,
  valueName: ValueName,
): string {
  if (rule.field === 'value') {
    return t(`canvas.valueRule.${rule.operator}`, {
      read: valueName(rule.read.expression),
      value: ruleValueText(rule.value),
    });
  }
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
  valueName: ValueName = (expression) => readableValue(expression, nameOf),
): string {
  const joiner = t(condition.match === 'all' ? 'canvas.and' : 'canvas.or');
  return condition.rules.map((rule) => ruleSentence(rule, nameOf, valueName)).join(` ${joiner} `);
}

/**
 * What a block is called on the canvas, in problems, in history and in sentences: its name in
 * links. Start is called Start.
 */
export function blockName(block: AutomationBlock): string {
  return block.type === 'start' ? t('canvas.kindStart') : block.id;
}

/** What a block is, as the second line of its label says: its tool's name, or its kind. */
export function blockKindText(block: AutomationBlock, tools: readonly ToolView[]): string {
  switch (block.type) {
    case 'start':
      return t('canvas.startKind');
    case 'run':
      return tools.find(({ id }) => id === block.tool)?.name ?? block.tool;
    case 'wait-for-time':
      return t('automation.labelTime', { count: block.seconds });
    default:
      return kindLabel(block.type);
  }
}

/** The rule of an If read back, such as "If FileCheck1 is completed". */
export function ifRuleText(condition: AutomationCondition, nameOf: (id: string) => string): string {
  return t('canvas.ifName', { rule: conditionSentence(condition, nameOf) });
}

/** Names for every block of a flow. */
export function blockNames(blocks: readonly AutomationBlock[]): ReadonlyMap<string, string> {
  return new Map(blocks.map((block) => [block.id, blockName(block)]));
}
