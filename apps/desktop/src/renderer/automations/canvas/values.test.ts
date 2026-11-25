import { describe, expect, it } from 'vitest';
import type { AutomationBlock } from '@bildora/protocol';
import type { ParameterView, ProfileView, ToolView } from '../../../shared/ipc-contract.js';
import { matchingBlocks } from './find.js';
import { blockIdProblem, emptyDocument, freeId, renameBlock } from './flow-document.js';
import type { FlowDocument } from './flow-document.js';
import {
  asExpression,
  expressionType,
  shownValue,
  unlinkedValue,
  usedByCounts,
  valueChoices,
} from './values.js';
import type { ValueContext } from './values.js';

const parameter = (
  name: string,
  type: ParameterView['type'],
  extra: Partial<ParameterView> = {},
): ParameterView => ({
  name,
  label: name.toUpperCase(),
  type,
  required: false,
  delivery: 'argument',
  ...extra,
});

const tool: ToolView = {
  key: 'global/acme.convert',
  id: 'acme.convert',
  scope: 'global',
  name: 'Convert',
  level: 1,
  program: 'C:\\convert.exe',
  parameters: [
    parameter('file', 'path'),
    parameter('width', 'integer', { default: 640 }),
    parameter('token', 'string', { secret: true }),
    parameter('fast', 'boolean'),
  ],
  outputs: ['result'],
  outputDetails: [
    {
      name: 'result',
      type: 'path',
      fields: [
        { name: 'count', type: 'integer' },
        { name: 'key', type: 'string', secret: true },
      ],
    },
  ],
  permissions: [],
  runtime: { status: 'ready' },
};

const blocks: AutomationBlock[] = [
  {
    id: 'start',
    type: 'start',
    inputs: [
      { name: 'size', type: 'integer', default: 3 },
      { name: 'name', type: 'string' },
    ],
  },
  { id: 'convert', type: 'run', tool: 'acme.convert', values: { file: 'C:\\in\\photo.png' } },
  {
    id: 'thumb',
    type: 'run',
    tool: 'acme.convert',
    profile: 'small',
    values: {
      file: { expression: 'join(folder(convert.file), stem(convert.file) + "_t.png")' },
      width: { expression: 'convert.width / 4 + inputs.size' },
    },
  },
  {
    id: 'check',
    type: 'if',
    condition: {
      match: 'all',
      rules: [
        { field: 'value', read: { expression: 'thumb.width' }, operator: 'greater-than', value: 1 },
      ],
    },
  },
];

const profiles = new Map<string, ProfileView>([
  ['thumb', { id: 'small', name: 'Small', values: { fast: true }, secrets: [] }],
]);

const context: ValueContext = {
  blocks,
  connections: [
    { from: 'start', to: 'convert' },
    { from: 'convert', to: 'thumb' },
    { from: 'thumb', to: 'check' },
  ],
  tools: [tool],
  profiles,
};

