/**
 * Values a block works out from others: links to what another block is set to, inputs of the
 * automation, outputs of earlier blocks and expressions over them. The same rules check a flow
 * before it runs and work its values out while it runs.
 */
import {
  ExpressionError,
  evaluateExpression,
  fitsParameter,
  isExpressionValue,
  linkCycles,
  namesOf,
  parseCached,
  targetOf,
  toParameterValue,
  typeOfExpression,
  typeOfParameter,
  typeWord,
} from '@bildora/protocol';
import type {
  Automation,
  AutomationProblemCode,
  AutomationProblemParams,
  Guarantee,
  LiteralValue,
  NameNode,
  ParameterKind,
  RuntimeValue,
  Span,
  ToolOutputFieldType,
  ToolParameter,
  ValueType,
} from '@bildora/protocol';
import { isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';

/** A problem found inside one block, which the caller files under that block. */
export interface Found {
  readonly code: AutomationProblemCode;
  readonly params: AutomationProblemParams;
}

export const found = (
  code: AutomationProblemCode,
  params: AutomationProblemParams = {},
): Found => ({
  code,
  params,
});

/** What is known of the blocks of an automation: their tools and profiles, by block id. */
export interface ValueContext {
  readonly automation: Automation;
  readonly tools: ReadonlyMap<string, RegisteredTool>;
  readonly profiles: ReadonlyMap<string, Profile>;
}

/** What a parameter of a block is set to, before any expression is worked out. */
export type Configured =
  | { readonly kind: 'literal'; readonly value: LiteralValue }
  | { readonly kind: 'expression'; readonly text: string }
  /** Set in the block's profile as a secret, which nothing may read. */
  | { readonly kind: 'secret' };

export function parametersOf(tool: RegisteredTool | undefined): readonly ToolParameter[] {
  return tool?.manifest.level === 1 ? tool.manifest.parameters : [];
}

/** What a block is set to: its own value, then its profile's, then the parameter's default. */
export function configuredValue(
  context: ValueContext,
  blockId: string,
  parameter: ToolParameter,
): Configured | undefined {
  const block = context.automation.blocks.find(({ id }) => id === blockId);
  const own = block?.type === 'run' ? block.values?.[parameter.name] : undefined;
  if (isExpressionValue(own)) return { kind: 'expression', text: own.expression };
  if (own !== undefined) return { kind: 'literal', value: own };
  const profile = context.profiles.get(blockId);
  if (profile?.secrets.includes(parameter.name) === true) return { kind: 'secret' };
  const fromProfile = profile?.values[parameter.name];
  if (fromProfile !== undefined) return { kind: 'literal', value: fromProfile };
  return parameter.default === undefined
    ? undefined
    : { kind: 'literal', value: parameter.default };
}

/** A name that cannot be read, with the problem that says why. */
class NameProblem extends ExpressionError {
  readonly problem: Found | undefined;

  /** With no problem, another one already tells, such as the source block's missing tool. */
  constructor(problem: Found | undefined, span: Span) {
    super('name', problem?.code ?? 'already reported', span);
    this.problem = problem;
  }
}

const FIELD_TYPES: Record<ToolOutputFieldType, ValueType> = {
  string: 'text',
  path: 'path',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  list: 'list',
};

/**
 * The type of each name an expression in a block reads, checked against what the automation and
 * its tools declare. `certain` says which blocks complete on every path that reaches the block.
 */
function nameTypes(context: ValueContext, certain: Guarantee, label: string) {
  const { automation, tools } = context;
  const problem = (name: NameNode, code: AutomationProblemCode, params: AutomationProblemParams) =>
    new NameProblem(found(code, { label, ...params }), name.span);
  const silent = (name: NameNode) => new NameProblem(undefined, name.span);
  return {
    typeOf(name: NameNode): ValueType {
      const target = targetOf(name);
      switch (target.kind) {
        case 'link': {
          const source = automation.blocks.find(({ id }) => id === target.block);
          if (source === undefined) {
            throw problem(name, 'link-block-missing', { source: target.block });
          }
          if (source.type !== 'run') throw problem(name, 'link-not-run', { source: source.id });
          const tool = tools.get(source.id);
          if (tool === undefined) throw silent(name);
          const parameter = parametersOf(tool).find(({ name: n }) => n === target.parameter);
          const params = { source: source.id, parameter: target.parameter };
          if (parameter === undefined) throw problem(name, 'link-parameter-missing', params);
          if (isSecretParameter(parameter)) throw problem(name, 'link-secret', params);
          return typeOfParameter(parameter.type);
        }
        case 'input': {
          const start = automation.blocks.find(({ type }) => type === 'start');
          const input =
            start?.type === 'start'
              ? start.inputs?.find(({ name: n }) => n === target.name)
              : undefined;
          if (input === undefined) throw problem(name, 'input-unknown', { input: target.name });
          return typeOfParameter(input.type);
        }
        case 'output': {
          const source = automation.blocks.find(({ id }) => id === target.block);
          if (source?.type !== 'run') {
            throw problem(name, 'reference-not-run', { source: target.block });
          }
          const manifest = tools.get(source.id)?.manifest;
          if (manifest === undefined) throw silent(name);
          if (manifest.level === 0) throw problem(name, 'reference-level-0', { source: source.id });
          const output = manifest.outputs.find(({ name: n }) => n === target.output);
          const params = { source: source.id, output: target.output, field: target.field ?? '' };
          if (output === undefined) throw problem(name, 'reference-output-unknown', params);
          if (!certain.completed.has(source.id)) {
            throw problem(name, 'reference-not-certain', { source: source.id });
          }
          if (!('json' in output)) {
            if (target.field !== undefined) throw problem(name, 'output-field-unknown', params);
            if ('path' in output) return 'path';
            const parameter = manifest.parameters.find(({ name: n }) => n === output.param);
            return parameter?.type === 'path' ? 'path' : 'text';
          }
          // The output itself is the file the tool wrote.
          if (target.field === undefined) return 'path';
          const field = output.fields.find(({ name: n }) => n === target.field);
          if (field === undefined) throw problem(name, 'output-field-unknown', params);
          if (field.secret) throw problem(name, 'output-field-secret', params);
          return FIELD_TYPES[field.type];
        }
        case 'run-folder':
        case 'path-variable':
          return 'path';
      }
    },
  };
}

/** Whether a block is set to be passed through, so that it leaves nothing for later blocks. */
export function isDisabledBlock(automation: Automation, id: string): boolean {
  const block = automation.blocks.find((candidate) => candidate.id === id);
  return block !== undefined && 'disabled' in block && block.disabled === true;
}

const ERROR_CODES: Record<ExpressionError['code'], AutomationProblemCode> = {
  syntax: 'expression-syntax',
  name: 'expression-name',
  function: 'expression-function',
  type: 'expression-type',
  value: 'expression-type',
};

/**
 * Checks one expression of a block, and that it fits where it goes when `expected` says. `label`
 * names the field or rule for the problem. Returns the problems found and, if it could be worked
 * out, the expression's type.
 */
export function checkExpression(
  context: ValueContext,
  certain: Guarantee,
  text: string,
  label: string,
  expected?: ParameterKind,
): { readonly problems: readonly Found[]; readonly type?: ValueType } {
  const tree = parseCached(text);
  if (tree instanceof ExpressionError) {
    return { problems: [found(ERROR_CODES[tree.code], { label, detail: tree.message })] };
  }
  // Outputs of a disabled block are warned about, whatever else the expression gets wrong.
  const disabled = new Set<string>();
  for (const name of namesOf(tree)) {
    const target = targetOf(name);
    if (target.kind === 'output' && isDisabledBlock(context.automation, target.block)) {
      disabled.add(target.block);
    }
  }
  const warnings = [...disabled].map((source) => found('output-from-disabled', { label, source }));
  let type: ValueType;
  try {
    type = typeOfExpression(tree, nameTypes(context, certain, label));
  } catch (error) {
    if (error instanceof NameProblem) {
      return { problems: error.problem === undefined ? warnings : [error.problem, ...warnings] };
    }
    if (error instanceof ExpressionError) {
      return {
        problems: [found(ERROR_CODES[error.code], { label, detail: error.message }), ...warnings],
      };
    }
    throw error;
  }
  if (expected !== undefined && !fitsParameter(type, expected)) {
    const needed = typeWord(typeOfParameter(expected));
    return {
      problems: [
        found('expression-type', {
          label,
          detail: `it gives ${typeWord(type)}, and needs ${needed}`,
        }),
        ...warnings,
      ],
      type,
    };
  }
  return { problems: warnings, type };
}

/** Values linked to one another in a circle, each reported on the block where it starts. */
export function linkCycleProblems(
  context: ValueContext,
): readonly { readonly blockId: string; readonly problem: Found }[] {
  return linkCycles(context.automation.blocks).map((cycle) => {
    const [first = ''] = cycle;
    const [blockId = '', parameter = ''] = first.split('.');
    const label =
      parametersOf(context.tools.get(blockId)).find(({ name }) => name === parameter)?.label ??
      parameter;
    return {
      blockId,
      problem: found('link-cycle', { label, reference: [...cycle, first].join(' → ') }),
    };
  });
}

/** What a block left for later blocks to read, by output. */
export interface OutputValue {
  /** A path or text, or for a JSON output the file it read. */
  readonly value: RuntimeValue;
  /** The fields of a JSON output, secret ones included, which only history leaves out. */
  readonly fields?: ReadonlyMap<string, RuntimeValue>;
}

/** What a run knows when it works a value out. */
export interface RunValueContext extends ValueContext {
  readonly inputs: ReadonlyMap<string, LiteralValue>;
  readonly outputs: ReadonlyMap<string, ReadonlyMap<string, OutputValue>>;
  readonly runFolder: string;
  readonly pathVariables: ReadonlyMap<string, string>;
  /** Replaces `{{...}}` references in a text value, which linked text values hold too. */
  readonly expandText: (text: string, isPath: boolean) => string;
}

function valueError(message: string, span: Span): ExpressionError {
  return new ExpressionError('value', message, span);
}

/**
 * Works out an expression while a run goes on. Links are followed through chains of other links;
 * the check before the run has already refused circles and types that do not fit.
 */
export function evaluateInRun(context: RunValueContext, text: string): RuntimeValue {
  const following = new Set<string>();
  const evaluateText = (expression: string): RuntimeValue => {
    const tree = parseCached(expression);
    if (tree instanceof ExpressionError) throw tree;
    return evaluateExpression(tree, names);
  };
  const names = {
    valueOf(name: NameNode): RuntimeValue {
      const target = targetOf(name);
      switch (target.kind) {
        case 'link': {
          const key = `${target.block}.${target.parameter}`;
          const parameter = parametersOf(context.tools.get(target.block)).find(
            ({ name: n }) => n === target.parameter,
          );
          if (parameter === undefined || isSecretParameter(parameter)) {
            throw valueError(`${key} cannot be read`, name.span);
          }
          const configured = configuredValue(context, target.block, parameter);
          if (configured === undefined) throw valueError(`${key} has no value`, name.span);
          if (configured.kind === 'secret') throw valueError(`${key} is secret`, name.span);
          if (configured.kind === 'literal') {
            const { value } = configured;
            const isText = parameter.type === 'string' || parameter.type === 'path';
            return isText && typeof value === 'string'
              ? context.expandText(value, parameter.type === 'path')
              : value;
          }
          if (following.has(key)) throw valueError(`${key} links back to itself`, name.span);
          following.add(key);
          const value = toParameterValue(evaluateText(configured.text), parameter.type, name.span);
          following.delete(key);
          return value;
        }
        case 'input': {
          const value = context.inputs.get(target.name);
          if (value === undefined) {
            throw valueError(`Input "${target.name}" has no value`, name.span);
          }
          return value;
        }
        case 'output': {
          const output = context.outputs.get(target.block)?.get(target.output);
          const value =
            target.field === undefined ? output?.value : output?.fields?.get(target.field);
          if (value === undefined) {
            const what = [target.output, target.field].filter((part) => part !== undefined);
            // A name error, as a missing reference is, rather than a value that went wrong.
            throw new ExpressionError(
              'name',
              `Step "${target.block}" did not produce output "${what.join('.')}"`,
              name.span,
            );
          }
          return value;
        }
        case 'run-folder':
          return context.runFolder;
        case 'path-variable': {
          const value = context.pathVariables.get(target.name);
          if (value === undefined) {
            throw valueError(`Path variable "${target.name}" has no value here`, name.span);
          }
          return value;
        }
      }
    },
  };
  return evaluateText(text);
}
