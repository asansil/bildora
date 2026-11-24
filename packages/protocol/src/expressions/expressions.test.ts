import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '../automation.js';
import {
  EXPRESSION_DEPTH_MAX,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_TEXT_MAX,
  ExpressionError,
  evaluateExpression,
  fitsParameter,
  linkCycles,
  linkUses,
  parseExpression,
  renameCalledInExpression,
  renameInBlockExpressions,
  renameInExpression,
  targetOf,
  targetsOf,
  toParameterValue,
  typeOfExpression,
} from './index.js';
import type { NameNode, RuntimeValue, ValueType } from './index.js';

const TYPES: Record<string, ValueType> = {
  'convert.width': 'integer',
  'convert.scale': 'number',
  'convert.file': 'path',
  'convert.title': 'text',
  'convert.fast': 'boolean',
  'inputs.size': 'integer',
  'inputs.file': 'path',
  'steps.extract.outputs.names': 'list',
};

const VALUES: Record<string, RuntimeValue> = {
  'convert.width': 640,
  'convert.scale': 1.5,
  'convert.file': 'C:\\data\\photo.final.png',
  'convert.title': 'Holiday',
  'convert.fast': true,
  'inputs.size': 150,
  'inputs.file': 'D:/in/report.csv',
  'steps.extract.outputs.names': ['a.txt', 'b.txt'],
};

const nameTypes = {
  typeOf(name: NameNode): ValueType {
    const type = TYPES[name.parts.join('.')];
    if (type === undefined) throw new ExpressionError('name', 'unknown', name.span);
    return type;
  },
};

const nameValues = {
  valueOf(name: NameNode): RuntimeValue {
    const value = VALUES[name.parts.join('.')];
    if (value === undefined) throw new ExpressionError('name', 'unknown', name.span);
    return value;
  },
};

function typeOf(text: string): ValueType {
  return typeOfExpression(parseExpression(text), nameTypes);
}

function run(text: string): RuntimeValue {
  const tree = parseExpression(text);
  typeOfExpression(tree, nameTypes);
  return evaluateExpression(tree, nameValues);
}

function failure(action: () => unknown): ExpressionError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExpressionError) return error;
    throw error;
  }
  throw new Error('Expected an ExpressionError');
}

describe('parseExpression', () => {
  it('reads links, inputs, outputs and literals', () => {
    expect(parseExpression('convert.file')).toMatchObject({
      kind: 'name',
      parts: ['convert', 'file'],
      span: { start: 0, end: 12 },
    });
    expect(parseExpression('steps.extract.outputs.csv.count')).toMatchObject({
      kind: 'name',
      parts: ['steps', 'extract', 'outputs', 'csv', 'count'],
    });
    expect(parseExpression('"a \\"b\\" \\\\ c"')).toMatchObject({
      kind: 'text',
      value: 'a "b" \\ c',
    });
    expect(parseExpression('12.5')).toMatchObject({ kind: 'number', value: 12.5 });
    expect(parseExpression('true')).toMatchObject({ kind: 'boolean', value: true });
  });

  it('keeps ids with dashes as one name, so subtraction needs spaces', () => {
    expect(parseExpression('convert-2.file')).toMatchObject({
      kind: 'name',
      parts: ['convert-2', 'file'],
    });
    expect(parseExpression('a.width - 1')).toMatchObject({ kind: 'binary', operator: '-' });
    expect(parseExpression('10-1')).toMatchObject({ kind: 'binary', operator: '-' });
  });

  it('follows the usual precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('-2 * 3')).toBe(-6);
    expect(run('1 < 2 and 3 > 4 or true')).toBe(true);
    expect(run('not 1 > 2')).toBe(true);
    expect(run('10 % 4 + 7 / 2')).toBe(5.5);
  });

  it('lets a block called like a keyword still be linked', () => {
    expect(parseExpression('not.file')).toMatchObject({ kind: 'name', parts: ['not', 'file'] });
    expect(parseExpression('and.x == or.y')).toMatchObject({ kind: 'binary', operator: '==' });
  });

  it('says where the text goes wrong', () => {
    expect(failure(() => parseExpression('1 +')).span).toEqual({ start: 3, end: 3 });
    expect(failure(() => parseExpression('"open')).message).toMatch(/closing quote/);
    expect(failure(() => parseExpression('(1')).message).toMatch(/closing parenthesis/);
    expect(failure(() => parseExpression('1 2')).message).toMatch(/follows the end/);
    expect(failure(() => parseExpression('a.')).message).toMatch(/dot must be followed/);
    expect(failure(() => parseExpression('1 < 2 < 3')).message).toMatch(/chained/);
    expect(failure(() => parseExpression('a $ b')).span).toEqual({ start: 2, end: 3 });
    expect(failure(() => parseExpression('"\\q"')).message).toMatch(/escape/);
    expect(failure(() => parseExpression('2x')).code).toBe('syntax');
    expect(failure(() => parseExpression('width')).code).toBe('name');
  });

  it('refuses expressions that nest too deeply', () => {
    const deep = '('.repeat(EXPRESSION_DEPTH_MAX + 1) + '1' + ')'.repeat(EXPRESSION_DEPTH_MAX + 1);
    expect(failure(() => parseExpression(deep)).message).toMatch(/too deeply/);
    const fine = '('.repeat(10) + '1' + ')'.repeat(10);
    expect(run(fine)).toBe(1);
  });
});

