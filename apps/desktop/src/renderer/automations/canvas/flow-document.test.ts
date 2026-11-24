import { describe, expect, it } from 'vitest';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { blockNames, ifRuleText } from './block-text.js';
import {
  addNote,
  alignToGrid,
  downstreamOf,
  duplicateItems,
  groupBlocks,
  upstreamOf,
  ungroup,
  updateGroup,
  addAfter,
  addBlocks,
  connect,
  copyItems,
  createBlocks,
  disablesChosen,
  isDisabled,
  toggleDisabled,
  draftOf,
  emptyDocument,
  moveItems,
  pasteItems,
  extractBlock,
  freeName,
  nameBase,
  namedChoice,
  replaceBlock,
  isInFlow,
  removeItems,
  sizeOf,
  spliceEnds,
  spliceInto,
  updateBlock,
} from './flow-document.js';
import type { FlowDocument } from './flow-document.js';
import { valueChoices } from './values.js';

const tool = (id: string, outputs: string[] = []): ToolView => ({
  key: `global/${id}`,
  id,
  scope: 'global',
  name: id === 'acme.extract' ? 'Extract' : id,
  level: 1,
  program: 'C:\\tool.exe',
  parameters: [],
  outputs,
  outputDetails: outputs.map((name) => ({ name, type: 'path' as const })),
  permissions: [],
  runtime: { status: 'ok' } as unknown as ToolView['runtime'],
});

const run = (doc: FlowDocument, toolId: string) =>
  createBlocks(doc, { kind: 'run', tool: toolId }, 'Check');

