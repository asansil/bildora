/**
 * What block expressions mean: the type of each value, the fixed set of functions, and how a tree
 * is worked out. Nothing here reads files, the network or the environment; names are resolved, and
 * files looked for, by whoever asks, through `NameTypes` and `NameValues`.
 */
import { ExpressionError } from './syntax.js';
import type { BinaryOperator, ExpressionNode, Span } from './syntax.js';

/** The item at `index`, which the caller knows is there. */
function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`No item at ${String(index)}`);
  return value;
}

/** Types a value can have. A path is text that names a file or folder. A list holds text. */
export type ValueType = 'text' | 'path' | 'integer' | 'number' | 'boolean' | 'list';

/** A worked-out value. Lists come from JSON outputs. */
export type RuntimeValue = string | number | boolean | readonly string[];

/** Characters a worked-out text may hold, so that an expression cannot grow without end. */
export const EXPRESSION_TEXT_MAX = 100_000;

export type NameNode = Extract<ExpressionNode, { kind: 'name' }>;

/** Says what type a name has, or throws an `ExpressionError` saying why it cannot be read. */
export interface NameTypes {
  typeOf(name: NameNode): ValueType;
}

/** Says what a name holds when the expression is worked out, or throws an `ExpressionError`. */
export interface NameValues {
  valueOf(name: NameNode): RuntimeValue;
  /** Whether a file or folder is there, for `exists`. Where it is left out, `exists` cannot run. */
  fileExists?(path: string): boolean;
}

const isTextual = (type: ValueType): boolean => type === 'text' || type === 'path';
const isNumeric = (type: ValueType): boolean => type === 'integer' || type === 'number';

/** Words for a type in messages. */
export function typeWord(type: ValueType): string {
  const words: Record<ValueType, string> = {
    text: 'text',
    path: 'a path',
    integer: 'a whole number',
    number: 'a number',
    boolean: 'yes or no',
    list: 'a list',
  };
  return words[type];
}

/** The type two values can share, such as the two sides of `iif`, if they can share one. */
function common(left: ValueType, right: ValueType): ValueType | undefined {
  if (left === right) return left;
  if (isNumeric(left) && isNumeric(right)) return 'number';
  if (isTextual(left) && isTextual(right)) return 'text';
  return undefined;
}

/** Whole numbers stay whole; anything else gives a number. */
function numericOf(left: ValueType, right: ValueType): ValueType {
  return left === 'integer' && right === 'integer' ? 'integer' : 'number';
}

function typeError(message: string, span: Span): ExpressionError {
  return new ExpressionError('type', message, span);
}

function valueError(message: string, span: Span): ExpressionError {
  return new ExpressionError('value', message, span);
}

// Paths are worked out as text, without the platform's path module, so that the app shows the same
// result the run gets. Both separators count, as they do on Windows.
function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
}

function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(lastSeparator(trimmed) + 1);
}

function extensionAt(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

function folderOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = lastSeparator(trimmed);
  if (at < 0) return '';
  // Keep the separator of a drive or root, as in `C:\`.
  return at === 0 || trimmed.charAt(at - 1) === ':'
    ? trimmed.slice(0, at + 1)
    : trimmed.slice(0, at);
}

function joinPaths(parts: readonly string[]): string {
  const separator =
    parts.some((part) => part.includes('\\')) || !parts.some((part) => part.includes('/'))
      ? '\\'
      : '/';
  return parts
    .filter((part) => part !== '')
    .map((part, index) => {
      const start = index === 0 ? part : part.replace(/^[\\/]+/, '');
      return index === parts.length - 1 ? start : start.replace(/[\\/]+$/, '');
    })
    .join(separator);
}

function asText(value: RuntimeValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return value.join(', ');
}

interface FunctionDefinition {
  /** Fewest and most arguments. */
  readonly arity: readonly [number, number];
  /** What it reads, for messages, such as "a path". */
  readonly takes: string;
  readonly type: (args: readonly ValueType[], spans: readonly Span[]) => ValueType;
  readonly run: (args: readonly RuntimeValue[], spans: readonly Span[]) => RuntimeValue;
}

function need(
  types: readonly ValueType[],
  spans: readonly Span[],
  index: number,
  fits: (type: ValueType) => boolean,
  what: string,
): void {
  const type = types[index];
  if (type !== undefined && !fits(type)) {
    throw typeError(`Needs ${what} here, and this is ${typeWord(type)}`, item(spans, index));
  }
}

const textual = (index: number) => (types: readonly ValueType[], spans: readonly Span[]) => {
  need(types, spans, index, isTextual, 'text or a path');
};

const str = (args: readonly RuntimeValue[], index: number): string => asText(args[index] ?? '');
const num = (args: readonly RuntimeValue[], index: number): number => Number(args[index]);

