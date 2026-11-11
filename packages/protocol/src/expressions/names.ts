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

/** What a dotted name reads. */
export type NameTarget =
  /** The value set in another block: `convert.file`. */
  | { readonly kind: 'link'; readonly block: string; readonly parameter: string }
  /** An input of the automation: `inputs.file`. */
  | { readonly kind: 'input'; readonly name: string }
  /** What an earlier block produced: `steps.extract.outputs.csv`, or a field of a JSON output. */
  | {
      readonly kind: 'output';
      readonly block: string;
      readonly output: string;
      readonly field?: string;
    }
  /** The run's own folder: `run.folder`. */
  | { readonly kind: 'run-folder' }
  /** A path variable of this computer: `paths.data`. */
  | { readonly kind: 'path-variable'; readonly name: string };

/**
 * Says what a name points at, throwing an `ExpressionError` when it has the wrong shape. Whether the
 * block, input or output exists is for the caller to check.
 */
export function targetOf(name: NameNode): NameTarget {
  const [head = '', second, third, fourth, fifth, ...rest] = name.parts;
  const wrong = (example: string): ExpressionError =>
    new ExpressionError('name', `${name.parts.join('.')} should read like ${example}`, name.span);
  switch (head) {
    case 'inputs':
      if (second === undefined || third !== undefined) throw wrong('inputs.file');
      return { kind: 'input', name: second };
    case 'steps':
      if (second === undefined || third !== 'outputs' || fourth === undefined || rest.length > 0) {
        throw wrong('steps.extract.outputs.csv');
      }
      return {
        kind: 'output',
        block: second,
        output: fourth,
        ...(fifth === undefined ? {} : { field: fifth }),
      };
    case 'run':
      if (second !== 'folder' || third !== undefined) throw wrong('run.folder');
      return { kind: 'run-folder' };
    case 'paths':
      if (second === undefined || third !== undefined) throw wrong('paths.data');
      return { kind: 'path-variable', name: second };
    case 'loop':
      throw new ExpressionError('name', 'Loops come in a later version', name.span);
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
    case 'if':
      return conditionExpressions(block.id, block.condition, undefined);
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

/**
 * Rewrites the block ids an expression names, keeping everything else as it was typed. `rename`
 * returns the new id, or undefined to keep it. Text that does not parse is returned as it is.
 */
export function renameInExpression(
  text: string,
  rename: (id: string) => string | undefined,
): string {
  const tree = parseCached(text);
  if (tree instanceof ExpressionError) return text;
  const edits: { span: Span; id: string }[] = [];
  for (const name of namesOf(tree)) {
    let target: NameTarget;
    try {
      target = targetOf(name);
    } catch {
      continue;
    }
    const at = target.kind === 'link' ? 0 : target.kind === 'output' ? 1 : undefined;
    if (at === undefined) continue;
    const id = rename(item(name.parts, at));
    if (id !== undefined && id !== name.parts[at])
      edits.push({ span: item(name.partSpans, at), id });
  }
  return edits
    .sort((a, b) => b.span.start - a.span.start)
    .reduce(
      (result, { span, id }) => result.slice(0, span.start) + id + result.slice(span.end),
      text,
    );
}

function renamedValue(
  value: BlockValue | undefined,
  rename: (id: string) => string | undefined,
): BlockValue | undefined {
  return isExpressionValue(value)
    ? { expression: renameInExpression(value.expression, rename) }
    : value;
}

function renamedCondition(
  condition: AutomationCondition,
  rename: (id: string) => string | undefined,
): AutomationCondition {
  return {
    ...condition,
    rules: condition.rules.map((rule) => {
      if (rule.field !== 'value') return rule;
      const value = renamedValue(rule.value, rename);
      return {
        ...rule,
        read: { expression: renameInExpression(rule.read.expression, rename) },
        ...(value === undefined ? {} : { value }),
      };
    }),
  };
}

/** A block with the ids named in its expressions rewritten. Other fields are left to the caller. */
export function renameInBlockExpressions<Block extends AutomationBlock>(
  block: Block,
  rename: (id: string) => string | undefined,
): Block {
  switch (block.type) {
    case 'run':
      if (block.values === undefined) return block;
      return {
        ...block,
        values: Object.fromEntries(
          Object.entries(block.values).map(([key, value]) => [
            key,
            renamedValue(value, rename) ?? value,
          ]),
        ),
      };
    case 'if':
      return { ...block, condition: renamedCondition(block.condition, rename) };
    case 'switch':
      return {
        ...block,
        cases: block.cases.map((branch) => ({
          ...branch,
          condition: renamedCondition(branch.condition, rename),
        })),
      };
    default:
      return block;
  }
}

/** Tells whether a block id would clash with the names expressions keep for other values. */
export function isReservedBlockId(id: string): boolean {
  return RESERVED_BLOCK_IDS.includes(id);
}
