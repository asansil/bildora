/**
 * The syntax of block expressions: what follows `=` in a field, such as `convert.width * 2` or
 * `iif(inputs.size > 100, "large", "small")`. Parsing never runs anything; it only builds a tree.
 */

/** Where something sits in the expression text, as character offsets. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export type BinaryOperator =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export type UnaryOperator = '-' | 'not';

export type ExpressionNode =
  | { readonly kind: 'number'; readonly value: number; readonly span: Span }
  | { readonly kind: 'text'; readonly value: string; readonly span: Span }
  | { readonly kind: 'boolean'; readonly value: boolean; readonly span: Span }
  /** A dotted name such as `convert.file`, `inputs.file` or `steps.extract.outputs.csv`. */
  | {
      readonly kind: 'name';
      readonly parts: readonly string[];
      /** Where each part sits, so that renaming a block can edit only its own part. */
      readonly partSpans: readonly Span[];
      readonly span: Span;
    }
  | {
      readonly kind: 'call';
      readonly name: string;
      readonly args: readonly ExpressionNode[];
      readonly span: Span;
    }
  | {
      readonly kind: 'unary';
      readonly operator: UnaryOperator;
      readonly operand: ExpressionNode;
      readonly span: Span;
    }
  | {
      readonly kind: 'binary';
      readonly operator: BinaryOperator;
      readonly left: ExpressionNode;
      readonly right: ExpressionNode;
      readonly span: Span;
    };

/** Something wrong with an expression, with where it is so that a field can point at it. */
export class ExpressionError extends Error {
  readonly code: ExpressionErrorCode;
  readonly span: Span;

  constructor(code: ExpressionErrorCode, message: string, span: Span) {
    super(message);
    this.name = 'ExpressionError';
    this.code = code;
    this.span = span;
  }
}

/** What kind of thing went wrong: the text, a name, a function, the types, or a worked-out value. */
export type ExpressionErrorCode = 'syntax' | 'name' | 'function' | 'type' | 'value';

/** How deep parentheses, calls and operators may nest. */
export const EXPRESSION_DEPTH_MAX = 32;

type Token =
  | { readonly kind: 'number'; readonly value: number; readonly span: Span }
  | { readonly kind: 'text'; readonly value: string; readonly span: Span }
  | { readonly kind: 'word'; readonly value: string; readonly span: Span }
  | { readonly kind: 'symbol'; readonly value: string; readonly span: Span }
  | { readonly kind: 'end'; readonly span: Span };

