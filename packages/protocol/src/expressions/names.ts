/**
 * What the names in an expression point at, and the places of an automation that hold expressions.
 * Core checks and runs them from here, and the app shows, finds and renames them from here.
 */
import type { AutomationBlock, AutomationCondition, BlockValue } from '../automation.js';
import { RESERVED_BLOCK_IDS, isExpressionValue } from '../automation.js';
import { ExpressionError, namesOf, parseExpression } from './syntax.js';
import type { ExpressionNode, Span } from './syntax.js';
import type { NameNode } from './language.js';

/** The item at `index`, which the caller knows is there. */
function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`No item at ${String(index)}`);
  return value;
}

/** What a loop gives the blocks inside it: `loop.item`, `loop.index` and `loop.folder`. */
export const LOOP_VALUES = ['item', 'index', 'folder'] as const;
export type LoopValue = (typeof LOOP_VALUES)[number];

export function isLoopValue(name: string): name is LoopValue {
  return (LOOP_VALUES as readonly string[]).includes(name);
}

/** What a dotted name reads. */
export type NameTarget =
  /**
   * The value set in another block: `convert.file`. When that block is a loop around the reader,
   * as in `For1.item`, it reads that loop's round instead, which only the caller can tell.
   */
  | { readonly kind: 'link'; readonly block: string; readonly parameter: string }
  /** An input of the automation: `inputs.file`. */
  | { readonly kind: 'input'; readonly name: string }
  /**
   * What an earlier block produced: `steps.extract.outputs.csv`, or a field of a JSON output. When
   * `block` runs another automation, `inner` names the block in it, and in the automations that one
   * calls in turn: `steps.Report1.Extract1.outputs.csv`.
   */
  | {
      readonly kind: 'output';
      readonly block: string;
      readonly output: string;
      readonly field?: string;
      readonly inner?: readonly string[];
    }
  /**
   * How an earlier block ended: `steps.Check1.result`, which reads `completed`, `failed`, or
   * `skipped` when it did not run.
   */
  | { readonly kind: 'result'; readonly block: string }
  /** The run's own folder: `run.folder`. */
  | { readonly kind: 'run-folder' }
  /** A path variable of this computer: `paths.data`. */
  | { readonly kind: 'path-variable'; readonly name: string }
  /** The round of the nearest loop around the block: `loop.item`. */
  | { readonly kind: 'loop'; readonly value: LoopValue };

/**
 * Says what a name points at, throwing an `ExpressionError` when it has the wrong shape. Whether the
 * block, input or output exists is for the caller to check.
 */
export function targetOf(name: NameNode): NameTarget {
  const [head = '', second, third] = name.parts;
  const wrong = (example: string): ExpressionError =>
    new ExpressionError('name', `${name.parts.join('.')} should read like ${example}`, name.span);
  switch (head) {
    case 'inputs':
      if (second === undefined || third !== undefined) throw wrong('inputs.file');
      return { kind: 'input', name: second };
    case 'steps': {
      if (third === 'result' && name.parts.length === 3 && second !== undefined) {
        return { kind: 'result', block: second };
      }
      // The blocks come first, then `outputs`, the output, and maybe a field of it.
      const at = name.parts.indexOf('outputs', 2);
      const [block, ...inner] = at < 0 ? [] : name.parts.slice(1, at);
      const [output, field, ...rest] = at < 0 ? [] : name.parts.slice(at + 1);
      if (block === undefined || output === undefined || rest.length > 0) {
        throw wrong('steps.extract.outputs.csv or steps.extract.result');
      }
      return {
        kind: 'output',
        block,
        output,
        ...(field === undefined ? {} : { field }),
        ...(inner.length === 0 ? {} : { inner }),
      };
    }
    case 'run':
      if (second !== 'folder' || third !== undefined) throw wrong('run.folder');
      return { kind: 'run-folder' };
    case 'paths':
      if (second === undefined || third !== undefined) throw wrong('paths.data');
      return { kind: 'path-variable', name: second };
    case 'loop':
      if (second === undefined || !isLoopValue(second) || third !== undefined) {
        throw wrong('loop.item, loop.index or loop.folder');
      }
      return { kind: 'loop', value: second };
    default:
      if (second === undefined || third !== undefined) throw wrong('convert.file');
      return { kind: 'link', block: head, parameter: second };
  }
}

const PARSED_CACHE_LIMIT = 500;
const parsedCache = new Map<string, ExpressionNode | ExpressionError>();

/**
 * Parses an expression, remembering recent ones, since the app reads the same few many times while
 * a flow is edited. Returns the error rather than throwing it.
 */
export function parseCached(text: string): ExpressionNode | ExpressionError {
  const known = parsedCache.get(text);
  if (known !== undefined) return known;
  let parsed: ExpressionNode | ExpressionError;
  try {
    parsed = parseExpression(text);
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    parsed = error;
  }
  if (parsedCache.size >= PARSED_CACHE_LIMIT) parsedCache.clear();
  parsedCache.set(text, parsed);
  return parsed;
}