describe('flow document', () => {
  it('starts with a Start block placed', () => {
    const doc = emptyDocument();
    expect(doc.blocks).toEqual([{ id: 'start', type: 'start' }]);
    expect(doc.positions['start']).toEqual({ x: 0, y: 0 });
  });

  it('adds a block after another, joined from its first free output', () => {
    const doc = emptyDocument();
    const { document, output } = addAfter(doc, 'start', run(doc, 'acme.extract'));
    expect(output).toBe('next');
    expect(document.blocks.map(({ id }) => id)).toEqual(['start', 'Extract1']);
    expect(document.connections).toEqual([{ from: 'start', to: 'Extract1' }]);
    expect(document.positions['Extract1']?.x).toBeGreaterThan(
      sizeOf({ id: 'start', type: 'start' }).width,
    );
  });

  it('gives each new block a free id, shared with notes and groups', () => {
    let doc = emptyDocument();
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 200, y: 0 });
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 200, y: 0 });
    expect(doc.blocks.map(({ id }) => id)).toEqual(['start', 'Extract1', 'Extract2']);
    // The second one moved down rather than covering the first.
    expect(doc.positions['Extract2']?.y).toBeGreaterThan(doc.positions['Extract1']?.y ?? 0);
  });

  it('adds a Parallel with its Join, which takes over where the anchor led', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    expect(doc.connections).toEqual([
      { from: 'start', to: 'Parallel1' },
      { from: 'Join1', to: 'Extract1' },
    ]);
    expect(doc.blocks.find(({ id }) => id === 'Join1')).toEqual({
      id: 'Join1',
      type: 'join',
      parallel: 'Parallel1',
    });
  });

  it('replaces where an output leads, except on a Parallel', () => {
    let doc = emptyDocument();
    doc = addBlocks(doc, [...run(doc, 'a'), ...run(doc, 'b')], { x: 200, y: 0 });
    doc = addBlocks(doc, run(doc, 'b'), { x: 200, y: 100 });
    doc = connect(doc, 'start', 'next', 'A1');
    doc = connect(doc, 'start', 'next', 'B1');
    expect(doc.connections).toEqual([{ from: 'start', to: 'B1' }]);
    doc = addBlocks(doc, createBlocks(doc, { kind: 'parallel' }, ''), { x: 0, y: 300 });
    doc = connect(doc, 'Parallel1', 'next', 'A1');
    doc = connect(doc, 'Parallel1', 'next', 'B2');
    expect(doc.connections.filter(({ from }) => from === 'Parallel1')).toHaveLength(2);
  });

  it('puts a block into a connection, and a Parallel with its Join as the tail', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addBlocks(doc, run(doc, 'acme.report'), { x: 0, y: 300 });
    const into = { from: 'start', output: 'next', to: 'Extract1' };
    const spliced = spliceInto(doc, into, 'Report1', 'Report1');
    expect(spliced?.connections).toEqual([
      { from: 'start', to: 'Report1' },
      { from: 'Report1', to: 'Extract1' },
    ]);

    doc = addBlocks(doc, createBlocks(doc, { kind: 'parallel' }, ''), { x: 0, y: 600 });
    expect(spliceInto(doc, into, 'Parallel1', 'Join1')?.connections).toEqual([
      { from: 'start', to: 'Parallel1' },
      { from: 'Join1', to: 'Extract1' },
    ]);
  });

  it('refuses a splice that has no way on, moves Start or makes a loop', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'Extract1', run(doc, 'acme.report')).document;
    doc = addBlocks(doc, createBlocks(doc, { kind: 'if' }, ''), { x: 0, y: 300 });
    const into = { from: 'Extract1', output: 'next', to: 'Report1' };
    // An If goes on through True or False, never through Next.
    expect(spliceInto(doc, into, 'If1', 'If1')).toBeUndefined();
    expect(spliceInto(doc, into, 'start', 'start')).toBeUndefined();
    expect(spliceInto(doc, into, 'Report1', 'Report1')).toBeUndefined();
    expect(spliceInto(doc, { ...into, to: 'nowhere' }, 'If1', 'If1')).toBeUndefined();

    // A block already in the flow, after the connection, would lead back into itself.
    doc = addBlocks(doc, run(doc, 'acme.send'), { x: 0, y: 600 });
    doc = connect(doc, 'Report1', 'next', 'Send1');
    expect(
      spliceInto(doc, { from: 'start', output: 'next', to: 'Extract1' }, 'Send1', 'Send1'),
    ).toBeUndefined();
  });

  it('takes a block out of the flow, leading what came before it to what came after', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'Extract1', run(doc, 'acme.report')).document;
    doc = addBlocks(doc, run(doc, 'acme.send'), { x: 0, y: 300 });
    doc = connect(doc, 'Send1', 'next', 'Extract1');
    doc = addBlocks(doc, run(doc, 'acme.alert'), { x: 0, y: 600 });
    doc = connect(doc, 'Extract1', 'error', 'Alert1');
    expect(isInFlow(doc, 'Extract1')).toBe(true);
    expect(spliceEnds(doc, 'Extract1')).toBeUndefined();

    const out = extractBlock(doc, 'Extract1');
    expect(out.connections).toEqual([
      { from: 'start', to: 'Report1' },
      { from: 'Send1', to: 'Report1' },
    ]);
    expect(isInFlow(out, 'Extract1')).toBe(false);
    expect(spliceEnds(out, 'Extract1')).toEqual({ first: 'Extract1', tail: 'Extract1' });
    // Out of one connection and into another, in one move.
    expect(
      spliceInto(out, { from: 'start', output: 'next', to: 'Report1' }, 'Extract1', 'Extract1')
        ?.connections,
    ).toEqual([
      { from: 'Send1', to: 'Report1' },
      { from: 'start', to: 'Extract1' },
      { from: 'Extract1', to: 'Report1' },
    ]);
  });

  it('lets a decision go without joining its branches, and moves a Parallel with its Join', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'if' }, '')).document;
    doc = addAfter(doc, 'If1', run(doc, 'acme.report')).document;
    expect(extractBlock(doc, 'If1').connections).toEqual([]);

    doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.report')).document;
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 0, y: 300 });
    doc = connect(doc, 'Parallel1', 'next', 'Extract1');
    doc = connect(doc, 'Extract1', 'next', 'Join1');
    expect(extractBlock(doc, 'Join1')).toBe(doc);
    const out = extractBlock(doc, 'Parallel1');
    expect(out.connections).toEqual([
      { from: 'Parallel1', to: 'Extract1' },
      { from: 'Extract1', to: 'Join1' },
      { from: 'start', to: 'Report1' },
    ]);
    expect(spliceEnds(out, 'Parallel1')).toEqual({ first: 'Parallel1', tail: 'Join1' });
  });

  it('removes a block with its connections, its Join, its place and its group', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    doc = { ...doc, groups: [{ id: 'g', name: 'G', blocks: ['Parallel1'] }] };
    doc = removeItems(doc, new Set(['Parallel1', 'start']));
    expect(doc.blocks.map(({ id }) => id)).toEqual(['start']);
    expect(doc.connections).toEqual([]);
    expect(Object.keys(doc.positions)).toEqual(['start']);
    expect(doc.groups).toEqual([]);
  });

  it('keeps connections of a renamed case, and drops those of a removed one', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'switch' }, '')).document;
    doc = addBlocks(doc, run(doc, 'a'), { x: 400, y: 0 });
    doc = connect(doc, 'Switch1', 'case-1', 'A1');
    doc = connect(doc, 'Switch1', 'default', 'A1');
    const block = doc.blocks.find(({ id }) => id === 'Switch1');
    if (block?.type !== 'switch') throw new Error('No switch');
    const renamed = { ...block, cases: block.cases.map((item) => ({ ...item, id: 'big' })) };
    doc = updateBlock(doc, renamed, { 'case-1': 'big' });
    expect(doc.connections).toContainEqual({ from: 'Switch1', output: 'big', to: 'A1' });
    doc = updateBlock(doc, {
      ...renamed,
      cases: renamed.cases.map((item) => ({ ...item, id: 'other' })),
    });
    expect(doc.connections.filter(({ from }) => from === 'Switch1')).toEqual([
      { from: 'Switch1', output: 'default', to: 'A1' },
    ]);
  });

  it('moves blocks and notes, and leaves positions of gone blocks out of the draft', () => {
    let doc = emptyDocument();
    doc = {
      ...doc,
      notes: [{ id: 'n', text: 'Hi', x: 0, y: 0 }],
      positions: { ...doc.positions, gone: { x: 1, y: 1 } },
    };
    doc = moveItems(doc, { start: { x: 5, y: 6 }, n: { x: 7, y: 8 } });
    const draft = draftOf({ ...doc, name: ' Flow ' }, 'flow');
    expect(draft).toMatchObject({ id: 'flow', name: 'Flow', positions: { start: { x: 5, y: 6 } } });
    expect(draft.notes).toEqual([{ id: 'n', text: 'Hi', x: 7, y: 8 }]);
  });
});