describe('typeOfExpression', () => {
  it('works out the type of each operator', () => {
    expect(typeOf('convert.width * 2')).toBe('integer');
    expect(typeOf('convert.width * convert.scale')).toBe('number');
    expect(typeOf('convert.width / 2')).toBe('number');
    expect(typeOf('convert.title + " " + convert.width')).toBe('text');
    expect(typeOf('convert.width > 2 and convert.fast')).toBe('boolean');
    expect(typeOf('"a" < "b"')).toBe('boolean');
  });

  it('refuses types that do not fit', () => {
    expect(failure(() => typeOf('convert.title * 2')).code).toBe('type');
    expect(failure(() => typeOf('convert.fast + 1')).message).toMatch(/adds numbers or joins/);
    expect(failure(() => typeOf('convert.width == "x"')).code).toBe('type');
    expect(failure(() => typeOf('convert.width and true')).code).toBe('type');
    expect(failure(() => typeOf('not convert.width')).code).toBe('type');
    expect(failure(() => typeOf('-convert.title')).code).toBe('type');
    expect(failure(() => typeOf('steps.extract.outputs.names + "x"')).code).toBe('type');
  });

  it('checks functions by name, count and type', () => {
    expect(failure(() => typeOf('nope(1)')).code).toBe('function');
    expect(failure(() => typeOf('upper()')).code).toBe('function');
    expect(failure(() => typeOf('upper(1)')).code).toBe('type');
    expect(failure(() => typeOf('iif(1, 2, 3)')).code).toBe('type');
    expect(failure(() => typeOf('iif(true, 2, "x")')).message).toMatch(/same type/);
    expect(typeOf('iif(true, 2, 3.5)')).toBe('number');
    expect(typeOf('iif(true, convert.file, "x")')).toBe('text');
    expect(typeOf('round(convert.scale)')).toBe('integer');
    expect(typeOf('round(convert.scale, 1)')).toBe('number');
    expect(typeOf('folder(convert.file)')).toBe('path');
  });

  it('does not let a constructor or prototype name pass as a function', () => {
    expect(failure(() => typeOf('constructor(1)')).code).toBe('function');
    expect(failure(() => typeOf('toString(1)')).code).toBe('function');
  });
});