/** The targets an expression reads, leaving out names with the wrong shape. */
export function targetsOf(text: string): { readonly target: NameTarget; readonly span: Span }[] {
  const tree = parseCached(text);
  if (tree instanceof ExpressionError) return [];
  return namesOf(tree).flatMap((name) => {
    try {
      return [{ target: targetOf(name), span: name.span }];
    } catch {
      return [];
    }
  });
}

/** Where in a block an expression sits. */
export type ExpressionPlace =
  | { readonly kind: 'value'; readonly parameter: string }
  /** A value for an input of the automation a Run automation block calls. */
  | { readonly kind: 'input'; readonly input: string }
  /** What a For goes through: its list, its folder or its number of times. */
  | { readonly kind: 'items' }
  /** The yes/no expression a While checks before each round. */
  | { readonly kind: 'condition' }
  | {
      readonly kind: 'rule';
      /** The Switch case, for a Switch. */
      readonly case?: string;
      readonly index: number;
      readonly side: 'read' | 'value';
    };

export interface PlacedExpression {
  /** The block holding the expression. */
  readonly block: string;
  readonly place: ExpressionPlace;
  readonly expression: string;
}

function conditionExpressions(
  block: string,
  condition: AutomationCondition,
  caseId: string | undefined,
): PlacedExpression[] {
  return condition.rules.flatMap((rule, index) => {
    if (rule.field !== 'value') return [];
    const base = {
      kind: 'rule' as const,
      index,
      ...(caseId === undefined ? {} : { case: caseId }),
    };
    const found: PlacedExpression[] = [
      { block, place: { ...base, side: 'read' }, expression: rule.read.expression },
    ];
    if (isExpressionValue(rule.value)) {
      found.push({ block, place: { ...base, side: 'value' }, expression: rule.value.expression });
    }
    return found;
  });
}

/** The value a For reads its items from. */
export function forSource(block: Extract<AutomationBlock, { type: 'for' }>): BlockValue | number {
  const { items } = block;
  switch (items.kind) {
    case 'list':
      return items.list;
    case 'folder':
      return items.folder;
    case 'count':
      return items.count;
  }
}

/** Every expression a block holds, in its values and in the rules of its conditions. */
export function expressionsOfBlock(block: AutomationBlock): PlacedExpression[] {
  switch (block.type) {
    case 'run':
      return Object.entries(block.values ?? {}).flatMap(([parameter, value]) =>
        isExpressionValue(value)
          ? [
              {
                block: block.id,
                place: { kind: 'value' as const, parameter },
                expression: value.expression,
              },
            ]
          : [],
      );
    case 'run-automation':
      return Object.entries(block.inputs ?? {}).flatMap(([input, value]) =>
        isExpressionValue(value)
          ? [
              {
                block: block.id,
                place: { kind: 'input' as const, input },
                expression: value.expression,
              },
            ]
          : [],
      );
    case 'for': {
      const source = forSource(block);
      return isExpressionValue(source)
        ? [{ block: block.id, place: { kind: 'items' as const }, expression: source.expression }]
        : [];
    }
    case 'if':
      return conditionExpressions(block.id, block.condition, undefined);
    case 'while':
      return [
        {
          block: block.id,
          place: { kind: 'condition' as const },
          expression: block.condition.expression,
        },
      ];
    case 'switch':
      return block.cases.flatMap((branch) =>
        conditionExpressions(block.id, branch.condition, branch.id),
      );
    default:
      return [];
  }
}

/** Every expression of an automation. */
export function expressionsOf(blocks: readonly AutomationBlock[]): PlacedExpression[] {
  return blocks.flatMap(expressionsOfBlock);
}

/** A link from a place in one block to a value set in another. */
export interface LinkUse extends PlacedExpression {
  readonly target: { readonly block: string; readonly parameter: string };
}

/** Every link of an automation, so that a block can say how many others use its values. */
export function linkUses(blocks: readonly AutomationBlock[]): LinkUse[] {
  return expressionsOf(blocks).flatMap((placed) =>
    targetsOf(placed.expression).flatMap(({ target }) =>
      target.kind === 'link'
        ? [{ ...placed, target: { block: target.block, parameter: target.parameter } }]
        : [],
    ),
  );
}

/** `<block>.<parameter>`, the way a link is written and found. */
export function linkKey(block: string, parameter: string): string {
  return `${block}.${parameter}`;
}

/**
 * The values that link to one another in a circle, as `<block>.<parameter>` keys, each circle once.
 * Only block values can be linked to, so rules never take part in a circle.
 */
export function linkCycles(blocks: readonly AutomationBlock[]): string[][] {
  const edges = new Map<string, string[]>();
  for (const use of linkUses(blocks)) {
    if (use.place.kind !== 'value') continue;
    const from = linkKey(use.block, use.place.parameter);
    edges.set(from, [...(edges.get(from) ?? []), linkKey(use.target.block, use.target.parameter)]);
  }
  const cycles: string[][] = [];
  const done = new Set<string>();
  const onPath: string[] = [];
  const visit = (key: string): void => {
    const at = onPath.indexOf(key);
    if (at >= 0) {
      cycles.push(onPath.slice(at));
      return;
    }
    if (done.has(key)) return;
    onPath.push(key);
    for (const next of edges.get(key) ?? []) visit(next);
    onPath.pop();
    done.add(key);
  };
  for (const key of edges.keys()) visit(key);
  return cycles;
}