describe('linked values while editing', () => {
  it('shows what a link resolves to, through chains, profiles, defaults and input defaults', () => {
    expect(shownValue(context, 'thumb.file')).toMatchObject({
      kind: 'value',
      text: 'C:\\in\\photo_t.png',
    });
    expect(shownValue(context, 'thumb.width')).toMatchObject({ kind: 'value', text: '163' });
    expect(shownValue(context, 'thumb.fast')).toMatchObject({ kind: 'value', value: true });
  });

  it('leaves to the run what only the run knows, and says when it cannot work a value out', () => {
    expect(shownValue(context, 'inputs.name')).toEqual({ kind: 'later' });
    expect(shownValue(context, 'steps.convert.outputs.result.count + 1')).toEqual({
      kind: 'later',
    });
    expect(shownValue(context, 'run.folder')).toEqual({ kind: 'later' });
    expect(shownValue(context, 'convert.token')).toEqual({ kind: 'unknown' });
    expect(shownValue(context, 'gone.file')).toEqual({ kind: 'unknown' });
    expect(shownValue(context, '1 +')).toEqual({ kind: 'unknown' });
  });

  it('keeps the resolved value on Unlink, as the parameter takes it', () => {
    expect(unlinkedValue(shownValue(context, 'thumb.width'), 'integer')).toBe(163);
    expect(unlinkedValue(shownValue(context, 'thumb.width'), 'string')).toBe('163');
    expect(unlinkedValue({ kind: 'later' }, 'path')).toBeUndefined();
    expect(asExpression('a "b"')).toBe('"a \\"b\\""');
    expect(asExpression(3)).toBe('3');
    expect(asExpression(undefined)).toBe('');
  });

  it('offers inputs, certain results without secret fields, and settings of other blocks', () => {
    const choices = valueChoices(context, 'check', 'integer');
    expect(choices.map(({ expression, fits }) => `${expression}:${String(fits)}`)).toEqual([
      'run.folder:false',
      'inputs.size:true',
      'inputs.name:false',
      'steps.convert.outputs.result:false',
      'steps.convert.outputs.result.count:true',
      'steps.thumb.outputs.result:false',
      'steps.thumb.outputs.result.count:true',
      'convert.file:false',
      'convert.width:true',
      'convert.fast:false',
      'thumb.file:false',
      'thumb.width:true',
      'thumb.fast:false',
    ]);
    // A block never offers its own settings, and results only of blocks that always finish first.
    expect(valueChoices(context, 'convert').some(({ block }) => block === 'convert')).toBe(false);
  });

  it('works out the type of what a rule reads', () => {
    expect(expressionType(context, 'thumb.width')).toBe('integer');
    expect(expressionType(context, 'steps.convert.outputs.result.count')).toBe('integer');
    expect(expressionType(context, 'name(convert.file)')).toBe('text');
    expect(expressionType(context, 'convert.nope')).toBeUndefined();
  });

  it('counts the other blocks that link to each block', () => {
    expect(usedByCounts(blocks)).toEqual(
      new Map([
        ['convert', 1],
        ['thumb', 1],
      ]),
    );
  });

  it('counts reads of results as uses too, as the find does', () => {
    const reading: AutomationBlock[] = [
      ...blocks,
      {
        id: 'report',
        type: 'run',
        tool: 'acme.convert',
        values: {
          file: { expression: 'steps.convert.outputs.result.path' },
          width: '{{steps.thumb.outputs.result.count}}',
        },
      },
      {
        id: 'decide',
        type: 'if',
        condition: {
          match: 'all',
          rules: [
            {
              field: 'value',
              read: { expression: 'steps.convert.outputs.result.count' },
              operator: 'greater-than',
              value: 1,
            },
          ],
        },
      },
    ];
    const counts = usedByCounts(reading);
    expect(counts.get('convert')).toBe(3);
    expect(counts.get('thumb')).toBe(2);
    for (const id of ['convert', 'thumb']) {
      const found = matchingBlocks(reading, `${id}.`, new Map(), new Map());
      expect(found.filter((block) => block !== id)).toHaveLength(counts.get(id) ?? 0);
    }
  });
});

describe('renaming a block', () => {
  const document: FlowDocument = {
    ...emptyDocument(),
    blocks,
    connections: context.connections,
    positions: { start: { x: 0, y: 0 }, convert: { x: 100, y: 0 } },
    groups: [{ id: 'group', name: 'Work', blocks: ['convert', 'thumb'] }],
  };

  it('moves everything that names it, links and expressions included', () => {
    const renamed = renameBlock(document, 'convert', 'resize');
    expect(renamed.blocks.map(({ id }) => id)).toEqual(['start', 'resize', 'thumb', 'check']);
    expect(renamed.blocks[2]).toMatchObject({
      values: {
        file: { expression: 'join(folder(resize.file), stem(resize.file) + "_t.png")' },
        width: { expression: 'resize.width / 4 + inputs.size' },
      },
    });
    expect(renamed.connections).toContainEqual({ from: 'start', to: 'resize' });
    expect(renamed.positions['resize']).toEqual({ x: 100, y: 0 });
    expect(renamed.groups[0]?.blocks).toEqual(['resize', 'thumb']);
  });

  it('refuses names a link cannot hold, kept names and names in use', () => {
    expect(blockIdProblem(document, 'convert', 'convert')).toBeUndefined();
    expect(blockIdProblem(document, 'convert', 'resize')).toBeUndefined();
    expect(blockIdProblem(document, 'convert', '2x')).toBe('pattern');
    expect(blockIdProblem(document, 'convert', 'steps')).toBe('reserved');
    expect(blockIdProblem(document, 'convert', 'thumb')).toBe('taken');
    expect(blockIdProblem(document, 'convert', 'group')).toBe('taken');
  });

  it('never gives a new block a kept name', () => {
    expect(freeId('acme.run', new Set())).toBe('run-2');
    expect(freeId('acme.inputs', new Set(['inputs-2']))).toBe('inputs-3');
  });
});

