/**
 * Values a field can link to or read, and what a linked field resolves to while the flow is edited.
 * The run works values out in core with the same language; here only what is known before a run is
 * shown, and anything that depends on the run reads as worked out later.
 */
import {
  ExpressionError,
  evaluateExpression,
  expressionsOf,
  findStepOutputReferences,
  fitsParameter,
  guarantees,
  isExpressionValue,
  parseCached,
  runtimeText,
  targetOf,
  targetsOf,
  typeOfExpression,
  typeOfParameter,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationInputDeclaration,
  GraphConnection,
  LiteralValue,
  NameNode,
  ParameterKind,
  RuntimeValue,
  ValueType,
} from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type {
  OutputFieldView,
  ParameterView,
  ProfileView,
  ToolView,
} from '../../../shared/ipc-contract.js';

/** What the canvas knows of a flow's blocks while it is edited. */
export interface ValueContext {
  readonly blocks: readonly AutomationBlock[];
  readonly connections: readonly GraphConnection[];
  readonly tools: readonly ToolView[];
  /** The profile each block uses, by block id, once it has been read. */
  readonly profiles: ReadonlyMap<string, ProfileView>;
}

export function toolOfBlock(context: ValueContext, blockId: string): ToolView | undefined {
  const block = context.blocks.find(({ id }) => id === blockId);
  return block?.type === 'run' ? context.tools.find(({ id }) => id === block.tool) : undefined;
}

/** The parameters a block can be linked to: those of its tool that are not secret. */
export function linkableParameters(
  context: ValueContext,
  blockId: string,
): readonly ParameterView[] {
  return (toolOfBlock(context, blockId)?.parameters ?? []).filter(({ secret }) => secret !== true);
}

export function inputsOfFlow(
  blocks: readonly AutomationBlock[],
): readonly AutomationInputDeclaration[] {
  const start = blocks.find(({ type }) => type === 'start');
  return start?.type === 'start' ? (start.inputs ?? []) : [];
}

/** What a resolved field shows under its link. */
export type ShownValue =
  /** Known now, from what blocks are set to and from input defaults. */
  | { readonly kind: 'value'; readonly text: string; readonly value: RuntimeValue }
  /** Known only when the flow runs: an output, the run's folder, or an input with no default. */
  | { readonly kind: 'later' }
  /** It cannot be worked out, which a problem of the flow explains. */
  | { readonly kind: 'unknown' };

/** Thrown inside evaluation for a name whose value only a run knows. */
class Later extends Error {}

/**
 * Works out what an expression of a block gives as the flow stands: links follow what blocks are
 * set to, their profile, then the default, and inputs give their default.
 */
export function shownValue(context: ValueContext, expression: string): ShownValue {
  const following = new Set<string>();
  const unknown = (name: NameNode) => new ExpressionError('value', 'unknown', name.span);
  const work = (text: string): RuntimeValue => {
    const tree = parseCached(text);
    if (tree instanceof ExpressionError) throw tree;
    return evaluateExpression(tree, names);
  };
  const names = {
    valueOf(name: NameNode): RuntimeValue {
      const target = targetOf(name);
      switch (target.kind) {
        case 'link': {
          const parameter = linkableParameters(context, target.block).find(
            ({ name: candidate }) => candidate === target.parameter,
          );
          if (parameter === undefined) throw unknown(name);
          const block = context.blocks.find(({ id }) => id === target.block);
          const own = block?.type === 'run' ? block.values?.[parameter.name] : undefined;
          if (isExpressionValue(own)) {
            const key = `${target.block}.${target.parameter}`;
            if (following.has(key)) throw unknown(name);
            following.add(key);
            const value = work(own.expression);
            following.delete(key);
            return value;
          }
          const value =
            own ?? context.profiles.get(target.block)?.values[parameter.name] ?? parameter.default;
          if (value === undefined) throw unknown(name);
          return value;
        }
        case 'input': {
          const input = inputsOfFlow(context.blocks).find(({ name: n }) => n === target.name);
          if (input === undefined) throw unknown(name);
          if (input.default === undefined) throw new Later();
          return input.default;
        }
        default:
          throw new Later();
      }
    },
  };
  try {
    const value = work(expression);
    return { kind: 'value', text: runtimeText(value), value };
  } catch (error) {
    if (error instanceof Later) return { kind: 'later' };
    if (error instanceof ExpressionError) return { kind: 'unknown' };
    throw error;
  }
}

