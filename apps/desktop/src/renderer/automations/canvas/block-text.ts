import {
  BODY_OUTPUT,
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
  ExpressionNode,
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
  for: 'canvas.kindFor',
  while: 'canvas.kindWhile',
  'run-automation': 'canvas.kindCall',
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
    case BODY_OUTPUT:
      return t('canvas.outputBody');
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
    case BODY_OUTPUT:
      return { name, purpose: t('canvas.portBodyPurpose') };
    default:
      break;
  }
  if (kind === 'for' || kind === 'while') {
    return { name, purpose: t('canvas.portLoopNextPurpose') };
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
      case 'result':
        return t('canvas.resultOf', { block: nameOf(target.block) });
      case 'output':
        return [
          nameOf(target.block),
          ...(target.inner ?? []),
          target.output,
          ...(target.field === undefined ? [] : [target.field]),
        ].join(' › ');
      case 'run-folder':
        return t('automation.runFolder');
      case 'path-variable':
        return target.name;
      case 'loop':
        return `loop › ${target.value}`;
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
export function blockKindText(
  block: AutomationBlock,
  tools: readonly ToolView[],
  automations: readonly { readonly id: string; readonly name: string }[] = [],
): string {
  switch (block.type) {
    case 'start':
      return t('canvas.startKind');
    case 'run':
      return tools.find(({ id }) => id === block.tool)?.name ?? block.tool;
    case 'wait-for-time':
      return t('automation.labelTime', { count: block.seconds });
    case 'run-automation':
      return t('canvas.callKind', {
        name: automations.find(({ id }) => id === block.automation)?.name ?? block.automation,
      });
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

const COMPARISONS: Readonly<Record<string, MessageKey>> = {
  '==': 'canvas.says.equals',
  '!=': 'canvas.says.notEquals',
  '<': 'canvas.says.less',
  '<=': 'canvas.says.atMost',
  '>': 'canvas.says.more',
  '>=': 'canvas.says.atLeast',
};

const RESULT_WORDS = ['completed', 'failed', 'skipped'] as const;

function isResultWord(text: string): text is (typeof RESULT_WORDS)[number] {
  return (RESULT_WORDS as readonly string[]).includes(text);
}

/**
 * A yes/no expression read back as a sentence, such as "Check1 is not completed and rounds done is
 * less than 5". Parts it cannot say in words are shown as written. `roundsDone` names `loop.index`
 * as the rounds a While has done, which is what its condition reads.
 */
export function expressionSentence(
  expression: string,
  nameOf: (id: string) => string,
  roundsDone = false,
): string {
  const tree = parseCached(expression);
  if (tree instanceof ExpressionError) return `= ${expression}`;
  const source = (node: ExpressionNode): string => expression.slice(node.span.start, node.span.end);
  const resultOf = (node: ExpressionNode): string | undefined => {
    if (node.kind !== 'name') return undefined;
    try {
      const target = targetOf(node);
      return target.kind === 'result' ? nameOf(target.block) : undefined;
    } catch {
      return undefined;
    }
  };
  const value = (node: ExpressionNode): string => {
    switch (node.kind) {
      case 'number':
        return String(node.value);
      case 'text':
        return `"${node.value}"`;
      case 'boolean':
        return t(node.value ? 'canvas.says.yes' : 'canvas.says.no');
      case 'name': {
        if (roundsDone && node.parts.join('.') === 'loop.index') return t('canvas.says.rounds');
        const read = readableValue(source(node), nameOf);
        return read.startsWith('= ') ? source(node) : read;
      }
      default:
        return source(node);
    }
  };
  const say = (node: ExpressionNode): string => {
    if (node.kind === 'binary') {
      if (node.operator === 'and' || node.operator === 'or') {
        const joiner = t(node.operator === 'and' ? 'canvas.and' : 'canvas.or');
        return `${say(node.left)} ${joiner} ${say(node.right)}`;
      }
      const key = COMPARISONS[node.operator];
      if (key === undefined) return source(node);
      const block = resultOf(node.left);
      const { right } = node;
      if (
        block !== undefined &&
        right.kind === 'text' &&
        isResultWord(right.value) &&
        (node.operator === '==' || node.operator === '!=')
      ) {
        return t(node.operator === '==' ? 'canvas.rule.is' : 'canvas.rule.is-not', {
          block,
          value: t(`canvas.result.${right.value}`),
        });
      }
      return t(key, { left: value(node.left), right: value(right) });
    }
    if (node.kind === 'unary' && node.operator === 'not') {
      const inner = node.operand;
      const [path] = inner.kind === 'call' && inner.name === 'exists' ? inner.args : [];
      if (path !== undefined) return t('canvas.says.notExists', { path: value(path) });
      return t('canvas.says.not', { value: say(inner) });
    }
    if (node.kind === 'call' && node.name === 'exists') {
      const [path] = node.args;
      if (path !== undefined) return t('canvas.says.exists', { path: value(path) });
    }
    if (node.kind === 'name') return t('canvas.says.isYes', { value: value(node) });
    return value(node);
  };
  return say(tree);
}

/** A piece of a frame's header: words, or a value the person set, which stands out. */
export interface HeaderPart {
  readonly text: string;
  readonly chip?: true;
}

/** Marks where a value goes in a message, so that the message can be cut around it. */
const MARK = '\u0000';

/** A message cut into words and values, each value a chip. */
function partsOf(key: MessageKey, chips: Readonly<Record<string, string | number>>): HeaderPart[] {
  const marked = Object.fromEntries(
    Object.keys(chips).map((name) => [name, `${MARK}${name}${MARK}`]),
  );
  return t(key, marked)
    .split(MARK)
    .flatMap((piece, index): HeaderPart[] => {
      if (index % 2 === 0) return piece === '' ? [] : [{ text: piece }];
      return [{ text: String(chips[piece] ?? piece), chip: true }];
    });
}

/**
 * What a loop goes through, as its frame's header says it: a sentence whose values are chips, such
 * as "Repeat ‹3› times" or "While ‹Check1 is not completed›, at most ‹10›".
 */
export function loopHeader(
  block: AutomationBlock,
  nameOf: (id: string) => string,
): readonly HeaderPart[] | undefined {
  const read = (expression: string): string => {
    const words = readableValue(expression, nameOf);
    return words.startsWith('= ') ? expression : words;
  };
  if (block.type === 'while') {
    return partsOf('canvas.headerWhile', {
      condition: expressionSentence(block.condition.expression, nameOf, true),
      max: block.maxRounds,
    });
  }
  if (block.type !== 'for') return undefined;
  const { items } = block;
  switch (items.kind) {
    case 'count':
      return typeof items.count === 'number'
        ? partsOf(items.count === 1 ? 'canvas.headerOnce' : 'canvas.headerCount', {
            count: items.count,
          })
        : partsOf('canvas.headerCount', { count: read(items.count.expression) });
    case 'list':
      return partsOf('canvas.headerList', { list: read(items.list.expression) });
    case 'folder': {
      const folder = isExpressionValue(items.folder)
        ? read(items.folder.expression)
        : items.folder === ''
          ? '…'
          : String(items.folder);
      return items.pattern === undefined
        ? partsOf('canvas.headerFolder', { folder })
        : partsOf('canvas.headerFolderPattern', { folder, pattern: items.pattern });
    }
  }
}

/** The header of a loop's frame as plain text, for its tooltip. */
export function loopSummary(
  block: AutomationBlock,
  nameOf: (id: string) => string,
): string | undefined {
  return loopHeader(block, nameOf)
    ?.map(({ text }) => text)
    .join('');
}

/** A round path in words: `For1:3/While1:2` as "For1 round 3 › While1 round 2". */
export function roundText(round: string): string {
  return round
    .split('/')
    .map((part) => {
      const at = part.lastIndexOf(':');
      return t('history.round', { loop: part.slice(0, at), index: part.slice(at + 1) });
    })
    .join(' › ');
}