describe('canvas find', () => {
  const names = new Map([
    ['convert', 'Convert'],
    ['thumb', 'Convert'],
  ]);
  const tools = new Map([[tool.id, tool]]);

  it('finds blocks by name, tool, id, or a value they read', () => {
    // A block's own id matches it, and so does a rule that reads one of its values.
    expect(matchingBlocks(blocks, 'thumb', names, tools)).toEqual(['thumb', 'check']);
    expect(matchingBlocks(blocks, 'acme.convert', names, tools)).toEqual(['convert', 'thumb']);
    expect(matchingBlocks(blocks, 'convert.file', names, tools)).toEqual(['thumb']);
    expect(matchingBlocks(blocks, 'thumb.width', names, tools)).toEqual(['check']);
    expect(matchingBlocks(blocks, 'inputs.size', names, tools)).toEqual(['thumb']);
    expect(matchingBlocks(blocks, '  ', names, tools)).toEqual([]);
  });
});

describe('values around loops and calls', () => {
  const loopBlocks: AutomationBlock[] = [
    { id: 'start', type: 'start' },
    { id: 'Files', type: 'for', items: { kind: 'folder', folder: 'C:/in' } },
    { id: 'Convert1', type: 'run', tool: 'acme.convert', loop: 'Files' },
    { id: 'After', type: 'run', tool: 'acme.convert' },
  ];
  const loopContext: ValueContext = {
    blocks: loopBlocks,
    connections: [
      { from: 'start', to: 'Files' },
      { from: 'Files', output: 'body', to: 'Convert1' },
      { from: 'Files', to: 'After' },
    ],
    tools: [tool],
    profiles: new Map(),
  };

  it('offers the loop item, number and folder inside the loop', () => {
    const inside = valueChoices(loopContext, 'Convert1');
    expect(
      inside.filter(({ group }) => group === 'loop').map(({ expression }) => expression),
    ).toEqual(['loop.item', 'loop.index', 'loop.folder']);
    expect(inside.find(({ expression }) => expression === 'loop.item')?.type).toBe('path');
    expect(valueChoices(loopContext, 'After').some(({ group }) => group === 'loop')).toBe(false);
  });

  it('offers what the body produced as lists after the loop, with its rounds', () => {
    const after = valueChoices(loopContext, 'After');
    const result = after.find(({ expression }) => expression === 'steps.Convert1.outputs.result');
    expect(result?.type).toBe('list');
    expect(after.find(({ expression }) => expression === 'steps.Files.outputs.rounds')?.type).toBe(
      'integer',
    );
    expect(expressionType(loopContext, 'steps.Convert1.outputs.result', 'After')).toBe('list');
  });

  it('never offers the rounds of a loop from inside it', () => {
    const inside = valueChoices(loopContext, 'Convert1');
    expect(inside.some(({ expression }) => expression === 'steps.Files.outputs.rounds')).toBe(
      false,
    );
  });

  it('offers the outputs of the blocks a called automation always runs', () => {
    const context: ValueContext = {
      blocks: [
        { id: 'start', type: 'start' },
        { id: 'Report1', type: 'run-automation', automation: 'report' },
        { id: 'Next1', type: 'wait-for-time', seconds: 1 },
      ],
      connections: [
        { from: 'start', to: 'Report1' },
        { from: 'Report1', to: 'Next1' },
      ],
      tools: [tool],
      profiles: new Map(),
      automations: [
        {
          id: 'report',
          name: 'Report',
          blocks: [
            { id: 'start', type: 'start' },
            { id: 'Extract1', type: 'run', tool: 'acme.convert' },
          ],
          connections: [{ from: 'start', to: 'Extract1' }],
        },
      ],
    };
    const choices = valueChoices(context, 'Next1').map(({ expression }) => expression);
    expect(choices).toContain('steps.Report1.Extract1.outputs.result');
    expect(choices).toContain('steps.Report1.Extract1.outputs.result.count');
    expect(choices).not.toContain('steps.Report1.Extract1.outputs.result.key');
    expect(expressionType(context, 'steps.Report1.Extract1.outputs.result.count')).toBe('integer');
  });
});