describe('evaluateExpression', () => {
  it('runs every function', () => {
    expect(run('name(convert.file)')).toBe('photo.final.png');
    expect(run('stem(convert.file)')).toBe('photo.final');
    expect(run('ext(convert.file)')).toBe('.png');
    expect(run('ext("C:\\\\data\\\\.env")')).toBe('');
    expect(run('folder(convert.file)')).toBe('C:\\data');
    expect(run('folder("C:\\\\file.txt")')).toBe('C:\\');
    expect(run('folder("file.txt")')).toBe('');
    expect(run('folder(inputs.file)')).toBe('D:/in');
    expect(run('join(folder(convert.file), "out", "x.png")')).toBe('C:\\data\\out\\x.png');
    expect(run('join("D:/in/", "/x.csv")')).toBe('D:/in/x.csv');
    expect(run('upper(convert.title)')).toBe('HOLIDAY');
    expect(run('lower(convert.title)')).toBe('holiday');
    expect(run('trim("  a ")')).toBe('a');
    expect(run('replace("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('text(convert.width)')).toBe('640');
    expect(run('text(convert.fast)')).toBe('true');
    expect(run('number(" 12.5 ")')).toBe(12.5);
    expect(run('round(2.567, 2)')).toBe(2.57);
    expect(run('round(2.5)')).toBe(3);
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1.5)')).toBe(3);
    expect(run('length(convert.title)')).toBe(7);
    expect(run('length(steps.extract.outputs.names)')).toBe(2);
    expect(run('contains(steps.extract.outputs.names, "b.txt")')).toBe(true);
    expect(run('contains(convert.title, "day")')).toBe(true);
    expect(run('starts(convert.title, "Hol")')).toBe(true);
    expect(run('ends(convert.title, "x")')).toBe(false);
    expect(run('iif(inputs.size > 100, "large", "small")')).toBe('large');
    // Removing or changing a function breaks shared files; the guide lists each of these.
    expect(Object.keys(EXPRESSION_FUNCTIONS).sort()).toEqual([
      'compact',
      'contains',
      'ends',
      'exists',
      'ext',
      'folder',
      'iif',
      'join',
      'length',
      'lower',
      'max',
      'min',
      'name',
      'number',
      'replace',
      'round',
      'starts',
      'stem',
      'text',
      'trim',
      'upper',
    ]);
  });

  it('joins text and numbers', () => {
    expect(run('stem(inputs.file) + "_" + convert.width + ".png"')).toBe('report_640.png');
  });

  it('compares numbers as numbers and texts as texts', () => {
    expect(run('9 < 10')).toBe(true);
    expect(run('"9" < "10"')).toBe(false);
    expect(run('convert.width == 640')).toBe(true);
    expect(run('convert.file != "x"')).toBe(true);
  });

  it('works out only the side of iif that is chosen', () => {
    expect(run('iif(true, 1, 1 / 0)')).toBe(1);
    expect(failure(() => run('iif(false, 1, 1 / 0)')).message).toMatch(/zero/);
  });

  it('fails on values it cannot work out', () => {
    expect(failure(() => run('1 % 0')).code).toBe('value');
    expect(failure(() => run('number("abc")')).message).toMatch(/not a number/);
    expect(failure(() => run('number("")')).code).toBe('value');
    expect(failure(() => run('replace("a", "", "b")')).code).toBe('value');
    expect(failure(() => run('round(1, 20)')).code).toBe('value');
  });

  it('keeps texts within their limit', () => {
    const big = `"${'x'.repeat(EXPRESSION_TEXT_MAX / 2 + 1)}"`;
    expect(failure(() => run(`${big} + ${big}`)).message).toMatch(/too long/);
  });
});

describe('parameters', () => {
  it('says which types fit which parameters', () => {
    expect(fitsParameter('integer', 'number')).toBe(true);
    expect(fitsParameter('number', 'integer')).toBe(false);
    expect(fitsParameter('text', 'path')).toBe(true);
    expect(fitsParameter('integer', 'string')).toBe(true);
    expect(fitsParameter('list', 'string')).toBe(false);
    expect(fitsParameter('text', 'boolean')).toBe(false);
  });

  it('turns values into what a parameter takes', () => {
    const span = { start: 0, end: 1 };
    expect(toParameterValue(640, 'string', span)).toBe('640');
    expect(toParameterValue(3, 'integer', span)).toBe(3);
    expect(failure(() => toParameterValue(3.5, 'integer', span)).code).toBe('value');
    expect(toParameterValue(true, 'boolean', span)).toBe(true);
  });
});

describe('exists', () => {
  it('asks whoever works the expression out whether a file is there', () => {
    const tree = parseExpression('exists(inputs.file) and not exists("")');
    expect(typeOfExpression(tree, nameTypes)).toBe('boolean');
    const looked: string[] = [];
    const values = {
      ...nameValues,
      fileExists: (path: string) => {
        looked.push(path);
        return true;
      },
    };
    expect(evaluateExpression(tree, values)).toBe(true);
    expect(looked).toEqual(['D:/in/report.csv']);
    expect(failure(() => evaluateExpression(tree, nameValues)).code).toBe('value');
  });
});

describe('names', () => {
  const nameOf = (text: string) => {
    const tree = parseExpression(text);
    if (tree.kind !== 'name') throw new Error('not a name');
    return tree;
  };

  it('tells what each name reads', () => {
    expect(targetOf(nameOf('convert.file'))).toEqual({
      kind: 'link',
      block: 'convert',
      parameter: 'file',
    });
    expect(targetOf(nameOf('inputs.file'))).toEqual({ kind: 'input', name: 'file' });
    expect(targetOf(nameOf('steps.x.outputs.y.z'))).toEqual({
      kind: 'output',
      block: 'x',
      output: 'y',
      field: 'z',
    });
    expect(targetOf(nameOf('steps.Check1.result'))).toEqual({ kind: 'result', block: 'Check1' });
    expect(renameInExpression('steps.Check1.result == "failed"', () => 'Check2')).toBe(
      'steps.Check2.result == "failed"',
    );
    expect(targetOf(nameOf('run.folder'))).toEqual({ kind: 'run-folder' });
    expect(targetOf(nameOf('paths.data'))).toEqual({ kind: 'path-variable', name: 'data' });
    expect(() => targetOf(nameOf('steps.x.y'))).toThrow(/steps.extract.outputs.csv/);
    expect(() => targetOf(nameOf('convert.file.more'))).toThrow(/convert.file/);
    expect(targetOf(nameOf('loop.item'))).toEqual({ kind: 'loop', value: 'item' });
    expect(() => targetOf(nameOf('loop.rounds'))).toThrow(/loop.index/);
    expect(targetOf(nameOf('steps.Report1.Extract1.outputs.result.total'))).toEqual({
      kind: 'output',
      block: 'Report1',
      inner: ['Extract1'],
      output: 'result',
      field: 'total',
    });
    expect(() => targetOf(nameOf('steps.Report1.Extract1.outputs'))).toThrow(/steps.extract/);
  });

  it('renames blocks inside called automations', () => {
    const text = 'steps.Report1.Archive1.Copy1.outputs.file + steps.Copy1.outputs.file';
    expect(
      renameCalledInExpression(text, (calls, id) =>
        calls.join('/') === 'Report1/Archive1' && id === 'Copy1' ? 'Copy2' : undefined,
      ),
    ).toBe('steps.Report1.Archive1.Copy2.outputs.file + steps.Copy1.outputs.file');
  });

  it('drops the empty texts a loop leaves with compact', () => {
    const tree = parseExpression('compact(steps.Convert1.outputs.file)');
    expect(evaluateExpression(tree, { valueOf: () => ['a.png', '', 'c.png'] })).toEqual([
      'a.png',
      'c.png',
    ]);
  });

  it('lists the targets of an expression, skipping malformed names', () => {
    expect(targetsOf('convert.width + inputs.size + a.b.c').map(({ target }) => target)).toEqual([
      { kind: 'link', block: 'convert', parameter: 'width' },
      { kind: 'input', name: 'size' },
    ]);
    expect(targetsOf('1 +')).toEqual([]);
  });

  it('renames block ids and keeps everything else as typed', () => {
    const rename = (id: string) => (id === 'convert' ? 'resize' : undefined);
    expect(renameInExpression('convert.width  *  2', rename)).toBe('resize.width  *  2');
    expect(renameInExpression('steps.convert.outputs.file', rename)).toBe(
      'steps.resize.outputs.file',
    );
    expect(renameInExpression('inputs.convert + convert.a + convert.b', rename)).toBe(
      'inputs.convert + resize.a + resize.b',
    );
    expect(renameInExpression('convert.a +', rename)).toBe('convert.a +');
  });

  const blocks: AutomationBlock[] = [
    { id: 'start', type: 'start' },
    {
      id: 'a',
      type: 'run',
      tool: 'acme.tool',
      values: { x: { expression: 'b.y' }, z: 'plain' },
    },
    { id: 'b', type: 'run', tool: 'acme.tool', values: { y: { expression: 'a.x + 1' } } },
    { id: 'c', type: 'run', tool: 'acme.tool', values: { w: { expression: 'a.z' } } },
    {
      id: 'check',
      type: 'if',
      condition: {
        match: 'all',
        rules: [
          {
            field: 'value',
            read: { expression: 'c.w' },
            operator: 'equals',
            value: { expression: 'a.z' },
          },
        ],
      },
    },
  ];

  it('lists links with where they sit', () => {
    expect(linkUses(blocks).map(({ block, place, target }) => ({ block, place, target }))).toEqual([
      {
        block: 'a',
        place: { kind: 'value', parameter: 'x' },
        target: { block: 'b', parameter: 'y' },
      },
      {
        block: 'b',
        place: { kind: 'value', parameter: 'y' },
        target: { block: 'a', parameter: 'x' },
      },
      {
        block: 'c',
        place: { kind: 'value', parameter: 'w' },
        target: { block: 'a', parameter: 'z' },
      },
      {
        block: 'check',
        place: { kind: 'rule', index: 0, side: 'read' },
        target: { block: 'c', parameter: 'w' },
      },
      {
        block: 'check',
        place: { kind: 'rule', index: 0, side: 'value' },
        target: { block: 'a', parameter: 'z' },
      },
    ]);
  });

  it('finds circles of links once', () => {
    expect(linkCycles(blocks)).toEqual([['a.x', 'b.y']]);
    expect(linkCycles(blocks.filter(({ id }) => id !== 'b'))).toEqual([]);
    const self: AutomationBlock = {
      id: 'self',
      type: 'run',
      tool: 'acme.tool',
      values: { v: { expression: 'self.v' } },
    };
    expect(linkCycles([self])).toEqual([['self.v']]);
  });

  it('renames ids in values and rules', () => {
    const rename = (id: string) => (id === 'a' ? 'first' : undefined);
    const [, a, , c, check] = blocks.map((block) => renameInBlockExpressions(block, rename));
    expect(a).toEqual(blocks[1]);
    expect(c).toMatchObject({ values: { w: { expression: 'first.z' } } });
    expect(check).toMatchObject({
      condition: { rules: [{ read: { expression: 'c.w' }, value: { expression: 'first.z' } }] },
    });
  });
});