describe('block names and references', () => {
  it('reads a decision back as a sentence naming its blocks', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'Extract1', createBlocks(doc, { kind: 'if' }, '', 'Extract1')).document;
    const decide = doc.blocks.find(({ id }) => id === 'If1');
    if (decide?.type !== 'if') throw new Error('No If');
    const names = blockNames(doc.blocks);
    expect(names.get('If1')).toBe('If1');
    expect(names.get('start')).toBe('Start');
    expect(ifRuleText(decide.condition, (id) => names.get(id) ?? id)).toBe(
      'If Extract1 is completed',
    );
  });

  it('offers outputs of blocks that finish on every path before the block', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'Extract1', run(doc, 'report')).document;
    const tools = [tool('acme.extract', ['csv']), tool('report')];
    const context = { ...doc, tools, profiles: new Map() };
    const results = (id: string) =>
      valueChoices(context, id).flatMap(({ group, expression }) =>
        group === 'result' || group === 'run' ? [expression] : [],
      );
    expect(results('Report1')).toEqual(['run.folder', 'steps.Extract1.outputs.csv']);
    expect(results('Extract1')).toEqual(['run.folder']);
  });
});

describe('notes and groups', () => {
  it('adds a note with a free id, and frames blocks in one group at most', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'a')).document;
    const noted = addNote(doc, { x: 0, y: 100 }, '');
    expect(noted.id).toBe('note');
    doc = noted.document;
    const first = groupBlocks(doc, ['start', 'A1', 'gone'], 'One');
    expect(first.document.groups).toEqual([{ id: 'group', name: 'One', blocks: ['start', 'A1'] }]);
    const second = groupBlocks(first.document, ['A1'], 'Two');
    expect(second.document.groups).toEqual([
      { id: 'group', name: 'One', blocks: ['start'] },
      { id: 'group-2', name: 'Two', blocks: ['A1'] },
    ]);
    const renamed = updateGroup(second.document, {
      id: 'group-2',
      name: 'Renamed',
      blocks: ['A1'],
    });
    expect(ungroup(renamed, 'group').groups.map(({ name }) => name)).toEqual(['Renamed']);
  });
});