const SYMBOLS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '.'];
const WORD_START = /[A-Za-z_]/;
/** A word continues with letters, digits, `_` and `-`, as block ids do, so `a-b` is one name. */
const WORD_PART = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    const start = at;
    if (DIGIT.test(char)) {
      while (DIGIT.test(text.charAt(at))) at += 1;
      if (text.charAt(at) === '.' && DIGIT.test(text.charAt(at + 1))) {
        at += 1;
        while (DIGIT.test(text.charAt(at))) at += 1;
      }
      if (WORD_START.test(text.charAt(at))) {
        throw new ExpressionError('syntax', 'A number runs straight into a name', {
          start,
          end: at + 1,
        });
      }
      tokens.push({
        kind: 'number',
        value: Number(text.slice(start, at)),
        span: { start, end: at },
      });
      continue;
    }
    if (WORD_START.test(char)) {
      at += 1;
      // A word can hold `-`, but not end with one, so that `a- 1` still subtracts.
      while (WORD_PART.test(text.charAt(at))) {
        if (text.charAt(at) === '-' && !/[A-Za-z0-9_]/.test(text.charAt(at + 1))) break;
        at += 1;
      }
      tokens.push({ kind: 'word', value: text.slice(start, at), span: { start, end: at } });
      continue;
    }
    if (char === '"') {
      at += 1;
      let value = '';
      for (;;) {
        if (at >= text.length) {
          throw new ExpressionError('syntax', 'A text has no closing quote', { start, end: at });
        }
        const next = text.charAt(at);
        if (next === '"') {
          at += 1;
          break;
        }
        if (next === '\\') {
          const escaped = text.charAt(at + 1);
          const meaning: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t' };
          const replacement = meaning[escaped];
          if (replacement === undefined) {
            throw new ExpressionError('syntax', `Unknown escape \\${escaped} in a text`, {
              start: at,
              end: at + 2,
            });
          }
          value += replacement;
          at += 2;
          continue;
        }
        value += next;
        at += 1;
      }
      tokens.push({ kind: 'text', value, span: { start, end: at } });
      continue;
    }
    const symbol = SYMBOLS.find((candidate) => text.startsWith(candidate, at));
    if (symbol === undefined) {
      throw new ExpressionError('syntax', `"${char}" has no meaning here`, {
        start,
        end: start + 1,
      });
    }
    at += symbol.length;
    tokens.push({ kind: 'symbol', value: symbol, span: { start, end: at } });
  }
  tokens.push({ kind: 'end', span: { start: text.length, end: text.length } });
  return tokens;
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** Reads an expression, throwing an `ExpressionError` that says where it went wrong. */
export function parseExpression(text: string): ExpressionNode {
  const tokens = tokenize(text);
  let position = 0;
  let depth = 0;

  const end: Token = { kind: 'end', span: { start: text.length, end: text.length } };
  const peek = (): Token => tokens[position] ?? end;
  const take = (): Token => {
    const token = peek();
    if (token.kind !== 'end') position += 1;
    return token;
  };
  const isSymbol = (value: string): boolean => {
    const token = peek();
    return token.kind === 'symbol' && token.value === value;
  };
  /** `and`, `or` and `not` are words only where no dot follows, so a block may still be called so. */
  const isKeyword = (value: string): boolean => {
    const token = peek();
    const after = tokens[position + 1];
    return (
      token.kind === 'word' &&
      token.value === value &&
      !(after?.kind === 'symbol' && after.value === '.')
    );
  };
  const expect = (value: string, what: string): Token => {
    if (!isSymbol(value)) {
      throw new ExpressionError('syntax', `Expected ${what}`, peek().span);
    }
    return take();
  };
  const nested = <T>(read: () => T): T => {
    depth += 1;
    if (depth > EXPRESSION_DEPTH_MAX) {
      throw new ExpressionError('syntax', 'The expression nests too deeply', peek().span);
    }
    const result = read();
    depth -= 1;
    return result;
  };
  const between = (left: ExpressionNode, right: ExpressionNode): Span => ({
    start: left.span.start,
    end: right.span.end,
  });

  const readOr = (): ExpressionNode => {
    let left = readAnd();
    while (isKeyword('or')) {
      take();
      const right = readAnd();
      left = { kind: 'binary', operator: 'or', left, right, span: between(left, right) };
    }
    return left;
  };
  const readAnd = (): ExpressionNode => {
    let left = readNot();
    while (isKeyword('and')) {
      take();
      const right = readNot();
      left = { kind: 'binary', operator: 'and', left, right, span: between(left, right) };
    }
    return left;
  };
  const readNot = (): ExpressionNode => {
    if (isKeyword('not')) {
      const start = take().span.start;
      const operand = nested(readNot);
      return { kind: 'unary', operator: 'not', operand, span: { start, end: operand.span.end } };
    }
    return readComparison();
  };
  const readComparison = (): ExpressionNode => {
    const left = readSum();
    const token = peek();
    if (token.kind !== 'symbol' || !COMPARISONS.has(token.value)) return left;
    take();
    const right = readSum();
    const after = peek();
    if (after.kind === 'symbol' && COMPARISONS.has(after.value)) {
      throw new ExpressionError(
        'syntax',
        'Comparisons cannot be chained; join them with and',
        after.span,
      );
    }
    return {
      kind: 'binary',
      operator: token.value as BinaryOperator,
      left,
      right,
      span: between(left, right),
    };
  };
  const symbolTaken = (): string => {
    const token = take();
    return token.kind === 'symbol' ? token.value : '';
  };
  const readSum = (): ExpressionNode => {
    let left = readProduct();
    while (isSymbol('+') || isSymbol('-')) {
      const operator = symbolTaken() as '+' | '-';
      const right = readProduct();
      left = { kind: 'binary', operator, left, right, span: between(left, right) };
    }
    return left;
  };
  const readProduct = (): ExpressionNode => {
    let left = readNegation();
    while (isSymbol('*') || isSymbol('/') || isSymbol('%')) {
      const operator = symbolTaken() as '*' | '/' | '%';
      const right = readNegation();
      left = { kind: 'binary', operator, left, right, span: between(left, right) };
    }
    return left;
  };
  const readNegation = (): ExpressionNode => {
    if (isSymbol('-')) {
      const start = take().span.start;
      const operand = nested(readNegation);
      return { kind: 'unary', operator: '-', operand, span: { start, end: operand.span.end } };
    }
    return readPrimary();
  };
  const readPrimary = (): ExpressionNode => {
    const token = take();
    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.value, span: token.span };
      case 'text':
        return { kind: 'text', value: token.value, span: token.span };
      case 'end':
        throw new ExpressionError('syntax', 'The expression ends too early', token.span);
      case 'symbol': {
        if (token.value !== '(') {
          throw new ExpressionError('syntax', `"${token.value}" cannot start a value`, token.span);
        }
        const inner = nested(readOr);
        const close = expect(')', 'a closing parenthesis');
        return { ...inner, span: { start: token.span.start, end: close.span.end } };
      }
      case 'word':
        return readWord(token);
    }
  };
  const readWord = (word: Extract<Token, { kind: 'word' }>): ExpressionNode => {
    if (isSymbol('(')) {
      take();
      const args: ExpressionNode[] = [];
      if (!isSymbol(')')) {
        args.push(nested(readOr));
        while (isSymbol(',')) {
          take();
          args.push(nested(readOr));
        }
      }
      const close = expect(')', 'a comma or a closing parenthesis');
      return {
        kind: 'call',
        name: word.value,
        args,
        span: { start: word.span.start, end: close.span.end },
      };
    }
    if (!isSymbol('.')) {
      if (word.value === 'true' || word.value === 'false') {
        return { kind: 'boolean', value: word.value === 'true', span: word.span };
      }
      throw new ExpressionError(
        'name',
        `"${word.value}" needs a dot and what to read, as in ${word.value}.file`,
        word.span,
      );
    }
    const parts = [word.value];
    const partSpans = [word.span];
    let last = word.span;
    while (isSymbol('.')) {
      take();
      const part = take();
      if (part.kind !== 'word') {
        throw new ExpressionError('syntax', 'A dot must be followed by a name', part.span);
      }
      parts.push(part.value);
      partSpans.push(part.span);
      last = part.span;
    }
    return { kind: 'name', parts, partSpans, span: { start: word.span.start, end: last.end } };
  };

  const tree = readOr();
  const rest = peek();
  if (rest.kind !== 'end') {
    throw new ExpressionError('syntax', 'Something follows the end of the expression', rest.span);
  }
  return tree;
}

/** Calls `visit` on every node of a tree, parents before children. */
export function walkExpression(node: ExpressionNode, visit: (node: ExpressionNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'call':
      for (const arg of node.args) walkExpression(arg, visit);
      break;
    case 'unary':
      walkExpression(node.operand, visit);
      break;
    case 'binary':
      walkExpression(node.left, visit);
      walkExpression(node.right, visit);
      break;
    default:
      break;
  }
}

/** The dotted names an expression reads, in the order they appear. */
export function namesOf(node: ExpressionNode): Extract<ExpressionNode, { kind: 'name' }>[] {
  const names: Extract<ExpressionNode, { kind: 'name' }>[] = [];
  walkExpression(node, (child) => {
    if (child.kind === 'name') names.push(child);
  });
  return names;
}
