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
  createBlocks,
  draftOf,
  emptyDocument,
  moveItems,
  removeItems,
  sizeOf,
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
