import { describe, expect, it } from 'vitest';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { blockNames } from './block-text.js';
import {
  addNote,
  groupBlocks,
  ungroup,
  updateGroup,
  addAfter,
  addBlocks,
  connect,
  copyItems,
  createBlocks,
  draftOf,
  emptyDocument,
  moveItems,
  pasteItems,
  extractBlock,
  isInFlow,
  removeItems,
  sizeOf,
  spliceEnds,
  spliceInto,
  updateBlock,
} from './flow-document.js';
import type { FlowDocument } from './flow-document.js';
import { referenceOptionsFor } from './references.js';

const tool = (id: string, outputs: string[] = []): ToolView => ({
  key: `global/${id}`,
  id,
  scope: 'global',
  name: id === 'acme.extract' ? 'Extract' : id,
  level: 1,
  program: 'C:\\tool.exe',
  parameters: [],
  outputs,
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
    expect(document.blocks.map(({ id }) => id)).toEqual(['start', 'extract']);
    expect(document.connections).toEqual([{ from: 'start', to: 'extract' }]);
    expect(document.positions['extract']?.x).toBeGreaterThan(
      sizeOf({ id: 'start', type: 'start' }).width,
    );
  });

  it('gives each new block a free id, shared with notes and groups', () => {
    let doc = emptyDocument();
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 200, y: 0 });
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 200, y: 0 });
    expect(doc.blocks.map(({ id }) => id)).toEqual(['start', 'extract', 'extract-2']);
    // The second one moved down rather than covering the first.
    expect(doc.positions['extract-2']?.y).toBeGreaterThan(doc.positions['extract']?.y ?? 0);
  });

  it('adds a Parallel with its Join, which takes over where the anchor led', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    expect(doc.connections).toEqual([
      { from: 'start', to: 'parallel' },
      { from: 'join', to: 'extract' },
    ]);
    expect(doc.blocks.find(({ id }) => id === 'join')).toEqual({
      id: 'join',
      type: 'join',
      parallel: 'parallel',
    });
  });

  it('replaces where an output leads, except on a Parallel', () => {
    let doc = emptyDocument();
    doc = addBlocks(doc, [...run(doc, 'a'), ...run(doc, 'b')], { x: 200, y: 0 });
    doc = addBlocks(doc, run(doc, 'b'), { x: 200, y: 100 });
    doc = connect(doc, 'start', 'next', 'a');
    doc = connect(doc, 'start', 'next', 'b');
    expect(doc.connections).toEqual([{ from: 'start', to: 'b' }]);
    doc = addBlocks(doc, createBlocks(doc, { kind: 'parallel' }, ''), { x: 0, y: 300 });
    doc = connect(doc, 'parallel', 'next', 'a');
    doc = connect(doc, 'parallel', 'next', 'b-2');
    expect(doc.connections.filter(({ from }) => from === 'parallel')).toHaveLength(2);
  });

  it('puts a block into a connection, and a Parallel with its Join as the tail', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addBlocks(doc, run(doc, 'acme.report'), { x: 0, y: 300 });
    const into = { from: 'start', output: 'next', to: 'extract' };
    const spliced = spliceInto(doc, into, 'report', 'report');
    expect(spliced?.connections).toEqual([
      { from: 'start', to: 'report' },
      { from: 'report', to: 'extract' },
    ]);

    doc = addBlocks(doc, createBlocks(doc, { kind: 'parallel' }, ''), { x: 0, y: 600 });
    expect(spliceInto(doc, into, 'parallel', 'join')?.connections).toEqual([
      { from: 'start', to: 'parallel' },
      { from: 'join', to: 'extract' },
    ]);
  });

  it('refuses a splice that has no way on, moves Start or makes a loop', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'extract', run(doc, 'acme.report')).document;
    doc = addBlocks(doc, createBlocks(doc, { kind: 'if' }, ''), { x: 0, y: 300 });
    const into = { from: 'extract', output: 'next', to: 'report' };
    // An If goes on through True or False, never through Next.
    expect(spliceInto(doc, into, 'decide', 'decide')).toBeUndefined();
    expect(spliceInto(doc, into, 'start', 'start')).toBeUndefined();
    expect(spliceInto(doc, into, 'report', 'report')).toBeUndefined();
    expect(spliceInto(doc, { ...into, to: 'nowhere' }, 'decide', 'decide')).toBeUndefined();

    // A block already in the flow, after the connection, would lead back into itself.
    doc = addBlocks(doc, run(doc, 'acme.send'), { x: 0, y: 600 });
    doc = connect(doc, 'report', 'next', 'send');
    expect(
      spliceInto(doc, { from: 'start', output: 'next', to: 'extract' }, 'send', 'send'),
    ).toBeUndefined();
  });

  it('takes a block out of the flow, leading what came before it to what came after', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'extract', run(doc, 'acme.report')).document;
    doc = addBlocks(doc, run(doc, 'acme.send'), { x: 0, y: 300 });
    doc = connect(doc, 'send', 'next', 'extract');
    doc = addBlocks(doc, run(doc, 'acme.alert'), { x: 0, y: 600 });
    doc = connect(doc, 'extract', 'error', 'alert');
    expect(isInFlow(doc, 'extract')).toBe(true);
    expect(spliceEnds(doc, 'extract')).toBeUndefined();

    const out = extractBlock(doc, 'extract');
    expect(out.connections).toEqual([
      { from: 'start', to: 'report' },
      { from: 'send', to: 'report' },
    ]);
    expect(isInFlow(out, 'extract')).toBe(false);
    expect(spliceEnds(out, 'extract')).toEqual({ first: 'extract', tail: 'extract' });
    // Out of one connection and into another, in one move.
    expect(
      spliceInto(out, { from: 'start', output: 'next', to: 'report' }, 'extract', 'extract')
        ?.connections,
    ).toEqual([
      { from: 'send', to: 'report' },
      { from: 'start', to: 'extract' },
      { from: 'extract', to: 'report' },
    ]);
  });

  it('lets a decision go without joining its branches, and moves a Parallel with its Join', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'if' }, '')).document;
    doc = addAfter(doc, 'decide', run(doc, 'acme.report')).document;
    expect(extractBlock(doc, 'decide').connections).toEqual([]);

    doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.report')).document;
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    doc = addBlocks(doc, run(doc, 'acme.extract'), { x: 0, y: 300 });
    doc = connect(doc, 'parallel', 'next', 'extract');
    doc = connect(doc, 'extract', 'next', 'join');
    expect(extractBlock(doc, 'join')).toBe(doc);
    const out = extractBlock(doc, 'parallel');
    expect(out.connections).toEqual([
      { from: 'parallel', to: 'extract' },
      { from: 'extract', to: 'join' },
      { from: 'start', to: 'report' },
    ]);
    expect(spliceEnds(out, 'parallel')).toEqual({ first: 'parallel', tail: 'join' });
  });

  it('removes a block with its connections, its Join, its place and its group', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'parallel' }, '')).document;
    doc = { ...doc, groups: [{ id: 'g', name: 'G', blocks: ['parallel'] }] };
    doc = removeItems(doc, new Set(['parallel', 'start']));
    expect(doc.blocks.map(({ id }) => id)).toEqual(['start']);
    expect(doc.connections).toEqual([]);
    expect(Object.keys(doc.positions)).toEqual(['start']);
    expect(doc.groups).toEqual([]);
  });

  it('keeps connections of a renamed case, and drops those of a removed one', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', createBlocks(doc, { kind: 'switch' }, '')).document;
    doc = addBlocks(doc, run(doc, 'a'), { x: 400, y: 0 });
    doc = connect(doc, 'choose', 'case-1', 'a');
    doc = connect(doc, 'choose', 'default', 'a');
    const block = doc.blocks.find(({ id }) => id === 'choose');
    if (block?.type !== 'switch') throw new Error('No switch');
    const renamed = { ...block, cases: block.cases.map((item) => ({ ...item, id: 'big' })) };
    doc = updateBlock(doc, renamed, { 'case-1': 'big' });
    expect(doc.connections).toContainEqual({ from: 'choose', output: 'big', to: 'a' });
    doc = updateBlock(doc, {
      ...renamed,
      cases: renamed.cases.map((item) => ({ ...item, id: 'other' })),
    });
    expect(doc.connections.filter(({ from }) => from === 'choose')).toEqual([
      { from: 'choose', output: 'default', to: 'a' },
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
    doc = addAfter(doc, 'extract', createBlocks(doc, { kind: 'if' }, '', 'extract')).document;
    const names = blockNames(doc.blocks, [tool('acme.extract')]);
    expect(names.get('decide')).toBe('If Extract is completed');
  });

  it('offers outputs of blocks that finish on every path before the block', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'acme.extract')).document;
    doc = addAfter(doc, 'extract', run(doc, 'report')).document;
    const tools = [tool('acme.extract', ['csv']), tool('report')];
    const names = blockNames(doc.blocks, tools);
    const options = referenceOptionsFor(doc, 'report', tools, (id) => names.get(id) ?? id);
    expect(options.map(({ value }) => value)).toEqual([
      '{{run.folder}}/',
      '{{steps.extract.outputs.csv}}',
    ]);
    expect(referenceOptionsFor(doc, 'extract', tools, (id) => id)).toHaveLength(1);
  });
});