function onText(run: (value: string) => string, returns: ValueType = 'text'): FunctionDefinition {
  return {
    arity: [1, 1],
    takes: 'text or a path',
    type: (types, spans) => {
      textual(0)(types, spans);
      return returns;
    },
    run: (args) => run(str(args, 0)),
  };
}

function textTest(test: (value: string, part: string) => boolean): FunctionDefinition {
  return {
    arity: [2, 2],
    takes: 'two texts',
    type: (types, spans) => {
      textual(0)(types, spans);
      textual(1)(types, spans);
      return 'boolean';
    },
    run: (args) => test(str(args, 0), str(args, 1)),
  };
}

function extreme(pick: (values: number[]) => number): FunctionDefinition {
  return {
    arity: [2, 20],
    takes: 'numbers',
    type: (types, spans) => {
      types.forEach((_, index) => {
        need(types, spans, index, isNumeric, 'a number');
      });
      return types.every((type) => type === 'integer') ? 'integer' : 'number';
    },
    run: (args) => pick(args.map((_, index) => num(args, index))),
  };
}

/**
 * The functions an expression can call. Adding one later keeps files compatible; changing what one
 * does would not, so each is documented in the expressions guide.
 */
export const EXPRESSION_FUNCTIONS: Readonly<Record<string, FunctionDefinition>> = {
  name: onText(fileName),
  stem: onText((path) => {
    const name = fileName(path);
    return name.slice(0, extensionAt(name));
  }),
  ext: onText((path) => {
    const name = fileName(path);
    return name.slice(extensionAt(name));
  }),
  folder: onText(folderOf, 'path'),
  join: {
    arity: [2, 20],
    takes: 'paths and names',
    type: (types, spans) => {
      types.forEach((_, index) => {
        textual(index)(types, spans);
      });
      return 'path';
    },
    run: (args) => joinPaths(args.map((_, index) => str(args, index))),
  },
  upper: onText((value) => value.toUpperCase()),
  lower: onText((value) => value.toLowerCase()),
  trim: onText((value) => value.trim()),
  replace: {
    arity: [3, 3],
    takes: 'a text, what to find and what to put instead',
    type: (types, spans) => {
      [0, 1, 2].forEach((index) => {
        textual(index)(types, spans);
      });
      return 'text';
    },
    run: (args, spans) => {
      const find = str(args, 1);
      if (find === '') throw valueError('There is nothing to find', item(spans, 1));
      return str(args, 0).split(find).join(str(args, 2));
    },
  },
  text: {
    arity: [1, 1],
    takes: 'any value',
    type: () => 'text',
    run: (args) => str(args, 0),
  },
  number: {
    arity: [1, 1],
    takes: 'text or a number',
    type: (types, spans) => {
      need(types, spans, 0, (type) => isTextual(type) || isNumeric(type), 'text or a number');
      return 'number';
    },
    run: (args, spans) => {
      const value = args[0];
      const parsed = typeof value === 'number' ? value : Number(asText(value ?? '').trim());
      if (asText(value ?? '').trim() === '' || !Number.isFinite(parsed)) {
        throw valueError(`"${asText(value ?? '')}" is not a number`, item(spans, 0));
      }
      return parsed;
    },
  },
  round: {
    arity: [1, 2],
    takes: 'a number, and optionally how many decimals',
    type: (types, spans) => {
      need(types, spans, 0, isNumeric, 'a number');
      need(types, spans, 1, (type) => type === 'integer', 'a whole number of decimals');
      return types.length === 1 ? 'integer' : 'number';
    },
    run: (args, spans) => {
      const decimals = args.length > 1 ? num(args, 1) : 0;
      if (decimals < 0 || decimals > 15) {
        throw valueError('Decimals go from 0 to 15', item(spans, 1));
      }
      const factor = 10 ** decimals;
      return Math.round(num(args, 0) * factor) / factor;
    },
  },
  min: extreme((values) => Math.min(...values)),
  max: extreme((values) => Math.max(...values)),
  length: {
    arity: [1, 1],
    takes: 'text or a list',
    type: (types, spans) => {
      need(types, spans, 0, (type) => isTextual(type) || type === 'list', 'text or a list');
      return 'integer';
    },
    run: (args) => {
      const value = args[0];
      return Array.isArray(value) ? value.length : str(args, 0).length;
    },
  },
  contains: {
    arity: [2, 2],
    takes: 'a text or a list, and what to look for',
    type: (types, spans) => {
      need(types, spans, 0, (type) => isTextual(type) || type === 'list', 'text or a list');
      textual(1)(types, spans);
      return 'boolean';
    },
    run: (args) => {
      const value = args[0];
      return Array.isArray(value)
        ? value.includes(str(args, 1))
        : str(args, 0).includes(str(args, 1));
    },
  },
  compact: {
    arity: [1, 1],
    takes: 'a list',
    type: (types, spans) => {
      need(types, spans, 0, (type) => type === 'list', 'a list');
      return 'list';
    },
    // A loop gives an empty text for a round that left nothing, and this drops those.
    run: (args) => {
      const value = args[0];
      return Array.isArray(value)
        ? (value as readonly string[]).filter((entry) => entry !== '')
        : [];
    },
  },
  starts: textTest((value, part) => value.startsWith(part)),
  ends: textTest((value, part) => value.endsWith(part)),
  /** Whether a file or folder is there. The caller looks, through `NameValues.fileExists`. */
  exists: {
    arity: [1, 1],
    takes: 'a path',
    type: (types, spans) => {
      textual(0)(types, spans);
      return 'boolean';
    },
    run: () => {
      throw new Error('exists is worked out by evaluateExpression');
    },
  },
  iif: {
    arity: [3, 3],
    takes: 'a condition, the value when it holds, and the value when it does not',
    type: (types, spans) => {
      need(types, spans, 0, (type) => type === 'boolean', 'yes or no');
      const both = common(item(types, 1), item(types, 2));
      if (both === undefined) {
        throw typeError(
          `Both choices need the same type, and they are ${typeWord(item(types, 1))} and ${typeWord(item(types, 2))}`,
          item(spans, 2),
        );
      }
      return both;
    },
    // Handled in `evaluateExpression`, so that only the chosen side is worked out.
    run: (args) => (args[0] === true ? item(args, 1) : item(args, 2)),
  },
};