describe('copy and paste', () => {
  const flow: FlowDocument = {
    ...emptyDocument(),
    blocks: [
      { id: 'start', type: 'start' },
      { id: 'Extract1', type: 'run', tool: 'acme.extract' },
      {
        id: 'Report1',
        type: 'run',
        tool: 'acme.report',
        values: {
          input: '{{steps.Extract1.outputs.table}}',
          other: '{{steps.start.outputs.x}} and {{steps.Extract1.outputs.table}}',
          count: 3,
        },
      },
      {
        id: 'If1',
        type: 'if',
        condition: {
          match: 'all',
          rules: [
            { block: 'Report1', field: 'result', operator: 'is', value: 'completed' },
            { block: 'start', field: 'result', operator: 'is', value: 'completed' },
          ],
        },
      },
      { id: 'Parallel1', type: 'parallel' },
      { id: 'Join1', type: 'join', parallel: 'Parallel1' },
    ],
    connections: [
      { from: 'start', to: 'Extract1' },
      { from: 'Extract1', to: 'Report1' },
      { from: 'Report1', to: 'If1' },
      { from: 'Parallel1', to: 'Join1' },
    ],
    positions: {
      start: { x: 0, y: 0 },
      Extract1: { x: 200, y: 40 },
      Report1: { x: 500, y: 40 },
      If1: { x: 800, y: 20 },
      Parallel1: { x: 200, y: 300 },
      Join1: { x: 500, y: 300 },
    },
    notes: [{ id: 'note', text: 'Hi', x: 150, y: 10 }],
  };

  it('keeps only the connections between copied blocks, and never Start', () => {
    const clip = copyItems(flow, new Set(['start', 'Extract1', 'Report1']));
    expect(clip?.blocks.map(({ id }) => id)).toEqual(['Extract1', 'Report1']);
    expect(clip?.connections).toEqual([{ from: 'Extract1', to: 'Report1' }]);
    expect(copyItems(flow, new Set(['start']))).toBeUndefined();
  });

  it('copies a Parallel with its Join, and a Join with its Parallel', () => {
    expect(copyItems(flow, new Set(['Parallel1']))?.blocks.map(({ id }) => id)).toEqual([
      'Parallel1',
      'Join1',
    ]);
    const clip = copyItems(flow, new Set(['Join1']));
    expect(clip?.connections).toEqual([{ from: 'Parallel1', to: 'Join1' }]);
    const pasted = clip === undefined ? undefined : pasteItems(flow, clip, { x: 0, y: 600 });
    expect(pasted?.document.blocks.at(-1)).toEqual({
      id: 'Join2',
      type: 'join',
      parallel: 'Parallel2',
    });
  });

  it('pastes under new ids at the point asked, and follows references between copies', () => {
    const clip = copyItems(flow, new Set(['Extract1', 'Report1', 'If1', 'note']));
    if (clip === undefined) throw new Error('nothing copied');
    const pasted = pasteItems(flow, clip, { x: 1000, y: 1000 });
    expect(pasted?.ids).toEqual(['Extract2', 'Report2', 'If2', 'note-2']);
    const document = pasted?.document;
    // The note was the top-left corner.
    expect(document?.positions['Extract2']).toEqual({ x: 1050, y: 1030 });
    expect(document?.notes.at(-1)).toEqual({ id: 'note-2', text: 'Hi', x: 1000, y: 1000 });
    expect(document?.connections.slice(-2)).toEqual([
      { from: 'Extract2', to: 'Report2' },
      { from: 'Report2', to: 'If2' },
    ]);
    const report = document?.blocks.find(({ id }) => id === 'Report2');
    expect(report?.type === 'run' ? report.values : undefined).toEqual({
      input: '{{steps.Extract2.outputs.table}}',
      other: '{{steps.start.outputs.x}} and {{steps.Extract2.outputs.table}}',
      count: 3,
    });
    const decide = document?.blocks.find(({ id }) => id === 'If2');
    expect(
      decide?.type === 'if'
        ? decide.condition.rules.map((rule) => ('block' in rule ? rule.block : ''))
        : [],
    ).toEqual(['Report2', 'start']);
    // A second paste takes the next free ids.
    const again = document === undefined ? undefined : pasteItems(document, clip, { x: 0, y: 0 });
    expect(again?.ids[0]).toBe('Extract3');
  });
  it('duplicates one grid step away, under new ids', () => {
    const copy = duplicateItems(flow, new Set(['Extract1', 'Report1']), 16);
    expect(copy?.ids).toEqual(['Extract2', 'Report2']);
    expect(copy?.document.positions['Extract2']).toEqual({ x: 216, y: 56 });
    expect(copy?.document.connections.at(-1)).toEqual({ from: 'Extract2', to: 'Report2' });
    expect(duplicateItems(flow, new Set(['start']), 16)).toBeUndefined();
  });

  it('walks the connections up and down from the chosen blocks', () => {
    expect([...downstreamOf(flow, ['Extract1'])].sort()).toEqual(['Extract1', 'If1', 'Report1']);
    expect([...upstreamOf(flow, ['Report1'])].sort()).toEqual(['Extract1', 'Report1', 'start']);
    expect([...upstreamOf(flow, ['Join1', 'note'])].sort()).toEqual(['Join1', 'Parallel1']);
  });

  it('aligns blocks and notes to the grid, and leaves the rest', () => {
    const moved: FlowDocument = {
      ...flow,
      positions: { ...flow.positions, Extract1: { x: 203, y: 41 } },
      notes: [{ id: 'note', text: 'Hi', x: 150, y: 10 }],
    };
    const aligned = alignToGrid(moved, new Set(['Extract1', 'note']), 16);
    expect(aligned.positions['Extract1']).toEqual({ x: 208, y: 48 });
    expect(aligned.positions['Report1']).toEqual({ x: 500, y: 40 });
    expect(aligned.notes[0]).toMatchObject({ x: 144, y: 16 });
  });
});