describe('notes and groups', () => {
  it('adds a note with a free id, and frames blocks in one group at most', () => {
    let doc = emptyDocument();
    doc = addAfter(doc, 'start', run(doc, 'a')).document;
    const noted = addNote(doc, { x: 0, y: 100 }, '');
    expect(noted.id).toBe('note');
    doc = noted.document;
    const first = groupBlocks(doc, ['start', 'a', 'gone'], 'One');
    expect(first.document.groups).toEqual([{ id: 'group', name: 'One', blocks: ['start', 'a'] }]);
    const second = groupBlocks(first.document, ['a'], 'Two');
    expect(second.document.groups).toEqual([
      { id: 'group', name: 'One', blocks: ['start'] },
      { id: 'group-2', name: 'Two', blocks: ['a'] },
    ]);
    const renamed = updateGroup(second.document, { id: 'group-2', name: 'Renamed', blocks: ['a'] });
    expect(ungroup(renamed, 'group').groups.map(({ name }) => name)).toEqual(['Renamed']);
  });
});

describe('copy and paste', () => {
  const flow: FlowDocument = {
    ...emptyDocument(),
    blocks: [
      { id: 'start', type: 'start' },
      { id: 'extract', type: 'run', tool: 'acme.extract' },
      {
        id: 'report',
        type: 'run',
        tool: 'acme.report',
        values: {
          input: '{{steps.extract.outputs.table}}',
          other: '{{steps.start.outputs.x}} and {{steps.extract.outputs.table}}',
          count: 3,
        },
      },
      {
        id: 'decide',
        type: 'if',
        condition: {
          match: 'all',
          rules: [
            { block: 'report', field: 'result', operator: 'is', value: 'completed' },
            { block: 'start', field: 'result', operator: 'is', value: 'completed' },
          ],
        },
      },
      { id: 'parallel', type: 'parallel' },
      { id: 'join', type: 'join', parallel: 'parallel' },
    ],
    connections: [
      { from: 'start', to: 'extract' },
      { from: 'extract', to: 'report' },
      { from: 'report', to: 'decide' },
      { from: 'parallel', to: 'join' },
    ],
    positions: {
      start: { x: 0, y: 0 },
      extract: { x: 200, y: 40 },
      report: { x: 500, y: 40 },
      decide: { x: 800, y: 20 },
      parallel: { x: 200, y: 300 },
      join: { x: 500, y: 300 },
    },
    notes: [{ id: 'note', text: 'Hi', x: 150, y: 10 }],
  };

  it('keeps only the connections between copied blocks, and never Start', () => {
    const clip = copyItems(flow, new Set(['start', 'extract', 'report']));
    expect(clip?.blocks.map(({ id }) => id)).toEqual(['extract', 'report']);
    expect(clip?.connections).toEqual([{ from: 'extract', to: 'report' }]);
    expect(copyItems(flow, new Set(['start']))).toBeUndefined();
  });

  it('copies a Parallel with its Join, and a Join with its Parallel', () => {
    expect(copyItems(flow, new Set(['parallel']))?.blocks.map(({ id }) => id)).toEqual([
      'parallel',
      'join',
    ]);
    const clip = copyItems(flow, new Set(['join']));
    expect(clip?.connections).toEqual([{ from: 'parallel', to: 'join' }]);
    const pasted = clip === undefined ? undefined : pasteItems(flow, clip, { x: 0, y: 600 });
    expect(pasted?.document.blocks.at(-1)).toEqual({
      id: 'join-2',
      type: 'join',
      parallel: 'parallel-2',
    });
  });

  it('pastes under new ids at the point asked, and follows references between copies', () => {
    const clip = copyItems(flow, new Set(['extract', 'report', 'decide', 'note']));
    if (clip === undefined) throw new Error('nothing copied');
    const pasted = pasteItems(flow, clip, { x: 1000, y: 1000 });
    expect(pasted?.ids).toEqual(['extract-2', 'report-2', 'decide-2', 'note-2']);
    const document = pasted?.document;
    // The note was the top-left corner.
    expect(document?.positions['extract-2']).toEqual({ x: 1050, y: 1030 });
    expect(document?.notes.at(-1)).toEqual({ id: 'note-2', text: 'Hi', x: 1000, y: 1000 });
    expect(document?.connections.slice(-2)).toEqual([
      { from: 'extract-2', to: 'report-2' },
      { from: 'report-2', to: 'decide-2' },
    ]);
    const report = document?.blocks.find(({ id }) => id === 'report-2');
    expect(report?.type === 'run' ? report.values : undefined).toEqual({
      input: '{{steps.extract-2.outputs.table}}',
      other: '{{steps.start.outputs.x}} and {{steps.extract-2.outputs.table}}',
      count: 3,
    });
    const decide = document?.blocks.find(({ id }) => id === 'decide-2');
    expect(decide?.type === 'if' ? decide.condition.rules.map(({ block }) => block) : []).toEqual([
      'report-2',
      'start',
    ]);
    // A second paste takes the next free ids.
    const again = document === undefined ? undefined : pasteItems(document, clip, { x: 0, y: 0 });
    expect(again?.ids[0]).toBe('extract-3');
  });
});