/** A value a field or a rule can read, as a list offers it. */
export interface ValueChoice {
  /** What the list groups it under. */
  readonly group: 'run' | 'input' | 'result' | 'setting';
  /** The block it comes from, for results and settings. */
  readonly block?: string;
  /** Its own name, such as a parameter's label or `result › count`. */
  readonly label: string;
  /** What goes after `=`, such as `convert.file`. */
  readonly expression: string;
  readonly type: ValueType;
  /** Whether it fits where it would go. A value that does not fit is offered disabled. */
  readonly fits: boolean;
}

const FIELD_TYPES: Readonly<Record<OutputFieldView['type'], ValueType>> = {
  string: 'text',
  path: 'path',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  list: 'list',
};

/**
 * Everything a value of `blockId` can read: the automation's inputs, results of blocks that finish
 * on every path into it, and the settings of any other block. `fits` says whether each fits a
 * parameter of kind `wanted`; without one, every value fits.
 */
export function valueChoices(
  context: ValueContext,
  blockId: string,
  wanted?: ParameterKind,
): readonly ValueChoice[] {
  const fits = (type: ValueType): boolean => wanted === undefined || fitsParameter(type, wanted);
  const inputs = inputsOfFlow(context.blocks).map((input): ValueChoice => {
    const type = typeOfParameter(input.type);
    return {
      group: 'input',
      label: input.label ?? input.name,
      expression: `inputs.${input.name}`,
      type,
      fits: fits(type),
    };
  });
  const completed = guarantees(context).get(blockId)?.completed ?? new Set<string>();
  const results = context.blocks.flatMap((block): ValueChoice[] => {
    if (block.type !== 'run' || !completed.has(block.id)) return [];
    const tool = toolOfBlock(context, block.id);
    return (tool?.outputDetails ?? []).flatMap((output) => {
      const base = `steps.${block.id}.outputs.${output.name}`;
      const whole: ValueChoice = {
        group: 'result',
        block: block.id,
        label: output.name,
        expression: base,
        type: output.type,
        fits: fits(output.type),
      };
      const fields = (output.fields ?? [])
        .filter(({ secret }) => secret !== true)
        .map((field): ValueChoice => {
          const type = FIELD_TYPES[field.type];
          return {
            group: 'result',
            block: block.id,
            label: `${output.name} › ${field.name}`,
            expression: `${base}.${field.name}`,
            type,
            fits: fits(type),
          };
        });
      return [whole, ...fields];
    });
  });
  const settings = context.blocks.flatMap((block): ValueChoice[] =>
    block.type !== 'run' || block.id === blockId
      ? []
      : linkableParameters(context, block.id).map((parameter) => {
          const type = typeOfParameter(parameter.type);
          return {
            group: 'setting',
            block: block.id,
            label: parameter.label,
            expression: `${block.id}.${parameter.name}`,
            type,
            fits: fits(type),
          };
        }),
  );
  const folder: ValueChoice = {
    group: 'run',
    label: t('automation.runFolder'),
    expression: 'run.folder',
    type: 'path',
    fits: fits('path'),
  };
  return [folder, ...inputs, ...results, ...settings];
}

/**
 * The type an expression gives, as far as the flow being edited tells, or undefined when it cannot
 * be worked out, which a problem of the flow then explains.
 */