function functionOf(node: Extract<ExpressionNode, { kind: 'call' }>): FunctionDefinition {
  const definition = Object.hasOwn(EXPRESSION_FUNCTIONS, node.name)
    ? EXPRESSION_FUNCTIONS[node.name]
    : undefined;
  if (definition === undefined) {
    throw new ExpressionError('function', `There is no function "${node.name}"`, node.span);
  }
  const [fewest, most] = definition.arity;
  if (node.args.length < fewest || node.args.length > most) {
    throw new ExpressionError('function', `${node.name} takes ${definition.takes}`, node.span);
  }
  return definition;
}

function binaryType(
  operator: BinaryOperator,
  left: ValueType,
  right: ValueType,
  node: Extract<ExpressionNode, { kind: 'binary' }>,
): ValueType {
  const mismatch = (what: string) =>
    typeError(`${what}, and these are ${typeWord(left)} and ${typeWord(right)}`, node.span);
  switch (operator) {
    case '+':
      if (isNumeric(left) && isNumeric(right)) return numericOf(left, right);
      if ((isTextual(left) || isTextual(right)) && left !== 'list' && right !== 'list') {
        return 'text';
      }
      throw mismatch('+ adds numbers or joins text');
    case '-':
    case '*':
    case '%':
      if (isNumeric(left) && isNumeric(right)) return numericOf(left, right);
      throw mismatch(`${operator} works on numbers`);
    case '/':
      if (isNumeric(left) && isNumeric(right)) return 'number';
      throw mismatch('/ works on numbers');
    case '==':
    case '!=':
      if (common(left, right) !== undefined && left !== 'list') return 'boolean';
      throw mismatch('Only values of the same kind can be compared');
    case '<':
    case '<=':
    case '>':
    case '>=':
      if ((isNumeric(left) && isNumeric(right)) || (isTextual(left) && isTextual(right))) {
        return 'boolean';
      }
      throw mismatch(`${operator} compares numbers or texts`);
    case 'and':
    case 'or':
      if (left === 'boolean' && right === 'boolean') return 'boolean';
      throw mismatch(`${operator} joins yes-or-no values`);
  }
}

/** Works out the type of an expression, throwing an `ExpressionError` where the types do not fit. */
export function typeOfExpression(node: ExpressionNode, names: NameTypes): ValueType {
  switch (node.kind) {
    case 'number':
      return Number.isInteger(node.value) ? 'integer' : 'number';
    case 'text':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'name':
      return names.typeOf(node);
    case 'call': {
      const definition = functionOf(node);
      const types = node.args.map((arg) => typeOfExpression(arg, names));
      return definition.type(
        types,
        node.args.map(({ span }) => span),
      );
    }
    case 'unary': {
      const type = typeOfExpression(node.operand, names);
      if (node.operator === 'not') {
        if (type === 'boolean') return 'boolean';
        throw typeError(`not works on yes or no, and this is ${typeWord(type)}`, node.span);
      }
      if (isNumeric(type)) return type;
      throw typeError(`- works on numbers, and this is ${typeWord(type)}`, node.span);
    }
    case 'binary':
      return binaryType(
        node.operator,
        typeOfExpression(node.left, names),
        typeOfExpression(node.right, names),
        node,
      );
  }
}