/** Applies edits to the parts of names, keeping everything else as it was typed. */
function applyEdits(text: string, edits: readonly { span: Span; id: string }[]): string {
  return [...edits]
    .sort((a, b) => b.span.start - a.span.start)
    .reduce(
      (result, { span, id }) => result.slice(0, span.start) + id + result.slice(span.end),
      text,
    );
}

/** The names of an expression with what they point at, leaving out those with the wrong shape. */
function targetedNames(text: string): { name: NameNode; target: NameTarget }[] {
  const tree = parseCached(text);
  if (tree instanceof ExpressionError) return [];
  return namesOf(tree).flatMap((name) => {
    try {
      return [{ name, target: targetOf(name) }];
    } catch {
      return [];
    }
  });
}

/**
 * Rewrites the block ids an expression names, keeping everything else as it was typed. `rename`
 * returns the new id, or undefined to keep it. Text that does not parse is returned as it is. A loop
 * read by its name, as in `For1.item`, is renamed as a link is.
 */
export function renameInExpression(
  text: string,
  rename: (id: string) => string | undefined,
): string {
  const edits: { span: Span; id: string }[] = [];
  for (const { name, target } of targetedNames(text)) {
    const at =
      target.kind === 'link'
        ? 0
        : target.kind === 'output' || target.kind === 'result'
          ? 1
          : undefined;
    if (at === undefined) continue;
    const id = rename(item(name.parts, at));
    if (id !== undefined && id !== name.parts[at]) {
      edits.push({ span: item(name.partSpans, at), id });
    }
  }
  return applyEdits(text, edits);
}

/**
 * Rewrites the names of blocks inside called automations, as `Extract1` in
 * `steps.Report1.Extract1.outputs.csv`. `rename` gets the Run automation blocks that lead to the
 * automation holding the block, outermost first, and the block's id. It returns the new id, or
 * undefined to keep it.
 */
export function renameCalledInExpression(
  text: string,
  rename: (calls: readonly string[], id: string) => string | undefined,
): string {
  const edits: { span: Span; id: string }[] = [];
  for (const { name, target } of targetedNames(text)) {
    if (target.kind !== 'output' || target.inner === undefined) continue;
    const calls = [target.block];
    target.inner.forEach((id, index) => {
      const renamed = rename([...calls], id);
      if (renamed !== undefined && renamed !== id) {
        edits.push({ span: item(name.partSpans, index + 2), id: renamed });
      }
      calls.push(id);
    });
  }
  return applyEdits(text, edits);
}

/** Rewrites every expression a block holds with `edit`. Other fields are left as they are. */
export function editBlockExpressions<Block extends AutomationBlock>(
  block: Block,
  edit: (expression: string) => string,
): Block {
  const value = (held: BlockValue | undefined): BlockValue | undefined =>
    isExpressionValue(held) ? { expression: edit(held.expression) } : held;
  const values = (held: Readonly<Record<string, BlockValue>>): Record<string, BlockValue> =>
    Object.fromEntries(Object.entries(held).map(([key, one]) => [key, value(one) ?? one]));
  const condition = (rules: AutomationCondition): AutomationCondition => ({
    ...rules,
    rules: rules.rules.map((rule) => {
      if (rule.field !== 'value') return rule;
      const compared = value(rule.value);
      return {
        ...rule,
        read: { expression: edit(rule.read.expression) },
        ...(compared === undefined ? {} : { value: compared }),
      };
    }),
  });
  switch (block.type) {
    case 'run':
      return block.values === undefined ? block : { ...block, values: values(block.values) };
    case 'run-automation':
      return block.inputs === undefined ? block : { ...block, inputs: values(block.inputs) };
    case 'if':
      return { ...block, condition: condition(block.condition) };
    case 'while':
      return { ...block, condition: { expression: edit(block.condition.expression) } };
    case 'switch':
      return {
        ...block,
        cases: block.cases.map((branch) => ({ ...branch, condition: condition(branch.condition) })),
      };
    case 'for': {
      const { items } = block;
      if (items.kind === 'list') {
        return { ...block, items: { ...items, list: { expression: edit(items.list.expression) } } };
      }
      if (items.kind === 'folder') {
        return { ...block, items: { ...items, folder: value(items.folder) ?? items.folder } };
      }
      return isExpressionValue(items.count)
        ? { ...block, items: { ...items, count: { expression: edit(items.count.expression) } } }
        : block;
    }
    default:
      return block;
  }
}

/** A block with the ids named in its expressions rewritten. Other fields are left to the caller. */
export function renameInBlockExpressions<Block extends AutomationBlock>(
  block: Block,
  rename: (id: string) => string | undefined,
): Block {
  return editBlockExpressions(block, (expression) => renameInExpression(expression, rename));
}

/** Tells whether a block id would clash with the names expressions keep for other values. */
export function isReservedBlockId(id: string): boolean {
  return RESERVED_BLOCK_IDS.includes(id);
}