describe('block names numbered from 1', () => {
  it('names a block from its tool name in CamelCase, without accents', () => {
    expect(nameBase('File check')).toBe('FileCheck');
    expect(nameBase('Revisar notas (año)')).toBe('RevisarNotasAno');
    expect(nameBase('convert-to_pdf')).toBe('ConvertToPdf');
    expect(nameBase('3D export')).toBe('Block');
    expect(nameBase('···')).toBe('Block');
    expect(freeName('FileCheck', new Set(['FileCheck1', 'FileCheck3']))).toBe('FileCheck2');
  });

  it('gives control blocks their own bases, and a tool name over its id', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'if' }, '')).document;
    for (const kind of ['switch', 'parallel', 'wait-for-time', 'wait-for-manual-action'] as const) {
      doc = addBlocks(doc, createBlocks(doc, { kind }, 'Check'), { x: 0, y: 300 });
    }
    const named = namedChoice({ kind: 'run', tool: 'acme.check' }, [
      { id: 'acme.check', name: 'File Check' },
    ]);
    doc = addBlocks(doc, createBlocks(doc, named, ''), { x: 0, y: 600 });
    doc = addBlocks(doc, createBlocks(doc, named, ''), { x: 0, y: 600 });
    expect(doc.blocks.map(({ id }) => id)).toEqual([
      'start',
      'If1',
      'Switch1',
      'Parallel1',
      'Join1',
      'Wait1',
      'Confirm1',
      'FileCheck1',
      'FileCheck2',
    ]);
  });

  it('renumbers a pasted block from its base, also for older names', () => {
    let doc = emptyDocument();
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 200, y: 0 });
    doc = {
      ...doc,
      blocks: [...doc.blocks, { id: 'convert-2', type: 'run', tool: 'acme.convert' }],
      positions: { ...doc.positions, 'convert-2': { x: 200, y: 300 } },
    };
    const pasted = duplicateItems(doc, new Set(['Extract1', 'convert-2']), 16);
    expect(pasted?.ids).toEqual(['Extract2', 'convert1']);
  });
});