function checkedText(value: string, span: Span): string {
  if (value.length > EXPRESSION_TEXT_MAX) {
    throw valueError('The text grows too long', span);
  }
  return value;
}

function compare(
  operator: '<' | '<=' | '>' | '>=',
  left: RuntimeValue,
  right: RuntimeValue,
): boolean {
  const [a, b] =
    typeof left === 'number' && typeof right === 'number'
      ? [left, right]
      : [asText(left), asText(right)];
  switch (operator) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function same(left: RuntimeValue, right: RuntimeValue): boolean {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return asText(left) === asText(right);
}

/**
 * Works out an expression. Run `typeOfExpression` first: this assumes the types fit, and throws an
 * `ExpressionError` only for what depends on the values, such as dividing by zero.
 */
export function evaluateExpression(node: ExpressionNode, names: NameValues): RuntimeValue {
  const run = (child: ExpressionNode): RuntimeValue => evaluateExpression(child, names);
  switch (node.kind) {
    case 'number':
    case 'text':
    case 'boolean':
      return node.value;
    case 'name':
      return names.valueOf(node);
    case 'call': {
      const definition = functionOf(node);
      if (node.name === 'iif') {
        return run(item(node.args, 0)) === true ? run(item(node.args, 1)) : run(item(node.args, 2));
      }
      if (node.name === 'exists') {
        const path = asText(run(item(node.args, 0)));
        if (names.fileExists === undefined) {
          throw valueError('Files cannot be looked for here', node.span);
        }
        return path !== '' && names.fileExists(path);
      }
      const result = definition.run(
        node.args.map(run),
        node.args.map(({ span }) => span),
      );
      if (typeof result === 'number' && !Number.isFinite(result)) {
        throw valueError('The result is not a number', node.span);
      }
      return typeof result === 'string' ? checkedText(result, node.span) : result;
    }
    case 'unary': {
      const value = run(node.operand);
      return node.operator === 'not' ? value !== true : -Number(value);
    }
    case 'binary': {
      if (node.operator === 'and') return run(node.left) === true && run(node.right) === true;
      if (node.operator === 'or') return run(node.left) === true || run(node.right) === true;
      const left = run(node.left);
      const right = run(node.right);
      switch (node.operator) {
        case '+':
          if (typeof left === 'number' && typeof right === 'number') return left + right;
          return checkedText(asText(left) + asText(right), node.span);
        case '-':
          return Number(left) - Number(right);
        case '*':
          return Number(left) * Number(right);
        case '/':
        case '%': {
          if (Number(right) === 0) throw valueError('Dividing by zero', node.right.span);
          return node.operator === '/'
            ? Number(left) / Number(right)
            : Number(left) % Number(right);
        }
        case '==':
          return same(left, right);
        case '!=':
          return !same(left, right);
        case '<':
        case '<=':
        case '>':
        case '>=':
          return compare(node.operator, left, right);
      }
    }
  }
}

/** Types of the values a parameter or an input can hold. */
export type ParameterKind = 'string' | 'path' | 'integer' | 'number' | 'boolean' | 'choice';

/** The type of value a parameter of this kind holds. */
export function typeOfParameter(kind: ParameterKind): ValueType {
  const types: Record<ParameterKind, ValueType> = {
    string: 'text',
    path: 'path',
    integer: 'integer',
    number: 'number',
    boolean: 'boolean',
    choice: 'text',
  };
  return types[kind];
}

/** Tells whether a value of this type can go into a parameter of this kind. */
export function fitsParameter(type: ValueType, kind: ParameterKind): boolean {
  switch (kind) {
    case 'string':
      return type !== 'list';
    case 'path':
    case 'choice':
      return isTextual(type);
    case 'integer':
      return type === 'integer';
    case 'number':
      return isNumeric(type);
    case 'boolean':
      return type === 'boolean';
  }
}

/**
 * Turns a worked-out value into what a parameter of this kind takes, throwing when it cannot, such as
 * a number with decimals for a whole-number parameter.
 */
export function toParameterValue(
  value: RuntimeValue,
  kind: ParameterKind,
  span: Span,
): string | number | boolean {
  switch (kind) {
    case 'string':
    case 'path':
    case 'choice':
      return asText(value);
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw valueError(`${asText(value)} is not a whole number`, span);
      }
      return value;
    case 'number':
      return Number(value);
    case 'boolean':
      return value === true;
  }
}

export { asText as runtimeText };