export function expressionType(context: ValueContext, expression: string): ValueType | undefined {
  const tree = parseCached(expression);
  if (tree instanceof ExpressionError) return undefined;
  const unknown = (name: NameNode) => new ExpressionError('name', 'unknown', name.span);
  try {
    return typeOfExpression(tree, {
      typeOf(name: NameNode): ValueType {
        const target = targetOf(name);
        switch (target.kind) {
          case 'link': {
            const parameter = linkableParameters(context, target.block).find(
              ({ name: candidate }) => candidate === target.parameter,
            );
            if (parameter === undefined) throw unknown(name);
            return typeOfParameter(parameter.type);
          }
          case 'input': {
            const input = inputsOfFlow(context.blocks).find(({ name: n }) => n === target.name);
            if (input === undefined) throw unknown(name);
            return typeOfParameter(input.type);
          }
          case 'output': {
            const output = toolOfBlock(context, target.block)?.outputDetails?.find(
              ({ name: n }) => n === target.output,
            );
            if (output === undefined) throw unknown(name);
            if (target.field === undefined) return output.type;
            const field = output.fields?.find(({ name: n }) => n === target.field);
            if (field === undefined) throw unknown(name);
            return FIELD_TYPES[field.type];
          }
          default:
            return 'path';
        }
      },
    });
  } catch (error) {
    if (error instanceof ExpressionError) return undefined;
    throw error;
  }
}

/**
 * How many other blocks use values of each block, by block id: links to its settings, and reads
 * of its results, also as `{{steps.<id>.outputs…}}` in text. Ctrl+F on `<id>.` finds the same
 * blocks.
 */
export function usedByCounts(blocks: readonly AutomationBlock[]): ReadonlyMap<string, number> {
  return new Map([...usersOf(blocks)].map(([id, set]) => [id, set.size]));
}

/** Which other blocks use values of each block, by block id, as `usedByCounts` counts them. */
export function usersOf(
  blocks: readonly AutomationBlock[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const users = new Map<string, Set<string>>();
  const use = (target: string, user: string): void => {
    if (target === user) return;
    const set = users.get(target) ?? new Set<string>();
    set.add(user);
    users.set(target, set);
  };
  for (const placed of expressionsOf(blocks)) {
    for (const { target } of targetsOf(placed.expression)) {
      if (target.kind === 'link' || target.kind === 'output') use(target.block, placed.block);
    }
  }
  for (const block of blocks) {
    if (block.type !== 'run') continue;
    for (const value of Object.values(block.values ?? {})) {
      if (typeof value !== 'string') continue;
      for (const reference of findStepOutputReferences(value)) use(reference.step, block.id);
    }
  }
  return users;
}

/** A value a block offers to the blocks after it, as its Data tab lists it. */
export interface SharedValue {
  readonly label: string;
  readonly expression: string;
  readonly type: ValueType;
}

/**
 * What other blocks can read from `blockId`: Start's inputs, and a tool block's results and
 * settings. Other kinds share nothing.
 */
export function sharedValues(context: ValueContext, blockId: string): readonly SharedValue[] {
  const block = context.blocks.find(({ id }) => id === blockId);
  if (block?.type === 'start') {
    return inputsOfFlow(context.blocks).map((input) => ({
      label: input.label ?? input.name,
      expression: `inputs.${input.name}`,
      type: typeOfParameter(input.type),
    }));
  }
  if (block?.type !== 'run') return [];
  const results = (toolOfBlock(context, blockId)?.outputDetails ?? []).flatMap((output) => {
    const base = `steps.${blockId}.outputs.${output.name}`;
    return [
      { label: output.name, expression: base, type: output.type },
      ...(output.fields ?? [])
        .filter(({ secret }) => secret !== true)
        .map((field) => ({
          label: `${output.name} › ${field.name}`,
          expression: `${base}.${field.name}`,
          type: FIELD_TYPES[field.type],
        })),
    ];
  });
  const settings = linkableParameters(context, blockId).map((parameter) => ({
    label: parameter.label,
    expression: `${blockId}.${parameter.name}`,
    type: typeOfParameter(parameter.type),
  }));
  return [...results, ...settings];
}

/** A plain value written as an expression, so that a person can go on from it. */
export function asExpression(value: LiteralValue | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/**
 * What a field keeps when its link is removed: the value it resolved to, as the parameter takes
 * it, or nothing when the value is only known when the flow runs.
 */
export function unlinkedValue(shown: ShownValue, kind: ParameterKind): LiteralValue | undefined {
  if (shown.kind !== 'value') return undefined;
  const { value } = shown;
  switch (kind) {
    case 'integer':
    case 'number':
      return typeof value === 'number' ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    default:
      return runtimeText(value);
  }
}