describe('replace', () => {
  it('puts a new block in place, keeping only its position and connections', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'Extract1', run(doc, 'acme.report')).document;
    doc = updateBlock(doc, {
      id: 'Extract1',
      type: 'run',
      tool: 'acme.extract',
      profile: 'fast',
      values: { size: 3 },
      onFailure: { retry: { attempts: 2 } },
    });
    doc = updateBlock(doc, {
      id: 'Report1',
      type: 'run',
      tool: 'acme.report',
      values: { file: { expression: 'Extract1.size' } },
    });
    doc = { ...doc, groups: [{ id: 'g', name: 'G', blocks: ['Extract1', 'Report1'] }] };
    const at = doc.positions['Extract1'];
    const replaced = replaceBlock(doc, 'Extract1', { kind: 'run', tool: 'acme.extract' });
    expect(replaced?.id).toBe('Extract2');
    const next = replaced?.document;
    expect(next?.blocks[1]).toEqual({ id: 'Extract2', type: 'run', tool: 'acme.extract' });
    expect(next?.positions['Extract2']).toEqual(at);
    expect(next?.positions['Extract1']).toBeUndefined();
    expect(next?.connections).toEqual([
      { from: 'start', to: 'Extract2' },
      { from: 'Extract2', to: 'Report1' },
    ]);
    // Links to the old name stay, as problems, and it leaves its group.
    expect(next?.blocks.find(({ id }) => id === 'Report1')).toMatchObject({
      values: { file: { expression: 'Extract1.size' } },
    });
    expect(next?.groups).toEqual([{ id: 'g', name: 'G', blocks: ['Report1'] }]);
    expect(replaceBlock(doc, 'start', { kind: 'run', tool: 'acme.extract' })).toBeUndefined();
  });
});

describe('disabling blocks', () => {
  const doc: FlowDocument = {
    ...emptyDocument(),
    blocks: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'run', tool: 'acme.extract' },
      { id: 'b', type: 'run', tool: 'acme.extract', disabled: true },
      { id: 'fork', type: 'parallel' },
    ],
  };
  const block = (document: FlowDocument, id: string) =>
    document.blocks.find((item) => item.id === id);

  it('disables the chosen blocks when any of them is enabled', () => {
    expect(disablesChosen(doc, new Set(['a', 'b']))).toBe(true);
    const next = toggleDisabled(doc, new Set(['a', 'b']));
    expect(block(next, 'a')).toMatchObject({ disabled: true });
    expect(block(next, 'b')).toMatchObject({ disabled: true });
  });

  it('enables them when all of them are disabled, leaving no field behind', () => {
    expect(disablesChosen(doc, new Set(['b']))).toBe(false);
    const next = toggleDisabled(doc, new Set(['b']));
    expect(block(next, 'b')).toEqual({ id: 'b', type: 'run', tool: 'acme.extract' });
    expect(isDisabled(block(next, 'b') ?? { id: 'x', type: 'start' })).toBe(false);
  });

  it('leaves Start and Parallel as they are', () => {
    expect(disablesChosen(doc, new Set(['start', 'fork']))).toBeUndefined();
    expect(toggleDisabled(doc, new Set(['start', 'fork']))).toBe(doc);
    const next = toggleDisabled(doc, new Set(['start', 'a']));
    expect(block(next, 'start')).toEqual({ id: 'start', type: 'start' });
    expect(block(next, 'a')).toMatchObject({ disabled: true });
  });
});
